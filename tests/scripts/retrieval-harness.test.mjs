import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

const { recallAtK, firstRelevantRank, validateGold, assertKnownTiers, runTierPolicySweep, runHarness } =
  await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);
const { bm25Rank } = await import(pathToFileURL(join(SCRIPTS, 'bm25.mjs')).href);
const { lexicalRankedIds } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);

test('recallAtK: gold below K is a miss, at/above K is a hit', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f'];
  assert.strictEqual(recallAtK(ranked, ['d'], 3), 0, 'd at rank 4 not in top 3');
  assert.strictEqual(recallAtK(ranked, ['d'], 5), 1, 'd at rank 4 is in top 5');
  assert.strictEqual(recallAtK(ranked, ['a', 'c'], 5), 1, 'both golds in top 5');
  assert.strictEqual(recallAtK(ranked, ['a', 'z'], 5), 0.5, 'one of two golds present');
  assert.strictEqual(recallAtK(ranked, [], 5), null, 'no expected → null (excluded from mean)');
});

test('firstRelevantRank: 1-indexed rank of first hit, 0 when absent', () => {
  assert.strictEqual(firstRelevantRank(['x', 'y', 'z'], ['z']), 3);
  assert.strictEqual(firstRelevantRank(['x', 'y', 'z'], ['q']), 0);
});

test('bm25Rank: surfaces the lexically-obvious unit first, deterministic', () => {
  const r = bm25Rank('omega speedmaster', FIXT);
  assert.ok(Array.isArray(r), 'returns an array');
  assert.strictEqual(r[0], 'want-omega-speedmaster-on-sale-wait', 'body match ranks first');
  assert.deepStrictEqual(bm25Rank('omega speedmaster', FIXT), r, 'deterministic across runs');
});

test('lexicalRankedIds: returns a ranked id list (shipped scorer, no slice)', () => {
  const r = lexicalRankedIds('omega speedmaster', FIXT);
  assert.ok(Array.isArray(r) && r.length > 0);
  assert.ok(r.includes('want-omega-speedmaster-on-sale-wait'));
});

// (interleaveRanked deleted 2026-07-11 — no production caller after the
// normalized-magnitude ranking landed; a test kept alive for dead code would
// document a combiner the product doesn't have.)

// ── A5 strict evaluator (Train A; Crest corrections 2026-07-12) ──

test('A5 validateGold: empty expected without no_answer:true is rejected — zero silent skips', () => {
  assert.throws(() => validateGold([{ id: 'q1', query: 'something' }]), /no_answer/);
  assert.throws(() => validateGold([{ id: 'q1', query: 'something', expected: [] }]), /no_answer/);
  assert.ok(validateGold([{ id: 'q1', query: 'something', no_answer: true }]), 'declared absence is valid');
  assert.throws(() => validateGold([{ id: 'q1', query: 'something', expected: ['u1'], no_answer: true }]),
    /contradicts/, 'support + no_answer together is contradictory');
  assert.throws(() => validateGold([{ id: 'q1', expected: ['u1'] }]), /query text/, 'query text required');
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', expected: [''] }]), /non-empty strings/);
});

test('A5 assertKnownTiers: unknown authority tier fails closed in the evaluator', () => {
  assert.ok(assertKnownTiers({ units: [{ id: 'a', tier: 'canonical' }, { id: 'b', tier: 'observation' }, { id: 'c' }] }));
  assert.throws(() => assertKnownTiers({ units: [{ id: 'x', tier: 'mystery' }] }), /fails closed/);
});

test('A5 sweep: bands are per (query, gold) pair — multi-valued estimand preserved — and the sweep pins its snapshot', () => {
  const gold = [{
    id: 'multi', query: 'zz-nonexistent-token-zz',
    expected: ['ghost-unit-one', 'ghost-unit-two'], // never retrievable → both must band
    forbidden: [],
  }];
  const sweep = runTierPolicySweep(FIXT, gold);
  const multiBands = sweep.bands.filter(b => b.query === 'multi');
  assert.equal(multiBands.length, 2, 'one band row per missed gold, not first-support-only');
  assert.deepEqual(new Set(multiBands.map(b => b.gold)), new Set(['ghost-unit-one', 'ghost-unit-two']));
  assert.match(sweep.snapshot_id, /^[0-9a-f]{64}$/, 'sweep numbers are pinned to a content-addressed snapshot');
  assert.equal(sweep.counts.declared_supports, 2);
});

test('A5 receipt: runHarness manifest carries product-function hashes, snapshot id, schema, and declared counts', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'a5-gold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ queries: [
    { id: 'q1', query: 'omega speedmaster', expected: ['want-omega-speedmaster-on-sale-wait'] },
  ] }));
  try {
    const report = await runHarness(FIXT, goldPath);
    const m = report.manifest;
    assert.equal(m.receipt_schema, 'train-a-evaluator/1');
    for (const f of ['retrieve-context.mjs', 'bm25.mjs', 'generate-summary-index.mjs']) {
      assert.match(m.product_function_sha256[f], /^[0-9a-f]{64}$/, `${f} hash present`);
    }
    assert.match(m.snapshot_id, /^[0-9a-f]{64}$/);
    assert.equal(m.built_artifact_sha256, null, 'artifact hash is the freeze step\'s to supply, never guessed from a dev tree');
    assert.deepEqual(m.counts, { queries: 1, no_answer: 0, declared_supports: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A5 runHarness: under-declared gold set is refused before any arm runs', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'a5-badgold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ queries: [{ id: 'q1', query: 'anything' }] }));
  try {
    await assert.rejects(() => runHarness(FIXT, goldPath), /no_answer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
