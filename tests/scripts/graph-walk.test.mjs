import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walk } from '../../plugins/core/skills/core/scripts/graph-walk.mjs';

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
  write('seed', { type: 'decision', created: '2026-05-25', sources: 'PROJECT.md' },
    [{ type: 'depends-on', target: 'a-valid' }, { type: 'supersedes', target: 'b-invalid' },
     { type: 'cites', target: 'obs-inbound-2026-05-20' }]);
  write('a-valid', { type: 'decision', created: '2026-05-25', sources: 'PROJECT.md' });
  // Recent created (high R·S so it survives the prune) but a PAST t_invalid — so
  // validity-suppression is the only reason it leaves the valid candidate set.
  write('b-invalid', { type: 'decision', created: '2026-05-25', t_invalid: '2026-05-28', sources: 'PROJECT.md' });
  // Observation unit in observations/<YYYY-MM>/ — invisible to the walk by
  // default, reachable only with includeObservations (SYN-007).
  const obsDir = join(mem, 'observations', '2026-05');
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, 'obs-inbound-2026-05-20.md'), [
    '---', 'id: obs-inbound-2026-05-20', 'type: observation',
    'created: 2026-05-25', 'sources: PROJECT.md',
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

const FM = { type: 'decision', created: '2026-05-25', sources: 'PROJECT.md' };

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
