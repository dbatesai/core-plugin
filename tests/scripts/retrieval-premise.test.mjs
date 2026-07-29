/**
 * retrieval-premise.test.mjs — the v3.11 premise tests.
 *
 * These test the CLAIMS, not just the code: (1) every eligible note — including
 * nested ones — is in the retrieval population; (2) the harness `live` arm is the
 * product ranking, rank for rank; (3) one-hop edge expansion survives the default
 * topN (the v3.10 regression); (4) no public entry point serves a stale cache
 * (retired-unit anti-resurrection on the standalone path). Each maps to a repro
 * that failed on the pre-remediation tree.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'nested-store');

const { runTierPolicySweep, validateGold } = await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);
const SAFETY = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'tier-safety-store');
const { generateSummaryIndex, loadFreshIndex, computeSourceSignature } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);
const { bm25Rank, loadActiveBodies } = await import(pathToFileURL(join(SCRIPTS, 'bm25.mjs')).href);
const { retrieveContext, productRankedIds, productRankedScores, applyTierPolicy } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);

// The committed fixture is NEVER touched by tests — even "read" paths write the
// cached index (_lib/unit-summaries.json) as a side effect, which polluted the
// committed tree and failed in read-only checkouts. Every test
// runs against a clone; STORE is the shared clone for non-mutating tests.
function cloneStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nested-store-'));
  cpSync(FIXT, dir, { recursive: true });
  return dir;
}
const STORE = cloneStore();
process.on('exit', () => { try { rmSync(STORE, { recursive: true, force: true }); } catch { /* tmpdir */ } });

test('premise 1 — recursive coverage: the index carries nested units with real paths and tiers', () => {
  const idx = generateSummaryIndex(STORE);
  const nested = idx.units.find(u => u.id === 'obs-nested-note');
  assert.ok(nested, 'nested observation is in the index');
  assert.equal(nested.path, 'observations/2026-07/obs-nested-note.md', 'index carries the real relative path');
  assert.equal(nested.tier, 'observation', 'raw capture is tier-labeled, not flattened');
  assert.equal(idx.units.find(u => u.id === 'dc-strong').tier, 'canonical');
});

test('premise 1 — a nested unit is findable by its body term through every retrieval surface', () => {
  assert.ok(bm25Rank('quokka incident', STORE).includes('obs-nested-note'), 'bm25 finds the nested body term');
  assert.ok(productRankedIds('quokka incident', STORE).includes('obs-nested-note'), 'product ranking finds it');
  const hits = retrieveContext('quokka incident', STORE);
  assert.ok(hits.some(h => h.id === 'obs-nested-note'), 'the live retriever surfaces it');
  assert.equal(hits.find(h => h.id === 'obs-nested-note').tier, 'observation', 'result carries its authority tier');
});

test('premise 1 — the source signature is recursive: a nested edit invalidates the cache', () => {
  const dir = cloneStore();
  try {
    loadFreshIndex(dir); // build cache
    const before = computeSourceSignature(dir);
    const f = join(dir, '_memories', 'observations', '2026-07', 'obs-nested-note.md');
    writeFileSync(f, readFileSync(f, 'utf8') + '\nEdited.\n');
    assert.notEqual(computeSourceSignature(dir), before, 'nested edit changes the signature');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('premise 2 — product/harness identity: the live arm IS retrieveContext\'s ranking, rank for rank', () => {
  const q = 'alpha subsystem rollout';
  const armIds = productRankedIds(q, STORE);
  const direct = productRankedScores(q, STORE).map(s => s.id);
  assert.deepEqual(armIds, direct, 'one function, two callers, identical ranking');
  // retrieveContext's direct (non-edge) hits come from the TOP of the product ranking,
  // in product order. (An edge hit may displace a weak direct hit from the final slice —
  // that's the restored one-hop semantic, not a divergence.)
  const hits = retrieveContext(q, STORE, { topN: 2 });
  const directHits = hits.filter(h => h.id !== 'dc-neighbor').map(h => h.id);
  assert.deepEqual(directHits, armIds.slice(0, directHits.length),
    'direct hits are the product ranking\'s prefix');
});

test('premise 3 — one-hop edge expansion survives the default topN (the v3.10.0 regression)', () => {
  // dc-strong matches all three query terms; the weak units match one. dc-neighbor
  // shares NO query vocabulary (guarded below — the first version of this fixture
  // leaked "alpha query" into the body, making the test pass on the BROKEN
  // baseline) and is reachable only through dc-strong's edge.
  // Red/green proven: these assertions FAIL at 0d00539 (neighbor absent) and pass here.
  const neighborBody = readFileSync(join(FIXT, '_memories', 'dc-neighbor.md'), 'utf8').toLowerCase();
  for (const term of ['alpha', 'subsystem', 'rollout']) {
    assert.ok(!neighborBody.includes(term), `fixture self-check: neighbor must not contain query term '${term}'`);
  }
  const hits = retrieveContext('alpha subsystem rollout', STORE);
  const ids = hits.map(h => h.id);
  assert.equal(ids[0], 'dc-strong', 'the strong direct hit leads');
  assert.equal(ids[1], 'dc-neighbor',
    `the edge neighbor of the strong hit must OUTRANK weak direct hits — the meaningful order, not mere presence (got ${ids.join(', ')})`);
});

test('premise 4b — PRESERVED-TIMESTAMP attack: a retire with its original mtime restored still invalidates (content-derived signature)', () => {
  // A unit rewritten as retired with its original timestamp restored left the
  // mtime signature stayed identical — the retired unit kept ranking. The signature
  // is content-derived now; timestamp equality can no longer certify content equality.
  const dir = cloneStore();
  try {
    assert.ok(bm25Rank('quokka incident', dir).includes('obs-nested-note'), 'active unit ranks (cache built)');
    const f = join(dir, '_memories', 'observations', '2026-07', 'obs-nested-note.md');
    const st = statSync(f);
    writeFileSync(f, readFileSync(f, 'utf8').replace('status: active', 'status: retired'));
    utimesSync(f, st.atime, st.mtime); // restore the original timestamps — the attack
    assert.ok(!bm25Rank('quokka incident', dir).includes('obs-nested-note'),
      'retired unit with restored mtime must NOT rank — content hash sees through it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate ids — an observation can never shadow canonical truth, and the store goes loudly degraded', () => {
  // First-wins let a nested observation (walks first) silently
  // discard a canonical unit with the same id. Resolution is authority-aware now,
  // and the conflict is recorded on the index (degraded flag) — never silent.
  const dir = cloneStore();
  try {
    // A nested observation claiming dc-strong's id — walk order would pick it first.
    writeFileSync(join(dir, '_memories', 'observations', '2026-07', 'imposter.md'),
      ['---', 'id: dc-strong', 'type: observation', 'status: active', 'created: 2026-07-06', 'topics: [misc]', 'edges: []', '---', '', '# Imposter observation', 'Shadowing attempt body.'].join('\n'));
    const idx = generateSummaryIndex(dir);
    const kept = idx.units.find(u => u.id === 'dc-strong');
    assert.equal(kept.tier, 'canonical', 'the canonical unit wins the id');
    assert.equal(kept.path, 'dc-strong.md', 'kept record points at the canonical file');
    assert.equal(idx.degraded, true, 'the index says loudly that the store is degraded');
    assert.equal(idx.duplicate_conflicts.length, 1);
    assert.ok(productRankedIds('alpha subsystem rollout', dir).includes('dc-strong'), 'canonical query still finds its unit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache validation covers EVERY record — a path stripped from a later record forces regeneration', () => {
  // loadFreshIndex validated only units[0].path; damaging a later
  // record left the cache accepted and the nested unit silently lost.
  const dir = cloneStore();
  try {
    loadFreshIndex(dir); // build a valid cache
    const cachePath = join(dir, '_memories', '_lib', 'unit-summaries.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    delete cache.units[cache.units.length - 1].path; // damage a LATER record
    writeFileSync(cachePath, JSON.stringify(cache));
    const reloaded = loadFreshIndex(dir);
    assert.ok(reloaded.units.every(u => typeof u.path === 'string' && u.path.length > 0),
      'damaged cache regenerated — every record carries a path again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tier policy — P0 is the identity control; P1/P2/P3 each do what they claim (v2 §7)', () => {
  // scored list: a strong observation, a near-tie canonical, a weak canonical.
  const scored = [
    { id: 'obs-a', tier: 'observation', score: 1.00 },
    { id: 'dc-b', tier: 'canonical', score: 0.97 },   // within default ε=0.05 of obs-a
    { id: 'obs-c', tier: 'observation', score: 0.90 },
    { id: 'dc-d', tier: 'canonical', score: 0.40 },
  ];
  // P0: unchanged (shipped default).
  assert.deepEqual(applyTierPolicy(scored, 'P0').map(u => u.id), ['obs-a', 'dc-b', 'obs-c', 'dc-d']);
  // P1: canonical wins the near-tie with obs-a (0.03 ≤ 0.05); obs-c stays below dc-b.
  assert.deepEqual(applyTierPolicy(scored, 'P1').map(u => u.id), ['dc-b', 'obs-a', 'obs-c', 'dc-d']);
  // P2 (topN=1): no canonical in top-1 → promote the best canonical (dc-b) to slot 0.
  assert.equal(applyTierPolicy(scored, 'P2', { topN: 1 })[0].id, 'dc-b');
  // P2 (topN=2): dc-b already in top-2 → no change.
  assert.deepEqual(applyTierPolicy(scored, 'P2', { topN: 2 }).map(u => u.id), ['obs-a', 'dc-b', 'obs-c', 'dc-d']);
  // P3 (w=0.5): obs halved → dc-b 0.97, obs-a 0.50, obs-c 0.45, dc-d 0.40.
  assert.deepEqual(applyTierPolicy(scored, 'P3', { weight: 0.5 }).map(u => u.id), ['dc-b', 'obs-a', 'obs-c', 'dc-d']);
  // input never mutated.
  assert.equal(scored[0].id, 'obs-a');
});

test('tier sweep — NON-TAUTOLOGICAL safety: no policy surfaces a retired strong-vocab unit', async () => {
  // The poison unit is RETIRED but present on disk with the strongest query vocab —
  // it would top the ranking if it weren't excluded. Every tier policy (incl. P2's
  // deeper slot reservation) operates on the active-only index, so it can never leak.
  // Non-tautological: the candidate is present at the stage under test, not pre-removed.
  const dir = mkdtempSync(join(tmpdir(), 'tier-safety-'));
  cpSync(SAFETY, dir, { recursive: true });
  try {
    const gold = JSON.parse(readFileSync(join(dir, '_tests-goldset.json'), 'utf8')).queries;
    const sweep = runTierPolicySweep(dir, gold);
    for (const p of sweep.perPolicy) {
      assert.equal(p.forbidden3, 0, `${p.policy} surfaced the retired poison unit — safety hole`);
    }
    // And directly: the retired unit is in no policy's final context.
    const { retrieveContext } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
    for (const policy of ['P0', 'P1', 'P2', 'P3']) {
      const ids = retrieveContext('gateway placement', dir, { topN: 3, tierPolicy: policy }).map(h => h.id);
      assert.ok(!ids.includes('dc-poison-retired'), `${policy} leaked the retired unit into final context`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('validateGold — rejects duplicate ids and non-array expected (completeness; strict rows)', () => {
  assert.throws(() => validateGold([{ id: 'a', query: 'q', rung: 'literal', expected: ['x'] }, { id: 'a', query: 'q', rung: 'literal', expected: ['x'] }]), /duplicate/);
  assert.throws(() => validateGold([{ id: 'a', query: 'q', rung: 'literal', expected: 'x' }]), /must be an array/);
  assert.throws(() => validateGold([]), /empty/);
  assert.ok(validateGold([{ id: 'a', query: 'q', rung: 'literal', expected: ['x'], forbidden: [] }]));
});

test('tier policy — default retrieveContext is byte-identical to explicit P0 (shipped behavior unchanged)', () => {
  const a = retrieveContext('alpha subsystem rollout', STORE);
  const b = retrieveContext('alpha subsystem rollout', STORE, { tierPolicy: 'P0' });
  assert.deepEqual(a.map(h => h.id), b.map(h => h.id), 'P0 default is the control');
});

test('premise 4 — standalone bm25 cannot resurrect a retired unit through a stale cache', () => {
  const dir = cloneStore();
  try {
    // Build the cache while active, then retire the unit and call the STANDALONE
    // path again — the pre-remediation tree kept serving it.
    assert.ok(bm25Rank('quokka incident', dir).includes('obs-nested-note'), 'active unit ranks');
    const f = join(dir, '_memories', 'observations', '2026-07', 'obs-nested-note.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('status: active', 'status: retired'));
    assert.ok(!bm25Rank('quokka incident', dir).includes('obs-nested-note'), 'retired unit no longer ranks — standalone path is fresh');
    assert.ok(!loadActiveBodies(dir).some(b => b.id === 'obs-nested-note'), 'retired unit has no body in the population');
    assert.deepEqual(retrieveContext('quokka incident', dir), [], 'full retriever agrees');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
