/**
 * retrieval-premise.test.mjs — the v3.11 premise tests (Hale 2026-07-11 blockers).
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
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'nested-store');

const { generateSummaryIndex, loadFreshIndex, computeSourceSignature } = await import(join(SCRIPTS, 'generate-summary-index.mjs'));
const { bm25Rank, loadActiveBodies } = await import(join(SCRIPTS, 'bm25.mjs'));
const { retrieveContext, productRankedIds, productRankedScores } = await import(join(SCRIPTS, 'retrieve-context.mjs'));

// The committed fixture is read-only for tests; anything that mutates clones first.
function cloneStore() {
  const dir = mkdtempSync(join(tmpdir(), 'nested-store-'));
  cpSync(FIXT, dir, { recursive: true });
  return dir;
}

test('premise 1 — recursive coverage: the index carries nested units with real paths and tiers', () => {
  const idx = generateSummaryIndex(FIXT);
  const nested = idx.units.find(u => u.id === 'obs-nested-note');
  assert.ok(nested, 'nested observation is in the index');
  assert.equal(nested.path, 'observations/2026-07/obs-nested-note.md', 'index carries the real relative path');
  assert.equal(nested.tier, 'observation', 'raw capture is tier-labeled, not flattened');
  assert.equal(idx.units.find(u => u.id === 'dc-strong').tier, 'canonical');
});

test('premise 1 — a nested unit is findable by its body term through every retrieval surface', () => {
  assert.ok(bm25Rank('quokka incident', FIXT).includes('obs-nested-note'), 'bm25 finds the nested body term');
  assert.ok(productRankedIds('quokka incident', FIXT).includes('obs-nested-note'), 'product ranking finds it');
  const hits = retrieveContext('quokka incident', FIXT);
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
  const armIds = productRankedIds(q, FIXT);
  const direct = productRankedScores(q, FIXT).map(s => s.id);
  assert.deepEqual(armIds, direct, 'one function, two callers, identical ranking');
  // retrieveContext's direct (non-edge) hits come from the TOP of the product ranking,
  // in product order. (An edge hit may displace a weak direct hit from the final slice —
  // that's the restored one-hop semantic, not a divergence.)
  const hits = retrieveContext(q, FIXT, { topN: 2 });
  const directHits = hits.filter(h => h.id !== 'dc-neighbor').map(h => h.id);
  assert.deepEqual(directHits, armIds.slice(0, directHits.length),
    'direct hits are the product ranking\'s prefix');
});

test('premise 3 — one-hop edge expansion survives the default topN (the v3.10.0 regression)', () => {
  // dc-strong matches all three query terms; the weak units match one. dc-neighbor
  // shares NO vocabulary with the query and is reachable only through dc-strong's
  // edge. Under the synthetic rank scores this unit could never rank (repro'd:
  // v3.10 returned it at #2, the first union rewrite dropped it entirely).
  const hits = retrieveContext('alpha subsystem rollout', FIXT);
  const ids = hits.map(h => h.id);
  assert.ok(ids.includes('dc-neighbor'),
    `edge-connected neighbor must compete in the final ranking (got ${ids.join(', ')})`);
  assert.equal(ids[0], 'dc-strong', 'the strong direct hit still leads');
});

test('premise 4 — standalone bm25 cannot resurrect a retired unit through a stale cache', () => {
  const dir = cloneStore();
  try {
    // Build the cache while active, then retire the unit and call the STANDALONE
    // path again — the pre-remediation tree kept serving it (Hale §4).
    assert.ok(bm25Rank('quokka incident', dir).includes('obs-nested-note'), 'active unit ranks');
    const f = join(dir, '_memories', 'observations', '2026-07', 'obs-nested-note.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('status: active', 'status: retired'));
    assert.ok(!bm25Rank('quokka incident', dir).includes('obs-nested-note'), 'retired unit no longer ranks — standalone path is fresh');
    assert.ok(!loadActiveBodies(dir).some(b => b.id === 'obs-nested-note'), 'retired unit has no body in the population');
    assert.deepEqual(retrieveContext('quokka incident', dir), [], 'full retriever agrees');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
