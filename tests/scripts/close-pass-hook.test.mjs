import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot, registryEnvFor } from './trusted-test-tmp.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'close-pass-hook.mjs');
const CLOSE_PASS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');

// Probe modules live in separately tracked test directories; receipts live in the
// explicit fixture project. Foreign overrides cannot redirect a production receipt.
const _isolatedLogDirs = [];
function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'close-pass-hook-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });

// A foreign override in this test process must not redirect in-process close receipts.
process.env.CORE_HOOKS_LOG_FILE = isolatedHooksLog();

// Run the real hook entry and record its exact skip receipt. Stub only the
// child spawn boundary, so the registered positive control proves every prior
// gate was reached without launching a detached writer into a removed fixture.
function runHook(payload, env = {}) {
  const log = join(payload.cwd, '_core', '_hooks', 'hooks-log.jsonl');
  const probeDir = dirname(isolatedHooksLog());
  const probe = join(probeDir, 'spawn-probe.mjs');
  const spawned = join(probeDir, 'spawned.json');
  writeFileSync(probe, `
    import cp from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    cp.spawn = (command, args) => {
      writeFileSync(${JSON.stringify(spawned)}, JSON.stringify({ command, args }));
      return { unref() {}, once(ev, fn) { if (ev === 'spawn') queueMicrotask(fn); return this; } };
    };
    syncBuiltinESMExports();
  `);
  let out = '', code = 0;
  try {
    out = execFileSync('node', ['--import', pathToFileURL(probe).href, HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, CORE_CLOSE_PASS_ACTIVE: '0', CORE_AUTO_CLOSE: '1', CORE_HOOKS_LOG_FILE: log, ...env },
      encoding: 'utf8',
    });
  } catch (e) { out = String(e.stdout || ''); code = e.status; }
  const events = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { out, code, events, spawned: existsSync(spawned) ? JSON.parse(readFileSync(spawned, 'utf8')) : null };
}

function registeredFixture(t) {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-registered-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, '_memories'), { recursive: true });
  writeFileSync(join(store, 'workspace.json'), '{"workspace_id":"registered-control"}');
  return {
    store,
    payload: { cwd: store, session_id: 'registered-session', reason: 'other' },
    env: registryEnvFor(store),
  };
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

test('registered positive control reaches the deterministic close spawn boundary', t => {
  const f = registeredFixture(t);
  const result = runHook(f.payload, f.env);
  assert.equal(result.code, 0);
  assert.equal(result.spawned?.command, process.execPath, 'the runner is this Node binary by path, not a PATH lookup');
  assert.ok(result.spawned.args.includes('process-request'));
  assert.ok(result.spawned.args.includes('registered-session'));
  assert.ok(result.events.some(e => e.hook === 'session-end' && e.action === 'spawn'));
});

for (const [name, override, reason, payloadChange] of [
  ['recursion guard', { CORE_CLOSE_PASS_ACTIVE: '1' }, 'recursion-guard', {}],
  ['kill switch', { CORE_AUTO_CLOSE: '0' }, 'kill-switch', {}],
  ['resume filter', {}, 'session-reason=resume', { reason: 'resume' }],
]) {
  test(`${name}: registered, owed session has exact skip receipt and no spawn`, t => {
    const f = registeredFixture(t);
    const result = runHook({ ...f.payload, ...payloadChange }, { ...f.env, ...override });
    assert.equal(result.code, 0);
    assert.equal(result.out.trim(), '');
    assert.equal(result.spawned, null, 'guard must prevent the child spawn');
    assert.ok(result.events.some(e => e.hook === 'session-end' && e.action === 'skip' && e.reason === reason),
      `expected exact ${reason} receipt, got ${JSON.stringify(result.events)}`);
  });
}

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

test('isRegisteredWorkspace: only a path in the ~/.core registry passes (security gate)', async () => {
  const cp = await import('../../plugins/core/skills/core/scripts/close-pass.mjs');
  const registry = mkdtempSync(join(tmpdir(), 'reg-core-'));
  const good = mkdtempSync(join(tmpdir(), 'reg-ws-'));
  const evil = mkdtempSync(join(tmpdir(), 'evil-ws-'));
  mkdirSync(join(evil, '_memories'), { recursive: true }); // attacker plants a _memories dir
  mkdirSync(join(evil, '_core', 'claude-code'), { recursive: true }); // and a .core/ state folder
  const idxPath = join(registry, 'projects.json');
  writeFileSync(idxPath, JSON.stringify([{ path: good }]));
  assert.equal(cp.isRegisteredWorkspace(good, { indexPath: idxPath }), true, 'a registered path passes');
  assert.equal(cp.isRegisteredWorkspace(evil, { indexPath: idxPath }), false,
    'a dir with _memories and .core folders but NOT in the registry must be rejected');
  // The legacy index.json still counts while older installs register there.
  writeFileSync(join(registry, 'index.json'), JSON.stringify([{ workspace_id: 'old', path: evil }]));
  assert.equal(cp.isRegisteredWorkspace(evil, { indexPath: idxPath }), true, 'a legacy registration passes');
  for (const d of [registry, good, evil]) rmSync(d, { recursive: true, force: true });
});

test('inspectLock: a LIVE pid is never stealable at any age; a DEAD pid is stealable past staleMs', async () => {
  // The prior anti-strand rule made a very old lock stealable regardless of
  // pid liveness — but a laptop suspended mid-close revives past any fixed
  // ceiling and would overlap its superseder (mutual-exclusion break,
  // integrity). Now: live pid → held at ANY age; the
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

// The receipt must tell a launch that started from one that did not. These go through the REAL
// spawn and its events; only the child's arguments (or its path) are swapped so nothing writes
// into a fixture that is about to be removed.
function runRealSpawn(t, rewrite, extraEnv = {}) {
  const f = registeredFixture(t);
  const log = join(f.store, '_core', '_hooks', 'hooks-log.jsonl');
  const probeDir = dirname(isolatedHooksLog());
  const probe = join(probeDir, 'real-spawn-probe.mjs');
  writeFileSync(probe, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const real = cp.spawn;
    cp.spawn = (command, args, opts) => { const [c, a] = (${rewrite})(command, args); return real(c, a, opts); };
    syncBuiltinESMExports();
  `);
  execFileSync(process.execPath, ['--import', pathToFileURL(probe).href, HOOK], {
    input: JSON.stringify(f.payload), encoding: 'utf8',
    env: { ...process.env, CORE_CLOSE_PASS_ACTIVE: '0', CORE_AUTO_CLOSE: '1', CORE_HOOKS_LOG_FILE: log, ...f.env, ...extraEnv },
  });
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.hook === 'session-end');
}

test('SessionEnd with no node on PATH still starts its close (its own binary, by path) and only then says spawn', t => {
  const rows = runRealSpawn(t, `(command) => [command, ['-e', '']]`, { PATH: '' });
  assert.equal(rows.at(-1).action, 'spawn');
});

test('SessionEnd whose close cannot be launched says spawn-failed with the reason, never spawn', t => {
  // A missing executable fails asynchronously, after spawn() has returned.
  const rows = runRealSpawn(t, `(command, args) => ['/nonexistent/core-test-binary', args]`);
  assert.deepEqual([rows.at(-1).action, rows.at(-1).reason], ['spawn-failed', 'ENOENT']);
  assert.ok(!rows.some((r) => r.action === 'spawn'), 'no row claims the close started');
});

test('pure resume helper returns its skip decision without caller receipt context', async () => {
  const { decideCloseAction } = await import('../../plugins/core/skills/core/hooks/close-pass-hook.mjs');
  assert.deepEqual(decideCloseAction({ reason: 'resume' }), { action: 'skip', reason: 'session-reason=resume' });
});
