import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runMaintenance } from '../../plugins/core/skills/core/scripts/maintenance-run.mjs';
import { hashText } from '../../plugins/core/skills/core/scripts/state-cache.mjs';
import { newRound, register, SELF_TEST_LOG_FILENAME } from '../../plugins/core/skills/core/scripts/self-test-round.mjs';
import { loadSnapshot } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { captureTurnEvidence, computeStoreSignature } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';
import { TRIPWIRE_THRESHOLDS } from '../../plugins/core/skills/core/scripts/metrics-tripwires.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAINT_SCRIPT = join(HERE, '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'maintenance-run.mjs');
const SELF_TEST_FIXTURE = join(HERE, '..', 'fixtures', 'obligation3-store');

// Isolated HOME so the state-cache global-prune step never touches the real
// developer ~/.core during tests (mirrors decorate-graph.test.mjs / hot-section.test.mjs).
function testHome(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  return home;
}

// M1: mechanical maintenance is signature-gated (regen only when units changed),
// narrated (never silent), and ledger-recorded (the cadence data for the M2 observe step).

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'core-maint-'));
  mkdirSync(join(root, '_memories'), { recursive: true });
  return root;
}
function writeUnit(root, id, { type = 'observation', status, title, mtime } = {}) {
  const fm = ['---', `id: ${id}`, `type: ${type}`];
  if (status) fm.push(`status: ${status}`);
  fm.push('---', '', `# ${title || id}`, '');
  const p = join(root, '_memories', `${id}.md`);
  writeFileSync(p, fm.join('\n'));
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

test('first run regenerates indexes, writes the ledger, and narrates what ran', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeUnit(root, 'risk-1-bar', { type: 'risk', title: 'A risk', mtime: 1000 });
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(res.unitsChanged, 'first run sees changes');
  assert.ok(existsSync(join(root, '_memories', 'INDEX-decisions.md')));
  assert.ok(existsSync(join(root, '_memories', 'INDEX-risks.md')));
  assert.ok(existsSync(join(root, '_memories', '_lib', 'unit-summaries.json')));
  const ledger = JSON.parse(readFileSync(join(root, '_memories', '_maintenance-state.json'), 'utf8'));
  assert.strictEqual(ledger.last_run, '2026-06-28T00:00:00Z');
  assert.ok(ledger.last_sig.length > 0);
  assert.strictEqual(ledger.ops['decisions-index'].run_count, 1);
  assert.match(res.narration, /Kept memory current/);
});

test('an unchanged store is a no-op: no regen, narrates "already current"', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  const idxPath = join(root, '_memories', 'INDEX-decisions.md');
  const firstMtime = statSync(idxPath).mtimeMs;
  const res = runMaintenance(root, { now: '2026-06-28T01:00:00Z' });
  assert.strictEqual(res.unitsChanged, false);
  assert.strictEqual(statSync(idxPath).mtimeMs, firstMtime, 'index not rewritten when nothing changed');
  assert.match(res.narration, /already current/);
});

test('a changed unit re-triggers regeneration', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  writeUnit(root, 'dc-2-new', { type: 'decision', title: 'Another decision', mtime: 2000 });
  const res = runMaintenance(root, { now: '2026-06-28T02:00:00Z' });
  assert.ok(res.unitsChanged, 'new unit retriggers');
  const ledger = JSON.parse(readFileSync(join(root, '_memories', '_maintenance-state.json'), 'utf8'));
  assert.strictEqual(ledger.ops['decisions-index'].run_count, 2);
});

test('ghost duplicates are cleaned, and the run is reported', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  // Exact-duplicate ghost.
  const orig = readFileSync(join(root, '_memories', 'dc-1-foo.md'), 'utf8');
  writeFileSync(join(root, '_memories', 'dc-1-foo 2.md'), orig);
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(!existsSync(join(root, '_memories', 'dc-1-foo 2.md')), 'identical ghost removed');
  assert.ok(res.ranOps.includes('ghost-cleanup'));
  assert.match(res.narration, /ghost/);
});

test('a differing ghost is NOT removed (verification-before-delete)', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeFileSync(join(root, '_memories', 'dc-1-foo 2.md'), 'genuinely different content');
  runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(existsSync(join(root, '_memories', 'dc-1-foo 2.md')), 'differing ghost preserved for human review');
});

test('PROJECT.md over the soft cap is surfaced as a note', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeFileSync(join(root, 'PROJECT.md'), 'x'.repeat(71000));
  const res = runMaintenance(root, { now: '2026-06-28T00:00:00Z' });
  assert.ok(res.notes.some(n => /over the .* soft cap/.test(n)), 'over-cap surfaced');
  assert.match(res.narration, /Heads up/);
});

test('dry-run does not write the ledger or indexes', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const res = runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z' });
  assert.ok(!existsSync(join(root, '_memories', '_maintenance-state.json')), 'no ledger on dry-run');
  assert.ok(!existsSync(join(root, '_memories', 'INDEX-decisions.md')), 'no index on dry-run');
  assert.ok(res.ranOps.length > 0, 'still reports what it would do');
});

// ---- state-cache stamping: maintenance-run
// writes INDEX-decisions.md, INDEX-risks.md, and the summary index on the
// user's behalf — those writes must be stamped in code, same pattern as
// decorate-graph.mjs and hot-section.mjs, so edit-detection never
// misclassifies them as a between-session user edit. ----

test('runMaintenance stamps the state cache for every generated file it writes, with the correct new hash', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  writeUnit(root, 'risk-1-bar', { type: 'risk', title: 'A risk', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z', home });

  const cachePath = join(root, '_memories', '_lib', 'state-cache.json');
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));

  const decisionsPath = join(root, '_memories', 'INDEX-decisions.md');
  const risksPath = join(root, '_memories', 'INDEX-risks.md');
  const summaryPath = join(root, '_memories', '_lib', 'unit-summaries.json');

  for (const p of [decisionsPath, risksPath, summaryPath]) {
    const entry = cache.files[p];
    assert.ok(entry, `${p} has a state-cache entry after runMaintenance`);
    assert.equal(entry.last_written_by, 'maintenance-run', `${p} stamped as CORE-authored`);
    assert.equal(entry.last_written, '2026-06-28T00:00:00Z');
    assert.equal(entry.last_hash, hashText(readFileSync(p, 'utf8')), `${p} cached hash matches the actual on-disk bytes`);
  }
});

test('an unchanged store does not re-stamp the state cache (no regen ran, nothing to stamp)', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { now: '2026-06-28T00:00:00Z', home });
  const cachePath = join(root, '_memories', '_lib', 'state-cache.json');
  const firstStamp = JSON.parse(readFileSync(cachePath, 'utf8')).files[join(root, '_memories', 'INDEX-decisions.md')].last_written;

  const res = runMaintenance(root, { now: '2026-06-28T01:00:00Z', home });
  assert.strictEqual(res.unitsChanged, false, 'sanity: nothing changed, so no regen ran');
  const secondStamp = JSON.parse(readFileSync(cachePath, 'utf8')).files[join(root, '_memories', 'INDEX-decisions.md')].last_written;
  assert.equal(secondStamp, firstStamp, 'the cache entry is untouched when the underlying file was never rewritten');
});

test('dry-run does not write the state cache either', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!existsSync(join(root, '_memories', '_lib', 'state-cache.json')), 'dry run must not stamp — nothing was actually written');
});

// ---- turn-capture retention (v3.14.0 evidence stream), wired into the op sequence ----

function plantTurnCapture(root, dateName) {
  const dir = join(root, '_metrics', 'turn-capture');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${dateName}.jsonl`);
  writeFileSync(file, JSON.stringify({ kind: 'turn-evidence', schema_version: '1.0.0', prompt_text: 'q' }) + '\n');
  return file;
}

test('maintenance retention: dry-run reports old turn-capture files but deletes nothing', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const oldFile = plantTurnCapture(root, '2020-01-01');
  const res = runMaintenance(root, { apply: false, now: '2026-06-28T00:00:00Z', home });
  assert.ok(res.notes.some((n) => /turn-capture retention \(dry-run\).*would be deleted/.test(n)), 'dry-run surfaces the pending deletion');
  assert.ok(existsSync(oldFile), 'dry-run deletes nothing');
});

test('maintenance retention: apply deletes old turn-capture rows, keeps recent, narrates it', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const oldFile = plantTurnCapture(root, '2020-01-01');
  const recentFile = plantTurnCapture(root, '2099-01-01');
  const res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!existsSync(oldFile), 'old turn-capture row deleted');
  assert.ok(existsSync(recentFile), 'recent turn-capture row kept');
  assert.ok(res.notes.some((n) => /turn-capture retention: deleted 1 row file/.test(n)), 'the deletion is narrated with a proof count');
});

test('--purge-turn-capture CLI removes the whole stream dir and nothing else', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const streamDir = join(root, '_metrics', 'turn-capture');
  plantTurnCapture(root, '2026-06-01');
  // dry-run first: reports, deletes nothing
  const dry = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--purge-turn-capture', '--dry-run'], { encoding: 'utf8' });
  assert.match(dry, /Would purge/);
  assert.ok(existsSync(streamDir), 'dry-run purge deletes nothing');
  // real purge
  const out = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--purge-turn-capture'], { encoding: 'utf8' });
  assert.match(out, /Purged the turn-capture evidence stream/);
  assert.ok(!existsSync(streamDir), 'stream dir removed');
  assert.ok(existsSync(join(root, '_memories')), 'memory store untouched');
});

test('judge op: unjudged evidence rows get judged in the pass, and the scorecard op pins them same-pass', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision about the foo subsystem', mtime: 1000 });
  // plant one evidence row through the real capture path
  const cap = captureTurnEvidence(root, {
    retrieval_id: 'r-maint-1', session_id: 's', harness: 'claude-code',
    prompt_text: 'a decision about the foo subsystem',
    pack_text: 'pack', delivered: [{ id: 'dc-1-foo', score: 1, source_stage: 'ranked' }],
    rejected_top: [], truncation: { byte_cap_applied: false, prompt_tokens_used: 5 },
    store_signature: computeStoreSignature(root), producer_version: 'v', producer_sha: 'sha',
  }, { env: { ...process.env, CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '' } });
  assert.equal(cap.written, true, cap.reason);
  const res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(res.ranOps.includes('hindsight-judge'), 'unjudged evidence → judge op ran');
  assert.ok(res.ranOps.includes('scorecard-computation'), 'fresh judgments pinned in the same pass');
  const judgmentRows = readFileSync(join(root, '_metrics', 'judgment-log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(judgmentRows.length, 1);
  // second pass: nothing unjudged, nothing new to pin
  const res2 = runMaintenance(root, { apply: true, now: '2026-06-29T00:00:00Z', home });
  assert.ok(!res2.ranOps.includes('hindsight-judge'));
  assert.ok(!res2.ranOps.includes('scorecard-computation'));
});

test('scorecard op: pins a scorecard when unpinned judgments exist, skips when nothing new', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  // nothing to pin → op does not run
  let res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!res.ranOps.includes('scorecard-computation'), 'no inputs → no scorecard');
  // plant a judgment row → op pins one scorecard
  const base = join(root, '_metrics');
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'judgment-log.jsonl'),
    JSON.stringify({ kind: 'hindsight-judgment', retrieval_id: 'r1', ts: '2026-06-27T00:00:00Z', verdict: 'hit-right', judge_version: '1.0.0' }) + '\n');
  res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(res.ranOps.includes('scorecard-computation'), 'unpinned judgment → scorecard pinned');
  assert.ok(existsSync(join(base, 'scorecard-log.jsonl')), 'scorecard log written');
  // second run with nothing new → skip
  res = runMaintenance(root, { apply: true, now: '2026-06-29T00:00:00Z', home });
  assert.ok(!res.ranOps.includes('scorecard-computation'), 'pinned already → skip');
});

test('pinned scorecards carry the live tripwire thresholds (visible-goalposts rule)', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const base = join(root, '_metrics');
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'judgment-log.jsonl'),
    JSON.stringify({ kind: 'hindsight-judgment', retrieval_id: 'r1', ts: '2026-06-27T00:00:00Z', verdict: 'hit-right', judge_version: '1.0.0' }) + '\n');
  runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  const card = JSON.parse(readFileSync(join(base, 'scorecard-log.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(card.thresholds.self_test_drop, TRIPWIRE_THRESHOLDS.self_test_drop);
  assert.equal(card.thresholds.capture_consecutive_failures, TRIPWIRE_THRESHOLDS.capture_consecutive_failures);
});

test('auto-author trigger: a stale round emits one narrated note and stamps the weekly cap', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  // cold start: no round at all → due → note + cap stamp
  const res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(res.notes.some((n) => /self-test round/.test(n) && /due|stale|cold start|exists yet/.test(n)),
    `expected an authoring-due note, got: ${JSON.stringify(res.notes)}`);
  // second pass inside the cap window → no repeat note
  const res2 = runMaintenance(root, { apply: true, now: '2026-06-29T00:00:00Z', home });
  assert.ok(!res2.notes.some((n) => /self-test round/.test(n) && /due|stale|cold start|exists yet/.test(n)),
    'weekly cap suppresses a repeat trigger');
});

test('legacy sweep: a leftover rich-context stream from the retired mechanism is removed on apply', () => {
  const root = makeProject();
  const home = testHome(root);
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  const legacyDir = join(root, '_metrics', 'rich-context');
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, '2026-07-01.jsonl'), '{"kind":"rich-context"}\n');
  const res = runMaintenance(root, { apply: true, now: '2026-06-28T00:00:00Z', home });
  assert.ok(!existsSync(legacyDir), 'retired stream dir removed');
  assert.ok(res.notes.some((n) => /removed the retired rich-context stream/.test(n)), 'the sweep is narrated');
});

// ── self-test auto-regrade wired into the CLI cadence (holistic-redesign §3d) ──

function selfTestFixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'core-maint-selftest-'));
  cpSync(SELF_TEST_FIXTURE, dir, { recursive: true });
  return dir;
}
function readSelfTestLogRows(store) {
  const sessionsDir = join(store, '_sessions');
  if (!existsSync(sessionsDir)) return [];
  const rows = [];
  for (const date of readdirSync(sessionsDir)) {
    const p = join(sessionsDir, date, SELF_TEST_LOG_FILENAME);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) rows.push(JSON.parse(line));
  }
  return rows;
}

test('CLI: with a registered self-test round, maintenance-run auto-regrades and logs it', () => {
  const root = selfTestFixtureStore();
  try {
    newRound(root);
    const snapshotId = loadSnapshot(root, { captureBodies: true }).snapshotId;
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] }],
    };
    const goldPath = join(root, 'gold.json');
    writeFileSync(goldPath, JSON.stringify(gold));
    const regResult = register(root, 1, goldPath);
    assert.ok(regResult.ok, `register should pass: ${JSON.stringify(regResult.violations)}`);

    const out = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.ok(parsed.self_test_regrade, 'CLI JSON output carries a self_test_regrade field');
    assert.match(parsed.self_test_regrade.note, /self-test round 1 re-graded automatically/);

    const rows = readSelfTestLogRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'auto-regrade');
    assert.equal(rows[0].old_vs_new_skipped, true, 'the CLI-wired regrade skips the historical delta');
    const roundFiles = readdirSync(join(root, '_tests', 'self-test', 'round-1'));
    assert.ok(!roundFiles.some((f) => /^results-/.test(f)), 'no deliberate results file written by the auto-regrade');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: no registered self-test round is a silent no-op — no self_test_regrade noise', () => {
  const root = makeProject();
  writeUnit(root, 'dc-1-foo', { type: 'decision', title: 'A decision', mtime: 1000 });
  try {
    const out = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.self_test_regrade, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: --dry-run skips the self-test auto-regrade entirely (no log write)', () => {
  const root = selfTestFixtureStore();
  try {
    newRound(root);
    const snapshotId = loadSnapshot(root, { captureBodies: true }).snapshotId;
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] }],
    };
    const goldPath = join(root, 'gold.json');
    writeFileSync(goldPath, JSON.stringify(gold));
    register(root, 1, goldPath);

    const out = execFileSync(process.execPath, [MAINT_SCRIPT, root, '--json', '--dry-run'], { encoding: 'utf8' });
    const parsed = JSON.parse(out);
    assert.equal(parsed.self_test_regrade, null, 'dry-run never regrades — it is a real append, not a report');
    assert.equal(readSelfTestLogRows(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
