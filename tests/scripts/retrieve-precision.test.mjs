import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

// A small labeled query set over the fixture store (validates A4 — does the lexical
// hook inject relevant units, or noise?). Each query lists the unit ids a human would
// call genuinely relevant. These are LEXICAL-tier queries (the literal/keyword cases);
// the abstract value/category leaps are deliberately out of scope here — those are the
// reasoning tier's job (Task 10), and scoring lexical against them would just re-measure
// the known gap rather than the precision question.
const QUERIES = [
  { q: 'omega speedmaster sale', relevant: ['want-omega-speedmaster-on-sale-wait'] },
  { q: 'speedmaster waiting for discount', relevant: ['want-omega-speedmaster-on-sale-wait'] },
  { q: 'grail chronograph collection', relevant: ['want-iconic-chronograph'] },
  { q: 'iconic chronograph grail', relevant: ['want-iconic-chronograph'] },
  { q: 'brand heritage in-house movement', relevant: ['values-heritage'] },
  { q: 'first-of-its-kind landmark calibre', relevant: ['values-heritage'] },
  { q: 'mixture of experts qwen benchmark', relevant: ['try-latest-moe-qwen'] },
  { q: 'latest moe models to try', relevant: ['try-latest-moe-qwen', 'note-new-google-moe-release'] },
  { q: 'google moe release', relevant: ['note-new-google-moe-release'] },
  { q: 'coffee grinder burr', relevant: ['distractor-coffee-grinder'] },
];

function precisionRecallAt(n) {
  let pSum = 0, rSum = 0, counted = 0;
  for (const { q, relevant } of QUERIES) {
    const hits = retrieveContext(q, FIXT, { topN: n }).map(h => h.id);
    if (hits.length === 0) { counted++; continue; } // precision undefined→0 contribution, recall 0
    const relSet = new Set(relevant);
    const tp = hits.filter(id => relSet.has(id)).length;
    pSum += tp / hits.length;
    rSum += tp / relevant.length;
    counted++;
  }
  return { precision: pSum / counted, recall: rSum / counted };
}

test('precision@3 clears the recorded threshold', () => {
  const { precision, recall } = precisionRecallAt(3);
  // Recorded actuals (see build log A4): the lexical hook is high-precision on
  // keyword-overlap queries because scoring is title/topic-weighted and the corpus
  // is small with little token collision.
  // eslint-disable-next-line no-console
  console.log(`precision@3=${precision.toFixed(3)} recall@3=${recall.toFixed(3)}`);
  assert.ok(precision >= 0.5, `precision@3 (${precision.toFixed(3)}) must clear the 0.5 starting bar`);
});

test('N sweep recorded (2 vs 3 vs 5) — default top-N stays David\'s call (G2)', () => {
  for (const n of [2, 3, 5]) {
    const { precision, recall } = precisionRecallAt(n);
    // eslint-disable-next-line no-console
    console.log(`N=${n}: precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`);
  }
  // No assertion that changes the default — recording only. G2 is David's.
  assert.ok(true);
});
