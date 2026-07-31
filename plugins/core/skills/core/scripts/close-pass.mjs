/**
 * close-pass.mjs — session-close orchestration: lock, per-op marker, three-state detection.
 *
 * The reliability spine of the session close. The SessionEnd hook's deterministic
 * per-session request, the manual /finalize, and the startup catch-up all drive
 * close work through this script so none of them can lie about a half-finished
 * close or race a second one.
 *
 * Three problems it solves:
 *   1. Partial close — a boolean "closed" marker can sit over a half-maintained store if
 *      a close dies mid-run. So the marker is PER-OP: it records which ops finished,
 *      and startup discharges whatever's still owed instead of trusting marker-presence.
 *   2. Concurrent close — close-then-reopen can put two closes against the same store. A
 *      single-flight lock (atomic 'wx' create, stale-stealable) serializes them, and
 *      detection reports a third state (in-progress) the boolean marker couldn't express.
 *   3. Duplicate close — receipts key on the harness's own session id, so a session
 *      that already certified (manual) or recorded (automatic) is never closed twice.
 *
 * NOT a judgment engine. It tracks completion; it does not decide whether an op's WRITE is
 * safe — PROJECT.md-mutating ops stay edit-gated in startup.md/finalize, and the autonomous
 * judgment tier stays behind the self-management preconditions. This is plumbing under that policy.
 *
 * Ships with the plugin as prescriptive code; .mjs only. Cross-platform (no shell, no bash-isms).
 *
 * CLI:
 *   node close-pass.mjs detect <store> [--session <id>]      → prints state + owed ops (JSON on --json)
 *   node close-pass.mjs begin <store> --session <id> --ops a,b,c             → acquire lock + in-progress marker
 *   node close-pass.mjs record <store> --op <op> --status done|failed|skipped [--note "..."]
 *   node close-pass.mjs finish <store> [--session <id>]      → mark closed, release lock
 *   node close-pass.mjs certify <store> [--session <id>] [--summary <path>]  → write the manual closed receipt
 *   node close-pass.mjs process-request <store> --session <id> [--transcript <path>]  → the deterministic auto-close
 *   node close-pass.mjs release <store>                       → force-release a stale lock
 *   node close-pass.mjs --self-test
 */

import { readFileSync, rmSync, mkdtempSync, mkdirSync, chmodSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveStoragePath, resolveWorkspaceId } from './log-event.mjs';
import { buildCloseRecord, renderCloseSummary } from './close-payload.mjs';
import { trustedHome } from './trusted-home.mjs';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { acquireFileLock, releaseFileLock, inspectFileLock } from './file-lock.mjs';
import { logHookEvent } from '../hooks/hook-log.mjs';
import { readTranscript, resolveTranscript } from './read-transcript.mjs';
import { isCliEntry } from './cli-entry.mjs';

// A lock older than this with no live owner is stale and supersedable. Generous
// enough for a manual close that renders and summarizes before finishing.
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
    .filter(([op, v]) => isOpSatisfied(op, v)).map(([k]) => k));
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
// (Session-derived ops aren't here — their truth comes from the session, not the store.)
const STORE_DERIVED = new Set([
  'render-project-md',
]);

// The ONE satisfaction predicate certification and detection share. 'done'
// satisfies any op; 'skipped' satisfies only the ops whose protocol permits a
// recorded skip (the render skips when nothing material changed). Divergent
// predicates let a session read closed to certification and owed to detection
// at the same time.
const SKIP_PERMITTED = new Set(['render-project-md']);
export function isOpSatisfied(op, record) {
  if (!record) return false;
  if (record.status === 'done') return true;
  return record.status === 'skipped' && SKIP_PERMITTED.has(op);
}
export function isStoreDerived(op) { return STORE_DERIVED.has(op); }


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

/**
 * Read a session's receipt as an explicit tri-state: absent / valid / corrupt /
 * unreadable. Absent is ONLY a missing file; torn or non-object JSON is
 * corrupt; any other read failure is unreadable — collapsing those into
 * absence let an exact-session corrupt receipt be silently overwritten.
 */
export function readCloseReceiptState(store, sessionId, opts = {}) {
  const p = receiptPath(store, sessionId, opts);
  let raw;
  try { raw = readFileSync(p, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'absent', receipt: null };
    return { status: 'unreadable', receipt: null, error: String(e && e.message || e).slice(0, 160) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { status: 'valid', receipt: parsed };
    return { status: 'corrupt', receipt: null };
  } catch {
    return { status: 'corrupt', receipt: null };
  }
}

/** Convenience read: the valid receipt or null. State-sensitive callers use readCloseReceiptState. */
export function readCloseReceipt(store, sessionId, opts = {}) {
  return readCloseReceiptState(store, sessionId, opts).receipt;
}

/** Write a session's receipt atomically, owner-only. */
export function writeCloseReceipt(store, receipt, opts = {}) {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('close-pass: receipt must be an object');
  }
  const sessionId = receipt.session_id;
  const p = receiptPath(store, sessionId, opts);
  mkdirSync(receiptDir(store, opts), { recursive: true });
  // Prior-receipt evidence rules: an UNREADABLE prior receipt refuses the
  // write outright — the bytes may be intact evidence we could not read, and
  // no preservation is possible without reading. A CORRUPT prior receipt may
  // be replaced only AFTER its bytes are successfully quarantined; a
  // quarantine failure (including a name collision) refuses rather than
  // overwriting.
  const prior = readCloseReceiptState(store, sessionId, opts);
  if (prior.status === 'unreadable') {
    return { written: false, reason: 'prior-receipt-unreadable', error: prior.error, path: p };
  }
  if (prior.status === 'corrupt') {
    let quarantined = null;
    for (let attempt = 0; attempt < 5 && !quarantined; attempt++) {
      const target = `${p}.corrupt-${Date.now()}-${attempt}-${Math.floor(Math.random() * 1e6)}`;
      try {
        if (!existsSync(target)) { renameSync(p, target); quarantined = target; }
      } catch { /* try the next unique name */ }
    }
    if (!quarantined) {
      return { written: false, reason: 'quarantine-failed', path: p };
    }
  }
  atomicWriteFileSync(p, `${JSON.stringify(receipt, null, 2)}\n`);
  chmodSync(p, 0o600);
  return { written: true, path: p };
}

/**
 * Should an automatic close be enqueued for this exact session?
 *
 * Reads ONLY the session-keyed receipt. The store-level marker is deliberately
 * not consulted: it cannot name a session, so reading it here would silently
 * degrade the dedup back to per-project and reintroduce the duplicate close.
 */
export function shouldEnqueueClose(store, { sessionId } = {}, opts = {}) {
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
  const wrote = writeCloseReceipt(store, receipt, opts);
  if (!wrote.written) {
    return { ...receipt, status: 'failed', write_refused: wrote.reason };
  }
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
 * close enqueues the deterministic per-session close. The trust anchor is the ~/.core/index.json
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

// The op set a session close is responsible for (single source — docs and the
// startup catch-up mirror this list). The close preserves and certifies the
// session; maintenance belongs to /process-memory, analytics to /metrics.
export const CLOSE_OPS = [
  'material-capture', 'render-project-md', 'session-summary', 'memory-refresh',
];


/**
 * Certify a manual close: write this exact session's `closed` receipt so a
 * subsequent SessionEnd for the same session is suppressed. `closed` is the
 * manual close's status alone — the automatic path writes `recorded`.
 *
 * When no session id is given, resolve the current session from the newest
 * project-bound transcript. Refuses to synthesize an identity: an unresolvable
 * session returns { ok:false, reason:'unresolved' } and writes nothing.
 */
export function certifyManualClose(store, { sessionId = null, summaryPath = null, home = null, now = new Date().toISOString() } = {}, opts = {}) {
  let sid = sessionId;
  let transcriptPath = null;
  if (!sid) {
    try {
      let canon;
      try { canon = realpathSync(store); } catch { canon = resolve(store); }
      const resolveOpts = { cwd: canon };
      if (home) resolveOpts.home = home;
      const t = resolveTranscript('claude-code', resolveOpts);
      transcriptPath = t && t.path ? t.path : null;
      if (transcriptPath) {
        const base = transcriptPath.split(/[\\/]/).pop();
        if (base && base.endsWith('.jsonl')) sid = base.slice(0, -'.jsonl'.length);
      }
    } catch (e) {
      return { ok: false, reason: 'unresolved', detail: String(e && e.message || e).slice(0, 120) };
    }
  }
  if (!sid) return { ok: false, reason: 'unresolved' };

  const existing = readCloseReceipt(store, sid, opts);
  if (existing && existing.status === 'closed') return { ok: true, already: true, session_id: sid };

  // Certification is DERIVED from the op record, never asserted by the caller:
  // every required op must be recorded 'done' — or 'skipped', which is itself
  // an explicitly recorded judgment — before a closed receipt can exist. A
  // failed or missing required op refuses; the session stays owed.
  const marker = readJson(markerPath(store)) || { ops: {} };
  const ops = marker.ops || {};
  const incomplete = CLOSE_OPS.filter((op) => !isOpSatisfied(op, ops[op]));
  if (incomplete.length) {
    return { ok: false, reason: 'required-ops-incomplete', incomplete, session_id: sid };
  }

  const receipt = {
    session_id: sid,
    status: 'closed',
    harness: 'claude-code',
    closed_at: now,
    summary_path: summaryPath || null,
    transcript_path: transcriptPath,
  };
  const wrote = writeCloseReceipt(store, receipt, opts);
  if (!wrote.written) {
    return { ok: false, reason: wrote.reason, session_id: sid };
  }
  return { ok: true, session_id: sid };
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
  if (!sub || !store) { process.stderr.write('usage: close-pass.mjs <detect|begin|record|finish|certify|process-request|release> <store> [...]\n'); return 2; }

  const ops = typeof f.ops === 'string' ? f.ops.split(',').map(s => s.trim()).filter(Boolean) : [];

  switch (sub) {
    case 'detect': {
      const det = detectCloseState(store, { allOps: ops });
      process.stdout.write(json ? JSON.stringify(det) + '\n' : `${det.state}${det.owed?.length ? ' owed=' + det.owed.join(',') : ''}\n`);
      return 0;
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
    case 'certify': {
      const r = certifyManualClose(store, {
        sessionId: typeof f.session === 'string' ? f.session : null,
        summaryPath: typeof f.summary === 'string' ? f.summary : null,
      });
      if (!r.ok) {
        if (r.reason === 'required-ops-incomplete') {
          process.stdout.write(`REQUIRED-OPS-INCOMPLETE: ${(r.incomplete || []).join(', ')} — record or legitimately skip them, then certify\n`);
        } else if (r.reason === 'unresolved') {
          process.stdout.write('UNRESOLVED: no session identity could be established; pass --session <id>\n');
        } else {
          process.stdout.write(`REFUSED: ${r.reason}\n`);
        }
        return 1;
      }
      process.stdout.write(json ? JSON.stringify(r) + '\n' : (r.already ? 'already certified\n' : `certified ${r.session_id}\n`));
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
  process.stdout.write('close-pass self-test: PASS (7 checks)\n');
  return 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
