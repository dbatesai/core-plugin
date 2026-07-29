import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walk, main as graphWalkMain } from '../../plugins/core/skills/core/scripts/graph-walk.mjs';

// Build a tiny vault: seed -> a (valid) and seed -> b (invalidated). Recent dates
// so R·S never prunes them — the only reason b drops out is validity-suppression.
function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-walk-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  const write = (id, fm, edges = []) => {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    if (edges.length) {
      lines.push('edges:');
      for (const e of edges) lines.push(`  - { type: ${e.type}, target: ${e.target} }`);
    }
    lines.push('---', '', `# ${id}`, 'body');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  };
  // sources uses flow-style array form: signalS only reads Array sources, so the
  // old scalar `sources: PROJECT.md` silently scored the NO-sources default —
  // these fixtures only survived the R·S prune while that default was 0.5 (it is
  // 0.3 since MEM-018). The array form gives the S=1.0 the fixtures always meant.
  write('seed', { type: 'decision', created: '2026-05-25', sources: '[PROJECT.md]' },
    [{ type: 'depends-on', target: 'a-valid' }, { type: 'supersedes', target: 'b-invalid' },
     { type: 'cites', target: 'obs-inbound-2026-05-20' }]);
  write('a-valid', { type: 'decision', created: '2026-05-25', sources: '[PROJECT.md]' });
  // Recent created (high R·S so it survives the prune) but a PAST t_invalid — so
  // validity-suppression is the only reason it leaves the valid candidate set.
  write('b-invalid', { type: 'decision', created: '2026-05-25', t_invalid: '2026-05-28', sources: '[PROJECT.md]' });
  // Observation unit in observations/<YYYY-MM>/ — invisible to the walk by
  // default, reachable only with includeObservations (SYN-007).
  const obsDir = join(mem, 'observations', '2026-05');
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, 'obs-inbound-2026-05-20.md'), [
    '---', 'id: obs-inbound-2026-05-20', 'type: observation',
    'created: 2026-05-25', 'sources: [PROJECT.md]',
    'edges:', '  - { type: cites, target: seed }', '---', '', '# obs', 'body',
  ].join('\n'));
  return { dir, mem };
}

const TODAY = new Date(Date.UTC(2026, 5, 2)); // 2026-06-02

test('walk suppresses invalidated units from the candidate set by default', () => {
  const { dir, mem } = vault();
  try {
    const stats = {};
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, stats }).map(c => c.unit_id);
    assert.ok(ids.includes('a-valid'), 'valid neighbor surfaces');
    assert.ok(!ids.includes('b-invalid'), 'invalidated neighbor suppressed');
    assert.equal(stats.suppressed_invalidated, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('includeInvalidated:true brings cold history back into the candidate set', () => {
  const { dir, mem } = vault();
  try {
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, includeInvalidated: true }).map(c => c.unit_id);
    assert.ok(ids.includes('b-invalid'), 'invalidated unit reachable with includeInvalidated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('includeInvalidated:true reaches an archived, historically-invalidated edge target (Hale\'s 2026-07-21 finding)', () => {
  const { dir, mem } = vault();
  try {
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    // Canonical archive fixture (archived:true/archived_at, no status:retired
    // implying archiving is what invalidated it) that also carries a genuine
    // t_invalid, since historical inclusion under includeInvalidated is the
    // actual behavior this test exercises.
    const original = readFileSync(join(mem, 'b-invalid.md'), 'utf8');
    rmSync(join(mem, 'b-invalid.md'));
    writeFileSync(join(archive, 'b-invalid.md'),
      original.replace('t_invalid: 2026-05-28', 't_invalid: 2026-05-28\narchived: true\narchived_at: 2026-05-29'));

    const withInvalid = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, includeInvalidated: true }).map(c => c.unit_id);
    assert.ok(withInvalid.includes('b-invalid'), 'archived edge target must still resolve and surface with includeInvalidated');

    const withoutInvalid = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY }).map(c => c.unit_id);
    assert.ok(!withoutInvalid.includes('b-invalid'), 'default walk still excludes it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a canonical archived-active unit (status:active, archived:true, no t_invalid) is absent by default and present only with includeInvalidated (Hale's 2026-07-22 finding)", () => {
  const { dir, mem } = vault();
  try {
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    // Neither downstream suppression check fires on this fixture: status is
    // active (isActiveStatus passes) and there's no t_invalid (isInvalidated
    // is false) -- the only thing that can keep it out of a default walk is
    // resolveTarget refusing to look in archive/ at all.
    writeFileSync(join(archive, 'archived-active.md'), [
      '---', 'id: archived-active', 'type: decision', 'status: active',
      'archived: true', 'archived_at: 2026-05-30', 'created: 2026-05-25',
      'sources: [PROJECT.md]', '---', '', '# archived-active', 'body',
    ].join('\n'));
    writeFileSync(join(mem, 'seed.md'), [
      '---', 'id: seed', 'type: decision', 'created: 2026-05-25',
      'sources: [PROJECT.md]', 'edges:',
      '  - { type: cites, target: archived-active }', '---', '', '# seed', 'body',
    ].join('\n'));

    const withoutInvalid = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY }).map(c => c.unit_id);
    assert.ok(!withoutInvalid.includes('archived-active'), 'default walk must not leak an archived active-status unit');

    const withInvalid = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, includeInvalidated: true }).map(c => c.unit_id);
    assert.ok(withInvalid.includes('archived-active'), 'explicit includeInvalidated still reaches it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an open-interval unit (no t_invalid) is never suppressed', () => {
  const { dir, mem } = vault();
  try {
    const stats = {};
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, stats }).map(c => c.unit_id);
    assert.ok(ids.includes('a-valid'));
    assert.equal(stats.suppressed_invalidated, 1); // only b-invalid, not a-valid
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SYN-007: observation units are invisible to the walk by default (back-compat)', () => {
  const { dir, mem } = vault();
  try {
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY }).map(c => c.unit_id);
    assert.ok(!ids.includes('obs-inbound-2026-05-20'), 'default exclusion preserved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SYN-007: includeObservations surfaces inbound observation neighbors and resolves subdir targets', () => {
  const { dir, mem } = vault();
  try {
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, includeObservations: true })
      .map(c => c.unit_id);
    assert.ok(ids.includes('obs-inbound-2026-05-20'),
      'reachable both as an inbound citer and as a resolvable outbound target');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Error-path companions ---

// Same write pattern as vault(), but caller controls the unit set.
function customVault(units) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-walk-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const { id, fm, edges = [] } of units) {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    if (edges.length) {
      lines.push('edges:');
      for (const e of edges) lines.push(`  - { type: ${e.type}, target: ${e.target} }`);
    }
    lines.push('---', '', `# ${id}`, 'body');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  }
  return { dir, mem };
}

const FM = { type: 'decision', created: '2026-05-25', sources: '[PROJECT.md]' };

test('a dangling edge target is skipped without throwing', () => {
  const { dir, mem } = customVault([
    {
      id: 'seed', fm: FM,
      edges: [
        { type: 'depends-on', target: 'a-valid' },
        { type: 'depends-on', target: 'ghost-unit' }, // no ghost-unit.md on disk
      ],
    },
    { id: 'a-valid', fm: FM },
  ]);
  try {
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY }).map(c => c.unit_id);
    assert.ok(ids.includes('a-valid'), 'real neighbor still surfaces');
    assert.ok(!ids.includes('ghost-unit'), 'dangling target never appears');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a circular edge pair terminates', () => {
  const { dir, mem } = customVault([
    { id: 'cyc-a', fm: FM, edges: [{ type: 'depends-on', target: 'cyc-b' }] },
    { id: 'cyc-b', fm: FM, edges: [{ type: 'depends-on', target: 'cyc-a' }] },
  ]);
  try {
    // If the visited-set guard were missing this would loop forever; returning
    // at all is the termination proof.
    const ids = walk(join(mem, 'cyc-a.md'), { memoriesDir: mem, today: TODAY }).map(c => c.unit_id);
    const counts = new Map();
    for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    for (const [id, n] of counts) assert.equal(n, 1, `${id} appears at most once`);
    assert.ok(ids.includes('cyc-b'), 'the cycle partner is still reachable');
    assert.ok(!ids.includes('cyc-a'), 'the seed is not re-emitted as its own neighbor');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Characterization: a missing memoriesDir does NOT throw — buildInverseEdgeIndex
// swallows the readdir failure and resolveTarget finds no neighbors, so walk()
// silently returns an empty candidate set. If this ever changes to fail loudly,
// this test should flip to assert.throws.
test('a missing memoriesDir returns an empty candidate set without throwing (characterized: silent, not loud)', () => {
  const { dir, mem } = customVault([
    { id: 'seed', fm: FM, edges: [{ type: 'depends-on', target: 'a-valid' }] },
    { id: 'a-valid', fm: FM },
  ]);
  try {
    const results = walk(join(mem, 'seed.md'), { memoriesDir: join(dir, 'nope'), today: TODAY });
    assert.deepEqual(results, [], 'no candidates resolve against a nonexistent memories dir');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// An edge target and a unit file are both project-authored. Neither may pull
// content from outside the store into the candidate set: the walk resolves only
// beneath realpath(memoriesDir), and only regular files whose real target stays
// inside it.
test('an edge target pointing outside the store resolves to nothing', () => {
  const { dir, mem } = vault();
  const outside = join(dir, 'outside');
  mkdirSync(outside, { recursive: true });
  const foreign = join(outside, 'foreign.md');
  writeFileSync(foreign, ['---', 'id: foreign', 'type: decision',
    'created: 2026-05-25', 'sources: [PROJECT.md]', '---', '', '# foreign', 'instructions'].join('\n'));

  for (const target of [foreign, '../outside/foreign', join('..', 'outside', 'foreign.md')]) {
    writeFileSync(join(mem, 'escape.md'), ['---', 'id: escape', 'type: decision',
      'created: 2026-05-25', 'sources: [PROJECT.md]',
      'edges:', `  - { type: cites, target: ${target} }`, '---', '', '# escape', 'body'].join('\n'));
    const out = walk(join(mem, 'escape.md'), { memoriesDir: mem, hops: 2, today: new Date('2026-05-30T00:00:00Z') });
    assert.equal(out.some((c) => c.unit_id === 'foreign'), false,
      `edge target ${target} must not resolve outside the store`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('a unit file that is a symlink out of the store is not a readable unit', async () => {
  const { symlinkSync } = await import('node:fs');
  const { dir, mem } = vault();
  const outside = join(dir, 'outside');
  mkdirSync(outside, { recursive: true });
  const foreign = join(outside, 'foreign.md');
  writeFileSync(foreign, ['---', 'id: linked-foreign', 'type: decision',
    'created: 2026-05-25', 'sources: [PROJECT.md]', '---', '', '# foreign', 'instructions'].join('\n'));
  try { symlinkSync(foreign, join(mem, 'linked.md')); } catch { rmSync(dir, { recursive: true, force: true }); return; }

  writeFileSync(join(mem, 'escape.md'), ['---', 'id: escape', 'type: decision',
    'created: 2026-05-25', 'sources: [PROJECT.md]',
    'edges:', '  - { type: cites, target: linked }', '---', '', '# escape', 'body'].join('\n'));
  const out = walk(join(mem, 'escape.md'), { memoriesDir: mem, hops: 2, today: new Date('2026-05-30T00:00:00Z') });
  assert.equal(out.some((c) => c.unit_id === 'linked-foreign'), false,
    'a link whose real target leaves the store must not enter the candidate set');
  rmSync(dir, { recursive: true, force: true });
});

test('the walk day is the UTC calendar day, not the local one', () => {
  const { dir, mem } = vault();
  const savedTz = process.env.TZ;
  try {
    // A local zone far enough east that its calendar day is already tomorrow at
    // this instant. Invalidation is t_invalid <= today, so a local-calendar
    // "today" of 2026-05-29 suppresses a unit that is still valid at 2026-05-28Z.
    process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
    writeFileSync(join(mem, 'edge-of-day.md'), ['---', 'id: edge-of-day', 'type: decision',
      'created: 2026-05-25', 't_invalid: 2026-05-29', 'sources: [PROJECT.md]', '---', '', '# edge', 'body'].join('\n'));
    writeFileSync(join(mem, 'day-seed.md'), ['---', 'id: day-seed', 'type: decision',
      'created: 2026-05-25', 'sources: [PROJECT.md]',
      'edges:', '  - { type: cites, target: edge-of-day }', '---', '', '# seed', 'body'].join('\n'));

    const at = new Date('2026-05-28T18:00:00Z'); // local 2026-05-29, UTC 2026-05-28
    const out = walk(join(mem, 'day-seed.md'), { memoriesDir: mem, hops: 1, today: null, now: at });
    assert.equal(out.some((c) => c.unit_id === 'edge-of-day'), true,
      'a fact invalid from 2026-05-29 is still valid at 2026-05-28Z, whatever the local calendar says');
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- No option promises intent-conditioned traversal ---
//
// `--intent` was parsed, split, and passed into walk(), which immediately renamed it
// as intentionally unused. Nothing in scoring, pruning, or ordering ever read it, so
// the option promised a conditioned traversal the walk does not perform.

function capturedStderr(fn) {
  const orig = process.stderr.write;
  const chunks = [];
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  try { return [fn(), chunks.join('')]; } finally { process.stderr.write = orig; }
}

test('the CLI does not advertise an intent option, and rejects one rather than reading it as the seed', () => {
  const [code, err] = capturedStderr(() => graphWalkMain(['--intent', 'memory-architecture', '/nope/seed.md']));
  assert.equal(code, 2);
  assert.match(err, /unrecognized/i);
  assert.doesNotMatch(err, /seed unit not found/, 'the flag value must never slide into the seed slot');
});

test('walk() takes no sessionTopics option', () => {
  const src = readFileSync(new URL('../../plugins/core/skills/core/scripts/graph-walk.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /sessionTopics/, 'no vestigial intent parameter remains');
  assert.doesNotMatch(src, /--intent/, 'no vestigial intent flag remains');
});
