/**
 * state-cache.mjs — shared file-write-attribution primitives for the
 * edit-detection state cache.
 *
 * When a script rewrites a file on the user's behalf, edit-detection must not
 * misread that write as a user edit on the next session — so the write gets
 * stamped `last_written_by` in the state cache. This module is the one
 * shared lock-and-write primitive for that stamp: `hot-section.mjs`'s
 * `recordProjectMdWrite` and `decorate-graph.mjs` both call into it rather
 * than owning copies of the lock/prune logic that could drift.
 *
 * Cache of record: per-project at `<project>/_memories/_lib/state-cache.json`
 * — single-owner ACROSS PROJECTS (two projects closing at once can't clobber
 * each other's hashes, since each writes its own file), but NOT single-owner
 * WITHIN a project: `decorate-graph.mjs`, `hot-section.mjs`, and
 * `maintenance-run.mjs` can all stamp the same project-local cache file in
 * the same window (concurrent hooks/agents/CLI invocations), and the write
 * itself is a read-modify-write over the whole JSON file — an unlocked
 * read-modify-write loses stamps to the race. So the write below is
 * serialized under a project-local lock
 * (`<project>/_memories/_lib/.state-cache.lock`, same `withFileLock`
 * primitive every other lock in this codebase uses — no new mechanism). A
 * residual global `~/.core/state-cache.json` exists for genuinely
 * cross-project files; every per-project stamp also prunes its own file
 * paths out of the global cache under `~/.core/state-cache.lock`, so a stale
 * global entry can never shadow a fresher per-project one (see
 * `data-storage.md` §"Shared-write concurrency" for the union-read rule).
 *
 * What this module deliberately does NOT own: any domain-specific "what
 * counts as CORE's own write vs a real user edit" classification (e.g.
 * hashing outside a marker-delimited block). That logic differs per file
 * shape (PROJECT.md's hot block vs a unit's edges block) and stays next to
 * the code that defines the block markers — see `hot-section.mjs`'s
 * `hashOutsideHotBlock`/`classifyProjectMdChange` and `decorate-graph.mjs`'s
 * `hashOutsideEdgesBlock`/`classifyUnitChange`. This module only provides the
 * generic hash primitive and the stamp-and-prune plumbing both of those
 * build on.
 */

import { readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { requireTrustedHome } from './trusted-home.mjs';

/**
 * The residual global cache lives under the operational root, so it resolves
 * from the OS-account home. An unresolvable one throws rather than writing
 * beneath whatever $HOME happens to say.
 */
export function globalCacheDir(opts) {
  return join(requireTrustedHome(opts), '.core');
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Generic content hash — sha256, truncated to 16 hex chars (matches the
 * convention `hot-section.mjs` established: enough to detect a mismatch,
 * short enough to keep the cache file readable). */
export function hashText(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

export function projectCachePath(projectDir) {
  return join(resolve(projectDir), '_memories', '_lib', 'state-cache.json');
}

/** Three distinct answers, because rebuilding damage as absence destroys evidence. */
export const CACHE_CLEAN = 'clean';
export const CACHE_ABSENT = 'absent';
export const CACHE_CORRUPT = 'corrupt';

/**
 * Read the project-local cache. The returned `status` separates a store that has
 * never been stamped (`absent`) from one whose baseline is unreadable
 * (`corrupt`) — both yield an empty `files` map, but only the first means "no
 * prior attribution existed". A caller that cannot tell them apart converts
 * damage into a plausible fresh start and overwrites the evidence.
 */
export function readProjectCache(projectDir) {
  const path = projectCachePath(projectDir);
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return { files: {}, status: CACHE_ABSENT }; }
  try {
    const cache = JSON.parse(raw);
    if (cache && typeof cache === 'object' && cache.files
      && typeof cache.files === 'object' && !Array.isArray(cache.files)) {
      return { ...cache, status: CACHE_CLEAN };
    }
  } catch { /* unparseable — corrupt, handled below */ }
  return { files: {}, status: CACHE_CORRUPT };
}

/**
 * Move a damaged cache aside, bytes intact, so the rebuild cannot destroy it.
 * Returns the quarantine path, or null when nothing could be preserved.
 */
export function quarantineCache(path, now = nowIso()) {
  if (!existsSync(path)) return null;
  const stamp = String(now).replace(/[:.]/g, '-');
  const dest = `${path}.corrupt-${stamp}`;
  try { renameSync(path, dest); return dest; } catch { return null; }
}

/**
 * stampFiles — record one or more file writes as CORE's own authorship, in
 * the project-local cache, then prune the same absolute paths from the
 * residual global cache under its lock. The cache write must never THROW —
 * the caller's real content write has already landed by the time this runs,
 * so a failure here must not blow up the caller — but it must NOT be swallowed
 * silently either: a content write that succeeds
 * while the baseline stamp fails means the file's on-disk bytes and its
 * recorded authorship have diverged. Reported, not hidden.
 *
 * Returns a truthful outcome:
 *   { stamped: true }
 *       The baseline landed. Attribution is correct.
 *   { stamped: false, outcome: 'attribution-unknown', recovery: 'recovery-required', reason }
 *       The content write already happened but the stamp did NOT land (lock
 *       timeout, disk error, EPERM under sync/AV). The file's authorship is now
 *       unknown: next lifecycle pass will see its content hash disagree with
 *       the (stale or absent) baseline and correctly treat it as unreconciled —
 *       i.e. it fails CLOSED on its own, which is the safe direction. The caller
 *       surfaces this so a human knows a re-stamp/reconcile is owed. No
 *       cross-file transaction is claimed or needed.
 *
 * @param {string} projectDir
 * @param {Array<{path: string, hash: string, lastWrittenBy: string, extra?: object}>} entries
 *   `path` absolute; `hash` the caller's own content hash for THIS stamp
 *   (whole-file or domain-specific, caller's choice) recorded as
 *   `last_hash`; `extra` merges additional fields into the stamp (e.g.
 *   `outside_hash` for a marker-delimited-block classifier).
 * @param {{now?: string, home?: string}} [opts]
 * @returns {{stamped: boolean, outcome?: string, recovery?: string, reason?: string}}
 */
export function stampFiles(projectDir, entries, { now, home = null } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { stamped: true };
  const ts = now || nowIso();
  const cachePath = projectCachePath(projectDir);

  // The read-modify-write over the whole project-local cache file must be
  // serialized: any caller of stampFiles/stampFile races every OTHER caller
  // (decorate-graph, hot-section, maintenance-run, and any future writer),
  // not just other instances of itself. Reuses the same withFileLock
  // primitive every other lock in this codebase uses. A lock-acquire or
  // cache-write failure never THROWS into the
  // caller (the underlying content write already happened), but it IS
  // reported truthfully instead of silently swallowed.
  let stampOutcome = { stamped: true };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    withFileLock(join(dirname(cachePath), '.state-cache.lock'), () => {
      const cache = readProjectCache(projectDir);
      // A damaged baseline is preserved, never overwritten: the rebuild below
      // would otherwise turn unreadable prior attribution into a plausible
      // partial cache, and every file it used to describe would silently
      // reclassify. The new stamp still lands; what the old bytes said is
      // reported as unknown, with the file kept for recovery.
      if (cache.status === CACHE_CORRUPT) {
        const quarantined = quarantineCache(cachePath, ts);
        stampOutcome = {
          stamped: true,
          outcome: 'prior-attribution-unknown',
          recovery: 'recovery-required',
          reason: 'corrupt-cache-quarantined',
          quarantined,
        };
      }
      for (const e of entries) {
        cache.files[e.path] = {
          last_hash: e.hash,
          last_written: ts,
          last_written_by: e.lastWrittenBy,
          ...(e.extra || {}),
        };
      }
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
    }, { retries: 20, retryDelayMs: 50 });
  } catch (e) {
    stampOutcome = {
      stamped: false,
      outcome: 'attribution-unknown',
      recovery: 'recovery-required',
      reason: (e && (e.code || e.message)) ? String(e.code || e.message) : 'stamp-failed',
    };
  }

  // One-release migration prune (matches recordProjectMdWrite's original
  // behavior): drop these paths from the global cache under the lock, so a
  // stale global stamp can't shadow the fresher per-project one. A prune
  // failure is genuinely best-effort — a held lock just defers the prune to
  // the next stamp and can't corrupt attribution — so it does NOT downgrade a
  // successful project-local stamp.
  try {
    const coreDir = home ? join(home, '.core') : globalCacheDir();
    const globalCachePath = join(coreDir, 'state-cache.json');
    withFileLock(join(coreDir, 'state-cache.lock'), () => {
      let gcache;
      let readable = true;
      try { gcache = JSON.parse(readFileSync(globalCachePath, 'utf8')); }
      catch { gcache = null; readable = !existsSync(globalCachePath); }
      // A damaged global cache is moved aside rather than left in place to
      // shadow the fresher per-project stamps it can no longer be pruned from.
      if (!readable) quarantineCache(globalCachePath, ts);
      if (!gcache?.files) return;
      let changed = false;
      for (const e of entries) {
        if (e.path in gcache.files) { delete gcache.files[e.path]; changed = true; }
      }
      if (changed) atomicWriteFileSync(globalCachePath, JSON.stringify(gcache, null, 2) + '\n');
    }, { retries: 3, retryDelayMs: 50 });
  } catch { /* best-effort — a held lock just defers the prune to the next stamp */ }

  return stampOutcome;
}

/** Convenience single-file wrapper around stampFiles. Returns the same
 *  truthful outcome. */
export function stampFile(projectDir, path, hash, lastWrittenBy, { now, home, extra } = {}) {
  return stampFiles(projectDir, [{ path, hash, lastWrittenBy, extra }], { now, home });
}
