/**
 * aggregate-receipt — Train A A2 acceptance tests.
 *
 * The boundary (Crest, files-repo data boundary 2026-07-12): rows stay local,
 * only non-reconstructive aggregates travel. The exporter must prove BOTH belts:
 * whitelist construction (a new report field never leaks by default) and the
 * refusal scan (a smuggled local fragment refuses the whole export, loudly).
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

const { buildAggregateReceipt, refusalScan, collectForbiddenStrings } =
  await import(pathToFileURL(join(SCRIPTS, 'aggregate-receipt.mjs')).href);
const { runHarness, runTierPolicySweep } =
  await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);

const GOLD = { queries: [
  { id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
] };

async function realReportAndSweep() {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'a2-gold-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify(GOLD));
  try {
    const report = await runHarness(FIXT, goldPath);
    const sweep = runTierPolicySweep(FIXT, GOLD.queries);
    return { report, sweep };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('A2: receipt from a real report contains NO unit ids, query text, or paths', async () => {
  const { report, sweep } = await realReportAndSweep();
  const receipt = buildAggregateReceipt(report, sweep);
  const json = JSON.stringify(receipt).toLowerCase();
  assert.ok(!json.includes('want-omega-speedmaster-on-sale-wait'), 'no gold unit id');
  assert.ok(!json.includes('omega speedmaster sale'), 'no query text');
  assert.ok(!json.includes(FIXT.toLowerCase()), 'no store path');
  assert.ok(!/\/users\/|\/home\/|[a-z]:\\\\/i.test(json), 'no filesystem path of any shape');
  // And it still carries the measurements that make it useful:
  assert.equal(receipt.receipt_schema, 'train-a-aggregate-receipt/1');
  assert.match(receipt.source.snapshot_id, /^[0-9a-f]{64}$/);
  assert.ok(receipt.evaluation.arms.context3, 'final-context arm rates present');
  assert.equal(receipt.tier_sweep.counts.queries, 1);
});

test('A2: band histogram aggregates counts and drops the per-(query,gold) labels', async () => {
  const sweepLike = {
    snapshot_id: 'a'.repeat(64), topN: 3,
    perPolicy: [{ policy: 'P0', r3: 0.5, n: 2, forbidden3: 0 }],
    bands: [
      { query: 'local-q-1', gold: 'local-unit-a', band: 'recall (absent from ranking; enrichment/reasoning, not tier)' },
      { query: 'local-q-2', gold: 'local-unit-b', band: 'recall (absent from ranking; enrichment/reasoning, not tier)' },
    ],
    counts: { queries: 2, scored: 2, no_answer: 0, declared_supports: 2 },
  };
  const receipt = buildAggregateReceipt({ manifest: {}, gold: [], rawRanks: {}, results: {}, latency: {}, mix: {} }, sweepLike);
  assert.deepEqual(receipt.tier_sweep.band_histogram,
    { 'recall (absent from ranking; enrichment/reasoning, not tier)': 2 });
  const json = JSON.stringify(receipt);
  assert.ok(!json.includes('local-q-1') && !json.includes('local-unit-a'), 'band row labels never leave');
});

test('A2 refusal: a smuggled local fragment refuses the whole export, loudly', async () => {
  const { report } = await realReportAndSweep();
  const forbidden = collectForbiddenStrings(report);
  const poisoned = buildAggregateReceipt(report); // clean receipt first
  poisoned.evaluation.smuggled = 'want-omega-speedmaster-on-sale-wait'; // then poison it
  assert.throws(() => refusalScan(poisoned, forbidden), /REFUSED/);
});

test('A2 refusal: filesystem paths are refused even when not in the forbidden vocabulary', () => {
  assert.throws(
    () => refusalScan({ note: 'evidence at /Users/someone/project/file.md' }, new Set()),
    /filesystem path/,
  );
  assert.throws(
    () => refusalScan({ note: 'C:\\Users\\someone\\store' }, new Set()),
    /filesystem path/,
  );
  assert.ok(refusalScan({ note: 'rates only', r3: 0.73 }, new Set()));
});

test('A2 CLI: writes a receipt from a report file; refusal is exit 2', async () => {
  const { writeFileSync, mkdtempSync, rmSync, readFileSync: rf } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'a2-cli-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify(GOLD));
  try {
    const report = await runHarness(FIXT, goldPath);
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const outPath = join(dir, 'receipt.json');
    const CLI = join(SCRIPTS, 'aggregate-receipt.mjs');
    execFileSync('node', [CLI, reportPath, '--out', outPath], { encoding: 'utf8' });
    const receipt = JSON.parse(rf(outPath, 'utf8'));
    assert.equal(receipt.receipt_schema, 'train-a-aggregate-receipt/1');
    // Poisoned report → the CLI refuses with exit 2. The poison rides a surface the
    // whitelist genuinely copies (unit-type mix keys), so this exercises the refusal
    // scan itself, not an incidental construction error.
    const bad = { ...report, mix: { ...report.mix, [report.gold[0].query]: 1 } };
    const badPath = join(dir, 'bad-report.json');
    writeFileSync(badPath, JSON.stringify(bad));
    assert.throws(() => execFileSync('node', [CLI, badPath, '--out', join(dir, 'nope.json')], { encoding: 'utf8' }),
      (e) => e.status === 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
