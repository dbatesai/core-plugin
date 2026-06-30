import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks');
const START_HOOK = join(HOOKS, 'session-start-hook.mjs');
const CLOSE_HOOK = join(HOOKS, 'close-pass-hook.mjs');
const CLOSE_PASS = join(HOOKS, '..', 'scripts', 'close-pass.mjs');

// Read the JSONL log a hook wrote and return the parsed events.
function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function tmpLog() {
  return join(mkdtempSync(join(tmpdir(), 'hook-log-')), 'hooks-log.jsonl');
}

function runStart(env) {
  try { execFileSync('node', [START_HOOK], { input: '{}', env: { ...process.env, ...env }, encoding: 'utf8' }); }
  catch { /* hook exits 0; ignore */ }
}

function runClose(payload, env) {
  try {
    execFileSync('node', [CLOSE_HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORE_CLOSE_STORE: payload.cwd || '', ...env },
      encoding: 'utf8',
    });
  } catch { /* hook exits 0; ignore */ }
}

test('logHookEvent appends valid JSONL with ts + hook + action', async () => {
  const log = tmpLog();
  const { logHookEvent } = await import('../../plugins/core/skills/core/hooks/hook-log.mjs');
  process.env.CORE_HOOKS_LOG_FILE = log;
  logHookEvent({ hook: 'session-start', action: 'inject' });
  delete process.env.CORE_HOOKS_LOG_FILE;
  const events = readLog(log);
  assert.equal(events.length, 1);
  assert.equal(events[0].hook, 'session-start');
  assert.equal(events[0].action, 'inject');
  assert.ok(events[0].ts, 'every event carries a timestamp');
});

test('logHookEvent is fail-open: an unwritable path does not throw', async () => {
  const { logHookEvent } = await import('../../plugins/core/skills/core/hooks/hook-log.mjs');
  // a path whose parent is a FILE, not a directory → mkdir + append both fail
  const f = tmpLog();
  writeFileSync(f, 'x');
  process.env.CORE_HOOKS_LOG_FILE = join(f, 'cannot', 'log.jsonl');
  assert.doesNotThrow(() => logHookEvent({ hook: 'x', action: 'y' }), 'a logger must never throw');
  delete process.env.CORE_HOOKS_LOG_FILE;
});

test('SessionStart hook logs action=inject when it fires', () => {
  const log = tmpLog();
  runStart({ CORE_HOOKS_LOG_FILE: log, CORE_AUTOSTART: '' });
  const events = readLog(log);
  assert.ok(events.some(e => e.hook === 'session-start' && e.action === 'inject'),
    'a fired SessionStart must log an inject event');
});

test('SessionStart opt-out logs action=skip reason=opt-out', () => {
  const log = tmpLog();
  runStart({ CORE_HOOKS_LOG_FILE: log, CORE_AUTOSTART: '0' });
  const events = readLog(log);
  assert.ok(events.some(e => e.action === 'skip' && e.reason === 'opt-out'),
    'opting out must still log a skip so the log shows the hook ran and chose to skip');
});

test('SessionEnd recursion guard logs reason=recursion-guard (proves the child fired + was suppressed)', () => {
  const log = tmpLog();
  const store = mkdtempSync(join(tmpdir(), 'hook-log-store-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  runClose({ cwd: store, reason: 'other', transcript_path: '/x' },
    { CORE_HOOKS_LOG_FILE: log, CORE_CLOSE_PASS_ACTIVE: '1' });
  const events = readLog(log);
  assert.ok(events.some(e => e.hook === 'session-end' && e.reason === 'recursion-guard'),
    'the recursion guard must log its skip');
  rmSync(store, { recursive: true, force: true });
});

test('SessionEnd on a closed store logs reason=nothing-owed (no spurious spawn)', () => {
  const log = tmpLog();
  const store = mkdtempSync(join(tmpdir(), 'hook-log-store-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  writeFileSync(join(store, 'workspace.json'), '{"workspace_id":"t"}');
  const ops = 'maintenance-run,render-project-md,hot-section,demote-moves,compact-project,demote-state,check-units,reflection-a,reflection-b,metrics,summary-stub,memory-refresh';
  execFileSync('node', [CLOSE_PASS, 'begin', store, '--session', 's', '--ops', ops]);
  for (const op of ops.split(',')) execFileSync('node', [CLOSE_PASS, 'record', store, '--op', op, '--status', 'done']);
  execFileSync('node', [CLOSE_PASS, 'finish', store, '--session', 's']);
  runClose({ cwd: store, reason: 'other' }, { CORE_HOOKS_LOG_FILE: log });
  const events = readLog(log);
  assert.ok(events.some(e => e.hook === 'session-end' && e.reason === 'nothing-owed'),
    'a trivial closed session must log nothing-owed, not spawn');
  rmSync(store, { recursive: true, force: true });
});
