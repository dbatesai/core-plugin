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

const { buildAggregateReceipt, refusalScan, collectForbiddenStrings, validateReceiptShape, isPathShaped } =
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

// ── Blocker 1 (Hale verdict 2026-07-14 §1): hostile-path battery + closed shapes ──
// His exact reproductions: rung '/private/tmp/secret-project' accepted and emitted;
// direct construction emitted '/etc/shadow' and '/var/db/private'. Every form in
// his required battery is a negative test here.

async function cleanReportAndSweep() {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'b1-'));
  const goldPath = join(dir, 'gold.json');
  writeFileSync(goldPath, JSON.stringify(GOLD));
  const report = await runHarness(FIXT, goldPath);
  const sweep = runTierPolicySweep(FIXT, GOLD.queries);
  rmSync(dir, { recursive: true, force: true });
  return { report, sweep };
}

test('blocker-1: Hale\'s exact repro — a path-shaped RUNG key refuses the export', async () => {
  const { report } = await cleanReportAndSweep();
  const poisoned = JSON.parse(JSON.stringify(report));
  for (const r of Object.values(poisoned.results)) {
    if (r.perRung) r.perRung['/private/tmp/secret-project'] = { 5: 1, 10: 1, 30: 1, 100: 1 };
  }
  assert.throws(() => buildAggregateReceipt(poisoned), /REFUSED/);
});

test('blocker-1: path-shaped scalar fields refuse (sha slots cannot carry /etc/shadow or /var/db/private)', async () => {
  const { report } = await cleanReportAndSweep();
  for (const poison of ['/etc/shadow', '/var/db/private']) {
    const p = JSON.parse(JSON.stringify(report));
    p.manifest.built_artifact_sha256 = poison;
    assert.throws(() => buildAggregateReceipt(p), /REFUSED/, `scalar poison ${poison} must refuse`);
  }
});

test('blocker-1: the full hostile-path battery is path-shaped; benign receipt strings are not', () => {
  const hostile = [
    '/private/tmp/secret-project', '/tmp/x', '/etc/shadow', '/var/db/private',
    '/Volumes/backup/store', '\\\\server\\share\\file', 'C:\\Users\\x', '~/projects/core',
    'see /etc/passwd for details', 'data at \\\\nas01\\vault',
  ];
  for (const h of hostile) assert.ok(isPathShaped(h), `${h} must read as path-shaped`);
  const benign = ['train-a-aggregate-receipt/1', 'lexical', 'cross-domain', 'tier-ordering (rescued by P1)', 'P3_w0.8'];
  for (const b of benign) assert.ok(!isPathShaped(b), `${b} must NOT read as path-shaped`);
});

test('blocker-1: path-shaped band and mix keys refuse via shape validation', async () => {
  const { report, sweep } = await cleanReportAndSweep();
  const badMix = JSON.parse(JSON.stringify(report));
  badMix.mix['/Volumes/exfil'] = 3;
  assert.throws(() => buildAggregateReceipt(badMix), /REFUSED/);
  const badSweep = JSON.parse(JSON.stringify(sweep));
  badSweep.bands.push({ query: 'q1', gold: 'g', band: '/var/db/private' });
  assert.throws(() => buildAggregateReceipt(report, badSweep), /REFUSED/);
});

test('blocker-1: non-shape scalars refuse (a sentence in a version, a bogus policy, an out-of-range rate)', async () => {
  const { report, sweep } = await cleanReportAndSweep();
  const badVersion = JSON.parse(JSON.stringify(report));
  badVersion.manifest.plugin_version = 'not a version at all with spaces';
  assert.throws(() => buildAggregateReceipt(badVersion), /plugin_version/);
  const badPolicy = JSON.parse(JSON.stringify(sweep));
  badPolicy.perPolicy.push({ policy: 'Pwned policy', r3: 0.5, n: 1, forbidden3: 0 });
  assert.throws(() => buildAggregateReceipt(report, badPolicy), /policy/);
  const badRate = JSON.parse(JSON.stringify(report));
  const firstArm = Object.keys(badRate.results)[0];
  badRate.results[firstArm].mrr = 7;
  assert.throws(() => buildAggregateReceipt(badRate), /mrr/);
});

test('blocker-1: a clean report + sweep still exports (shape validation is not a tautology)', async () => {
  const { report, sweep } = await cleanReportAndSweep();
  const receipt = buildAggregateReceipt(report, sweep);
  assert.ok(validateReceiptShape(receipt));
  assert.equal(receipt.receipt_schema, 'train-a-aggregate-receipt/1');
});
