/**
 * close-pass.mjs — session-close orchestration: lock, per-op marker, three-state detection.
 *
 * The reliability spine of self-managed maintenance. The exit hook
 * (Stop-hook claude -p) and the startup catch-up both drive close work through this
 * script so neither can lie about a half-finished close or race a second close agent.
 *
 * Three problems it solves:
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
 * judgment tier stays behind the self-management M3 preconditions. This is plumbing under that policy.
 *
 * Ships with the plugin as prescriptive code; .mjs only. Cross-platform (no shell, no bash-isms).
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

import { readFileSync, openSync, writeSync, closeSync, rmSync, mkdtempSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { resolveStoragePath, resolveWorkspaceId } from './log-event.mjs';
import { buildCloseRecord, renderCloseSummary } from './close-payload.mjs';
import { trustedHome } from './trusted-home.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { acquireFileLock, releaseFileLock, inspectFileLock } from './file-lock.mjs';
import { runMaintenance } from './maintenance-run.mjs';
import { logHookEvent } from '../hooks/hook-log.mjs';
import { readTranscript } from './read-transcript.mjs';

// A lock older than this with no live owner is stale and supersedable. Generous: a real close
// pass (claude -p re-reading a transcript) can take a couple of minutes.
export const LOCK_STALE_MS = 10 * 60 * 1000;
// Ceiling for locks whose owner can't be identified (unreadable payload, no pid). A lock with
// a READABLE LIVE pid is never auto-superseded at ANY age: a laptop
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
 * Delegates to file-lock.mjs.
 * @returns {{ held: boolean, lock: object|null, stale: boolean }}
 */
export function inspectLock(store, now = Date.now()) {
  return inspectFileLock(lockPath(store), { now, staleMs: LOCK_STALE_MS, hardStaleMs: LOCK_HARD_STALE_MS });
}

/**
 * Acquire the single-flight lock. Atomic 'wx' create; a stale lock is stolen via
 * file-lock.mjs's rename-claim CAS, so two concurrent stealers cannot both "win".
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
 * command) the release is an unconditional remove.
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
  // The lock is already held here — if the marker write fails, drop the lock we just took
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
  const release = releaseLock(store, { sessionId });
  // Fail closed on a real release failure: a swallowed permission/I/O error
  // would leave a live lock silently blocking every future close while this
  // close reports success. Record it ON the marker so detection
  // and forensics see it; callers get it in the return.
  if (release && release.released === false && release.reason === 'release-failed') {
    marker.release_error = release.error || 'release-failed';
    try { atomicWriteFileSync(markerPath(store), JSON.stringify(marker, null, 2) + '\n'); } catch { /* marker already closed */ }
    logHookEvent({ hook: 'close-finish', action: 'error', reason: `lock release failed: ${marker.release_error}`, cwd: store });
  }
  return { ...marker, release };
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

  // Terminal states. `closed` = the runner's finish stamped success. A genuinely complete
  // close DOES carry every judgment op in marker.ops — the headless /finalize child shells
  // out to `close-pass.mjs record --op <op>` at each protocol step (finalize/SKILL.md).
  // What `closed` alone can't rule out is the child exiting cleanly (or a test stub
  // returning success) WITHOUT ever following that protocol. So: trust `closed`, but only
  // once the required ops are actually present as `done` — that re-owes the pathological
  // case without re-closing a session that worked.
  // `failed` = finished but /finalize failed — re-owe so the next startup retries.
  if (marker.status === 'closed') {
    if (sigMismatch) return { state: 'owed', owed: allOps.filter(isStoreDerived), reason: 'store-changed' };
    if (notDone.length) return { state: 'owed', owed: notDone, reason: 'closed-but-incomplete' };
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
  'compact-project', 'demote-state', 'check-units', 'validity-stamp', 'decorate-graph',
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

/* ─────────────────── Exact-session close receipts ───────────────────
 *
 * The close marker (`_memories/_close-marker.json`) is keyed per STORE, so it
 * can say "this project closed" but never "this session closed". That is why a
 * manual finalize can be followed by a second reasoning close moments later:
 * the marker looks satisfied to one caller and unsatisfied to the next, and
 * neither can name the session it belongs to.
 *
 * Receipts key on the harness's own session id. Only a `closed` receipt
 * suppresses a subsequent close for that same id; `failed` and `partial` stay
 * owed so a broken close is recovered rather than silently certified.
 */

/**
 * Statuses that certify a session as terminal for duplicate-SessionEnd suppression
 * (spec §4.5). 'closed' = manual semantic capture; 'recorded' = automatic lifecycle
 * evidence only, no semantic capture attempted -- both stop a second close, neither
 * implies the other. Everything else ('partial', 'failed', abandoned 'queued') stays owed.
 */
const CERTIFIED_STATUSES = new Set(['closed', 'recorded']);

/**
 * Derive the stable per-session key. Throws on anything that is not a real
 * identity — a missing session id must never be synthesized into one, which is
 * how `auto-<timestamp>` turned repeat SessionEnd events into distinct sessions.
 */
export function sessionKey(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new TypeError('close-pass: session id must be a nonempty string; refusing to synthesize one');
  }
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

/** Resolve the receipt directory. `opts.storageRoot` keeps tests hermetic. */
function receiptDir(store, { storageRoot = null } = {}) {
  const root = storageRoot
    || resolveStoragePath(resolve(store), { workspaceId: resolveWorkspaceId(resolve(store)) });
  return join(root, 'close', 'receipts');
}

export function receiptPath(store, sessionId, opts = {}) {
  return join(receiptDir(store, opts), `${sessionKey(sessionId)}.json`);
}

/** Read a session's receipt. Returns null when absent or unreadable — never throws on a bad file. */
export function readCloseReceipt(store, sessionId, opts = {}) {
  const p = receiptPath(store, sessionId, opts);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Write a session's receipt atomically, owner-only. */
export function writeCloseReceipt(store, receipt, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('close-pass: receipt must be an object');
  }
  const sessionId = receipt.session_id;
  const p = receiptPath(store, sessionId, opts);
  mkdirSync(receiptDir(store, opts), { recursive: true });
  atomicWriteFileSync(p, `${JSON.stringify(receipt, null, 2)}\n`);
  chmodSync(p, 0o600);
  return p;
}

/**
 * Should an automatic close be enqueued for this exact session?
 *
 * Reads ONLY the session-keyed receipt. The store-level marker is deliberately
 * not consulted: it cannot name a session, so reading it here would silently
 * degrade the dedup back to per-project and reintroduce the duplicate close.
 */
export function shouldEnqueueClose(store, { sessionId, harness = null } = {}, opts = {}) {
  const receipt = readCloseReceipt(store, sessionId, opts);
  if (!receipt) return true;
  return !CERTIFIED_STATUSES.has(receipt.status);
}

/**
 * Perform the automatic close for one exact session, deterministically.
 *
 * Makes NO model call. Builds the record from already-normalized transcript
 * events, renders the fixed-shape summary, writes both atomically, and returns
 * the receipt it wrote.
 *
 * Status honesty: this is the AUTOMATIC path -- it may certify lifecycle evidence
 * (`recorded`) but never semantic capture (`closed`, spec §4.5/§2.2 — that status is
 * manual /finalize's alone to write). Partial coverage records `partial` and therefore
 * stays owed, so the next startup recovers it rather than treating an incomplete
 * observation as a finished close.
 */
export function runDeterministicClose(store, {
  sessionId,
  harness = null,
  events = [],
  startedAt = null,
  endedAt = null,
  coverage = 'full',
  gitHead = null,
  now = new Date().toISOString(),
} = {}, opts = {}) {
  const record = buildCloseRecord({
    sessionId, harness, events, startedAt, endedAt, coverage, gitHead,
  });
  const summary = renderCloseSummary(record);

  const summaryDir = join(receiptDir(store, opts), '..', 'summaries');
  mkdirSync(summaryDir, { recursive: true });
  const summaryFile = join(summaryDir, `${sessionKey(sessionId)}.md`);
  atomicWriteFileSync(summaryFile, summary);
  chmodSync(summaryFile, 0o600);

  const receipt = {
    session_id: sessionId,
    status: coverage === 'full' ? 'recorded' : 'partial',
    harness,
    closed_at: now,
    ops: { capture: 'done', summary: 'done', 'project-state': 'skipped' },
    summary_path: summaryFile,
    summary_sha256: createHash('sha256').update(summary, 'utf8').digest('hex'),
    model_calls: 0,
    record,
  };
  writeCloseReceipt(store, receipt, opts);
  return receipt;
}

/** First and last `timestamp` field seen across a transcript's JSONL lines, or nulls if unreadable. */
function extractTimestampRange(transcriptPath) {
  if (!transcriptPath) return { startedAt: null, endedAt: null };
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return { startedAt: null, endedAt: null }; }
  let startedAt = null, endedAt = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.timestamp !== 'string') continue;
    if (!startedAt) startedAt = e.timestamp;
    endedAt = e.timestamp;
  }
  return { startedAt, endedAt };
}

/**
 * Security gate: is `store` a CORE workspace we should auto-close?
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
// It is the active default here. The explicit
// `indexPath` option is the TRUSTED in-process channel — a caller passing it does so from
// code, not from a project's forwarded env — which is how the tests exercise the positive
// path. Untrusted env cannot redirect the gate; a subprocess can't fake trustedHome().
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
  'compact-project', 'demote-state', 'check-units', 'decorate-graph', 'reflection-a', 'reflection-b',
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
 * The deterministic close envelope: the marker lifecycle and mechanical maintenance are
 * plumbing, NOT left to the LLM's discretion (a headless agent can narrate "indexes
 * regenerated" and "session closed" while writing neither the maintenance
 * ledger nor the marker). Sequence: begin (lock + in-progress marker) → runMaintenance (mechanical,
 * signature-gated) → `claude -p /finalize` (the intelligent reflection/render/summary) → finish
 * (closed marker, lock released). Even if the LLM inside does nothing structural, the store ends
 * in a correct `closed` state and startup catch-up won't needlessly re-run.
 *
 * @param {(store: object) => any} [spawnFinalize] injectable claude spawn (for tests)
 */
export function runClose(store, { now = new Date().toISOString(), spawnFinalize = defaultSpawnFinalize } = {}) {
  const sessionId = 'auto-' + now.slice(0, 19).replace(/[:T]/g, '-');

  // beginClose acquires the lock AND writes the marker. If either throws (disk full,
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
    // Capture the finalize outcome. A no-op test stub returns undefined → treat as ok.
    const fin = spawnFinalize(store);
    finalizeOk = fin == null ? true : fin.ok !== false;
    let incompleteOps = [];
    if (finalizeOk) {
      // A clean process exit is not proof the child actually
      // followed the finalize protocol. detectCloseState() catching this on a LATER read is
      // defense-in-depth, not disposition -- the function that DOES the certifying (this one)
      // must not stamp 'closed' / log 'close-complete' on a close that skipped its required
      // ops. Verify before trusting the exit code, not after.
      const marker = readJson(markerPath(store)) || { ops: {} };
      const done = new Set(Object.entries(marker.ops || {}).filter(([, v]) => v && v.status === 'done').map(([k]) => k));
      incompleteOps = CLOSE_OPS.filter(op => !done.has(op));
      if (incompleteOps.length) finalizeOk = false;
    }
    recordOp(store, {
      op: 'finalize',
      status: finalizeOk ? 'done' : 'failed',
      note: finalizeOk ? null
        : incompleteOps.length ? `required ops never recorded: ${incompleteOps.join(', ')}`
        : `exit=${fin.status} signal=${fin.signal || ''} ${fin.error || ''}`.slice(0, 200),
    });
  } catch (e) {
    finalizeOk = false;
    recordOp(store, { op: 'finalize', status: 'failed', note: String(e && e.message || e).slice(0, 200) });
  } finally {
    // Only stamp `closed` when finalize actually succeeded; otherwise `failed` → the next
    // startup re-owes and retries, instead of the marker lying that the close completed.
    finishClose(store, { sessionId, status: finalizeOk ? 'closed' : 'failed' });
    // Log the OUTCOME (not just the launch) so `cat hooks-log.jsonl` reflects reality.
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
  // Append (never truncate) so a fast-failing spawn can't erase the last good log, and
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
  // Surface the spawn result — spawnSync does NOT throw on ENOENT / non-zero / signal.
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
      const fin = finishClose(store, { sessionId: f.session || null });
      if (fin.release && fin.release.released === false && fin.release.reason === 'release-failed') {
        process.stdout.write(`close marked closed; LOCK RELEASE FAILED (${fin.release.error}) — run 'release' once the cause clears\n`);
        return 1;
      }
      process.stdout.write('close marked closed; lock released\n');
      return 0;
    }
    case 'process-request': {
      // The exact-session automatic close the SessionEnd hook enqueues. Zero model calls:
      // read the transcript (if the hook could name one), build the deterministic record,
      // write the receipt. Dedup is receipt-based (shouldEnqueueClose), not the store lock —
      // a repeat request for an already-closed session is a cheap no-op, not a race to guard.
      const sessionId = f.session;
      if (!sessionId) { process.stderr.write('process-request needs --session\n'); return 2; }
      if (!shouldEnqueueClose(store, { sessionId })) {
        process.stdout.write(json ? JSON.stringify({ ok: true, skipped: true, reason: 'already-closed' }) + '\n' : 'already closed; nothing to do\n');
        return 0;
      }
      const transcriptOverride = typeof f.transcript === 'string' ? f.transcript : null;
      const { available, events, path: transcriptPath } = readTranscript({
        harness: 'claude-code', cwd: store, override: transcriptOverride, sessionId,
      });
      const { startedAt, endedAt } = extractTimestampRange(transcriptPath);
      let gitHead = null;
      const g = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(store), encoding: 'utf8' });
      if (g.status === 0 && typeof g.stdout === 'string') gitHead = g.stdout.trim();

      const receipt = runDeterministicClose(store, {
        sessionId, harness: 'claude-code', events, startedAt, endedAt, gitHead,
        coverage: available ? 'full' : 'partial',
      });
      process.stdout.write(json ? JSON.stringify({ ok: true, receipt }) + '\n' : `close ${receipt.status}: ${sessionId}\n`);
      return 0;
    }
    case 'release': {
      const rel = releaseLock(store);
      if (rel && rel.released === false) {
        process.stdout.write(`LOCK RELEASE FAILED (${rel.error || rel.reason}) — the lock is still present; clear the cause and re-run\n`);
        return 1;
      }
      process.stdout.write('lock released\n');
      return 0;
    }
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

  // 6. Stale lock is stealable; a held fresh lock is not. (Policy: a lock
  // with a LIVE pid is never stealable at any age, so the steal scenario must be
  // set up with a DEAD-pid lock only — clear our own live generation first.)
  acquireLock(store, { sessionId: 's3' });
  assert(!acquireLock(store, { sessionId: 's3b' }).ok, 'fresh lock must not be stealable');
  releaseLock(store); // force-clear the live-pid generation before planting the dead one
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
