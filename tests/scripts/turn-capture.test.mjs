import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import {
  captureTurnEvidence,
  turnCaptureEnabled,
  turnCaptureDir,
  turnCaptureLockPath,
  normalizeTurnEvidenceRow,
  runTurnCaptureRetention,
  purgeTurnCapture,
  turnCapturePurgeScope,
  readCaptureHealth,
  TURN_CAPTURE_SCHEMA_VERSION,
  TURN_CAPTURE_MAX_PROMPT_BYTES,
  TURN_CAPTURE_MAX_PACK_BYTES,
  TURN_CAPTURE_MAX_REJECTED,
  TURN_CAPTURE_DIR_MODE,
  TURN_CAPTURE_FILE_MODE,
} from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

const IS_WIN = platform() === 'win32';
const WS_ID = 'tc-fixture';

/** Project fixture. The opt-out flag lives in the PROJECT-ROOT workspace.json
 * (DC-129: an opt-OUT travelling with a copied project is privacy-safe — the
 * inverse of rich-context's machine-local opt-in reasoning). */
function makeProject(root, { turnCaptureFlag } = {}) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  const ptr = { workspace_id: WS_ID };
  if (turnCaptureFlag !== undefined) ptr.turn_capture = turnCaptureFlag;
  writeFileSync(join(project, 'workspace.json'), JSON.stringify(ptr));
  return project;
}

const goodRow = (extra = {}) => ({
  retrieval_id: 'rid-1',
  session_id: 's-1',
  harness: 'claude-code',
  prompt_text: 'how does the hindsight judge grade retrieval quality',
  delivered: [
    { id: 'dc-128-metrics', score: 12.4, source_stage: 'ranked', pack_text: 'DC-128: holistic metrics redesign …' },
    { id: 'obs-nonblocking', score: 9.1, source_stage: 'one-hop-expansion', pack_text: 'inventory of mechanics …' },
  ],
  rejected_top: [
    { id: 'dc-60-pivot', score: 3.2, source_stage: 'ranked' },
    { id: 'risk-1-selfref', score: 2.9, source_stage: 'ranked' },
  ],
  truncation: { byte_cap_applied: true, prompt_tokens_used: 8 },
  store_signature: 'u531-abcdef12',
  producer_version: '3.13.1',
  producer_sha: 'deadbeef',
  ...extra,
});

function cleanEnv(extra = {}) {
  // Isolated env so the runner's real CORE_* settings can't leak in.
  const env = { ...process.env, ...extra };
  delete env.CORE_METRICS_ENABLED;
  delete env.CORE_TURN_CAPTURE;
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

// ---------- gating ----------

test('default ON: no flags → enabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-on-'));
  try {
    const project = makeProject(root);
    assert.equal(turnCaptureEnabled({ project, env: cleanEnv() }), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CORE_TURN_CAPTURE=0 disables; row not written', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-env-off-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv({ CORE_TURN_CAPTURE: '0' });
    assert.equal(turnCaptureEnabled({ project, env }), false);
    const res = captureTurnEvidence(project, goodRow(), { env });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'disabled');
    assert.equal(existsSync(turnCaptureDir(project)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project workspace.json turn_capture:false disables', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-ws-off-'));
  try {
    const project = makeProject(root, { turnCaptureFlag: false });
    assert.equal(turnCaptureEnabled({ project, env: cleanEnv() }), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('master CORE_METRICS_ENABLED=0 disables capture (nested gate)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-master-off-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv({ CORE_METRICS_ENABLED: '0' });
    assert.equal(turnCaptureEnabled({ project, env }), false);
    const res = captureTurnEvidence(project, goodRow(), { env });
    assert.equal(res.written, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- writing ----------

test('writes one parseable JSONL row carrying all required fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-write-'));
  try {
    const project = makeProject(root);
    const res = captureTurnEvidence(project, goodRow(), { env: cleanEnv(), now: '2026-07-24T21:00:00.000Z' });
    assert.equal(res.written, true, JSON.stringify(res));
    const raw = readFileSync(res.path, 'utf8').trim().split('\n');
    assert.equal(raw.length, 1);
    const row = JSON.parse(raw[0]);
    assert.equal(row.kind, 'turn-evidence');
    assert.equal(row.schema_version, TURN_CAPTURE_SCHEMA_VERSION);
    assert.equal(row.retrieval_id, 'rid-1');
    assert.equal(row.session_id, 's-1');
    assert.equal(row.prompt_text, goodRow().prompt_text);
    assert.equal(row.delivered.length, 2);
    assert.equal(row.delivered[0].id, 'dc-128-metrics');
    assert.equal(row.delivered[0].pack_text.includes('DC-128'), true);
    assert.equal(row.rejected_top.length, 2);
    assert.equal(row.truncation.byte_cap_applied, true);
    assert.equal(row.store_signature, 'u531-abcdef12');
    assert.equal(row.producer_version, '3.13.1');
    assert.equal(row.producer_sha, 'deadbeef');
    assert.ok(row.ts.startsWith('2026-07-24'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('second write appends — two lines, both parse', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-append-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv();
    const a = captureTurnEvidence(project, goodRow({ retrieval_id: 'rid-a' }), { env, now: '2026-07-24T21:00:00.000Z' });
    const b = captureTurnEvidence(project, goodRow({ retrieval_id: 'rid-b' }), { env, now: '2026-07-24T21:00:01.000Z' });
    assert.equal(a.written, true);
    assert.equal(b.written, true);
    assert.equal(a.path, b.path);
    const rows = readFileSync(a.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.retrieval_id), ['rid-a', 'rid-b']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejected_top is bounded to TURN_CAPTURE_MAX_REJECTED entries', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `u-${i}`, score: 50 - i, source_stage: 'ranked' }));
  const row = normalizeTurnEvidenceRow(goodRow({ rejected_top: many }));
  assert.equal(row.rejected_top.length, TURN_CAPTURE_MAX_REJECTED);
  assert.equal(row.rejected_top[0].id, 'u-0');
});

test('the cutoff candidate score (first dropped beyond the bound) is recorded for tail density (Agy, Gate A)', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `u-${i}`, score: 50 - i, source_stage: 'ranked' }));
  const row = normalizeTurnEvidenceRow(goodRow({ rejected_top: many }));
  assert.equal(row.rejected_cutoff_score, 50 - TURN_CAPTURE_MAX_REJECTED, 'score of the 21st candidate');
  // nothing dropped → null, honestly
  const small = normalizeTurnEvidenceRow(goodRow());
  assert.equal(small.rejected_cutoff_score, null);
});

test('prompt_text byte-capped at TURN_CAPTURE_MAX_PROMPT_BYTES with honest truncation record', () => {
  const huge = 'x'.repeat(TURN_CAPTURE_MAX_PROMPT_BYTES + 5000);
  const row = normalizeTurnEvidenceRow(goodRow({ prompt_text: huge }));
  assert.equal(Buffer.byteLength(row.prompt_text, 'utf8') <= TURN_CAPTURE_MAX_PROMPT_BYTES, true);
  assert.equal(row.prompt_truncated, true);
  assert.equal(row.prompt_bytes, Buffer.byteLength(huge, 'utf8'));
});

test('per-unit pack_text byte-capped at TURN_CAPTURE_MAX_PACK_BYTES', () => {
  const huge = 'y'.repeat(TURN_CAPTURE_MAX_PACK_BYTES + 3000);
  const row = normalizeTurnEvidenceRow(goodRow({ delivered: [{ id: 'u-big', score: 1, source_stage: 'ranked', pack_text: huge }] }));
  assert.equal(Buffer.byteLength(row.delivered[0].pack_text, 'utf8') <= TURN_CAPTURE_MAX_PACK_BYTES, true);
  assert.equal(row.delivered[0].pack_truncated, true);
});

test('row-level pack_text (the combined delivered pack) is captured and byte-capped', () => {
  const row = normalizeTurnEvidenceRow(goodRow({ pack_text: 'the exact combined pack text the user turn received' }));
  assert.equal(row.pack_text, 'the exact combined pack text the user turn received');
  const huge = 'z'.repeat(TURN_CAPTURE_MAX_PACK_BYTES + 100);
  const capped = normalizeTurnEvidenceRow(goodRow({ pack_text: huge }));
  assert.equal(Buffer.byteLength(capped.pack_text, 'utf8') <= TURN_CAPTURE_MAX_PACK_BYTES, true);
  assert.equal(capped.pack_text_truncated, true);
});

test('empty prompt_text is an invalid row — reported, not thrown at capture', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-invalid-'));
  try {
    const project = makeProject(root);
    const res = captureTurnEvidence(project, goodRow({ prompt_text: '   ' }), { env: cleanEnv() });
    assert.equal(res.written, false);
    assert.match(res.reason, /invalid-row/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the stream dir self-excludes from git: first capture plants a .gitignore covering everything', () => {
  // Found live during the v3.14.0 Gate-C demo: CORE itself is a git-tracked
  // project and `_metrics/turn-capture/` was committable — the exact
  // content-in-the-repo-tree footgun the retired trace stream had. The stream
  // must protect itself regardless of any project-level .gitignore.
  const root = mkdtempSync(join(tmpdir(), 'tc-gitignore-'));
  try {
    const project = makeProject(root);
    const res = captureTurnEvidence(project, goodRow(), { env: cleanEnv() });
    assert.equal(res.written, true);
    const gi = join(turnCaptureDir(project), '.gitignore');
    assert.equal(existsSync(gi), true, 'stream .gitignore planted at first capture');
    assert.equal(readFileSync(gi, 'utf8').trim(), '*');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- permissions ----------

test('stream dir 0700 and row file 0600 on POSIX', { skip: IS_WIN }, () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-perm-'));
  try {
    const project = makeProject(root);
    const res = captureTurnEvidence(project, goodRow(), { env: cleanEnv() });
    assert.equal(res.written, true);
    assert.equal(statSync(turnCaptureDir(project)).mode & 0o777, TURN_CAPTURE_DIR_MODE);
    assert.equal(statSync(res.path).mode & 0o777, TURN_CAPTURE_FILE_MODE);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- fail-open + health ----------

test('write failure is fail-open and lands in the health counter', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-failopen-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv();
    // one good write so the stream + health file exist
    assert.equal(captureTurnEvidence(project, goodRow(), { env, now: '2026-07-24T21:00:00Z' }).written, true);
    // Squat the stream-dir path with a regular FILE: mkdirSync then fails with
    // ENOTDIR/EEXIST. Immune to the capture path's own perm re-hardening (which
    // correctly defeats chmod-based injection), and works on Windows too.
    rmSync(turnCaptureDir(project), { recursive: true, force: true });
    writeFileSync(turnCaptureDir(project), 'squatter');
    const res = captureTurnEvidence(project, goodRow({ retrieval_id: 'rid-fail' }), { env, now: '2026-07-24T21:00:01Z' });
    assert.equal(res.written, false);
    assert.match(res.reason, /capture-failed/);
    const health = readCaptureHealth(project);
    assert.equal(health.attempts, 2);
    assert.equal(health.failures, 1);
    assert.ok(health.last_failure_reason);
    assert.ok(health.last_failure_ts);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('health counts attempts on success too', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-health-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv();
    captureTurnEvidence(project, goodRow(), { env });
    captureTurnEvidence(project, goodRow(), { env });
    const health = readCaptureHealth(project);
    assert.equal(health.attempts, 2);
    assert.equal(health.failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('health tracks consecutive failures and a success resets the streak (Agy tripwire floor, Gate A)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-streak-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv();
    assert.equal(captureTurnEvidence(project, goodRow(), { env, now: '2026-07-24T21:00:00Z' }).written, true);
    // squat the stream dir to force failures
    rmSync(turnCaptureDir(project), { recursive: true, force: true });
    writeFileSync(turnCaptureDir(project), 'squatter');
    captureTurnEvidence(project, goodRow(), { env, now: '2026-07-24T21:00:01Z' });
    captureTurnEvidence(project, goodRow(), { env, now: '2026-07-24T21:00:02Z' });
    assert.equal(readCaptureHealth(project).consecutive_failures, 2);
    // clear the squatter — a success resets the streak, failures total stays
    rmSync(turnCaptureDir(project), { force: true });
    assert.equal(captureTurnEvidence(project, goodRow(), { env, now: '2026-07-24T21:00:03Z' }).written, true);
    const health = readCaptureHealth(project);
    assert.equal(health.consecutive_failures, 0);
    assert.equal(health.failures, 2);
    assert.equal(health.attempts, 4);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------- retention + purge ----------

test('retention deletes only files strictly older than the window', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-ret-'));
  try {
    const project = makeProject(root);
    const dir = turnCaptureDir(project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-05-01.jsonl'), '{"old":true}\n');
    writeFileSync(join(dir, '2026-07-20.jsonl'), '{"recent":true}\n');
    const res = runTurnCaptureRetention(project, { windowDays: 30, now: '2026-07-24T00:00:00Z', apply: true });
    assert.equal(res.ran, true);
    assert.equal(res.deleted.length, 1);
    assert.match(res.deleted[0], /2026-05-01\.jsonl$/);
    assert.equal(existsSync(join(dir, '2026-07-20.jsonl')), true);
    assert.equal(res.verified, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('purge removes the stream dir and refuses anything else', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-purge-'));
  try {
    const project = makeProject(root);
    captureTurnEvidence(project, goodRow(), { env: cleanEnv() });
    const dir = turnCaptureDir(project);
    assert.equal(existsSync(dir), true);
    const res = purgeTurnCapture(project, { apply: true });
    assert.equal(res.purged, true);
    assert.equal(existsSync(dir), false);
    // idempotent second purge
    assert.equal(purgeTurnCapture(project, { apply: true }).purged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('purge covers the whole declared scope — nested files, interrupted writes, derived judgments, health counters', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-purge-scope-'));
  try {
    const project = makeProject(root);
    captureTurnEvidence(project, goodRow(), { env: cleanEnv() });
    const dir = turnCaptureDir(project);
    const base = join(project, '_metrics');
    // Derived copies a purge must not leave behind.
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'nested', 'overlay.jsonl'), '{"prompt_text":"secret"}\n');
    writeFileSync(join(dir, '2026-07-20.jsonl.tmp'), '{"interrupted":true}\n');
    writeFileSync(join(base, 'judgment-log.jsonl'), '{"kind":"hindsight-judgment"}\n');
    assert.equal(existsSync(join(base, 'turn-capture-health.json')), true);

    const res = purgeTurnCapture(project, { apply: true });
    assert.equal(res.purged, true);
    for (const entry of res.scope) {
      assert.equal(entry.removed, true, `${entry.id} removed`);
      assert.equal(existsSync(entry.path), false, `${entry.path} gone`);
    }
    assert.deepEqual(res.scope.map((e) => e.id).sort(), ['health', 'judgments', 'stream']);
    assert.equal(existsSync(join(dir, 'nested', 'overlay.jsonl')), false);
    assert.equal(existsSync(join(dir, '2026-07-20.jsonl.tmp')), false);
    assert.equal(existsSync(join(base, 'turn-capture-health.json')), false);
    assert.equal(existsSync(join(base, 'judgment-log.jsonl')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('purge REPORTS a scope entry it could not remove instead of silently skipping it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-purge-obstructed-'));
  try {
    const project = makeProject(root);
    captureTurnEvidence(project, goodRow(), { env: cleanEnv() });
    const base = join(project, '_metrics');
    // Something else occupies the health-counter path as a non-empty directory:
    // a real "could not remove this" case for a single-file scope entry.
    rmSync(join(base, 'turn-capture-health.json'), { force: true });
    mkdirSync(join(base, 'turn-capture-health.json'), { recursive: true });
    writeFileSync(join(base, 'turn-capture-health.json', 'blocker'), 'x');

    const res = purgeTurnCapture(project, { apply: true });
    assert.equal(res.purged, false, 'a partial purge is not reported as a purge');
    const health = res.scope.find((e) => e.id === 'health');
    assert.equal(health.removed, false);
    assert.ok(health.reason, 'the obstruction is named');
    assert.equal(res.scope.find((e) => e.id === 'stream').removed, true, 'the rest of the scope still runs');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('retention refuses an invalid window BEFORE any deletion runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-ret-window-'));
  try {
    const project = makeProject(root);
    const dir = turnCaptureDir(project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-05-01.jsonl'), '{"old":true}\n');
    for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '30', null]) {
      const res = runTurnCaptureRetention(project, { windowDays: bad, now: '2026-07-24T00:00:00Z', apply: true });
      assert.equal(res.ran, false, `window ${String(bad)} refused`);
      assert.equal(res.reason, 'invalid-window');
      assert.deepEqual(res.candidates, [], `window ${String(bad)} never names a candidate`);
      assert.equal(existsSync(join(dir, '2026-05-01.jsonl')), true, `window ${String(bad)} deleted nothing`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('every declared purge-scope path sits directly under the storage base', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-purge-decl-'));
  try {
    const project = makeProject(root);
    const base = join(project, '_metrics');
    const scope = turnCapturePurgeScope(project);
    assert.ok(scope.length >= 3);
    for (const entry of scope) {
      assert.equal(dirname(entry.path), base, `${entry.id} is a direct child of the storage base`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lock path is a stable sibling OUTSIDE the purged dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-lock-'));
  try {
    const project = makeProject(root);
    const lock = turnCaptureLockPath(project);
    const dir = turnCaptureDir(project);
    assert.equal(lock.startsWith(dir), false);
    assert.equal(lock.endsWith('.turn-capture.lock'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a malformed row counts as a failed attempt in the health counter (a systematic rejection must be visible)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-invalid-health-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv();
    // A caller that stops supplying prompt_text is a live failure: every turn
    // is rejected. If the attempt is not counted, failures/attempts stays 0/0
    // and the capture-failure tripwire can never see it.
    for (let i = 0; i < 3; i++) {
      const res = captureTurnEvidence(project, { retrieval_id: `r-${i}`, session_id: 's' }, { env });
      assert.equal(res.written, false);
    }
    const health = readCaptureHealth(project);
    assert.equal(health.attempts, 3, 'rejected rows must count as attempts');
    assert.equal(health.failures, 3, 'rejected rows must count as failures');
    assert.equal(health.consecutive_failures, 3, 'a rejection streak must be visible to the tripwire');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an opt-out is not a failure (disabled capture leaves the health counter untouched)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tc-optout-health-'));
  try {
    const project = makeProject(root);
    const env = cleanEnv({ CORE_TURN_CAPTURE: '0' });
    const res = captureTurnEvidence(project, goodRow(), { env });
    assert.equal(res.written, false);
    assert.equal(res.reason, 'disabled');
    const health = readCaptureHealth(project);
    assert.equal(health.attempts, 0, 'opting out must never read as a failing recorder');
    assert.equal(health.failures, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
