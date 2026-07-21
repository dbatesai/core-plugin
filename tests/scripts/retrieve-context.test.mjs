import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { retrieveContext, tokenize, main as retrieveContextMain } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

// The obligation-3 fixture store lives in-repo under tests/fixtures/ so CI (which checks
// out only core-plugin) can reach it. The generated _lib/ cache is gitignored + regenerated.
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

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

// ---------- CLI main(): unrecognized-flag garbage query (Meridian, live Windows box, 2026-07-20) ----------
//
// A fat-fingered `--query "..."` used to fall straight through the old arg filter
// (which only stripped --top/--pack) into the positional slot, so the literal
// string "--query" became the query text and the tool silently returned a
// confident top result for garbage input -- no error, no abstention signal. Since
// this CLI must invoke the exact same function agents/harnesses use to probe
// delivered bytes (Train A A4), a silently-corrupted query here is a
// silently-corrupted measurement anywhere the CLI is used that way.

function captured(stream, fn) {
  const orig = stream.write;
  const chunks = [];
  stream.write = (c) => { chunks.push(String(c)); return true; };
  try { return [fn(), chunks.join('')]; } finally { stream.write = orig; }
}

test('CLI main(): an unrecognized --query flag is rejected, not silently treated as the query text', () => {
  const [code, err] = captured(process.stderr, () => retrieveContextMain([FIXT, '--query', 'omega speedmaster sale']));
  assert.equal(code, 2, 'must fail loud, not silently proceed on garbage input');
  assert.match(err, /unrecognized flag/);
});

test('CLI main(): a real positional query still works normally', () => {
  const [code, out] = captured(process.stdout, () => retrieveContextMain([FIXT, 'omega speedmaster sale', '--top', '3']));
  assert.equal(code, 0);
  assert.match(out, /\[\d\.\d\]/, 'prints at least one scored result line');
});

test('CLI main(): --top and --pack are still recognized and never rejected as unknown flags', () => {
  const [code] = captured(process.stdout, () => retrieveContextMain([FIXT, 'omega speedmaster sale', '--top', '5', '--pack']));
  assert.equal(code, 0);
});
