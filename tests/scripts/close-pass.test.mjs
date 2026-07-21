import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
import {
  detectCloseState, beginClose, recordOp, releaseLock, runClose,
  claudeSpawnShell,
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

// ---- coverage additions (2026-07-20, iteration ~73): main()'s CLI dispatch,
// selfTest() (invoked via --self-test — fully self-contained, no real process
// spawning), and two safe pure-function branches in runClose/detectCloseState
// had zero coverage. Deliberately NOT covering defaultSpawnFinalize (spawns a
// real `claude` CLI process) or the CLI `run` subcommand (drives that same
// real spawn) — those stay integration-verified, not unit-tested, per the
// same restraint this session applied to the disputed chaos/monkey scope. ----

test('CLI --self-test runs the built-in 8-check self-test and exits 0', () => {
  const res = runCli(['--self-test']);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /close-pass self-test: PASS \(8 checks\)/);
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

test('CLI should-spawn: exits 1 (no spawn) on a trivial session with nothing owed, 0 with --did-work', () => {
  const store = freshStore();
  try {
    // Nothing owed: no ops in scope at all.
    const res = runCli(['should-spawn', store]);
    assert.equal(res.status, 1, 'no work, no ops in scope -> skip spawn');

    const res2 = runCli(['should-spawn', store, '--did-work']);
    assert.equal(res2.status, 0, 'real work -> spawn regardless of owed state');
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

test('runClose: a spawnFinalize that THROWS (not just returns ok:false) is still caught and marks the close failed', () => {
  const store = freshStore();
  try {
    const r = runClose(store, { spawnFinalize: () => { throw new Error('finalize exploded'); } });
    assert.equal(r.ok, false, 'a thrown spawnFinalize must not crash runClose or report success');
    const det = detectCloseState(store, { allOps: [] });
    assert.equal(det.state, 'owed', 'a failed close is re-owed, not silently treated as closed');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('claudeSpawnShell: true only on win32 (the .cmd-shim EINVAL workaround), false elsewhere', () => {
  assert.equal(claudeSpawnShell('win32'), true);
  assert.equal(claudeSpawnShell('darwin'), false);
  assert.equal(claudeSpawnShell('linux'), false);
});

test('runClose: beginClose throwing (e.g. _memories path blocked) is caught, lock is released, close reports begin-failed', () => {
  const store = mkdtempSync(join(tmpdir(), 'close-pass-cli-'));
  try {
    // No _memories dir created — instead a FILE sits where _memories/ needs to be a
    // directory, so acquireLock's mkdirSync(..., {recursive:true}) throws ENOTDIR.
    writeFileSync(store + '/_memories', 'not a directory');
    const r = runClose(store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'begin-failed');
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
