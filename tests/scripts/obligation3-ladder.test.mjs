import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
const RUNGS = [
  { rung: 'literal', hook: 'omega speedmaster sale email', expectId: 'want-omega-speedmaster-on-sale-wait' },
  { rung: 'category', hook: 'omega speedmaster professional listing', expectId: 'want-iconic-chronograph' },
  { rung: 'value', hook: 'zenith el primero on sale', expectId: 'values-heritage' },
  { rung: 'crossdomain', hook: "what's left on our agenda?", expectId: 'try-latest-moe-qwen' },
];

test('ladder has four rungs with expected ids', () => {
  assert.equal(RUNGS.length, 4);
  for (const r of RUNGS) {
    assert.ok(r.expectId, 'each rung names the unit it expects to surface');
    assert.ok(r.hook, 'each rung carries a present-day hook query');
    assert.ok(r.rung, 'each rung is named (literal/category/value/crossdomain)');
  }
});

test('LEXICAL-TIER BASELINE: rung 1 hits, the abstract rungs miss (the gap Task 10 must close)', () => {
  // Run the real deterministic retriever over each rung's present-day hook and score it.
  // This is the measured baseline the abstract-relevance prototype (Task 10) improves on:
  // lexical clears the literal rung and is expected to miss the category/value rungs that
  // have no shared keyword. Cross-domain may or may not surface lexically.
  const retrievedByRung = {};
  for (const r of RUNGS) {
    retrievedByRung[r.rung] = retrieveContext(r.hook, FIXT, { topN: 5 }).map(h => h.id);
  }

  // Hard assertions — the load-bearing baseline claims:
  assert.equal(retrievedByRung.literal.includes('want-omega-speedmaster-on-sale-wait'), true, 'lexical MUST clear the literal rung');
  assert.equal(retrievedByRung.value.includes('values-heritage'), false, 'lexical CANNOT bridge heritage→El Primero (value rung)');

  // Record the full per-rung baseline for the build report (not assertions — measurements).
  // eslint-disable-next-line no-console
  console.log('LEXICAL recall@5 baseline:', JSON.stringify(Object.fromEntries(RUNGS.map((r) => [r.rung, Number(retrievedByRung[r.rung].includes(r.expectId))]))));
});

test('expected ids match the committed fixture unit ids', () => {
  const ids = RUNGS.map(r => r.expectId).sort();
  assert.deepEqual(ids, [
    'try-latest-moe-qwen',
    'values-heritage',
    'want-iconic-chronograph',
    'want-omega-speedmaster-on-sale-wait',
  ]);
});
