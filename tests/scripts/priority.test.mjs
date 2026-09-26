import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Validity predicates now live in priority.mjs (the canonical unit module) per the
// 2026-06-02 validity-dimension consolidation — increment 2. These imports failing
// would mean the consolidation regressed (predicates moved back out, or never landed).
import {
  effectiveValidity, validAt, isInvalidated, parseIsoDate,
  parseFrontmatter, normalizeNewlines, _todayFromArg,
  rankUnits, main as priorityMain, iterArchivedUnits, iterUnits,
  score, signalS, NO_SOURCES_DEFAULT_S,
} from '../../plugins/core/skills/core/scripts/priority.mjs';

test('a malformed --today falls back to today, never null (no TypeError at toISOString)', () => {
  const d = _todayFromArg('garbage');
  assert.ok(d instanceof Date, 'returns a Date, not null');
  assert.doesNotThrow(() => d.toISOString(), 'the display path can stamp it');
  // a well-formed date still parses through
  assert.equal(_todayFromArg('2026-03-01').toISOString().slice(0, 10), '2026-03-01');
});
// bitemporal.mjs must re-export the same functions so its CLI + existing importers keep working.
import {
  effectiveValidity as biEffectiveValidity,
  isInvalidated as biIsInvalidated,
} from '../../plugins/core/skills/core/scripts/bitemporal.mjs';

const u = (fm) => ({ fm });

test('predicates are exported from priority.mjs (canonical home)', () => {
  assert.equal(typeof effectiveValidity, 'function');
  assert.equal(typeof validAt, 'function');
  assert.equal(typeof isInvalidated, 'function');
});

test('bitemporal.mjs re-exports the SAME function objects (one definition, not a copy)', () => {
  assert.equal(biEffectiveValidity, effectiveValidity);
  assert.equal(biIsInvalidated, isInvalidated);
});

test('effectiveValidity defaults t_valid to created, leaves t_invalid open', () => {
  assert.deepEqual(effectiveValidity(u({ created: '2026-01-01' })), { t_valid: '2026-01-01', t_invalid: null });
});

test('effectiveValidity honors explicit t_valid / t_invalid (the overlay world-time case)', () => {
  assert.deepEqual(
    effectiveValidity(u({ created: '2026-01-01', t_valid: '2025-06-01', t_invalid: '2026-03-01' })),
    { t_valid: '2025-06-01', t_invalid: '2026-03-01' },
  );
});

test('validAt: inside the interval is valid; before t_valid and at/after t_invalid are not', () => {
  const unit = u({ t_valid: '2026-01-01', t_invalid: '2026-06-01' });
  assert.equal(validAt(unit, '2026-03-01'), true);
  assert.equal(validAt(unit, '2025-12-31'), false);   // before t_valid
  assert.equal(validAt(unit, '2026-06-01'), false);    // at t_invalid (half-open)
});

test('validAt: open interval (no t_invalid) is valid for any date >= t_valid', () => {
  assert.equal(validAt(u({ created: '2026-01-01' }), '2030-01-01'), true);
});

test('isInvalidated: true once t_invalid is at/before today, false while open', () => {
  const today = parseIsoDate('2026-06-02');
  assert.equal(isInvalidated(u({ t_invalid: '2026-05-01' }), today), true);
  assert.equal(isInvalidated(u({ t_invalid: '2026-07-01' }), today), false);
  assert.equal(isInvalidated(u({ created: '2026-01-01' }), today), false);
});

// ---------- CRLF tolerance ----------

test('parseFrontmatter parses a CRLF unit the same as an LF unit', () => {
  const lf = '---\nid: x\ntype: decision\ncreated: 2026-01-01\n---\n\nbody line';
  const crlf = lf.replace(/\n/g, '\r\n');
  const [fmLf] = parseFrontmatter(lf);
  const [fmCrlf, bodyCrlf] = parseFrontmatter(crlf);
  // The CRLF delimiter must still be detected and values must not carry a trailing \r.
  assert.equal(fmCrlf.id, 'x');
  assert.equal(fmCrlf.type, 'decision');
  assert.equal(fmCrlf.created, '2026-01-01', 'value has no trailing \\r');
  assert.deepEqual(fmCrlf, fmLf);
  assert.ok(!bodyCrlf.includes('\r'), 'body normalized to LF');
});

// ---------- indent-0 list continuation (PyYAML default block style) ----------
// A generic YAML dumper's default block style writes list items at the SAME
// indent as the parent key (`edges:\n- type: cites\n  target: x`), not indented
// under it. Confirmed live: a cross-session peer normalizing legacy edge shorthand
// with PyYAML hit this and nearly shipped 48 units with silently emptied edges.
test('parseFrontmatter accepts indent-0 list continuation lines (PyYAML block style), not just indented ones', () => {
  const pyyamlStyle = '---\nid: x\nedges:\n- type: cites\n  target: some-unit\ntopics:\n- foo\n- bar\n---\n\nbody';
  const [fm] = parseFrontmatter(pyyamlStyle);
  assert.deepEqual(fm.edges, [{ type: 'cites', target: 'some-unit' }], 'edges must not silently empty');
  assert.deepEqual(fm.topics, ['foo', 'bar'], 'topics must not silently empty');
  assert.equal(fm['- type'], undefined, 'a list-continuation line must never become a bogus top-level key');
});

test('parseFrontmatter still parses the project convention (2-space-indented list items) the same as before', () => {
  const indented = '---\nid: x\nedges:\n  - {type: cites, target: some-unit}\ntopics:\n  - foo\n  - bar\n---\n\nbody';
  const [fm] = parseFrontmatter(indented);
  assert.deepEqual(fm.edges, [{ type: 'cites', target: 'some-unit' }]);
  assert.deepEqual(fm.topics, ['foo', 'bar']);
});

test('normalizeNewlines collapses CRLF and lone CR to LF; passes non-strings through', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(normalizeNewlines(null), null);
});

// ---------- suppression invariant + malformed-frontmatter surfacing ----------

function rankVault() {
  const dir = mkdtempSync(join(tmpdir(), 'priority-rank-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-live.md'),
    '---\nid: dc-live\ntype: decision\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n\n# live\n');
  writeFileSync(join(mem, 'dc-dead.md'),
    '---\nid: dc-dead\ntype: decision\nstatus: superseded\ncreated: 2026-01-01\nupdated: 2026-06-01\nt_invalid: 2026-03-01\ntopics: [a]\n---\n\n# dead\n');
  return { dir, mem };
}

function quiet(stream, fn) {
  const orig = stream.write;
  const chunks = [];
  stream.write = (c) => { chunks.push(String(c)); return true; };
  try { return [fn(), chunks.join('')]; } finally { stream.write = orig; }
}

test('rankUnits excludes invalidated units by default', () => {
  const { dir, mem } = rankVault();
  try {
    const ids = rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id);
    assert.ok(ids.includes('dc-live'));
    assert.ok(!ids.includes('dc-dead'), 't_invalid in the past must suppress the unit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('includeInvalidated:true ranks cold history', () => {
  const { dir, mem } = rankVault();
  try {
    const ids = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true }).map(([, u]) => u.id);
    assert.ok(ids.includes('dc-dead'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the CLI ranking inherits the filter (invalidated id absent from --top output)', () => {
  const { dir, mem } = rankVault();
  try {
    const [, out] = quiet(process.stdout, () => priorityMain([mem, '--today', '2026-06-09', '--top', '10']));
    assert.match(out, /dc-live/);
    assert.doesNotMatch(out, /dc-dead/, 'main() must not rank an invalidated unit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('iterArchivedUnits: returns units physically relocated to archive/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-'));
  try {
    const mem = join(dir, '_memories');
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'risk-1-archived.md'),
      '---\nid: risk-1-archived\ntype: risk\nstatus: active\narchived: true\narchived_at: 2026-05-30\ncreated: 2026-01-01\nupdated: 2026-01-01\ntopics: [a]\n---\n\n# archived\n');
    const units = iterArchivedUnits(mem);
    assert.deepEqual(units.map(u => u.id), ['risk-1-archived']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('iterArchivedUnits: no archive/ subdir at all returns empty, not a throw (ENOENT-only tolerance)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-absent-'));
  try {
    const mem = join(dir, '_memories');
    mkdirSync(mem, { recursive: true });
    assert.deepEqual(iterArchivedUnits(mem), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("iterArchivedUnits: malformed (frontmatter-less) archive content is excluded, not ranked", () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-malformed-'));
  try {
    const mem = join(dir, '_memories');
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'broken.md'), 'no frontmatter here at all\n');
    const units = iterArchivedUnits(mem);
    const broken = units.find(u => u.id === 'broken');
    assert.ok(broken && broken.fm._load_error, 'malformed archive unit is tagged _load_error, same as a top-level malformed unit');
    const ranked = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true });
    assert.ok(ranked.every(([, u]) => u.id !== 'broken'), 'malformed archive unit must not appear in ranked output');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('includeInvalidated:true reaches a unit physically relocated to archive/', () => {
  const { dir, mem } = rankVault();
  try {
    mkdirSync(join(mem, 'archive'), { recursive: true });
    writeFileSync(join(mem, 'archive', 'dc-relocated.md'),
      '---\nid: dc-relocated\ntype: decision\nstatus: active\narchived: true\narchived_at: 2026-05-30\ncreated: 2026-01-01\nupdated: 2026-01-01\ntopics: [a]\n---\n\n# relocated\n');
    const withInvalid = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true }).map(([, u]) => u.id);
    assert.ok(withInvalid.includes('dc-relocated'), 'an archived unit must still be reachable via includeInvalidated');
    const withoutInvalid = rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id);
    assert.ok(!withoutInvalid.includes('dc-relocated'), 'default ranking still excludes archive/ entirely');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a frontmatter-less unit is excluded from ranking and warned to stderr', () => {
  const { dir, mem } = rankVault();
  try {
    writeFileSync(join(mem, 'broken.md'), '---\nid: broken\nNO CLOSING FENCE\n');
    const [ids, errOut] = quiet(process.stderr, () =>
      rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id));
    assert.ok(!ids.includes('broken'), 'damaged unit must not rank on default scores');
    assert.match(errOut, /broken\.md.*no parseable frontmatter/, 'the damage is surfaced, not swallowed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- priority scoring calibration ----------

test('no-sources units score S=0.3 — below summary-sourced, above transcript', () => {
  assert.equal(NO_SOURCES_DEFAULT_S, 0.3);
  assert.equal(signalS({ fm: {} }), 0.3, 'unknown provenance no longer ties with summary');
  assert.equal(signalS({ fm: { sources: ['summary-2026-06-01.md'] } }), 0.5, 'explicit summary still 0.5');
});

test('scalar sources string coerces to a single-element list — not the no-sources default', () => {
  assert.equal(signalS({ fm: { sources: 'PROJECT.md' } }), 1.0,
    'a scalar `sources: PROJECT.md` must score as one PROJECT.md source, not S=0.3');
  assert.equal(signalS({ fm: { sources: 'summary-2026-06-01.md' } }), 0.5,
    'a scalar summary source scores the summary tier');
  assert.equal(signalS({ fm: { sources: '' } }), NO_SOURCES_DEFAULT_S,
    'an empty-string scalar still scores the no-sources default');
});

test('pinned:false is neutral — identical score to an unpinned unit (decided behavior)', () => {
  const today = parseIsoDate('2026-06-09');
  const base = { fm: { created: '2026-06-01', topics: ['a'] } };
  const pinnedFalse = { fm: { created: '2026-06-01', topics: ['a'], pinned: false } };
  assert.equal(score(pinnedFalse, [], today), score(base, [], today));
});

test('signalS: both agent-profile and the legacy dm-profile source paths score as configuration', () => {
  const modern = signalS({ fm: { sources: ['~/.core/agent-profile.md'] } });
  const legacy = signalS({ fm: { sources: ['~/.core/dm-profile.md'] } });
  assert.equal(modern, legacy, 'renamed profile path must not change a unit\'s provenance score');
  assert.ok(modern > NO_SOURCES_DEFAULT_S, 'profile-sourced units outrank unknown provenance');
});

// Reviewer-supplied synthetic control (files repo receipt codex-to-all-20260915T195633Z). Acceptance test for the
// bounded ranking-population repair: nested active notes must rank; archive exclusion, retired suppression,
// explicit history, and per-turn retrieval must keep their current behavior. Red on 3.17.1 at the last assertion only.
test('ranking population: nested active observation ranks; archive/retired exclusions and explicit history preserved (reviewer check-ranking)', async () => {
  const { retrieveContext } = await import('../../plugins/core/skills/core/scripts/retrieve-context.mjs');
  const project = mkdtempSync(join(tmpdir(), 'ranking-population-'));
  const mem = join(project, '_memories');
  try {
    for (const dir of ['', 'observations/2026-09', 'archive']) mkdirSync(join(mem, dir), { recursive: true });
    for (const [file, id, state, type] of [
      ['dc-root.md', 'root', 'active', 'decision'],
      ['observations/2026-09/obs-nested.md', 'nested', 'active', 'observation'],
      ['dc-retired.md', 'retired', 'retired', 'decision'],
      ['archive/dc-archived.md', 'archived', 'active', 'decision'],
    ]) writeFileSync(join(mem, file), `---\nid: ${id}\ntype: ${type}\nstatus: ${state}\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [recovery]\n---\n# Recovery ${id}\nSynthetic recovery constraint.\n`);
    const ranked = rankUnits(mem).map(([, u]) => u.id).sort();
    const historical = rankUnits(mem, { includeInvalidated: true }).map(([, u]) => u.id).sort();
    const retrieved = retrieveContext('recovery', project, { topN: 10 }).map(u => u.id).sort();
    assert.ok(ranked.includes('root'), 'Root active control must rank');
    assert.ok(!ranked.includes('retired'), 'Retired control must stay excluded');
    assert.ok(!ranked.includes('archived'), 'Archive path must stay excluded even with active status');
    assert.ok(historical.includes('archived'), 'Explicit history must still reach the archive');
    assert.deepEqual(retrieved, ['nested', 'root'], 'Per-turn retrieval must reach nested active notes and preserve exclusions');
    assert.ok(ranked.includes('nested'), 'DEFECT: nested active observation is absent from priority ranking');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('ranking population: an unreadable nested unit lands on the skipped list and in the excluded counts, never silently vanishes', { skip: process.platform === 'win32' ? 'chmod has no effect on win32; the read-failure control needs a POSIX mode bit' : false }, () => {
  const project = mkdtempSync(join(tmpdir(), 'ranking-unreadable-'));
  const mem = join(project, '_memories');
  const nested = join(mem, 'observations', '2026-09');
  const locked = join(nested, 'obs-locked.md');
  try {
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(mem, 'dc-root.md'), '---\nid: root\ntype: decision\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# root\n');
    writeFileSync(locked, '---\nid: locked\ntype: observation\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# locked\n');
    chmodSync(locked, 0o000);
    const units = iterUnits(mem);
    assert.deepEqual(units.map(u => u.id), ['root'], 'the unreadable unit is not loaded');
    assert.equal(units.skipped.length, 1, 'the unreadable unit is on the skipped list');
    assert.equal(units.skipped[0].path, locked, 'skipped entry carries the native absolute path');
    const ranked = rankUnits(mem, { today: parseIsoDate('2026-09-15') });
    assert.equal(ranked.excluded.unreadable, 1, 'rankUnits reports the unreadable count');
    assert.equal(ranked.excluded.read, 1, 'rankUnits reports how many it actually read');
  } finally { try { chmodSync(locked, 0o644); } catch {} rmSync(project, { recursive: true, force: true }); }
});

test('ranking population: the path iterUnits returns for a nested unit is the state-cache key shape — a stamp on it is found by the consumer lookup', async () => {
  const { stampFile, readProjectCache } = await import('../../plugins/core/skills/core/scripts/state-cache.mjs');
  const project = mkdtempSync(join(tmpdir(), 'ranking-cache-key-'));
  const home = mkdtempSync(join(tmpdir(), 'ranking-cache-home-'));
  const mem = join(project, '_memories');
  try {
    mkdirSync(join(mem, 'observations', '2026-09'), { recursive: true });
    mkdirSync(join(mem, '_lib'), { recursive: true });
    writeFileSync(join(mem, 'observations', '2026-09', 'obs-nested.md'), '---\nid: nested\ntype: observation\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# nested\n');
    const [u] = iterUnits(mem);
    assert.equal(u.id, 'nested');
    stampFile(project, u.path, 'deadbeef', 'test', { home });
    const cache = readProjectCache(project);
    assert.ok(cache.files[u.path], 'the consumer finds the nested unit under the exact path the walk returned');
    assert.ok(!cache.files[u.path.replace(/\\/g, '/')] || u.path === u.path.replace(/\\/g, '/'), 'no second, normalized identity was introduced');
  } finally { rmSync(project, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

// Fault-injected subtree (reviewer-supplied shape, files repo receipt codex-to-all-20260915T222006Z): a directory that
// will not list must be reported as unreadable by the ranker and by both downstream consumers, in live and history modes.
for (const history of [false, true]) test(`ranking coverage: an unlistable ${history ? 'archive' : 'live'} subtree is reported by rankUnits, the memory-index block, and hot-section candidates`, async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { renderPriorityBlock } = await import('../../plugins/core/skills/core/scripts/generate-memory-index.mjs');
  const { candidatesForSynthesis } = await import('../../plugins/core/skills/core/scripts/hot-section.mjs');
  const project = mkdtempSync(join(tmpdir(), 'ranking-coverage-'));
  const mem = join(project, '_memories'), blocked = join(mem, history ? 'archive' : 'observations', '2026-09');
  const realReaddir = fs.readdirSync, realStderr = process.stderr.write;
  try {
    mkdirSync(blocked, { recursive: true });
    const note = id => `---\nid: ${id}\ntype: observation\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# ${id}\n`;
    writeFileSync(join(mem, 'root.md'), note('root')); writeFileSync(join(blocked, 'nested.md'), note('nested'));
    assert.deepEqual(rankUnits(mem, { includeInvalidated: history, today: parseIsoDate('2026-09-15') }).map(([, u]) => u.id).sort(), ['nested', 'root'], 'positive control: both rank before the fault');
    fs.readdirSync = (p, ...a) => { if (String(p) === blocked) throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); return realReaddir(p, ...a); };
    syncBuiltinESMExports();
    let err = ''; process.stderr.write = (c) => { err += c; return true; };
    const ranked = rankUnits(mem, { includeInvalidated: history, today: parseIsoDate('2026-09-15') });
    assert.deepEqual(ranked.map(([, u]) => u.id), ['root']);
    assert.equal(ranked.excluded.unreadable, 1, 'the unlistable subtree is counted as unreadable');
    assert.equal(ranked.excluded.skipped[0].kind, 'directory');
    assert.match(err, /failed to list/, 'the failed subtree is warned on stderr');
    if (!history) {
      const block = renderPriorityBlock({ memoriesDir: mem, topN: 10, today: new Date('2026-09-15'), existingDescriptions: new Map() });
      assert.match(block, /Coverage incomplete: 1 path\(s\) could not be read — _memories\/observations\/2026-09 \(EACCES\)/, 'the memory-index block names the unread path');
      const cands = candidatesForSynthesis(project, { today: new Date('2026-09-15') });
      assert.deepEqual(cands.map(c => c.id), ['root']);
      assert.equal(cands.skipped.length, 1, 'hot-section candidates carry the skip evidence');
    }
  } finally { fs.readdirSync = realReaddir; syncBuiltinESMExports(); process.stderr.write = realStderr; rmSync(project, { recursive: true, force: true }); }
});

test('ranking coverage: excluded-by-status is broken out by status value', () => {
  const project = mkdtempSync(join(tmpdir(), 'ranking-bystatus-'));
  const mem = join(project, '_memories');
  try {
    mkdirSync(join(mem, 'observations', '2026-06'), { recursive: true });
    const note = (id, status) => `---\nid: ${id}\ntype: observation\nstatus: ${status}\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n# ${id}\n`;
    writeFileSync(join(mem, 'a.md'), note('a', 'active')); writeFileSync(join(mem, 'r.md'), note('r', 'retired'));
    writeFileSync(join(mem, 'observations', '2026-06', 'x.md'), note('x', 'archived')); writeFileSync(join(mem, 'observations', '2026-06', 'y.md'), note('y', 'archived'));
    const ranked = rankUnits(mem, { today: parseIsoDate('2026-09-15') });
    assert.deepEqual(ranked.map(([, u]) => u.id), ['a']);
    assert.deepEqual(ranked.excluded.byStatus, { archived: 2, retired: 1 });
    assert.equal(ranked.excluded.read, 4);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('ranking coverage: when the only unit sits under an unlistable subtree, hot-section candidates are empty but still carry the skip evidence (reviewer no-root case)', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { candidatesForSynthesis, main: hotMain } = await import('../../plugins/core/skills/core/scripts/hot-section.mjs');
  const project = mkdtempSync(join(tmpdir(), 'ranking-noroot-'));
  const mem = join(project, '_memories'), blocked = join(mem, 'observations', '2026-09');
  const realReaddir = fs.readdirSync, realStderr = process.stderr.write, realStdout = process.stdout.write;
  try {
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, 'nested.md'), '---\nid: nested\ntype: observation\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# nested\n');
    assert.deepEqual(candidatesForSynthesis(project, { today: new Date('2026-09-15') }).map(c => c.id), ['nested'], 'positive control');
    fs.readdirSync = (p, ...a) => { if (String(p) === blocked) throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); return realReaddir(p, ...a); };
    syncBuiltinESMExports();
    process.stderr.write = () => true; let out = ''; process.stdout.write = (c) => { out += c; return true; };
    const cands = candidatesForSynthesis(project, { today: new Date('2026-09-15') });
    assert.deepEqual(cands, []);
    assert.equal(cands.skipped.length, 1, 'empty result still names the unread subtree');
    const exit = hotMain(['candidates', project, '--json']);
    assert.equal(exit, 0);
    assert.equal(JSON.parse(out).coverage_incomplete.length, 1, 'JSON CLI keeps the evidence on the zero-candidate path');
  } finally { fs.readdirSync = realReaddir; syncBuiltinESMExports(); process.stderr.write = realStderr; process.stdout.write = realStdout; rmSync(project, { recursive: true, force: true }); }
});

test('ranking coverage: a symlink or junction inside the store is not followed and is recorded as skipped, reaching the CLI line, the memory-index block, and the candidates (Windows reviewer finding)', async () => {
  const { symlinkSync } = await import('node:fs');
  const { renderPriorityBlock } = await import('../../plugins/core/skills/core/scripts/generate-memory-index.mjs');
  const { candidatesForSynthesis } = await import('../../plugins/core/skills/core/scripts/hot-section.mjs');
  const project = mkdtempSync(join(tmpdir(), 'ranking-junction-'));
  const mem = join(project, '_memories'), real = join(project, 'elsewhere');
  const realStdout = process.stdout.write;
  try {
    mkdirSync(join(mem, 'observations', '2026-09'), { recursive: true }); mkdirSync(real, { recursive: true });
    const note = id => `---\nid: ${id}\ntype: observation\nstatus: active\ncreated: 2026-09-15\nupdated: 2026-09-15\ntopics: [a]\n---\n# ${id}\n`;
    writeFileSync(join(mem, 'observations', '2026-09', 'obs-real.md'), note('real'));
    writeFileSync(join(real, 'obs-behind-link.md'), note('behind-link'));
    symlinkSync(real, join(mem, 'linked'), 'junction');
    symlinkSync(mem, join(mem, 'observations', 'loop'), 'junction');
    const units = iterUnits(mem);
    assert.deepEqual(units.map(u => u.id), ['real'], 'the readable sibling ranks; nothing behind a link is loaded and the self-link does not loop');
    assert.deepEqual(units.skipped.map(s => [s.kind, s.reason]).sort(), [['link', 'symlink-or-junction-not-followed'], ['link', 'symlink-or-junction-not-followed']]);
    const ranked = rankUnits(mem, { today: parseIsoDate('2026-09-15') });
    assert.equal(ranked.excluded.unreadable, 2);
    const block = renderPriorityBlock({ memoriesDir: mem, topN: 10, today: new Date('2026-09-15'), existingDescriptions: new Map() });
    assert.match(block, /Coverage incomplete: 2 path\(s\)[^\n]*_memories\/linked \(symlink-or-junction-not-followed\)/);
    assert.equal(candidatesForSynthesis(project, { today: new Date('2026-09-15') }).skipped.length, 2);
    let out = ''; process.stdout.write = (c) => { out += c; return true; };
    priorityMain([mem, '--top', '1']);
    assert.match(out, /unreadable: 2/); assert.match(out, /COVERAGE INCOMPLETE:.*symlink-or-junction-not-followed/);
  } finally { process.stdout.write = realStdout; rmSync(project, { recursive: true, force: true }); }
});
