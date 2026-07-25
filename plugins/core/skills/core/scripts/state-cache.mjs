/**
 * state-cache.mjs — shared file-write-attribution primitives for the
 * edit-detection state cache.
 *
 * Extracted 2026-07-22: `hot-section.mjs` was the only
 * script that stamped `last_written_by` into the state cache in code — the
 * lock-and-write logic lived inline in its `recordProjectMdWrite`.
 * `decorate-graph.mjs` needed the identical primitive (a script rewrites a
 * file on the user's behalf; edit-detection must not misread that write as a
 * user edit on the next session) and duplicating the lock/prune logic a
 * second time would just be one more place for the two copies to drift.
 * This module is that shared primitive; `hot-section.mjs`'s
 * `recordProjectMdWrite` now calls into it instead of owning its own copy.
 *
 * Cache of record: per-project at `<project>/_memories/_lib/state-cache.json`
 * — single-owner ACROSS PROJECTS (two projects closing at once can't clobber
 * each other's hashes, since each writes its own file), but NOT single-owner
 * WITHIN a project: `decorate-graph.mjs`, `hot-section.mjs`, and
 * `maintenance-run.mjs` can all stamp the same project-local cache file in
 * the same window (concurrent hooks/agents/CLI invocations), and the write
 * itself is a read-modify-write over the whole JSON file. Hale's 40-concurrent-
 * process probe (2026-07-22) measured the real consequence of the old
 * "no lock needed" assumption: 29/40 stamps survived, 11 lost to the race.
 * Fixed: the read-modify-write below is now serialized under a project-local
 * lock (`<project>/_memories/_lib/.state-cache.lock`, same `withFileLock`
 * primitive every other lock in this codebase uses — no new mechanism). A
 * residual global `~/.core/state-cache.json` exists for genuinely
 * cross-project files; every per-project stamp also prunes its own file
 * paths out of the global cache under `~/.core/state-cache.lock`, so a stale
 * global entry can never shadow a fresher per-project one (see
 * `data-storage.md` §"Shared-write concurrency" for the one-release
 * union-read this migration established).
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

import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';

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

export function readProjectCache(projectDir) {
  const path = projectCachePath(projectDir);
  try {
    const cache = JSON.parse(readFileSync(path, 'utf8'));
    if (cache && typeof cache === 'object' && cache.files && typeof cache.files === 'object') return cache;
  } catch { /* absent or unparseable — start fresh */ }
  return { files: {} };
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
export function stampFiles(projectDir, entries, { now, home = homedir() } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { stamped: true };
  const ts = now || nowIso();
  const cachePath = projectCachePath(projectDir);

  // The read-modify-write over the whole project-local cache file must be
  // serialized: any caller of stampFiles/stampFile races every OTHER caller
  // (decorate-graph, hot-section, maintenance-run, and any future writer),
  // not just other instances of itself. Reuses the same withFileLock
  // primitive every other lock in this codebase uses (Hale's finding,
  // 2026-07-22 — 29/40 entries survived an unlocked 40-concurrent-process
  // stamp probe). A lock-acquire or cache-write failure never THROWS into the
  // caller (the underlying content write already happened), but it IS now
  // reported truthfully instead of silently swallowed.
  let stampOutcome = { stamped: true };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    withFileLock(join(dirname(cachePath), '.state-cache.lock'), () => {
      const cache = readProjectCache(projectDir);
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
  const globalCachePath = join(home, '.core', 'state-cache.json');
  try {
    withFileLock(join(home, '.core', 'state-cache.lock'), () => {
      let gcache;
      try { gcache = JSON.parse(readFileSync(globalCachePath, 'utf8')); } catch { gcache = null; }
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
