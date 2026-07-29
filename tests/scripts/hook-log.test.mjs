import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { trustedTestTmpRoot, symlinkCapable } from './trusted-test-tmp.mjs';
import { resolveHookLogPath, logHookEvent } from '../../plugins/core/skills/core/hooks/hook-log.mjs';

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

// Rooted under ~/.core (D1 fix, 2026-07-18): CORE_HOOKS_LOG_FILE now only
// honors overrides inside the trusted ~/.core. Unlike os.tmpdir(), that dir
// isn't auto-cleaned — every created dir is tracked and removed below.
const _isolatedLogDirs = [];
function tmpLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'hook-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });

// Isolate every hook test log by construction (Hale audit, 2026-07-17, fresh
// re-audit of 246a77a): every current call site here happens to pass
// CORE_HOOKS_LOG_FILE explicitly, but the helpers themselves had no default —
// one call a future test author forgets to annotate silently writes into the
// real machine-wide ~/.core/hooks-log.jsonl. Default here, so "isolated" is
// the only way to call these, not a convention every caller has to remember.
function runStart(env) {
  try { execFileSync('node', [START_HOOK], { input: '{}', env: { ...process.env, CORE_HOOKS_LOG_FILE: tmpLog(), ...env }, encoding: 'utf8' }); }
  catch { /* hook exits 0; ignore */ }
}

function spawnCloseHook(payload, env) {
  try {
    execFileSync('node', [CLOSE_HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORE_HOOKS_LOG_FILE: tmpLog(), ...env },
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

test('SessionStart no-ops for the close child (CORE_CLOSE_PASS_ACTIVE=1 → no /core inject)', () => {
  const log = tmpLog();
  runStart({ CORE_HOOKS_LOG_FILE: log, CORE_CLOSE_PASS_ACTIVE: '1' });
  const events = readLog(log);
  assert.ok(events.some(e => e.action === 'skip' && e.reason === 'close-pass-child'),
    'the headless close child must NOT be told to run /core — it has one job, /finalize');
  assert.ok(!events.some(e => e.action === 'inject'), 'no inject for the close child');
});

test('SessionEnd recursion guard logs reason=recursion-guard (proves the child fired + was suppressed)', () => {
  const log = tmpLog();
  const store = mkdtempSync(join(tmpdir(), 'hook-log-store-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  spawnCloseHook({ cwd: store, reason: 'other', transcript_path: '/x' },
    { CORE_HOOKS_LOG_FILE: log, CORE_CLOSE_PASS_ACTIVE: '1' });
  const events = readLog(log);
  assert.ok(events.some(e => e.hook === 'session-end' && e.reason === 'recursion-guard'),
    'the recursion guard must log its skip');
  rmSync(store, { recursive: true, force: true });
});

// The "trivial closed session → don't spawn" decision (the nothing-owed path) is now
// asserted IN-PROCESS via shouldSpawn. It can't be exercised through the hook subprocess
// anymore: the hardened trust gate (trustedHome + resolveIndexPath) checks the REAL
// ~/.core registry, which a subprocess can't redirect via env, so a temp store can never
// reach the nothing-owed branch — it fails closed at not-registered-workspace (covered
// by the next test). Security anchors are DI-tested in-process; see the close-authority spec.
test('shouldSpawn: a closed store with nothing owed does not spawn (nothing-owed decision)', async () => {
  const { shouldSpawn, CLOSE_OPS } = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  const store = mkdtempSync(join(tmpdir(), 'hook-log-closed-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  const ops = CLOSE_OPS.join(',');
  execFileSync('node', [CLOSE_PASS, 'begin', store, '--session', 's', '--ops', ops]);
  for (const op of CLOSE_OPS) execFileSync('node', [CLOSE_PASS, 'record', store, '--op', op, '--status', 'done']);
  execFileSync('node', [CLOSE_PASS, 'finish', store, '--session', 's']);
  // didWork false, marker closed, nothing owed → must not spawn.
  assert.equal(shouldSpawn(store, { didWork: false, allOps: CLOSE_OPS }), false,
    'a trivial closed session must not spawn a close agent');
  rmSync(store, { recursive: true, force: true });
});

test('SessionEnd on an UNREGISTERED dir (attacker _memories/) skips — security gate', () => {
  const log = tmpLog();
  const store = mkdtempSync(join(tmpdir(), 'hook-log-evil-'));
  mkdirSync(join(store, '_memories'), { recursive: true }); // looks like a CORE store but isn't registered
  const emptyIdx = join(store, 'idx.json');
  writeFileSync(emptyIdx, '[]');
  spawnCloseHook({ cwd: store, reason: 'other', transcript_path: '/x' }, { CORE_HOOKS_LOG_FILE: log, CORE_CLOSE_INDEX: emptyIdx });
  const events = readLog(log);
  assert.ok(events.some(e => e.reason === 'not-registered-workspace'),
    'an unregistered dir must be rejected even with a _memories/ folder');
  assert.ok(!events.some(e => e.action === 'spawn'), 'no close agent spawned for an unregistered dir');
  rmSync(store, { recursive: true, force: true });
});

// D1 (Crest, 2026-07-16 / Keel, 2026-07-18): CORE_HOOKS_LOG_FILE was read
// unconditionally, an arbitrary-file-append primitive reachable via a hostile
// project's forwarded settings.json env. Same fix shape and same test shape
// as close-index-path-validation.test.mjs's resolveIndexPath coverage.
test('resolveHookLogPath: a project-forwarded path outside ~/.core is ignored', () => {
  const home = homedir();
  const dflt = join(home, '.core', 'hooks-log.jsonl');
  assert.equal(resolveHookLogPath({ CORE_HOOKS_LOG_FILE: '/tmp/evil-repo/.fake-log.jsonl' }), dflt);
  assert.equal(resolveHookLogPath({ CORE_HOOKS_LOG_FILE: './.fake-log.jsonl' }), dflt);
  assert.equal(resolveHookLogPath({ CORE_HOOKS_LOG_FILE: join(home, 'Documents', 'x', 'log.jsonl') }), dflt);
});

test('resolveHookLogPath: a path under ~/.core is honored', () => {
  const ok = join(homedir(), '.core', 'custom-hooks-log.jsonl');
  assert.equal(resolveHookLogPath({ CORE_HOOKS_LOG_FILE: ok }), ok);
});

test('resolveHookLogPath: /dev/null is always honored (the documented silence affordance)', () => {
  assert.equal(resolveHookLogPath({ CORE_HOOKS_LOG_FILE: '/dev/null' }), '/dev/null');
});

test('resolveHookLogPath: no env var falls back to the default', () => {
  assert.equal(resolveHookLogPath({}), join(homedir(), '.core', 'hooks-log.jsonl'));
});

// D1 second pass (Hale + Antigravity, 2026-07-18): resolveHookLogPath()'s
// lexical check alone is a CWE-22-shaped gap — a symlink placed under the
// trusted ~/.core pointing outside it passes the string check while writes
// go through it to the real outside target. logHookEvent()'s canonical
// re-check (realpathSync after mkdir) is the actual defense; this proves it
// refuses the write rather than following the link, using a real symlink,
// not a hypothetical.
test('logHookEvent: a symlink under ~/.core pointing outside it is refused, not followed', (t) => {
  if (!symlinkCapable()) return t.skip('symlink privilege unavailable (Windows non-elevated box)');
  const outsideDir = mkdtempSync(join(tmpdir(), 'hook-log-outside-'));
  const linkDir = join(trustedTestTmpRoot(), `escape-link-${Date.now()}`);
  symlinkSync(outsideDir, linkDir, 'dir');
  const targetFile = join(linkDir, 'hooks-log.jsonl');
  try {
    const prior = process.env.CORE_HOOKS_LOG_FILE;
    process.env.CORE_HOOKS_LOG_FILE = targetFile;
    try {
      const result = logHookEvent({ hook: 'test', action: 'skip' });
      assert.equal(result.written, false, 'a symlinked escape must be refused, not written through');
      assert.equal(result.error_code, 'hook-log-untrusted-target');
      assert.ok(!existsSync(join(outsideDir, 'hooks-log.jsonl')), 'the real outside target must never receive the write');
    } finally {
      if (prior === undefined) delete process.env.CORE_HOOKS_LOG_FILE;
      else process.env.CORE_HOOKS_LOG_FILE = prior;
    }
  } finally {
    rmSync(linkDir, { force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
