import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'close-pass-hook.mjs');
const CLOSE_PASS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');

// Run the hook with a SessionEnd payload. Returns {out, code}. The hook always exits 0
// (fail-open), and in every case tested here a guard returns BEFORE the claude spawn, so
// no child process is launched — the test never depends on `claude` being on PATH.
function runHook(payload, env = {}) {
  try {
    const out = execFileSync('node', [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORE_CLOSE_STORE: payload.cwd || '', ...env },
      encoding: 'utf8',
    });
    return { out, code: 0 };
  } catch (e) {
    return { out: String(e.stdout || ''), code: e.status };
  }
}

// A CORE workspace dir that has closed cleanly with nothing owed → shouldSpawn is false,
// so the hook no-ops without spawning. This is the "core workspace, no work" baseline.
function freshClosedStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  writeFileSync(join(store, 'workspace.json'), '{"workspace_id":"t"}');
  const ops = 'maintenance-run,render-project-md,hot-section,demote-moves,compact-project,demote-state,check-units,reflection-a,reflection-b,metrics,summary-stub,memory-refresh';
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
  // No transcript_path → didWork false; marker is closed → nothing owed → shouldSpawn false.
  const { out, code } = runHook({ cwd: store, reason: 'other' });
  assert.equal(code, 0);
  assert.equal(out.trim(), '', 'a trivial closed session must not spawn a close agent');
  rmSync(store, { recursive: true, force: true });
});

test('always exits 0 even on garbage stdin (fail-open)', () => {
  try {
    execFileSync('node', [HOOK], { input: 'not json at all', encoding: 'utf8',
      env: { ...process.env, CORE_CLOSE_PASS_ACTIVE: '1' } });
  } catch (e) {
    assert.fail('hook must never throw on bad input: ' + e.message);
  }
});
