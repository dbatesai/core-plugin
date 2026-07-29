import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import {
  detectCloseState, beginClose, recordOp, releaseLock, finishClose, CLOSE_OPS,
  certifyManualClose, readCloseReceipt, shouldEnqueueClose,
} from '../../plugins/core/skills/core/scripts/close-pass.mjs';
import { writeFileSync } from 'node:fs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');

// Same isolation as close-pass-hook.test.mjs: logHookEvent() reads
// CORE_HOOKS_LOG_FILE from process.env directly, and it only honors overrides
// inside the trusted ~/.core (D1 fix) — os.tmpdir() doesn't qualify. This file
// doesn't assert on log content, only that runClose/CLI paths never touch the
// real machine-wide ~/.core/hooks-log.jsonl.
const _isolatedLogDirs = [];
function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'close-pass-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });
process.env.CORE_HOOKS_LOG_FILE = isolatedHooksLog();

function freshStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-pass-cli-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  return store;
}

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CORE_HOOKS_LOG_FILE: process.env.CORE_HOOKS_LOG_FILE, ...env },
  });
  return res;
}

// ---- CLI dispatch coverage: main()'s subcommands, selfTest() via --self-test
// (fully self-contained), and detectCloseState's pure branches. ----

test('CLI --self-test runs the built-in 7-check self-test and exits 0', () => {
  const res = runCli(['--self-test']);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /close-pass self-test: PASS \(7 checks\)/);
});

test('CLI with no subcommand or no store prints usage and exits 2', () => {
  const res = runCli([]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: close-pass\.mjs/);

  const res2 = runCli(['detect']); // subcommand but no store
  assert.equal(res2.status, 2);
  assert.match(res2.stderr, /usage: close-pass\.mjs/);
});

test('CLI unknown subcommand exits 2 with an error naming it', () => {
  const store = freshStore();
  try {
    const res = runCli(['bogus', store]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown subcommand: bogus/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('CLI detect: no marker → owed, all ops listed; --json emits parseable state', () => {
  const store = freshStore();
  try {
    const res = runCli(['detect', store, '--ops', 'a,b,c']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /^owed owed=a,b,c/);

    const jsonRes = runCli(['detect', store, '--ops', 'a,b,c', '--json']);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.state, 'owed');
    assert.deepEqual(parsed.owed, ['a', 'b', 'c']);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('CLI begin/record/finish/release round-trip through the real subprocess boundary', () => {
  const store = freshStore();
  try {
    const begin = runCli(['begin', store, '--session', 's1', '--ops', 'a,b']);
    assert.equal(begin.status, 0);
    assert.match(begin.stdout, /lock acquired; close in-progress/);

    // A second begin while the first holds the lock is refused.
    const begin2 = runCli(['begin', store, '--session', 's2', '--ops', 'a,b']);
    assert.equal(begin2.status, 1);
    assert.match(begin2.stdout, /another close is running/);

    const recordNoOp = runCli(['record', store]);
    assert.equal(recordNoOp.status, 2, 'record without --op is an error');
    assert.match(recordNoOp.stderr, /record needs --op/);

    const record = runCli(['record', store, '--op', 'a']);
    assert.equal(record.status, 0);

    const finish = runCli(['finish', store, '--session', 's1']);
    assert.equal(finish.status, 0);
    assert.match(finish.stdout, /close marked closed; lock released/);

    // Lock is gone — a bare `release` on an already-released store is still a clean 0.
    const release = runCli(['release', store]);
    assert.equal(release.status, 0);
    assert.match(release.stdout, /lock released/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('detectCloseState: crashed-mid-close with a store-signature mismatch re-owes store-derived ops only (line 190 branch)', () => {
  const store = freshStore();
  try {
    const ALL = ['maintenance-run', 'reflection-a']; // one store-derived, one not (per STORE_DERIVED set)
    beginClose(store, { sessionId: 's1', ops: ALL, storeSignature: 'SIG-A' });
    recordOp(store, { op: 'reflection-a' }); // mark the non-store-derived op done
    releaseLock(store); // simulate a crash: lock drops, marker never reaches 'closed'

    const det = detectCloseState(store, { allOps: ALL, storeSignature: 'SIG-B' });
    assert.equal(det.state, 'owed');
    assert.equal(det.reason, 'crashed-mid-close');
    // sigMismatch branch: re-owe store-derived ops even though not "done"; the
    // already-recorded-done transcript op should NOT reappear.
    assert.ok(det.owed.includes('maintenance-run'), 'store-derived op re-owed on signature drift');
    assert.ok(!det.owed.includes('reflection-a'), 'already-done transcript op not re-owed');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// Hale's falsifier (2026-07-21, close-marker-semantic-gap): a spawnFinalize that returns
// success (or a test-stub `undefined`, treated as success per P1/P5) WITHOUT the headless
// child ever calling `close-pass.mjs record --op <op>` for the ten judgment ops (everything
// beyond maintenance-run) must not read back as a complete, nothing-owed close. Confirmed
// live production markers DO carry all twelve ops when the headless child follows the
// finalize protocol correctly (`_close-marker.json` on a real close shows every op recorded)
// — so this isn't "the mechanism never works," it's "the parent trusts the child's exit code
// as a proxy for protocol compliance, with nothing checking that compliance actually happened."
test('detectCloseState: a closed marker with every CLOSE_OPS entry actually recorded reads as complete (the healthy-path counterpart)', () => {
  const store = freshStore();
  try {
    const b = beginClose(store, { sessionId: 's-healthy', ops: CLOSE_OPS });
    assert.ok(b.ok);
    for (const op of CLOSE_OPS) recordOp(store, { op, status: 'done' });
    finishClose(store, { sessionId: 's-healthy' });
    const det = detectCloseState(store, { allOps: CLOSE_OPS });
    assert.equal(det.state, 'closed', 'a genuinely complete close must not be penalized by the completeness check');
    assert.deepEqual(det.owed, []);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('beginClose: a marker-write failure releases the lock it just took and rethrows (P3)', () => {
  const store = freshStore();
  try {
    // Pre-create the marker path AS A DIRECTORY so atomicWriteFileSync's write fails.
    mkdirSync(join(store, '_memories', '_close-marker.json'));
    assert.throws(() => beginClose(store, { sessionId: 's1', ops: ['a'] }));
    // The lock must not be stranded — a fresh begin (after clearing the bad marker
    // path) should succeed rather than reporting "held".
    rmSync(join(store, '_memories', '_close-marker.json'), { recursive: true, force: true });
    const r = beginClose(store, { sessionId: 's2', ops: ['a'] });
    assert.ok(r.ok, 'lock was released on the failed attempt, so a fresh begin can acquire it');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('CLI: the model-spawn close verb does not exist — `run` is rejected as unknown', () => {
  const store = freshStore();
  try {
    const r = spawnSync(process.execPath, [SCRIPT, 'run', store], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'the `run` subcommand must not be a valid close entry');
    assert.ok(!/close complete/.test(r.stdout || ''), 'no close envelope may execute via `run`');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('certify: an explicit session id writes the closed receipt and suppresses the automatic close', () => {
  const store = freshStore();
  try {
    const root = join(store, '_metrics');
    mkdirSync(join(root, 'close', 'receipts'), { recursive: true });
    const opts = { storageRoot: root };
    const r = certifyManualClose(store, { sessionId: 'sess-manual-1', summaryPath: '_summaries/summary-x.md' }, opts);
    assert.ok(r.ok, JSON.stringify(r));
    const receipt = readCloseReceipt(store, 'sess-manual-1', opts);
    assert.equal(receipt.status, 'closed');
    assert.equal(receipt.summary_path, '_summaries/summary-x.md');
    assert.equal(shouldEnqueueClose(store, { sessionId: 'sess-manual-1' }, opts), false,
      'a certified session must not be re-closed by the hook');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('certify: refuses to invent an identity when no session can be resolved', () => {
  const store = freshStore();
  try {
    const root = join(store, '_metrics');
    mkdirSync(join(root, 'close', 'receipts'), { recursive: true });
    const r = certifyManualClose(store, { home: join(store, 'no-such-home') }, { storageRoot: root });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unresolved');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('certify: an already-closed session is a clean no-op, not an error or a second receipt', () => {
  const store = freshStore();
  try {
    const root = join(store, '_metrics');
    mkdirSync(join(root, 'close', 'receipts'), { recursive: true });
    const opts = { storageRoot: root };
    certifyManualClose(store, { sessionId: 's-again', summaryPath: 'a.md' }, opts);
    const r2 = certifyManualClose(store, { sessionId: 's-again', summaryPath: 'b.md' }, opts);
    assert.ok(r2.ok && r2.already, 'second certify reports already-closed');
    const receipt = readCloseReceipt(store, 's-again', opts);
    assert.equal(receipt.summary_path, 'a.md', 'the original receipt is preserved');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('certify: auto-resolves the session from a real project-bound transcript (the SKILL.md path, no --session)', async () => {
  const store = freshStore();
  const home = mkdtempSync(join(tmpdir(), 'certify-home-'));
  try {
    const { mapProjectPathToSlug } = await import('../../plugins/core/skills/core/scripts/project-slug.mjs');
    const { realpathSync } = await import('node:fs');
    const canon = realpathSync(store);
    const tdir = join(home, '.claude', 'projects', mapProjectPathToSlug(canon));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 'sess-auto-77.jsonl'), '{"type":"user"}\n');

    const root = join(store, '_metrics');
    mkdirSync(join(root, 'close', 'receipts'), { recursive: true });
    const opts = { storageRoot: root };
    const r = certifyManualClose(store, { summaryPath: 's.md', home }, opts);
    assert.ok(r.ok, `auto-resolve must certify from the project transcript: ${JSON.stringify(r)}`);
    assert.equal(r.session_id, 'sess-auto-77');
    const receipt = readCloseReceipt(store, 'sess-auto-77', opts);
    assert.equal(receipt.status, 'closed');
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
