import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

const FIXT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
// The committed fixture is NEVER touched by tests — even "read" paths write the
// cached index (_lib/unit-summaries.json) as a side effect, which polluted the
// committed tree (retrieval-premise.test.mjs owns this pattern; the
// fixture-cold-clean guard test enforces it). All reads run against a clone.
const FIXT = mkdtempSync(join(tmpdir(), 'obligation3-store-'));
cpSync(FIXT_SRC, FIXT, { recursive: true });
process.on('exit', () => { try { rmSync(FIXT, { recursive: true, force: true }); } catch { /* tmpdir */ } });

// A small labeled query set over the fixture store (does the lexical
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
  // Recorded actuals: the lexical hook is high-precision on
  // keyword-overlap queries because scoring is title/topic-weighted and the corpus
  // is small with little token collision.
  // eslint-disable-next-line no-console
  console.log(`precision@3=${precision.toFixed(3)} recall@3=${recall.toFixed(3)}`);
  // Ratcheted to just under the measured value (0.850). A starting bar of 0.5
  // let precision fall 41% without failing; this fails on a real regression.
  assert.ok(precision >= 0.80, `precision@3 (${precision.toFixed(3)}) fell below the ratcheted 0.80 floor`);
});

test('N sweep recorded (2 vs 3 vs 5) — the default top-N stays an open choice', () => {
  for (const n of [2, 3, 5]) {
    const { precision, recall } = precisionRecallAt(n);
    // eslint-disable-next-line no-console
    console.log(`N=${n}: precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`);
  }
  // The default top-N is a product decision, not this test's to make — but the
  // sweep must still fail if the retriever stops returning anything at any N.
  for (const n of [2, 3, 5]) {
    const { recall } = precisionRecallAt(n);
    assert.ok(recall > 0, `N=${n} returned zero relevant results — the retriever is dead at this N`);
  }
});
