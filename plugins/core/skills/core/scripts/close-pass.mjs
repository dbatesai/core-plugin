/**
 * close-pass.mjs — session-close orchestration: lock, per-op marker, three-state detection.
 *
 * The reliability spine of self-managed maintenance (spec 2026-06-29). The exit hook
 * (Stop-hook claude -p) and the startup catch-up both drive close work through this
 * script so neither can lie about a half-finished close or race a second close agent.
 *
 * Three problems it solves (all caught by the 2026-06-29 adversarial pass):
 *   1. Partial close — a boolean "closed" marker can sit over a half-maintained store if
 *      the close agent dies mid-run. So the marker is PER-OP: it records which ops finished,
 *      and startup discharges whatever's still owed instead of trusting marker-presence.
 *   2. Concurrent close — close-then-reopen can put two agents against the same store. A
 *      single-flight lock (atomic 'wx' create, stale-stealable) serializes them, and
 *      detection reports a third state (in-progress) the boolean marker couldn't express.
 *   3. Wasted spawn — shouldSpawn() gates the exit-hook agent so a trivial session that
 *      did no real work and owes nothing never pays for a close agent.
 *
 * NOT a judgment engine. It tracks completion; it does not decide whether an op's WRITE is
 * safe — PROJECT.md-mutating ops stay edit-gated in startup.md/finalize, and the autonomous
 * judgment tier stays behind the DC-110 M3 preconditions. This is plumbing under that policy.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Cross-platform (no shell, no bash-isms).
 *
 * CLI:
 *   node close-pass.mjs detect <store> [--session <id>]      → prints state + owed ops (JSON on --json)
 *   node close-pass.mjs should-spawn <store> [--did-work] [--made-decision]  → exit 0 spawn / 1 skip
 *   node close-pass.mjs begin <store> --session <id> --ops a,b,c             → acquire lock + in-progress marker
 *   node close-pass.mjs record <store> --op <op> --status done|failed|skipped [--note "..."]
 *   node close-pass.mjs finish <store> [--session <id>]      → mark closed, release lock
 *   node close-pass.mjs release <store>                       → force-release a stale lock
 *   node close-pass.mjs --self-test
 */

import { readFileSync, openSync, writeSync, closeSync, rmSync, mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { trustedHome } from './trusted-home.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { acquireFileLock, releaseFileLock, inspectFileLock } from './file-lock.mjs';
import { runMaintenance } from './maintenance-run.mjs';
import { logHookEvent } from '../hooks/hook-log.mjs';

// A lock older than this with no live owner is stale and supersedable. Generous: a real close
// pass (claude -p re-reading a transcript) can take a couple of minutes.
export const LOCK_STALE_MS = 10 * 60 * 1000;
// Ceiling for locks whose owner can't be identified (unreadable payload, no pid). A lock with
// a READABLE LIVE pid is never auto-superseded at ANY age (Hale round 3, 2026-07-15): a laptop
// suspended mid-close revives past any ceiling and would overlap its superseder. The recycled-
// pid strand this reopens (pidAlive→true forever → closes skip) is the accepted lesser failure:
// detect reports in-progress, startup narrates it, and `close-pass.mjs release` is the remedy.
export const LOCK_HARD_STALE_MS = 30 * 60 * 1000;

const markerPath = (store) => join(resolve(store), '_memories', '_close-marker.json');
const lockPath = (store) => join(resolve(store), '_memories', '_close.lock');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Is the lock currently held by a live, non-stale owner?
 * Delegates to file-lock.mjs (extracted 2026-07-14, shared-write concurrency spec).
 * @returns {{ held: boolean, lock: object|null, stale: boolean }}
 */
export function inspectLock(store, now = Date.now()) {
  return inspectFileLock(lockPath(store), { now, staleMs: LOCK_STALE_MS, hardStaleMs: LOCK_HARD_STALE_MS });
}

/**
 * Acquire the single-flight lock. Atomic 'wx' create; a stale lock is stolen via
 * file-lock.mjs's rename-claim CAS, so two concurrent stealers can no longer both
 * "win" (the old blind-overwrite steal allowed exactly that).
 * @returns {{ ok: boolean, reason?: string, lock?: object, stolen?: boolean }}
 */
export function acquireLock(store, { sessionId = null, now = Date.now() } = {}) {
  mkdirSync(join(resolve(store), '_memories'), { recursive: true });
  return acquireFileLock(lockPath(store), {
    extra: { session_id: sessionId },
    now, staleMs: LOCK_STALE_MS, hardStaleMs: LOCK_HARD_STALE_MS,
  });
}

/**
 * Release the lock. With a sessionId the release is VERIFIED: a revived slow owner
 * whose stale lock was stolen cannot delete the fresh owner's lock (session_id
 * mismatch is a no-op). Without a sessionId (legacy callers, the operator `release`
 * command) behavior stays the historical unconditional remove.
 */
export function releaseLock(store, { sessionId = null } = {}) {
  const p = lockPath(store);
  if (sessionId) return releaseFileLock(p, null, { verify: { field: 'session_id', value: sessionId } });
  return releaseFileLock(p, null, { force: true });
}

/**
 * Begin a close: acquire the lock and write an in-progress marker enumerating owed ops.
 * Returns { ok:false, reason:'held' } if another close holds the lock.
 */
export function beginClose(store, { sessionId, ops = [], storeSignature = null, now = new Date().toISOString() }) {
  const lock = acquireLock(store, { sessionId, now: Date.parse(now) || Date.now() });
  if (!lock.ok) return { ok: false, reason: lock.reason, lock: lock.lock };
  const marker = {
    session_id: sessionId,
    status: 'in-progress',
    started_at: now,
    completed_at: null,
    owed_at_start: [...ops],
    // The store signature at close time. detectCloseState compares the live signature
    // against this to re-owe store-derived ops when units changed after the close.
    store_signature: storeSignature,
    ops: {},
  };
  // P3: the lock is already held here — if the marker write fails, drop the lock we just took
  // so a disk-full/permission error can't strand it (rethrow so the caller records the failure).
  try {
    atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  } catch (e) {
    releaseLock(store, { sessionId });
    throw e;
  }
  return { ok: true, marker };
}

export function recordOp(store, { op, status = 'done', note = null, now = new Date().toISOString() }) {
  const marker = readJson(markerPath(store)) || { ops: {} };
  marker.ops = marker.ops || {};
  marker.ops[op] = { status, at: now, ...(note ? { note } : {}) };
  atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

export function finishClose(store, { sessionId = null, status = 'closed', now = new Date().toISOString() } = {}) {
  const marker = readJson(markerPath(store)) || { ops: {} };
  marker.status = status; // 'closed' = finalize succeeded; 'failed' = finished but /finalize failed → detectCloseState re-owes
  marker.completed_at = now;
  if (sessionId) marker.session_id = sessionId;
  atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  releaseLock(store, { sessionId });
  return marker;
}

/**
 * Three-state detection for startup. Returns one of:
 *   { state: 'in-progress' }  — a live close is running; don't race it, skip catch-up.
 *   { state: 'closed', owed: [] } — last session closed cleanly and store unchanged.
 *   { state: 'owed', owed: [...] } — no marker, crashed mid-close, or store changed since
 *      close (store-derived ops owed again). `owed` lists the ops to discharge.
 *
 * `allOps` is the full op set the caller considers in-scope; owed = those not marked done,
 * unioned with store-derived ops if the store changed since the marker (signature mismatch).
 */
export function detectCloseState(store, { allOps = [], storeSignature = null, now = Date.now() } = {}) {
  const { held } = inspectLock(store, now);
  if (held) return { state: 'in-progress', owed: [] };

  const marker = readJson(markerPath(store));
  if (!marker) return { state: 'owed', owed: [...allOps], reason: 'no-marker' };

  const done = new Set(Object.entries(marker.ops || {})
    .filter(([, v]) => v && v.status === 'done').map(([k]) => k));
  const notDone = allOps.filter(op => !done.has(op));

  // Store changed since the marker → store-derived ops are owed again even if previously done.
  const sigMismatch = storeSignature != null && marker.store_signature != null
    && marker.store_signature !== storeSignature;

  // Terminal states. `closed` = the runner's finish stamped success — TRUST it (the envelope
  // guarantees the marker, so a clean close is closed even though the runner records only a
  // couple of the ops; re-deriving "owed" from unrecorded LLM ops would re-close every session).
  // `failed` = finished but /finalize failed (P1 fix) — re-owe so the next startup retries.
  if (marker.status === 'closed') {
    if (sigMismatch) return { state: 'owed', owed: allOps.filter(isStoreDerived), reason: 'store-changed' };
    return { state: 'closed', owed: [] };
  }
  if (marker.status === 'failed') {
    return { state: 'owed', owed: notDone.length ? notDone : [...allOps], reason: 'prior-close-failed' };
  }
  // Anything else (status 'in-progress' with no live lock) = the close crashed mid-run.
  const owed = sigMismatch ? allOps.filter(op => !done.has(op) || isStoreDerived(op)) : notDone;
  return { state: 'owed', owed: owed.length ? owed : [...allOps], reason: 'crashed-mid-close' };
}

// Ops whose correctness depends on the unit store; re-owed when the store changes after close.
// (Transcript-derived ops aren't here — they always run when a close runs, gated by shouldSpawn.)
const STORE_DERIVED = new Set([
  'maintenance-run', 'render-project-md', 'hot-section', 'demote-moves',
  'compact-project', 'demote-state', 'check-units', 'validity-stamp',
]);
export function isStoreDerived(op) { return STORE_DERIVED.has(op); }

/**
 * Spawn pre-check for the exit hook: is it worth spawning a close agent at all?
 * Spawn when the session did real work OR made a decision OR there's owed work pending.
 * A read-only trivial session that owes nothing → skip (no agent cost).
 */
export function shouldSpawn(store, { didWork = false, madeDecision = false, allOps = [], storeSignature = null } = {}) {
  if (didWork || madeDecision) return true;
  const det = detectCloseState(store, { allOps, storeSignature });
  return det.state === 'owed' && det.owed.length > 0;
}

/**
 * Security gate (review 2026-06-30, HIGH): is `store` a CORE workspace we should auto-close?
 * A generic `_memories/` dirname is NOT proof — an attacker-supplied repo can have one, and the
 * close spawns a detached, tool-enabled `claude -p`. The trust anchor is the ~/.core/index.json
 * registry, which an attacker can't plant from inside a project dir. Requires the canonicalized
 * (realpath'd) store to match a registered workspace path.
 */
// Resolve the workspace-registry path. CORE_CLOSE_INDEX is an override, but Claude
// Code forwards a trusted project's .claude/settings.json env into hook
// subprocesses — so a hostile-but-trusted repo could aim the trust check at its own
// fake index. Honor the override only when it resolves inside ~/.core; otherwise
// ignore it and use the real registry. Pure + exported for unit testing.
export function resolveIndexPath(env = process.env) {
  const home = trustedHome();
  if (!home) return null;                 // no trusted OS home → caller fails closed
  const coreDir = join(home, '.core');
  const dflt = join(coreDir, 'index.json');
  const override = env && env.CORE_CLOSE_INDEX;
  if (!override) return dflt;
  const resolved = resolve(override);
  // Honor the override ONLY inside the trusted ~/.core — a store-local or attacker
  // path (the shape Claude Code forwards from a project settings.json) is ignored.
  if (resolved === coreDir || resolved.startsWith(coreDir + sep)) return override;
  return dflt;
}

// resolveIndexPath() (above) is the hardened resolver: it bases ~/.core on the trusted
// OS home (not the spoofable $HOME) and ignores any CORE_CLOSE_INDEX pointing outside it.
// It is the active default here (wired 2026-07-13, close-authority spec). The explicit
// `indexPath` option is the TRUSTED in-process channel — a caller passing it does so from
// code, not from a project's forwarded env — which is how the tests exercise the positive
// path. Untrusted env can no longer redirect the gate; a subprocess can't fake trustedHome().
export function isRegisteredWorkspace(store, { indexPath = resolveIndexPath() } = {}) {
  if (!indexPath) return false;               // no trusted registry → fail closed
  const home = trustedHome();
  let canon;
  try { canon = realpathSync(store); } catch { canon = resolve(store); }
  let idx;
  try { idx = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { return false; }
  if (!Array.isArray(idx)) return false;
  return idx.some(e => {
    if (!e || typeof e.path !== 'string') return false;
    // `home` is guaranteed non-null here (null trustedHome fails closed at the top),
    // so the ~ expansion never falls back to the spoofable homedir().
    let p = e.path.startsWith('~') ? join(home, e.path.slice(1)) : e.path;
    try { p = realpathSync(p); } catch { p = resolve(p); }
    return p === canon;
  });
}

// The full op set the close envelope is responsible for (the hook imports this list — single source).
export const CLOSE_OPS = [
  'maintenance-run', 'render-project-md', 'hot-section', 'demote-moves',
  'compact-project', 'demote-state', 'check-units', 'reflection-a', 'reflection-b',
  'metrics', 'session-summary', 'memory-refresh',
];

/**
 * Build the env for the spawned `claude -p /finalize`. Strips API-key auth by default so an
 * unattended close uses the subscription login (an automated close billing the user's API key
 * is a surprise cost; a dead key also shadows the claude.ai login and kills the close). Opt
 * back in with CORE_CLOSE_USE_API_KEY=1. CORE_CLOSE_ENVELOPE=1 tells /finalize the runner owns
 * the begin/finish marker + mechanical maintenance (so the LLM does only the judgment work).
 */
export function buildChildEnv(env = process.env) {
  const childEnv = { ...env, CORE_CLOSE_PASS_ACTIVE: '1', CORE_CLOSE_HEADLESS: '1', CORE_CLOSE_ENVELOPE: '1' };
  if (env.CORE_CLOSE_USE_API_KEY !== '1') { delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN; }
  return childEnv;
}

/**
 * The deterministic close envelope (DC-77): the marker lifecycle and mechanical maintenance are
 * plumbing, NOT left to the LLM's discretion (validation 2026-06-30 showed a headless agent
 * narrating "indexes regenerated" and "session closed" while writing neither the maintenance
 * ledger nor the marker). Sequence: begin (lock + in-progress marker) → runMaintenance (mechanical,
 * signature-gated) → `claude -p /finalize` (the intelligent reflection/render/summary) → finish
 * (closed marker, lock released). Even if the LLM inside does nothing structural, the store ends
 * in a correct `closed` state and startup catch-up won't needlessly re-run.
 *
 * @param {(store: object) => any} [spawnFinalize] injectable claude spawn (for tests)
 */
export function runClose(store, { now = new Date().toISOString(), spawnFinalize = defaultSpawnFinalize } = {}) {
  const sessionId = 'auto-' + now.slice(0, 19).replace(/[:T]/g, '-');

  // P3: beginClose acquires the lock AND writes the marker. If either throws (disk full,
  // read-only store), make sure we never strand a lock we took, and never crash silently.
  let begun;
  try {
    begun = beginClose(store, { sessionId, ops: CLOSE_OPS, now });
  } catch (e) {
    releaseLock(store, { sessionId }); // in case the lock was taken but the marker write threw
    logHookEvent({ hook: 'close-run', action: 'error', reason: 'begin-failed: ' + String(e && e.message || e).slice(0, 120), cwd: store });
    return { ok: false, reason: 'begin-failed' };
  }
  if (!begun.ok) return { ok: false, reason: begun.reason }; // another close holds the lock

  let finalizeOk = true;
  try {
    try {
      const m = runMaintenance(store, {});
      recordOp(store, { op: 'maintenance-run', note: (m.narration || '').slice(0, 120) });
    } catch (e) {
      recordOp(store, { op: 'maintenance-run', status: 'failed', note: String(e && e.message || e).slice(0, 200) });
    }
    // P1/P5: capture the finalize outcome. A no-op test stub returns undefined → treat as ok.
    const fin = spawnFinalize(store);
    finalizeOk = fin == null ? true : fin.ok !== false;
    recordOp(store, {
      op: 'finalize',
      status: finalizeOk ? 'done' : 'failed',
      note: finalizeOk ? null : `exit=${fin.status} signal=${fin.signal || ''} ${fin.error || ''}`.slice(0, 200),
    });
  } catch (e) {
    finalizeOk = false;
    recordOp(store, { op: 'finalize', status: 'failed', note: String(e && e.message || e).slice(0, 200) });
  } finally {
    // P1: only stamp `closed` when finalize actually succeeded; otherwise `failed` → the next
    // startup re-owes and retries, instead of the marker lying that the close completed.
    finishClose(store, { sessionId, status: finalizeOk ? 'closed' : 'failed' });
    // P7: log the OUTCOME (not just the launch) so `cat hooks-log.jsonl` reflects reality.
    logHookEvent({ hook: 'close-run', action: finalizeOk ? 'close-complete' : 'close-failed', cwd: store });
  }
  return { ok: finalizeOk };
}

// On Windows the `claude` CLI is a claude.cmd shim; current Node (post
// CVE-2024-27980) throws EINVAL if spawnSync runs a .cmd without shell:true.
// So the self-managed close needs shell on win32 — and only there (POSIX spawns
// the real binary directly). Args stay a fixed literal array, no user input, so
// shell mode carries no injection risk here. Pure + exported so it's unit-testable.
export function claudeSpawnShell(platform = process.platform) {
  return platform === 'win32';
}

function defaultSpawnFinalize(store) {
  // P1b: append (never truncate) so a fast-failing spawn can't erase the last good log, and
  // 0600 so project content the close echoes isn't world-readable on a shared host.
  const logPath = join(homedir(), '.core', 'close-pass-last.log');
  let stdio = 'ignore';
  let logFd = null;
  try {
    logFd = openSync(logPath, 'a');
    try { chmodSync(logPath, 0o600); } catch { /* best-effort perms */ }
    writeSync(logFd, `\n=== close ${new Date().toISOString()} store=${store} ===\n`);
    stdio = ['ignore', logFd, logFd];
  } catch { /* fall back to ignored stdio */ }
  const r = spawnSync('claude', ['-p', '/finalize'], { cwd: resolve(store), env: buildChildEnv(process.env), stdio, shell: claudeSpawnShell() });
  // P1: surface the spawn result — spawnSync does NOT throw on ENOENT / non-zero / signal.
  const result = { ok: !r.error && r.status === 0, status: r.status, signal: r.signal, error: r.error && String(r.error.message || r.error) };
  if (logFd != null) {
    try { writeSync(logFd, `=== result ok=${result.ok} exit=${result.status} signal=${result.signal || ''} ${result.error || ''} ===\n`); } catch { /* ignore */ }
    try { closeSync(logFd); } catch { /* ignore */ }
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const sub = argv[0];
  const f = parseFlags(argv.slice(1));
  const store = f._[0];
  const json = !!f.json;
  if (!sub || !store) { process.stderr.write('usage: close-pass.mjs <detect|should-spawn|begin|record|finish|release> <store> [...]\n'); return 2; }

  const ops = typeof f.ops === 'string' ? f.ops.split(',').map(s => s.trim()).filter(Boolean) : [];

  switch (sub) {
    case 'run': {
      // The deterministic close envelope: begin -> maintenance -> claude -p /finalize -> finish.
      const r = runClose(store, {});
      process.stdout.write(json ? JSON.stringify(r) + '\n' : (r.ok ? 'close complete\n' : `close skipped: ${r.reason}\n`));
      return r.ok ? 0 : 1;
    }
    case 'detect': {
      const det = detectCloseState(store, { allOps: ops });
      process.stdout.write(json ? JSON.stringify(det) + '\n' : `${det.state}${det.owed?.length ? ' owed=' + det.owed.join(',') : ''}\n`);
      return 0;
    }
    case 'should-spawn': {
      const spawn = shouldSpawn(store, { didWork: !!f['did-work'], madeDecision: !!f['made-decision'], allOps: ops });
      if (json) process.stdout.write(JSON.stringify({ spawn }) + '\n');
      return spawn ? 0 : 1;
    }
    case 'begin': {
      const r = beginClose(store, { sessionId: f.session || null, ops });
      process.stdout.write(json ? JSON.stringify(r) + '\n' : (r.ok ? 'lock acquired; close in-progress\n' : `lock ${r.reason}; another close is running\n`));
      return r.ok ? 0 : 1;
    }
    case 'record': {
      if (!f.op) { process.stderr.write('record needs --op\n'); return 2; }
      recordOp(store, { op: f.op, status: f.status || 'done', note: typeof f.note === 'string' ? f.note : null });
      return 0;
    }
    case 'finish': {
      finishClose(store, { sessionId: f.session || null });
      process.stdout.write('close marked closed; lock released\n');
      return 0;
    }
    case 'release': { releaseLock(store); process.stdout.write('lock released\n'); return 0; }
    default: process.stderr.write(`unknown subcommand: ${sub}\n`); return 2;
  }
}

function selfTest() {
  const assert = (c, m) => { if (!c) throw new Error('SELF-TEST FAIL: ' + m); };
  const store = mkdtempSync(join(tmpdir(), 'close-pass-test-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  const ALL = ['maintenance-run', 'render-project-md', 'metrics', 'reflection-a'];

  // 1. No marker → fully owed.
  let det = detectCloseState(store, { allOps: ALL });
  assert(det.state === 'owed' && det.owed.length === ALL.length, 'no-marker should be fully owed');

  // 2. Begin acquires lock + in-progress marker; detection sees in-progress.
  const b = beginClose(store, { sessionId: 's1', ops: ALL });
  assert(b.ok, 'beginClose should acquire');
  det = detectCloseState(store, { allOps: ALL });
  assert(det.state === 'in-progress', 'lock held → in-progress, got ' + det.state);

  // 3. Second concurrent begin is refused (single-flight).
  const b2 = beginClose(store, { sessionId: 's1b', ops: ALL });
  assert(!b2.ok && b2.reason === 'held', 'second begin must be refused while lock held');

  // 4. Record some ops, then finish → closed; lock released.
  recordOp(store, { op: 'maintenance-run' });
  recordOp(store, { op: 'render-project-md' });
  recordOp(store, { op: 'metrics' });
  recordOp(store, { op: 'reflection-a' });
  finishClose(store, { sessionId: 's1' });
  det = detectCloseState(store, { allOps: ALL });
  assert(det.state === 'closed', 'after finish all-ops → closed, got ' + det.state + ' owed=' + det.owed);

  // 5. PARTIAL CLOSE: begin, record only some ops, drop the lock WITHOUT finishing (crash).
  beginClose(store, { sessionId: 's2', ops: ALL });
  recordOp(store, { op: 'maintenance-run' });
  releaseLock(store); // simulate the agent dying after the lock went away but before finish
  det = detectCloseState(store, { allOps: ALL });
  assert(det.state === 'owed' && det.reason === 'crashed-mid-close', 'crashed mid-close must be owed, got ' + det.state + '/' + det.reason);
  assert(det.owed.includes('render-project-md') && det.owed.includes('metrics'), 'owed must list the unfinished ops');
  assert(!det.owed.includes('maintenance-run'), 'a recorded-done op should not be re-owed on a clean crash, got ' + det.owed);

  // 6. Stale lock is stealable; a held fresh lock is not.
  acquireLock(store, { sessionId: 's3' });
  assert(!acquireLock(store, { sessionId: 's3b' }).ok, 'fresh lock must not be stealable');
  // age the lock past stale by writing an old-pid lock manually
  atomicWriteFileSync(lockPath(store), JSON.stringify({ pid: 999999, session_id: 'dead', started_at: new Date(Date.now() - 11 * 60 * 1000).toISOString() }));
  const stolen = acquireLock(store, { sessionId: 's4', now: Date.now() + 11 * 60 * 1000 });
  assert(stolen.ok, 'stale lock (dead pid, old) must be stealable');

  // 7. shouldSpawn: trivial session that owes nothing → false; work done → true.
  releaseLock(store);
  finishClose(store, { sessionId: 's4' });
  // mark everything done so nothing is owed
  for (const op of ALL) recordOp(store, { op });
  finishClose(store, { sessionId: 's4' });
  assert(shouldSpawn(store, { didWork: false, madeDecision: false, allOps: ALL }) === false, 'no work + nothing owed → no spawn');
  assert(shouldSpawn(store, { didWork: true, allOps: ALL }) === true, 'real work → spawn');

  // 8. Store changed after a clean close → store-derived ops re-owed, transcript ops not.
  releaseLock(store);
  beginClose(store, { sessionId: 's5', ops: ALL, storeSignature: 'SIG-A' });
  for (const op of ALL) recordOp(store, { op });
  finishClose(store, { sessionId: 's5' });
  let d8 = detectCloseState(store, { allOps: ALL, storeSignature: 'SIG-A' });
  assert(d8.state === 'closed', 'same signature → still closed, got ' + d8.state);
  d8 = detectCloseState(store, { allOps: ALL, storeSignature: 'SIG-B' });
  assert(d8.state === 'owed' && d8.reason === 'store-changed', 'changed signature → owed/store-changed, got ' + d8.state + '/' + d8.reason);
  assert(d8.owed.includes('render-project-md') && !d8.owed.includes('reflection-a'),
    'store-changed re-owes store-derived ops only, got ' + d8.owed);

  rmSync(store, { recursive: true, force: true });
  process.stdout.write('close-pass self-test: PASS (8 checks)\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
