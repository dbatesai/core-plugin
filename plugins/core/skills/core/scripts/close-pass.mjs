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

import { readFileSync, existsSync, statSync, openSync, writeSync, closeSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { runMaintenance } from './maintenance-run.mjs';

// A lock older than this with no live owner is stale and stealable. Generous: a real close
// pass (claude -p re-reading a transcript) can take a couple of minutes.
export const LOCK_STALE_MS = 10 * 60 * 1000;

const markerPath = (store) => join(resolve(store), '_memories', '_close-marker.json');
const lockPath = (store) => join(resolve(store), '_memories', '_close.lock');

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Is the lock currently held by a live, non-stale owner?
 * @returns {{ held: boolean, lock: object|null, stale: boolean }}
 */
export function inspectLock(store, now = Date.now()) {
  const p = lockPath(store);
  if (!existsSync(p)) return { held: false, lock: null, stale: false };
  const lock = readJson(p);
  if (!lock) return { held: false, lock: null, stale: true }; // corrupt → treat as stale
  let ageMs = Infinity;
  try { ageMs = now - statSync(p).mtimeMs; } catch { /* gone */ }
  const stale = ageMs > LOCK_STALE_MS && !pidAlive(lock.pid);
  return { held: !stale, lock, stale };
}

/**
 * Acquire the single-flight lock. Atomic 'wx' create; steals a stale lock.
 * @returns {{ ok: boolean, reason?: string, lock?: object }}
 */
export function acquireLock(store, { sessionId = null, now = Date.now() } = {}) {
  const p = lockPath(store);
  mkdirSync(join(resolve(store), '_memories'), { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, session_id: sessionId, started_at: new Date(now).toISOString() });
  try {
    const fd = openSync(p, 'wx'); // fails if exists — this IS the single-flight guard
    writeSync(fd, payload); closeSync(fd);
    return { ok: true, lock: readJson(p) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const { held, lock } = inspectLock(store, now);
    if (held) return { ok: false, reason: 'held', lock };
    // stale — steal it (atomic overwrite)
    atomicWriteFileSync(p, payload);
    return { ok: true, lock: readJson(p), stolen: true };
  }
}

export function releaseLock(store) {
  const p = lockPath(store);
  try { rmSync(p); } catch { /* already gone */ }
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
  atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  return { ok: true, marker };
}

export function recordOp(store, { op, status = 'done', note = null, now = new Date().toISOString() }) {
  const marker = readJson(markerPath(store)) || { ops: {} };
  marker.ops = marker.ops || {};
  marker.ops[op] = { status, at: now, ...(note ? { note } : {}) };
  atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  return marker;
}

export function finishClose(store, { sessionId = null, now = new Date().toISOString() } = {}) {
  const marker = readJson(markerPath(store)) || { ops: {} };
  marker.status = 'closed';
  marker.completed_at = now;
  if (sessionId) marker.session_id = sessionId;
  atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n');
  releaseLock(store);
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

  // A marker stuck 'in-progress' with no live lock = the close crashed mid-run.
  const crashed = marker.status !== 'closed';
  const notDone = allOps.filter(op => !done.has(op));

  // Store changed since the marker → store-derived ops are owed again even if previously done.
  const sigMismatch = storeSignature != null && marker.store_signature != null
    && marker.store_signature !== storeSignature;

  let owed = notDone;
  if (sigMismatch) owed = allOps.filter(op => !done.has(op) || isStoreDerived(op));

  if (crashed) return { state: 'owed', owed: owed.length ? owed : [...allOps], reason: 'crashed-mid-close' };
  if (owed.length) return { state: 'owed', owed, reason: sigMismatch ? 'store-changed' : 'incomplete' };
  return { state: 'closed', owed: [] };
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

// The full op set the close envelope is responsible for (kept in sync with close-pass-hook).
export const CLOSE_OPS = [
  'maintenance-run', 'render-project-md', 'hot-section', 'demote-moves',
  'compact-project', 'demote-state', 'check-units', 'reflection-a', 'reflection-b',
  'metrics', 'summary-stub', 'memory-refresh',
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
  const begun = beginClose(store, { sessionId, ops: CLOSE_OPS, now });
  if (!begun.ok) return { ok: false, reason: begun.reason }; // another close holds the lock
  try {
    try {
      const m = runMaintenance(store, {});
      recordOp(store, { op: 'maintenance-run', note: (m.narration || '').slice(0, 120) });
    } catch (e) {
      recordOp(store, { op: 'maintenance-run', status: 'failed', note: String(e && e.message || e).slice(0, 120) });
    }
    spawnFinalize(store);
    recordOp(store, { op: 'summary-stub' }); // best-effort marker that the LLM half ran
  } finally {
    finishClose(store, { sessionId });
  }
  return { ok: true };
}

function defaultSpawnFinalize(store) {
  let stdio = 'ignore';
  try {
    const fd = openSync(join(homedir(), '.core', 'close-pass-last.log'), 'w');
    stdio = ['ignore', fd, fd];
  } catch { /* fall back to ignored stdio */ }
  spawnSync('claude', ['-p', '/finalize'], { cwd: resolve(store), env: buildChildEnv(process.env), stdio });
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
