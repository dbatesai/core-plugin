/**
 * buildFinalContextPack — Train A A4 acceptance tests.
 *
 * The contract (Crest closure program 2026-07-12 §2, keel-to-crest-and-hale
 * next-steps §1): one function owns final ordering, authority labels, warnings,
 * formatting, UTF-8 byte accounting, and the byte cap; hook + CLI + evaluator +
 * tests all call it; accepted identities and exact output bytes agree on
 * synthetic fixtures.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { linkFixtureUnderTrustedRoot, trustedTestTmpRoot } from './trusted-test-tmp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
// D1 fix, 2026-07-18: CORE_RETRIEVAL_STORE only honors overrides inside the
// trusted ~/.core now — the subprocess hook call below needs the linked
// path; retrieveContext()/buildFinalContextPack() below call FIXT directly
// (in-process, not via env), unaffected either way.
const FIXT_LINK = linkFixtureUnderTrustedRoot(FIXT);
const _createdDirs = [];
after(() => { rmSync(FIXT_LINK, { force: true }); for (const d of _createdDirs) rmSync(d, { recursive: true, force: true }); });

const { buildFinalContextPack, retrieveContext, storeHealth } =
  await import(new URL('../../plugins/core/skills/core/scripts/retrieve-context.mjs', import.meta.url).href);

test('A4 equivalence: hook subprocess output === pack function output, byte-exact, on the same fixture', () => {
  const prompt = 'omega speedmaster sale';
  // Isolate the hook test log (Hale audit, 2026-07-17) — default
  // ~/.core/hooks-log.jsonl is a real machine-wide file, not a test fixture.
  // Rooted under ~/.core (D1 fix, 2026-07-18): os.tmpdir() no longer qualifies.
  const hooksLogDir = mkdtempSync(join(trustedTestTmpRoot(), 'a4-hook-log-'));
  _createdDirs.push(hooksLogDir);
  const hooksLog = join(hooksLogDir, 'hooks-log.jsonl');
  const hookOut = execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt }),
    env: { ...process.env, CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT_LINK, CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: hooksLog },
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

test('A3 snapshot: loadSnapshot returns a content-derived id that changes only when store bytes change', async () => {
  const { loadSnapshot } = await import(new URL('../../plugins/core/skills/core/scripts/generate-summary-index.mjs', import.meta.url).href);
  const a = loadSnapshot(FIXT);
  const b = loadSnapshot(FIXT);
  assert.equal(a.snapshotId, b.snapshotId, 'same bytes → same snapshot id');
  assert.match(a.snapshotId, /^[0-9a-f]{64}$/, 'sha256 hex');
  assert.ok(Array.isArray(a.index.units) && a.index.units.length > 0, 'snapshot carries the loaded index');
});

test('A3 threading: bm25Scores with a preloaded snapshot index equals a standalone load', async () => {
  const { loadSnapshot } = await import(new URL('../../plugins/core/skills/core/scripts/generate-summary-index.mjs', import.meta.url).href);
  const { bm25Scores } = await import(new URL('../../plugins/core/skills/core/scripts/bm25.mjs', import.meta.url).href);
  const { index } = loadSnapshot(FIXT);
  const threaded = bm25Scores('omega speedmaster sale', FIXT, { preloadedIndex: index });
  const standalone = bm25Scores('omega speedmaster sale', FIXT);
  assert.deepEqual(threaded, standalone, 'one-snapshot read path scores identically on an unchanged store');
});

test('A3 trace: buildRetrievalTrace records snapshot id, stages, delivered pack, and timing — final agrees with retrieveContext', async () => {
  const { buildRetrievalTrace } = await import(new URL('../../plugins/core/skills/core/scripts/retrieve-context.mjs', import.meta.url).href);
  const query = 'omega speedmaster sale';
  const trace = buildRetrievalTrace(query, FIXT, { topN: 3 });
  assert.equal(trace.kind, 'retrieval-trace');
  assert.equal(trace.local_only, true, 'traces are local-only; sharing goes through the aggregate exporter');
  assert.match(trace.snapshot_id, /^[0-9a-f]{64}$/);
  assert.ok(trace.stages.substrate.length >= trace.stages.final.length, 'substrate is the pre-slice ranking');
  assert.deepEqual(
    trace.stages.final.map(h => h.id),
    retrieveContext(query, FIXT, { topN: 3 }).map(h => h.id),
    'trace final and product final are the same pipeline',
  );
  assert.deepEqual(
    trace.pack.accepted.map(a => a.id),
    buildFinalContextPack(retrieveContext(query, FIXT, { topN: 3 })).accepted.map(a => a.id),
    'trace pack agrees with the delivered pack',
  );
  assert.ok(trace.timing_ms >= 0);
  assert.ok(trace.component_identity['retrieve-context.mjs'], 'component hash recorded');
});

test('A3 trace: storeless directory → explicit storeless trace, no crash, no writes', async () => {
  const { buildRetrievalTrace } = await import(new URL('../../plugins/core/skills/core/scripts/retrieve-context.mjs', import.meta.url).href);
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'trace-storeless-'));
  try {
    const trace = buildRetrievalTrace('anything', dir);
    assert.equal(trace.storeless, true);
    assert.equal(trace.snapshot_id, null);
    assert.deepEqual(readdirSync(dir), [], 'no side-effect writes into a store-less directory');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('A4 CLI: --pack emits the exact delivered bytes (same function, same cap, same health)', () => {
  const CLI = join(ROOT, 'plugins', 'core', 'skills', 'core', 'scripts', 'retrieve-context.mjs');
  const query = 'omega speedmaster sale';
  const cliOut = execFileSync('node', [CLI, FIXT, query, '--pack'], { encoding: 'utf8' });
  const pack = buildFinalContextPack(retrieveContext(query, FIXT, { topN: 3 }), { health: storeHealth(FIXT) });
  assert.equal(cliOut, pack.text, 'CLI --pack and the product function must emit identical bytes');
});

test('A4 harness: context3 arm reports DELIVERED identities (pack-accepted), not pre-cap selection', async () => {
  const { runHarness } = await import(new URL('../../plugins/core/skills/core/scripts/retrieval-harness.mjs', import.meta.url).href);
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const gold = { queries: [
    { id: 'q1', query: 'omega speedmaster sale', expected: ['want-omega-speedmaster-on-sale-wait'], forbidden: [], rung: 'literal' },
  ] };
  const dir = mkdtempSync(join(tmpdir(), 'pack-gold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify(gold));
  try {
    const report = await runHarness(FIXT, goldPath);
    for (const q of gold.queries) {
      const delivered = buildFinalContextPack(retrieveContext(q.query, FIXT, { topN: 3 })).accepted.map(a => a.id);
      assert.deepEqual(report.rawRanks.context3[q.id], delivered,
        `context3 raw ranks for ${q.id} must equal pack-accepted ids`);
    }
    assert.match(report.manifest.entry_points.context3, /buildFinalContextPack/,
      'manifest names the pack function as the context3 entry point');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
