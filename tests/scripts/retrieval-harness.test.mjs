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

// ── Strict evaluator ──

test('validateGold: empty expected without no_answer:true is rejected — zero silent skips', () => {
  assert.throws(() => validateGold([{ id: 'q1', query: 'something', rung: 'literal' }]), /no_answer/);
  assert.throws(() => validateGold([{ id: 'q1', query: 'something', rung: 'literal', expected: [] }]), /no_answer/);
  assert.ok(validateGold([{ id: 'q1', query: 'something', rung: 'literal', no_answer: true }]), 'declared absence is valid');
  assert.throws(() => validateGold([{ id: 'q1', query: 'something', rung: 'literal', expected: ['u1'], no_answer: true }]),
    /contradicts/, 'support + no_answer together is contradictory');
  assert.throws(() => validateGold([{ id: 'q1', rung: 'literal', expected: ['u1'] }]), /query text/, 'query text required');
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', rung: 'literal', expected: [''] }]), /non-empty strings/);
});

// ── Blocker 4: evaluator validation fails CLOSED ──

test('validateGold: unknown or missing rung is refused (closed reporting enum)', () => {
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', rung: 'vibes', expected: ['u1'] }]),
    /rung 'vibes'/, 'unknown rung refused');
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', expected: ['u1'] }]),
    /rung '\(missing\)'/, 'missing rung refused — it would vanish from perRung reporting');
  assert.ok(validateGold([{ id: 'q1', query: 'x', rung: 'cross-domain', expected: ['u1'] }]));
});

test('validateGold: duplicate supports are refused, not deduped', () => {
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', rung: 'literal', expected: ['u1', 'u1'] }]),
    /duplicate ids in expected/);
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', rung: 'literal', expected: ['u1'], forbidden: ['f1', 'f1'] }]),
    /duplicate ids in forbidden/);
});

test('validateGold: an id in both expected and forbidden is contradictory gold — refused', () => {
  assert.throws(() => validateGold([{ id: 'q1', query: 'x', rung: 'literal', expected: ['u1', 'u2'], forbidden: ['u2'] }]),
    /both expected and forbidden \(u2\)/);
});

test('assertKnownTiers: unknown AND missing authority tiers fail closed in the evaluator', () => {
  assert.ok(assertKnownTiers({ units: [{ id: 'a', tier: 'canonical' }, { id: 'b', tier: 'observation' }] }));
  assert.throws(() => assertKnownTiers({ units: [{ id: 'x', tier: 'mystery' }] }), /fails closed/);
  // The exact hole: a unit with NO tier used to pass silently and
  // be defaulted canonical by product code. Absence is not a tier.
  assert.throws(() => assertKnownTiers({ units: [{ id: 'c' }] }), /missing authority tier on unit c/);
  assert.throws(() => assertKnownTiers({ units: [{ id: 'd', tier: '' }] }), /missing authority tier/);
});

test('sweep: bands are per (query, gold) pair — multi-valued estimand preserved — and the sweep pins its snapshot', () => {
  const gold = [{
    id: 'multi', query: 'zz-nonexistent-token-zz', rung: 'literal',
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

test('receipt: runHarness manifest carries product-function hashes, snapshot id, schema, and declared counts', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'a5-gold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ queries: [
    { id: 'q1', query: 'omega speedmaster', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
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

test('runHarness: under-declared gold set is refused before any arm runs', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join((await import('node:os')).tmpdir(), 'a5-badgold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ queries: [{ id: 'q1', query: 'anything' }] }));
  try {
    await assert.rejects(() => runHarness(FIXT, goldPath), /no_answer/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── Blocker 2: immutable captured corpus — the two falsifiers ──
// Compare a DETERMINISTIC PROJECTION (ranks per arm,
// snapshot id), never whole receipts (latency fields legitimately vary).

test('falsifier A: mutating unit files after capture cannot change any measured rank (capture-leak test)', async () => {
  const { mkdtempSync, cpSync, rmSync, appendFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadSnapshot } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);
  const { lexicalRankedIds, productRankedIds, retrieveContext, buildFinalContextPack } =
    await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
  const { bm25Rank } = await import(pathToFileURL(join(SCRIPTS, 'bm25.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'b2-mutate-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  try {
    const snapshot = loadSnapshot(store, { captureBodies: true });
    assert.ok(Array.isArray(snapshot.bodies) && snapshot.bodies.length > 0, 'bodies captured');
    const q = 'omega speedmaster sale';
    const project = () => ({
      lexical: lexicalRankedIds(q, store, { snapshot }),
      ranking: productRankedIds(q, store, { snapshot }),
      context3: buildFinalContextPack(retrieveContext(q, store, { topN: 3, snapshot })).accepted.map(a => a.id),
      bm25: bm25Rank(q, store, { snapshot }),
      snapshot_id: snapshot.snapshotId,
    });
    const before = project();
    // Mutate EVERY unit body on disk after capture — poison that would rerank everything if read.
    const memDir = join(store, '_memories');
    for (const f of readdirSync(memDir, { recursive: true })) {
      if (String(f).endsWith('.md')) appendFileSync(join(memDir, String(f)), '\n\nomega speedmaster sale omega speedmaster sale omega speedmaster sale\n');
    }
    const after = project();
    assert.deepEqual(after, before, 'deterministic projection identical across on-disk mutation — the capture is leak-free');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('falsifier B: every arm completes against the capture with the store UNREADABLE (fs-stub equivalent)', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, cpSync, rmSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { loadSnapshot } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);
  const { lexicalRankedIds, productRankedIds, retrieveContext, buildFinalContextPack } =
    await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
  const { bm25Rank } = await import(pathToFileURL(join(SCRIPTS, 'bm25.mjs')).href);
  const dir = mkdtempSync(join(tmpdir(), 'b2-noread-'));
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  const memDir = join(store, '_memories');
  try {
    const snapshot = loadSnapshot(store, { captureBodies: true });
    chmodSync(memDir, 0o000); // any live read from here on throws EACCES
    const q = 'omega speedmaster sale';
    const outs = {
      lexical: lexicalRankedIds(q, store, { snapshot }),
      ranking: productRankedIds(q, store, { snapshot }),
      context3: buildFinalContextPack(retrieveContext(q, store, { topN: 3, snapshot })).accepted.map(a => a.id),
      bm25: bm25Rank(q, store, { snapshot }),
    };
    for (const [arm, ids] of Object.entries(outs)) {
      assert.ok(Array.isArray(ids), `${arm} arm completed with zero live reads`);
    }
    assert.ok(outs.bm25.length > 0, 'the body arm ranked from CAPTURED bytes (would be empty/thrown on live reads)');
  } finally {
    chmodSync(memDir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── close path: byteCap binds absolutely; context3 reports at its real depth ──

test('close-path-6: a byteCap below the pack header delivers an EMPTY pack, never bytes > byteCap', async () => {
  const { buildFinalContextPack } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
  const hits = [{ id: 'u1', tier: 'canonical', score: 1, summary: 'something' }];
  const pack = buildFinalContextPack(hits, { byteCap: 20 }); // header alone is ~51 bytes
  assert.equal(pack.bytes, 0, 'nothing delivered');
  assert.equal(pack.text, '');
  assert.ok(pack.bytes <= 20, 'the cap binds absolutely');
  assert.equal(pack.excluded.length, 1, 'every hit excluded, visibly');
  assert.match(pack.warnings[0], /below the \d+-byte pack header/);
  // And a normal cap still packs (the constraint is named, not trigger-happy).
  const ok = buildFinalContextPack(hits, { byteCap: 2048 });
  assert.equal(ok.accepted.length, 1);
});

test('close-path-6: the context3 arm reports R@3 only — a 3-item delivered context is never labeled R@5+', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'k3-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify({ queries: [
    { id: 'q1', query: 'omega speedmaster', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
  ] }));
  try {
    const report = await runHarness(FIXT, goldPath);
    assert.deepEqual(Object.keys(report.results.context3.recall), ['3'],
      'context3 recall keys are exactly {3}');
    assert.ok(Object.keys(report.results.bm25.recall).includes('10'),
      'unbounded arms keep the full K ladder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
