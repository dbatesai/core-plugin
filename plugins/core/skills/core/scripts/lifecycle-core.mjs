/**
 * lifecycle-core.mjs — the user-authorship-boundary primitives shared by every
 * writer that mutates a mixed-ownership file.
 * Deliberately imports NO writer module (only node:* + file-lock), so the
 * writers can depend on it without an import cycle, and `lifecycle-detect.mjs`
 * (the executable preflight) can depend on BOTH the writers and this.
 *
 * Two things live here, and only these two:
 *
 *   1. `writeGuardDecision` — the single, shared refuse-or-proceed rule every
 *      in-scope writer applies against the PRE-WRITE cache baseline, so the
 *      decision is identical across decorate-graph, hot-section, compact-project,
 *      demote-moves, and demote-state-narrative rather than several subtly-
 *      divergent inline copies.
 *
 *   2. `withProjectMdWriterLock` — ONE shared lock across ALL writers that touch
 *      PROJECT.md (hot-section, compaction, moves/state demotion, full render).
 *      Writer-local locks (.hot-section.lock etc.) only serialize a writer
 *      against ITSELF; two DIFFERENT writers racing the same PROJECT.md still
 *      interleave destructively without a lock they all share.
 *
 * THE AUTHORSHIP RULE (Hale's 2026-07-22 falsifier — session timing cannot prove
 * authorship). A file with NO cache-stamp baseline is NEVER assumed to be
 * CORE-authored. The previous design inferred "absent from the session-start
 * inventory => CORE created it this session => safe to auto-write" — that
 * inference is false: a file the USER creates by hand partway through a session
 * is also absent from the start-of-session inventory, so timing alone cannot
 * tell "CORE created this a moment ago" from "the user created this a moment
 * ago." That inference is removed. The ONLY way a no-baseline file becomes
 * writable by decorate/hot-section/compact is that the CREATING CORE writer
 * stamps the exact bytes it just wrote, at creation time (see
 * `lifecycle-detect.mjs` `stampCreatedBaseline`/`createFile`). Absent that
 * stamp, every downstream writer REFUSES the file and surfaces it as
 * `no-baseline`/`needs-reconciliation` — fail closed, never fail open.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only, node:* imports only.
 */

import { join, resolve } from 'node:path';
import { withFileLock } from './file-lock.mjs';

// ---------- Shared PROJECT.md writer lock ----------

/** The ONE lock every PROJECT.md writer acquires. Distinct from each writer's
 *  old private lock, which only serialized a writer against itself. */
export function projectMdWriterLockPath(projectDir) {
  return join(resolve(projectDir), '_memories', '.project-md-writer.lock');
}

/** Run `fn` while holding the shared PROJECT.md writer lock. Generous retry
 *  budget: PROJECT.md writes are short, so contention (a hook + a manual close)
 *  clears fast. Same withFileLock primitive every other lock uses. */
export function withProjectMdWriterLock(projectDir, fn, opts = {}) {
  return withFileLock(projectMdWriterLockPath(projectDir), fn, {
    retries: 40, retryDelayMs: 50, ...opts,
  });
}

// ---------- The no-baseline safety rule ----------

/**
 * resolveNoBaseline — the judgment for a file that has NO cache baseline at all.
 *
 * There is exactly one answer now: REFUSE. Timing-based authorship inference
 * (the old "absent from session inventory => created-this-session => safe"
 * branch) is GONE — it could not distinguish a CORE-created file from a
 * user-created one that appeared after session start (Hale's 2026-07-22
 * executable falsifier). A creating CORE writer establishes the first baseline
 * itself at creation time; any writer that later meets a file with no baseline
 * is, by construction, NOT its creator and must not overwrite or attribute it.
 *
 * Kept as a named export (rather than inlined) so the decision has one home and
 * the intent is documented at the call site. Always returns:
 *   { safe: false, reason: 'no-baseline' }
 */
export function resolveNoBaseline() {
  return { safe: false, reason: 'no-baseline' };
}

/**
 * writeGuardDecision — the shared refuse-or-proceed rule. `classification` is
 * whatever the domain classifier returned for this file's human-authored region
 * against the pre-write baseline: one of 'hot-block-only' / 'edges-block-only'
 * (CORE's own generated region, safe), 'outside-changed' (a real edit to the
 * human-authored region since the last stamp — an unreconciled user edit), or
 * 'no-baseline' (the classifier had no outside_hash to compare against).
 *
 * Returns { proceed, classification, reason? }:
 *   - No cache stamp at all → REFUSE ('no-baseline'): a creating writer would
 *     have stamped it; absence means it is not CORE-authored (see the module
 *     header). Fail closed.
 *   - Cache stamp present but the region diverged ('outside-changed') or can't
 *     be proven ('no-baseline' with a stamp that predates outside_hash) →
 *     refuse; it is an unreconciled edit in flight and must not be laundered.
 *   - Otherwise (region byte-identical to the baseline) → proceed.
 */
export function writeGuardDecision({ cachedStamp, classification }) {
  if (!cachedStamp) {
    const nb = resolveNoBaseline();
    return { proceed: false, classification: 'no-baseline', reason: nb.reason };
  }
  if (classification === 'outside-changed' || classification === 'no-baseline') {
    return { proceed: false, classification, reason: classification };
  }
  return { proceed: true, classification };
}
