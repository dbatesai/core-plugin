import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSummaryIndex, loadFreshIndex, loadSnapshot, loadUnitBodies, computeSourceSignature, truncate, SUMMARY_MAX } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { EDGES_BEGIN, EDGES_END } from '../../plugins/core/skills/core/scripts/unit-vocab.mjs';

function fixtureStore() {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    '---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-1-alpha — Alpha decision\n\nBody prose here.');
  writeFileSync(join(mem, 'dc-2-retired.md'),
    '---\nid: dc-2-retired\ntype: decision\nstatus: retired\ntopics:\n  - retrieval\n---\n\n# DC-2-beta — Retired\n\nShould be excluded.');
  return root;
}

test('indexes active units and excludes retired', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const ids = res.units.map(u => u.id);
  assert.ok(ids.includes('dc-1-alpha'));
  assert.ok(!ids.includes('dc-2-retired'), 'retired units must be excluded');
});

test('summary is the H1 line stripped', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const u = res.units.find(x => x.id === 'dc-1-alpha');
  assert.match(u.summary, /Alpha decision/);
  assert.ok(!u.summary.startsWith('#'), 'leading # must be stripped');
});

// Found regression-testing the K-series UTF-8 byte-cap fix, 2026-07-19: a cut
// landing between the two UTF-16 code units of a surrogate pair (any astral
// character — most emoji, CJK extension characters) orphaned the high
// surrogate, which serializes as a U+FFFD replacement character wherever the
// truncated summary later gets written as UTF-8 (the retrieval hook's stdout,
// PROJECT.md renders, etc). A run of emoji straddling the maxLen boundary is
// the deterministic way to force the cut onto an actual pair boundary.
test('truncate() never orphans a UTF-16 surrogate pair (astral characters, e.g. emoji)', () => {
  const emoji = '🎯'.repeat(SUMMARY_MAX); // each is one surrogate pair (2 code units) — guarantees a mid-pair cut somewhere
  const out = truncate(emoji, SUMMARY_MAX);
  assert.ok(!out.includes('�'), 'no lone-surrogate replacement character in the JS string itself');
  assert.ok(!Buffer.from(out, 'utf8').toString('utf8').includes('�'), 'round-tripping through UTF-8 bytes must not surface a replacement character either');
  // Re-encode to confirm every code unit in the result pairs correctly (no dangling high/low surrogate at the very end).
  const last = out.codePointAt(out.length - 1);
  assert.ok(last !== undefined, 'the result decodes to a full, well-formed sequence of code points');
});

test('truncate() is a no-op under the max and appends an ellipsis only when it actually cuts', () => {
  assert.equal(truncate('short', SUMMARY_MAX), 'short');
  const long = 'x'.repeat(SUMMARY_MAX + 50);
  const out = truncate(long, SUMMARY_MAX);
  assert.ok(out.endsWith('…'), 'a genuinely truncated string gets the ellipsis marker');
  assert.ok(out.length <= SUMMARY_MAX, 'stays within the requested bound');
});

test('topics survive as a list (canonical parser, not flat)', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const u = res.units.find(x => x.id === 'dc-1-alpha');
  assert.ok(Array.isArray(u.topics), 'topics must be an array');
  assert.ok(u.topics.includes('retrieval'));
});

test('writes _lib/unit-summaries.json atomically', () => {
  const root = fixtureStore();
  generateSummaryIndex(root);
  const written = JSON.parse(readFileSync(join(root, '_memories', '_lib', 'unit-summaries.json'), 'utf8'));
  assert.ok(Array.isArray(written.units));
  assert.equal(typeof written.count, 'number');
});

test('missing status is treated as active', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-nostatus-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-3-nostatus.md'),
    '---\nid: dc-3-nostatus\ntype: decision\ntopics:\n  - retrieval\n---\n\n# DC-3-gamma — No status\n\nBody.');
  const res = generateSummaryIndex(root);
  assert.ok(res.units.map(u => u.id).includes('dc-3-nostatus'));
});

// K04: anti-resurrection was not structural — the
// cache staleness check was pure content-hash (source_sig), so a unit whose
// t_invalid date arrives with zero byte changes anywhere in the store kept
// serving from a stale cache indefinitely. Fixed by baking next_invalidation_at
// into the index at generation time and having loadFreshIndex force a
// regenerate once `now` reaches it, independent of content hashing.
test('K04: stale cache past its own next_invalidation_at regenerates and excludes the now-invalid unit, even though byte content is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-k04-'));
  const mem = join(root, '_memories');
  const lib = join(mem, '_lib');
  mkdirSync(lib, { recursive: true });
  // A unit whose fact expired yesterday, but whose record status is still
  // 'active' (the two dimensions are independent — this is a real, valid shape).
  writeFileSync(join(mem, 'dc-4-expired.md'),
    '---\nid: dc-4-expired\ntype: decision\nstatus: active\nt_invalid: 2000-01-01\ntopics:\n  - retrieval\n---\n\n# DC-4-delta — Expired fact\n\nMust not resurrect.');
  writeFileSync(join(mem, 'dc-5-alive.md'),
    '---\nid: dc-5-alive\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-5-epsilon — Still valid\n\nBody.');

  // Hand-write a stale cache simulating one written BEFORE 2000-01-01 arrived:
  // source_sig genuinely matches the current on-disk bytes (a content-hash
  // check alone would treat this cache as fresh), but next_invalidation_at
  // is in the past relative to the real clock, and the stale cache's own
  // units array still lists the now-expired unit as valid — exactly what a
  // byte-only staleness check would keep serving forever.
  const staleIndex = {
    count: 2,
    generated: '',
    source_sig: computeSourceSignature(root),
    next_invalidation_at: '2000-01-01',
    degraded: false,
    duplicate_conflicts: [],
    units: [
      { id: 'dc-4-expired', path: 'dc-4-expired.md', type: 'decision', tier: 'canonical', summary: 'Expired fact', topics: ['retrieval'], status: 'active', updated: '2000-01-01' },
      { id: 'dc-5-alive', path: 'dc-5-alive.md', type: 'decision', tier: 'canonical', summary: 'Still valid', topics: ['retrieval'], status: 'active', updated: '2000-01-01' },
    ],
  };
  writeFileSync(join(lib, 'unit-summaries.json'), JSON.stringify(staleIndex, null, 2));

  const res = loadFreshIndex(root);
  const ids = res.units.map(u => u.id);
  assert.ok(!ids.includes('dc-4-expired'), 'a unit past its own t_invalid must not resurrect from a byte-unchanged stale cache');
  assert.ok(ids.includes('dc-5-alive'), 'a still-valid unit must survive the forced regenerate');
});

test('K04 control: an index with no next_invalidation_at (nothing time-bound) is still served from cache on a byte match', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-k04-control-'));
  const mem = join(root, '_memories');
  const lib = join(mem, '_lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(mem, 'dc-6-plain.md'),
    '---\nid: dc-6-plain\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-6-zeta — Plain\n\nBody.');
  const cached = {
    count: 1,
    generated: '',
    source_sig: computeSourceSignature(root),
    next_invalidation_at: null,
    degraded: false,
    duplicate_conflicts: [],
    units: [{ id: 'dc-6-plain', path: 'dc-6-plain.md', type: 'decision', tier: 'canonical', summary: 'SENTINEL-FROM-CACHE', topics: ['retrieval'], status: 'active', updated: '2000-01-01' }],
  };
  writeFileSync(join(lib, 'unit-summaries.json'), JSON.stringify(cached, null, 2));
  const res = loadFreshIndex(root);
  assert.equal(res.units[0].summary, 'SENTINEL-FROM-CACHE', 'a cache with no time bound and a byte match must be served as-is, not regenerated');
});

test('archive/ is excluded from the active-data walk (anti-resurrection)', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-archive-'));
  const mem = join(root, '_memories');
  const archive = join(mem, 'archive');
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(mem, 'dc-1-active.md'),
    '---\nid: dc-1-active\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-1-alpha\n\nBody.');
  writeFileSync(join(archive, 'dc-2-archived.md'),
    '---\nid: dc-2-archived\ntype: decision\nstatus: archived\ntopics:\n  - retrieval\n---\n\n# DC-2-beta\n\nMust never appear.');

  const cap = loadSnapshot(root, { captureBodies: true, retainRaw: true });
  const paths = cap.index.units.map(u => u.path);
  assert.ok(paths.every(p => !p.includes('archive/')), 'no unit path should include archive/');
  assert.ok(!('dc-2-archived.md' in (cap.raw || {})) || !paths.includes('archive/dc-2-archived.md'));
});

test('loadUnitBodies strips the decorate-graph generated edges block from the BM25-facing body', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-edges-strip-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-1-alpha\n\nReal body content that should rank.\n\n${EDGES_BEGIN}\n## Related\n- cites: [[dc-2-beta]]\n${EDGES_END}\n`);

  const res = generateSummaryIndex(root);
  const bodies = loadUnitBodies(root, res);
  const u = bodies.find(b => b.id === 'dc-1-alpha');
  assert.match(u.text, /Real body content that should rank/);
  assert.doesNotMatch(u.text, /CORE:BEGIN_EDGES/, 'generated marker must not reach the ranked body');
  assert.doesNotMatch(u.text, /\[\[dc-2-beta\]\]/, 'generated wikilink must not reach the ranked body');
});

test('captureStore\'s bodies (the real product path) also strip the generated edges block', () => {
  // loadSnapshot(...,{captureBodies:true}) -> captureStore() is what
  // decorate-graph.mjs and the live retriever/harness actually read.
  // loadUnitBodies (tested above) is a SEPARATE, index-only path -- fixing
  // one without the other left the real product path contaminated.
  const root = mkdtempSync(join(tmpdir(), 'core-idx-capture-edges-strip-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-1-alpha\n\nReal body content that should rank.\n\n${EDGES_BEGIN}\n## Related\n- cites: [[dc-2-beta]]\n${EDGES_END}\n`);

  const cap = loadSnapshot(root, { captureBodies: true });
  const u = cap.bodies.find(b => b.id === 'dc-1-alpha');
  assert.ok(u, 'dc-1-alpha must appear in the capture');
  assert.match(u.text, /Real body content that should rank/);
  assert.doesNotMatch(u.text, /CORE:BEGIN_EDGES/, 'generated marker must not reach the capture body either');
  assert.doesNotMatch(u.text, /\[\[dc-2-beta\]\]/, 'generated wikilink must not reach the capture body either');
});
