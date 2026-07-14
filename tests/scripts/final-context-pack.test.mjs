/**
 * buildFinalContextPack — Train A A4 acceptance tests.
 *
 * The contract (Crest closure program 2026-07-12 §2, keel-to-crest-and-hale
 * next-steps §1): one function owns final ordering, authority labels, warnings,
 * formatting, UTF-8 byte accounting, and the byte cap; hook + CLI + evaluator +
 * tests all call it; accepted identities and exact output bytes agree on
 * synthetic fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

const { buildFinalContextPack, retrieveContext, storeHealth } =
  await import(new URL('../../plugins/core/skills/core/scripts/retrieve-context.mjs', import.meta.url).href);

test('A4 equivalence: hook subprocess output === pack function output, byte-exact, on the same fixture', () => {
  const prompt = 'omega speedmaster sale';
  const hookOut = execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT },
    encoding: 'utf8',
  });
  const hits = retrieveContext(prompt, FIXT, { topN: 3 });
  const pack = buildFinalContextPack(hits, { byteCap: 2048, health: storeHealth(FIXT) });
  assert.equal(hookOut, pack.text, 'installed hook and product function must emit identical bytes');
  assert.equal(Buffer.byteLength(hookOut, 'utf8'), pack.bytes, 'reported byte count is the delivered byte count');
  for (const a of pack.accepted) assert.match(hookOut, new RegExp(`- ${a.id}`), `accepted id ${a.id} present in delivered text`);
});

test('byte accounting: pack.bytes is the exact UTF-8 length of pack.text', () => {
  const hits = [
    { id: 'unit-a', summary: 'plain ascii summary', tier: 'canonical', score: 1 },
    { id: 'unit-b', summary: 'multibyte — ⚠ émphasis über 日本語', tier: 'canonical', score: 0.9 },
  ];
  const pack = buildFinalContextPack(hits);
  assert.equal(pack.bytes, Buffer.byteLength(pack.text, 'utf8'));
  assert.equal(pack.accepted.length, 2);
});

test('byte cap: first over-cap line stops packing; overflow hits are excluded with reason, text stays under cap', () => {
  const long = 'x'.repeat(900);
  const hits = [
    { id: 'fits-1', summary: long, tier: 'canonical', score: 1 },
    { id: 'fits-2', summary: long, tier: 'canonical', score: 0.9 },
    { id: 'over-3', summary: long, tier: 'canonical', score: 0.8 },
    { id: 'never-4', summary: 'tiny', tier: 'canonical', score: 0.7 },
  ];
  const pack = buildFinalContextPack(hits, { byteCap: 2048 });
  assert.ok(pack.bytes <= 2048, 'delivered bytes within the cap');
  assert.deepEqual(pack.accepted.map(a => a.id), ['fits-1', 'fits-2']);
  // 'never-4' would fit, but the shipped semantic is stop-at-first-overflow, not skip-and-continue.
  assert.deepEqual(pack.excluded.map(e => e.id), ['over-3', 'never-4']);
  assert.ok(pack.excluded.every(e => e.reason === 'byte-cap'));
  assert.ok(!pack.text.includes('never-4'), 'no line packed after the cap is hit');
});

test('multibyte cap: the cap is UTF-8 bytes, not characters', () => {
  const wide = '⚠'.repeat(400); // 3 bytes each in UTF-8
  const pack = buildFinalContextPack(
    [{ id: 'wide-unit', summary: wide, tier: 'canonical', score: 1 }],
    { byteCap: 512 },
  );
  assert.equal(pack.accepted.length, 0, 'a line over the cap in BYTES is excluded even if under it in chars');
  assert.equal(pack.excluded[0].reason, 'byte-cap');
});

test('authority tier: observation hits carry the [observation] label in the delivered text', () => {
  const pack = buildFinalContextPack([
    { id: 'obs-x', summary: 'raw note', tier: 'observation', score: 1 },
    { id: 'dc-y', summary: 'a decision', tier: 'canonical', score: 0.9 },
  ]);
  assert.match(pack.text, /- obs-x \[observation\]: raw note/);
  assert.match(pack.text, /- dc-y: a decision/);
});

test('degraded warning: appended when health.degraded and it fits; recorded in warnings', () => {
  const health = { degraded: true, duplicate_conflicts: [{ id: 'dup-1' }] };
  const pack = buildFinalContextPack(
    [{ id: 'u', summary: 's', tier: 'canonical', score: 1 }],
    { health },
  );
  assert.match(pack.text, /CORE memory index degraded: 1 duplicate unit id/);
  assert.equal(pack.warnings.length, 1);
});

test('degraded warning is dropped, not truncated, when it would exceed the cap', () => {
  const health = { degraded: true, duplicate_conflicts: [] };
  const summary = 'y'.repeat(150);
  const pack = buildFinalContextPack(
    [{ id: 'u', summary, tier: 'canonical', score: 1 }],
    { byteCap: 220, health },
  );
  assert.ok(!pack.text.includes('degraded'), 'warning never partially packed');
  assert.equal(pack.warnings.length, 0);
  assert.ok(pack.bytes <= 220);
});

test('empty hits → empty pack (no header emitted for nothing)', () => {
  const pack = buildFinalContextPack([]);
  assert.equal(pack.text, '');
  assert.equal(pack.bytes, 0);
  assert.deepEqual(pack.accepted, []);
});
