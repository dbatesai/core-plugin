import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

const { recallAtK, firstRelevantRank } = await import(join(SCRIPTS, 'retrieval-harness.mjs'));
const { bm25Rank } = await import(join(SCRIPTS, 'bm25.mjs'));
const { lexicalRankedIds } = await import(join(SCRIPTS, 'retrieve-context.mjs'));

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
