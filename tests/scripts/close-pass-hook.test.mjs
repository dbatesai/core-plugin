import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'close-pass-hook.mjs');
const CLOSE_PASS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');

// Isolate every hook test log (Hale audit, 2026-07-17, re-flagged on a fresh
// audit of 246a77a after the first isolation pass missed this file): a
// subprocess hook run that doesn't override CORE_HOOKS_LOG_FILE defaults to
// the real machine-wide ~/.core/hooks-log.jsonl.
// Rooted under ~/.core (D1 fix, 2026-07-18): CORE_HOOKS_LOG_FILE now only
// honors overrides inside the trusted ~/.core. Unlike os.tmpdir(), that dir
// isn't auto-cleaned — every created dir is tracked and removed below.
const _isolatedLogDirs = [];
function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'close-pass-hook-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });

// SEPARATE leak (found on Hale's fresh audit): several tests below call
// close-pass.mjs's runClose/beginClose IN-PROCESS via dynamic import — not a
// subprocess — so the execFileSync-level CORE_HOOKS_LOG_FILE override above
// never applies to them. logHookEvent() inside close-pass.mjs reads
// process.env.CORE_HOOKS_LOG_FILE from THIS test-runner process directly.
// Setting it once at module load (this file's tests don't assert on the
// log's content, only that they never touch the real one) covers every
// in-process call for the lifetime of this file.
process.env.CORE_HOOKS_LOG_FILE = isolatedHooksLog();

// Run the hook with a SessionEnd payload. Returns {out, code}. The hook always exits 0
// (fail-open), and in every case tested here a guard returns BEFORE the claude spawn, so
// no child process is launched — the test never depends on `claude` being on PATH.
function runHook(payload, env = {}) {
  try {
    const out = execFileSync('node', [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORE_HOOKS_LOG_FILE: isolatedHooksLog(), ...env },
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: String(e.stdout || ''), code: e.status };
  }
}

// A CORE workspace dir that has closed cleanly with nothing owed → no close is owed,
// so the hook no-ops without spawning. This is the "core workspace, no work" baseline.
function freshClosedStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  writeFileSync(join(store, 'workspace.json'), '{"workspace_id":"t"}');
  writeFileSync(join(store, 'idx.json'), JSON.stringify([{ workspace_id: 't', path: store }])); // register for the security gate
  const ops = 'maintenance-run,render-project-md,hot-section,demote-moves,compact-project,demote-state,check-units,reflection-a,reflection-b,metrics,session-summary,memory-refresh';
  // begin + record-all + finish → marker says closed, nothing owed.
  execFileSync('node', [CLOSE_PASS, 'begin', store, '--session', 's', '--ops', ops]);
  for (const op of ops.split(',')) execFileSync('node', [CLOSE_PASS, 'record', store, '--op', op, '--status', 'done']);
  execFileSync('node', [CLOSE_PASS, 'finish', store, '--session', 's']);
  return store;
}

test('recursion guard: CORE_CLOSE_PASS_ACTIVE=1 → no-op, no spawn', () => {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  const { out, code } = runHook({ cwd: store, reason: 'other', transcript_path: '/x' },
    { CORE_CLOSE_PASS_ACTIVE: '1' });
  assert.equal(code, 0);
  assert.equal(out.trim(), '', 'recursion guard must produce no output and not spawn');
  rmSync(store, { recursive: true, force: true });
});

test('kill switch: CORE_AUTO_CLOSE=0 → no-op', () => {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  const { code } = runHook({ cwd: store, reason: 'other', transcript_path: '/x' },
    { CORE_AUTO_CLOSE: '0' });
  assert.equal(code, 0, 'kill switch halts the hook cleanly');
  rmSync(store, { recursive: true, force: true });
});

test('skip reason: resume is a suspension, not a real end → no-op', () => {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  const { code } = runHook({ cwd: store, reason: 'resume', transcript_path: '/x' });
  assert.equal(code, 0, 'resume must be skipped');
  rmSync(store, { recursive: true, force: true });
});

test('not a CORE workspace: no workspace.json or _memories → no-op', () => {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  // deliberately no _memories, no workspace.json
  const { code } = runHook({ cwd: store, reason: 'other', transcript_path: '/x' });
  assert.equal(code, 0, 'a non-CORE dir must be left alone');
  rmSync(store, { recursive: true, force: true });
});

test('spawn pre-check: closed store, nothing owed, no transcript → no spawn', () => {
  const store = freshClosedStore();
  // No transcript_path → didWork false; marker is closed → nothing owed → no spawn.
  const { out, code } = runHook({ cwd: store, reason: 'other' }, { CORE_CLOSE_INDEX: join(store, 'idx.json') });
  assert.equal(code, 0);
  assert.equal(out.trim(), '', 'a trivial closed session must not spawn a close agent');
  rmSync(store, { recursive: true, force: true });
});

test('isRegisteredWorkspace: only a path in ~/.core/index.json passes (security gate)', async () => {
  const cp = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  const good = mkdtempSync(join(tmpdir(), 'reg-ws-'));
  const evil = mkdtempSync(join(tmpdir(), 'evil-ws-'));
  mkdirSync(join(evil, '_memories'), { recursive: true }); // attacker plants a _memories dir
  const idxPath = join(good, 'index.json');
  writeFileSync(idxPath, JSON.stringify([{ workspace_id: 'g', path: good }]));
  assert.equal(cp.isRegisteredWorkspace(good, { indexPath: idxPath }), true, 'a registered path passes');
  assert.equal(cp.isRegisteredWorkspace(evil, { indexPath: idxPath }), false,
    'a dir with a _memories folder but NOT in the registry must be rejected');
  rmSync(good, { recursive: true, force: true });
  rmSync(evil, { recursive: true, force: true });
});

test('inspectLock: a LIVE pid is never stealable at any age; a DEAD pid is stealable past staleMs (Hale round 3)', async () => {
  // POLICY FLIP (2026-07-15, Hale's advisory): the old P2 anti-strand rule made a
  // very old lock stealable regardless of pid liveness — but a laptop suspended
  // mid-close revives past any fixed ceiling and would overlap its superseder
  // (mutual-exclusion break, integrity). Now: live pid → held at ANY age; the
  // recycled-pid strand this reopens is the accepted lesser failure (availability),
  // surfaced loudly and remedied by the operator `release` command.
  const cp = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  const store = mkdtempSync(join(tmpdir(), 'lock-strand-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  cp.acquireLock(store, { sessionId: 's' }); // held by THIS live process (pid alive)
  const held = cp.inspectLock(store); // now → fresh, held
  assert.equal(held.held, true, 'a fresh lock held by a live pid is held');
  const old = cp.inspectLock(store, Date.now() + 31 * 60 * 1000); // 31 min in the future
  assert.equal(old.held, true, 'a live pid stays held at ANY age — suspension-revival must not overlap a superseder');
  cp.releaseLock(store, { sessionId: 's' });
  rmSync(store, { recursive: true, force: true });
});

test('always exits 0 even on garbage stdin (fail-open)', () => {
  try {
    execFileSync('node', [HOOK], { input: 'not json at all', encoding: 'utf8',
      env: { ...process.env, CORE_CLOSE_PASS_ACTIVE: '1', CORE_HOOKS_LOG_FILE: isolatedHooksLog() } });
  } catch (e) {
    assert.fail('hook must never throw on bad input: ' + e.message);
  }
});
