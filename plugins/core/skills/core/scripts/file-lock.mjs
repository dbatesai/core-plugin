/**
 * file-lock.mjs — generalized advisory file lock with nonce-CAS steal + verified release.
 *
 * Extracted from close-pass.mjs's single-flight lock (2026-07-14, shared-write
 * concurrency spec) and hardened against the two defects the adversarial pass
 * proved in the original:
 *
 *   1. Two-stealer race: the old steal path was a plain atomic overwrite, so two
 *      agents inspecting the same stale lock could BOTH "win". Here the steal's
 *      claim is a rename of the stale file to a per-stealer graveyard name —
 *      rename is atomic and consumes the source, so exactly one stealer's rename
 *      succeeds; the loser gets ENOENT and reports the lock as contended. The
 *      winner then wx-creates fresh (wx still guards against a brand-new acquirer
 *      slipping in), and re-reads to confirm its nonce survived.
 *   2. Unverified release: the old release was an unconditional rm, so a revived
 *      slow owner could delete a FRESH owner's lock. releaseFileLock verifies the
 *      on-disk nonce is its own before removing; mismatch is a no-op.
 *
 * Locks are advisory and same-machine (~/.core is per-machine; if the meta root
 * ever lands on a synced/virtualized path, rename/unlink can throw EPERM under
 * OneDrive/AV — those are caught and reported as "couldn't acquire", never a crash).
 *
 * Callers with more than one lock follow the total order: per-project lock
 * (e.g. close-pass's _close.lock) BEFORE any global ~/.core lock. Locks are
 * non-reentrant — acquiring a path this process already holds self-refuses like
 * any other contention.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only, node:* imports only.
 */

import {
  readFileSync, writeFileSync, statSync,
  openSync, writeSync, closeSync, linkSync,
  renameSync, rmSync, mkdirSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Same calibration as close-pass.mjs: generous enough for a real close pass.
export const DEFAULT_STALE_MS = 10 * 60 * 1000;
// Past the hard ceiling a lock is stealable regardless of pid liveness — a
// SIGKILL'd owner whose pid got recycled must not strand the lock forever.
export const DEFAULT_HARD_STALE_MS = 30 * 60 * 1000;

export function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function newNonce() {
  return randomBytes(12).toString('hex');
}

/**
 * Inspect a lock file. { held, lock, stale } — held means a live, non-stale owner.
 */
export function inspectFileLock(lockPath, {
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
} = {}) {
  let ageMs = Infinity;
  try { ageMs = now - statSync(lockPath).mtimeMs; } catch { return { held: false, lock: null, stale: false }; }
  const lock = readJson(lockPath);
  if (!lock) {
    // Unreadable content. Our own writers create locks atomically (temp + link),
    // so a YOUNG unreadable lock is an outside writer mid-flight or real
    // corruption — treat as held until it ages out; never steal a fresh file.
    // (The race test proved the old corrupt→stale-immediately rule let a reader
    // that caught a half-written lock steal a FRESH one.)
    const stale = ageMs > staleMs;
    return { held: !stale, lock: null, stale };
  }
  const stale = (ageMs > staleMs && !pidAlive(lock.pid)) || ageMs > hardStaleMs;
  return { held: !stale, lock, stale };
}

/**
 * Create the lock file with its payload ATOMICALLY. openSync('wx') + writeSync
 * has a window where the path exists with empty content — a concurrent inspector
 * reads "corrupt" and may steal a lock that was just legitimately created. A
 * hard link from a fully-written temp file fails EEXIST exactly like 'wx' but
 * the content is complete the instant the path exists. Filesystems without hard
 * links (exFAT shares) fall back to the wx window — rare, and the young-corrupt
 * rule above covers it.
 */
function wxCreate(lockPath, payload, nonce) {
  const tmp = join(dirname(lockPath), `.${basename(lockPath)}.new-${nonce}`);
  writeFileSync(tmp, payload);
  try {
    linkSync(tmp, lockPath); // fails EEXIST — this IS the mutex
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'ENOENT') { try { rmSync(tmp); } catch { /* gone */ } throw e; }
    // No hard-link support: fall back to the wx create.
    try { rmSync(tmp); } catch { /* gone */ }
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, payload);
    closeSync(fd);
    return;
  }
  try { rmSync(tmp); } catch { /* gone */ }
}

/**
 * Acquire the lock. Returns { ok, nonce, lock, stolen? } or { ok:false, reason, lock? }.
 * `extra` fields (e.g. session_id) are merged into the lock payload for callers
 * whose release happens in a different process (they verify by their own field).
 */
export function acquireFileLock(lockPath, {
  extra = {},
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
} = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const nonce = newNonce();
  const payload = JSON.stringify({
    ...extra,
    pid: process.pid,
    nonce,
    started_at: new Date(now).toISOString(),
  });
  try {
    wxCreate(lockPath, payload, nonce);
    return { ok: true, nonce, lock: readJson(lockPath) };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  const { held, lock } = inspectFileLock(lockPath, { now, staleMs, hardStaleMs });
  if (held) return { ok: false, reason: 'held', lock };

  // Stale — steal via rename-claim CAS. Rename consumes the stale file atomically,
  // so of N concurrent stealers exactly one proceeds past this line.
  const graveyard = join(dirname(lockPath), `.${basename(lockPath)}.stale-${nonce}`);
  try {
    renameSync(lockPath, graveyard);
  } catch {
    // ENOENT: another stealer claimed it first. EPERM/EACCES (AV/sync holding the
    // file on Windows): can't safely steal. Either way: not acquired, retryable.
    return { ok: false, reason: 'steal-lost', lock };
  }
  try { rmSync(graveyard); } catch { /* best-effort */ }

  try {
    wxCreate(lockPath, payload, nonce);
  } catch {
    // A fresh acquirer slipped in between our rename and create — they own it.
    return { ok: false, reason: 'steal-lost', lock: readJson(lockPath) };
  }
  // Belt-and-braces: confirm our nonce survived (defends against any writer that
  // bypasses wx semantics, e.g. a legacy blind-overwrite steal still in the wild).
  const confirmed = readJson(lockPath);
  if (!confirmed || confirmed.nonce !== nonce) {
    return { ok: false, reason: 'steal-lost', lock: confirmed };
  }
  return { ok: true, nonce, lock: confirmed, stolen: true };
}

let _relCounter = 0;

/**
 * Release the lock ONLY if it is ours (nonce match, or `verify` — a {field, value}
 * pair for cross-process releases, e.g. close-pass's session_id).
 * force:true skips verification — reserved for explicit operator commands.
 *
 * The removal is an atomic rename-claim, not verify-then-rm (Hale's release-vs-steal
 * TOCTOU, 2026-07-15 advisory): with verify-then-rm, a hard-stale stealer can install
 * a fresh lock between the read and the rm, and the revived owner's rm then deletes
 * the FRESH owner's lock. Rename consumes the path atomically; we verify the claimed
 * file and restore it if it turns out not to be ours. Named residual: if the restore
 * collides with a brand-new acquirer (wx on the momentarily-empty path), the displaced
 * lock stays in the graveyard as a forensic breadcrumb and we report 'restore-failed'
 * — a three-way race inside a microsecond window, bounded by all writers being atomic.
 */
export function releaseFileLock(lockPath, nonce, { verify = null, force = false } = {}) {
  if (force) { try { rmSync(lockPath); } catch { /* already gone */ } return { released: true }; }
  const grave = join(dirname(lockPath), `.${basename(lockPath)}.rel-${process.pid}-${++_relCounter}`);
  try { renameSync(lockPath, grave); } catch { return { released: false, reason: 'absent' }; }
  const claimed = readJson(grave);
  const ours = claimed && ((nonce && claimed.nonce === nonce) ||
    (verify && claimed[verify.field] != null && claimed[verify.field] === verify.value));
  if (ours) { try { rmSync(grave); } catch { /* gone */ } return { released: true }; }
  // Not ours — we are a revived owner whose lock was stolen. Put the true owner's back.
  try { renameSync(grave, lockPath); return { released: false, reason: 'not-owner' }; }
  catch { return { released: false, reason: 'restore-failed', grave }; }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run fn while holding the lock; release (verified) in finally. Retries a
 * contended lock briefly — registry ops are short, so contention clears fast.
 * Throws Error(code='LOCK_HELD') if the lock can't be acquired within budget.
 */
export function withFileLock(lockPath, fn, {
  retries = 20,
  retryDelayMs = 100,
  extra = {},
  staleMs = DEFAULT_STALE_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
} = {}) {
  let got = null;
  for (let attempt = 0; ; attempt++) {
    got = acquireFileLock(lockPath, { extra, staleMs, hardStaleMs });
    if (got.ok) break;
    if (attempt >= retries) {
      const err = new Error(`lock held: ${lockPath} (owner pid ${got.lock?.pid ?? '?'}, reason ${got.reason})`);
      err.code = 'LOCK_HELD';
      err.lock = got.lock;
      throw err;
    }
    sleepSync(retryDelayMs);
  }
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath, got.nonce);
  }
}
