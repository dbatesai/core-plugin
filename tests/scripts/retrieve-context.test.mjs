import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { retrieveContext, tokenize } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

// The obligation-3 fixture store lives in the CORE repo, a sibling of core-plugin.
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'CORE',
  '_outputs', '2026-06-27', 'fixtures', 'obligation3-store');

test('tokenize lowercases, splits on non-word, drops stopwords', () => {
  const toks = tokenize('The Omega Speedmaster, on sale!');
  assert.ok(toks.includes('omega'));
  assert.ok(toks.includes('speedmaster'));
  assert.ok(!toks.includes('the'), 'stopword dropped');
  assert.ok(!toks.includes('on'), 'stopword dropped');
});

test('lexical surfaces the literal-match want (rung 1)', () => {
  const hits = retrieveContext('omega speedmaster sale email', FIXT, { topN: 5 });
  assert.ok(hits.some(h => h.id === 'want-omega-speedmaster-on-sale-wait'),
    'a literal keyword overlap must surface the matching want');
});

test('lexical MISSES the value rung (documents the A5 gap reasoning closes)', () => {
  const hits = retrieveContext('zenith el primero on sale', FIXT, { topN: 5 });
  assert.ok(!hits.some(h => h.id === 'values-heritage'),
    'lexical cannot bridge heritage→El Primero — this is the gap the reasoning prototype must close');
});

test('retired units are never surfaced', () => {
  const hits = retrieveContext('rolex daytona watch', FIXT, { topN: 10 });
  assert.ok(!hits.some(h => h.id === 'distractor-retired-rolex'),
    'a retired unit must not appear in retrieval');
});

test('returns at most topN results, each with id/summary/score', () => {
  const hits = retrieveContext('watch chronograph', FIXT, { topN: 3 });
  assert.ok(hits.length <= 3);
  for (const h of hits) {
    assert.ok(typeof h.id === 'string' && h.id.length > 0);
    assert.ok(typeof h.summary === 'string');
    assert.ok(typeof h.score === 'number');
  }
});

test('deterministic — same query yields the same ordered ids', () => {
  const a = retrieveContext('omega speedmaster sale', FIXT, { topN: 5 }).map(h => h.id);
  const b = retrieveContext('omega speedmaster sale', FIXT, { topN: 5 }).map(h => h.id);
  assert.deepEqual(a, b);
});
