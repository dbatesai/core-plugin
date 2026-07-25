/**
 * file-lock.mjs — generalized advisory file lock: generation files + verified release.
 *
 * Third design iteration (2026-07-14/15, shared-write concurrency spec + independent
 * advisory passes), each driven by a proven defect in the previous one:
 *
 *   v1 (close-pass original): steal = blind atomic overwrite → two stealers could
 *      both "win"; release = unconditional rm → a revived slow owner deleted a
 *      fresh owner's lock.
 *   v2 (rename-claim): steal consumed the stale file atomically (one winner), and
 *      release verified ownership — but release-verify-then-remove kept a TOCTOU,
 *      and the rename-claim + restore repair had an irreducible three-process
 *      corner: a revived releaser could displace a fresh owner's lock while a
 *      third writer claimed the exposed path.
 *   v3 (this file): GENERATION LOCKS eliminate that corner structurally. The lock
 *      is a family of files `<lockPath>.g<N>` plus `.g<N>.done` tombstones:
 *
 *        - Acquire: target = (highest N over ALL generation artifacts, live or
 *          done) + 1, taken only when no live generation is fresh. Creating
 *          `<lockPath>.g<target>` exclusively IS the mutex — two acquirers that
 *          race compute the same target and the filesystem picks one winner.
 *        - Release: rename YOUR OWN generation file to its `.done` tombstone.
 *          No process ever moves, deletes, or restores another owner's lock, so
 *          the v2 corner cannot occur. The tombstone preserves the numbering:
 *          a later acquirer still computes max+1, so numbers never restart and a
 *          delete-then-lower-recreate split-brain is impossible.
 *        - Steal: nothing to steal — a stale live generation is simply left
 *          behind; the new owner creates the NEXT generation and garbage-collects
 *          artifacts below it (safe: they are inert once a higher live gen exists).
 *
 * Lock-file creation is atomic (write temp, hard-link into place) so no reader
 * ever sees a created-but-empty lock; on filesystems without hard links the
 * wx-create fallback is covered by the young-unreadable-is-held rule below
 * (proven by the forced-fallback race test, not asserted).
 *
 * Locks are advisory and same-machine. EPERM under sync/AV tooling reads as
 * "couldn't acquire, retry", never a crash. Callers with more than one lock
 * follow the total order: per-project lock BEFORE any global ~/.core lock.
 *
 * Ships with the plugin as prescriptive code; .mjs only, node:* imports only.
 */

import {
  readFileSync, writeFileSync, statSync, readdirSync,
  openSync, writeSync, closeSync, linkSync,
  renameSync, rmSync, mkdirSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Same calibration as close-pass.mjs: generous enough for a real close pass.
export const DEFAULT_STALE_MS = 10 * 60 * 1000;
// Ceiling for locks whose owner CANNOT be identified (unreadable content, no pid):
// past this they are supersedable. For locks with a READABLE, LIVE pid there is
// deliberately no ceiling — the round-3 review advisory (2026-07-15): a laptop
// suspended mid-critical-section revives past any fixed ceiling and would overlap
// its superseder, a mutual-exclusion break. Never steal from a live pid; the
// recycled-pid strand this reopens is accepted as the lesser failure (availability,
// not integrity) and surfaces as a loud LOCK_HELD error naming the pid, remedied
// by the operator force-release.
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

// ---------- generation bookkeeping ----------

/** All generation artifacts for a lock: [{n, done, path}], unsorted. */
function listGenerations(lockPath) {
  const dir = dirname(lockPath);
  const base = basename(lockPath);
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    // Legacy single-file lock (pre-generation format, e.g. a 3.10.0 session's
    // _close.lock): treated as generation 0 so a still-running old session's
    // lock is respected, its staleness judged by the same rules, and the first
    // new-format acquirer numbers itself above it. One-release compat shim.
    if (name === base) { out.push({ n: 0, done: false, path: join(dir, name) }); continue; }
    if (!name.startsWith(base + '.g')) continue;
    const m = name.slice(base.length).match(/^\.g(\d+)(\.done)?$/);
    if (m) out.push({ n: Number(m[1]), done: !!m[2], path: join(dir, name) });
  }
  return out;
}

/** The current live generation file (highest live N), or null. */
export function currentLockFile(lockPath) {
  const live = listGenerations(lockPath).filter(g => !g.done);
  if (!live.length) return null;
  live.sort((a, b) => b.n - a.n);
  return live[0].path;
}

/**
 * Inspect a pre-fetched generation snapshot. Same {held, lock, stale} contract
 * as inspectFileLock, but reads no directory state itself — the caller supplies
 * `gens` so a held-check and a maxN computation can share ONE listGenerations()
 * read instead of two independent ones taken at two different instants.
 */
function inspectFromGenerations(gens, { now, staleMs, hardStaleMs }) {
  const live = gens.filter(g => !g.done);
  if (!live.length) return { held: false, lock: null, stale: false };
  live.sort((a, b) => b.n - a.n);
  const cur = live[0].path;
  let ageMs = Infinity;
  try { ageMs = now - statSync(cur).mtimeMs; } catch { return { held: false, lock: null, stale: false }; }
  const lock = readJson(cur);
  if (!lock) {
    // Unreadable content. Our writers create locks atomically (temp + link), so a
    // YOUNG unreadable lock is an outside/fallback writer mid-flight — held until
    // it ages out; never treat a fresh file as stealable. (The v2 race test proved
    // corrupt→stale-immediately lets a reader steal a half-written fresh lock.)
    const stale = ageMs > staleMs;
    return { held: !stale, lock: null, stale };
  }
  // A lock with a recorded pid: stale only when aged AND the owner is dead.
  // NO liveness override at any age: a suspended-then-revived
  // owner past any ceiling would overlap its superseder. A readable lock with
  // no usable pid falls back to the hard ceiling.
  const stale = typeof lock.pid === 'number'
    ? (ageMs > staleMs && !pidAlive(lock.pid))
    : ageMs > hardStaleMs;
  return { held: !stale, lock, stale };
}

/**
 * Inspect the lock. { held, lock, stale } — held means a live, non-stale owner
 * of the current generation. Read-only diagnostic entry point (close-pass.mjs
 * uses this to report lock state without acquiring); acquireFileLock does NOT
 * call this — see K12 note below for why.
 */
export function inspectFileLock(lockPath, {
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
} = {}) {
  return inspectFromGenerations(listGenerations(lockPath), { now, staleMs, hardStaleMs });
}

/**
 * Create `path` with `payload` ATOMICALLY and EXCLUSIVELY. Hard link from a
 * fully-written temp file fails EEXIST exactly like 'wx' but the content is
 * complete the instant the path exists. Filesystems without hard links (and the
 * CORE_FILELOCK_NO_LINK=1 test seam) fall back to wx-create — the young-
 * unreadable-is-held rule in inspectFileLock covers that window (race-tested).
 */
function exclusiveCreate(path, payload, nonce) {
  if (!process.env.CORE_FILELOCK_NO_LINK) {
    const tmp = join(dirname(path), `.${basename(path)}.new-${nonce}`);
    writeFileSync(tmp, payload);
    try {
      linkSync(tmp, path); // fails EEXIST — this IS the mutex
      try { rmSync(tmp); } catch { /* gone */ }
      return;
    } catch (e) {
      try { rmSync(tmp); } catch { /* gone */ }
      if (e.code === 'EEXIST' || e.code === 'ENOENT') throw e;
      // fall through: no hard-link support on this filesystem
    }
  }
  const fd = openSync(path, 'wx');
  writeSync(fd, payload);
  closeSync(fd);
}

/**
 * Acquire the lock. Returns { ok, nonce, gen, lock, stolen? } or
 * { ok:false, reason, lock? }. `extra` fields (e.g. session_id) are merged into
 * the payload for callers whose release happens in a different process.
 */
export function acquireFileLock(lockPath, {
  extra = {},
  now = Date.now(),
  staleMs = DEFAULT_STALE_MS,
  hardStaleMs = DEFAULT_HARD_STALE_MS,
} = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const nonce = newNonce();

  // K12: the original code
  // read maxN from ONE listGenerations() call, then computed `held` from a
  // SECOND, independent listGenerations() read buried inside inspectFileLock
  // (via currentLockFile). Real I/O (statSync + readJson + a pidAlive syscall)
  // separates those two reads in time. Under load, a full concurrent
  // acquire-then-release cycle can complete entirely inside that window: the
  // maxN this process computed is then stale by the time it creates its own
  // generation file, and `target = maxN + 1` can collide with a generation
  // number that already existed and was already retired (renamed to `.done`)
  // by someone else — the live path for that number is free again, so our
  // exclusiveCreate succeeds and silently resurrects a used number. A later,
  // correctly-computed acquirer then sees our resurrected low generation as
  // garbage below its own (higher, correctly-computed) target and GC's it out
  // from under us while we still believe we hold the lock — two processes in
  // the critical section at once, and our eventual release reports
  // 'not-owner' because our generation file is simply gone (review measured
  // 1/8, 2/10 failure rates under concurrent load).
  //
  // Fixed two ways: (1) maxN and the held-check now derive from the SAME
  // listGenerations() snapshot, closing the two-read window entirely; (2)
  // after winning exclusiveCreate, re-list and confirm no OTHER generation
  // artifact (live or done) carries n >= target — if one does, our target was
  // stale despite the single-snapshot read (the window between snapshot and
  // create is non-zero and can never be fully closed with plain filesystem
  // ops), so we back off: remove our own resurrected file and report a
  // retryable loss instead of proceeding as if we held an honest lock.
  const gens = listGenerations(lockPath);
  const maxN = gens.reduce((m, g) => Math.max(m, g.n), 0);
  const { held, lock, stale } = inspectFromGenerations(gens, { now, staleMs, hardStaleMs });

  // Test-only seam (K12 regression coverage): widen the snapshot-to-create
  // window deterministically so the stale-target race can be reproduced
  // without depending on real scheduler timing. Never set outside tests.
  // CORE_FILELOCK_TEST_SIGNAL_FILE is written the instant the snapshot above
  // is taken (before the held check, before the sleep) — a real happens-before
  // a test can block on, rather than a second process racing to start at
  // roughly the same wall-clock moment (which flaked on a loaded Windows
  // runner: a shared start barrier alone doesn't guarantee WHICH process's
  // first listGenerations() read happens first).
  const testDelayMs = Number(process.env.CORE_FILELOCK_TEST_DELAY_MS || 0);
  if (testDelayMs > 0 && process.env.CORE_FILELOCK_TEST_SIGNAL_FILE) {
    try { writeFileSync(process.env.CORE_FILELOCK_TEST_SIGNAL_FILE, String(process.pid)); } catch { /* best effort */ }
  }
  if (held) return { ok: false, reason: 'held', lock };
  if (testDelayMs > 0) sleepSync(testDelayMs);

  // Target the next generation. The tombstone convention makes maxN monotonic —
  // numbering never restarts, so two racers reading the SAME snapshot always
  // compute the SAME target and the exclusive create picks exactly one winner.
  const target = maxN + 1;
  const targetPath = join(dirname(lockPath), `${basename(lockPath)}.g${target}`);
  const payload = JSON.stringify({
    ...extra,
    pid: process.pid,
    nonce,
    gen: target,
    started_at: new Date(now).toISOString(),
  });
  try {
    exclusiveCreate(targetPath, payload, nonce);
  } catch {
    // EEXIST: another acquirer won this generation (fresh — report held).
    // EPERM/other (sync/AV): couldn't acquire safely. Either way: retryable.
    return { ok: false, reason: stale ? 'steal-lost' : 'create-lost', lock: readJson(currentLockFile(lockPath) || '') };
  }
  // Post-win re-verify: if any OTHER artifact (live or done) at n >= target
  // exists now, our target number was already used by a cycle that completed
  // inside the snapshot-to-create window — back off rather than proceed.
  const staleTarget = listGenerations(lockPath).some(g => g.path !== targetPath && g.n >= target);
  if (staleTarget) {
    try { rmSync(targetPath); } catch { /* gone */ }
    return { ok: false, reason: 'stale-target', lock: readJson(currentLockFile(lockPath) || '') };
  }
  // Winner. Garbage-collect inert artifacts below us (stale live gens + old
  // tombstones). Safe: our live generation preserves the numbering max, and a
  // superseded owner's release of a GC'd file is a harmless no-op.
  for (const g of listGenerations(lockPath)) {
    if (g.n < target) { try { rmSync(g.path); } catch { /* gone */ } }
  }
  return { ok: true, nonce, gen: target, lock: readJson(targetPath), stolen: stale };
}

/**
 * Release the lock ONLY if a generation file is ours (nonce match, or `verify` —
 * a {field, value} pair for cross-process releases, e.g. close-pass's session_id).
 * Releasing = renaming OUR OWN generation file to its `.done` tombstone — we
 * never touch another owner's file, which is what eliminates the v2 three-process
 * corner. force:true removes every generation artifact (operator command).
 */
export function releaseFileLock(lockPath, nonce, { verify = null, force = false } = {}) {
  const gens = listGenerations(lockPath);
  if (force) {
    // The operator recovery path must not lie either: a removal
    // that fails for any reason other than already-gone reports failure, naming
    // the artifact and cause — "lock released" while the lock survives is worse
    // than the stuck lock itself.
    const failures = [];
    for (const g of gens) {
      try { rmSync(g.path); }
      catch (e) { if (e.code !== 'ENOENT') failures.push(`${basename(g.path)}: ${e.code || e}`); }
    }
    if (failures.length) return { released: false, reason: 'release-failed', error: failures.join('; ') };
    return { released: true };
  }
  if (!gens.some(g => !g.done)) return { released: false, reason: 'absent' };
  for (const g of gens) {
    if (g.done) continue;
    const lock = readJson(g.path);
    const ours = lock && ((nonce && lock.nonce === nonce) ||
      (verify && lock[verify.field] != null && lock[verify.field] === verify.value));
    if (ours) {
      try { renameSync(g.path, `${g.path}.done`); }
      catch (e) {
        // ENOENT only: our generation was superseded and GC'd — released in effect.
        // Anything else (EPERM/EACCES/EIO — sync tooling, permissions, disk) means
        // the LIVE lock file is still on disk: report failure, never false success
        // (review round: the old blanket catch returned released:true over a live lock).
        if (e.code !== 'ENOENT') return { released: false, reason: 'release-failed', error: e.code || String(e) };
      }
      return { released: true };
    }
  }
  return { released: false, reason: 'not-owner' };
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
  // K12: this used to be `try { return fn(); }
  // finally { releaseFileLock(...); }` — releaseFileLock's return value was
  // discarded entirely. releaseFileLock already does the work of honestly
  // reporting a real failure ({released:false, reason, error} — EPERM/EACCES/
  // a generation another process claimed), but nothing ever read it, so a
  // failed release was indistinguishable from a successful one to every caller.
  // Fixed: a release failure is never silent now. If fn() succeeded, the
  // release failure becomes the loud signal (a real thrown error — "report
  // failure, never false success", the same rule releaseFileLock itself
  // already follows). If fn() threw, its error is still what propagates
  // (a lock-release problem must never mask the real failure that already
  // happened), but the release failure is attached to it and logged loudly
  // rather than dropped.
  let result, threw = false, caught;
  try {
    result = fn();
  } catch (e) {
    threw = true;
    caught = e;
  }
  const rel = releaseFileLock(lockPath, got.nonce);
  if (!rel.released) {
    const detail = `${lockPath} (reason: ${rel.reason}${rel.error ? `, error: ${rel.error}` : ''}) — lock may still be live on disk`;
    if (threw) {
      try { if (caught && typeof caught === 'object') caught.lockReleaseFailure = rel; } catch { /* caught may be frozen/non-object */ }
      process.stderr.write(`withFileLock: lock release failed for ${detail} (masked by an in-flight error from fn(): ${caught && caught.message ? caught.message : caught})\n`);
    } else {
      const err = new Error(`withFileLock: lock release failed for ${detail}`);
      err.code = 'LOCK_RELEASE_FAILED';
      err.lockPath = lockPath;
      err.releaseResult = rel;
      throw err;
    }
  }
  if (threw) throw caught;
  return result;
}
