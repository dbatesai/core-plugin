/**
 * lifecycle-core.mjs — the user-authorship-boundary primitives shared by every
 * writer that mutates a mixed-ownership file (Hale's 2026-07-22 finding, second
 * pass). Deliberately imports NO writer module (only node:* + file-lock), so the
 * writers can depend on it without an import cycle, and `lifecycle-detect.mjs`
 * (the executable preflight) can depend on BOTH the writers and this.
 *
 * Three things live here, and only these three:
 *
 *   1. The session-start inventory — the record of which user-sensitive files
 *      already existed when the session began. This is what lets a no-cache-
 *      baseline file be told apart: a file present at session start with no
 *      cache stamp is a genuinely PRE-EXISTING, never-seen file (a user could
 *      have created it between sessions — treat conservatively); a file that
 *      appears only AFTER session start is one CORE created this session (the
 *      normal graduation/first-write path — safe to establish its baseline).
 *      This is the honest `no-baseline` semantics Hale's point 8 asked for.
 *
 *   2. `writeGuardDecision` — the single, shared refuse-or-proceed rule every
 *      in-scope writer applies against the PRE-WRITE cache baseline, so the
 *      decision is identical across decorate-graph, hot-section, and
 *      compact-project rather than three subtly-divergent inline copies.
 *
 *   3. `withProjectMdWriterLock` — ONE shared lock across ALL writers that touch
 *      PROJECT.md (hot-section, compaction, moves/state demotion, full render).
 *      Writer-local locks (.hot-section.lock etc.) only serialize a writer
 *      against ITSELF; two DIFFERENT writers racing the same PROJECT.md still
 *      interleave destructively without a lock they all share (Hale's point 7).
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only, node:* imports only.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withFileLock } from './file-lock.mjs';

// ---------- Shared PROJECT.md writer lock (Hale point 7) ----------

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

// ---------- Session-start inventory (Hale point 8) ----------

export function sessionInventoryPath(projectDir) {
  return join(resolve(projectDir), '_memories', '_lib', '.lifecycle-session.json');
}

/**
 * Read the session-start inventory, or `null` when none has been recorded.
 * `null` is a real, distinct state: it means "no preflight ran this session,"
 * and every caller degrades gracefully to the pre-fix behaviour (first write
 * establishes the baseline) rather than blocking legitimate work.
 */
export function readSessionInventory(projectDir) {
  try {
    const inv = JSON.parse(readFileSync(sessionInventoryPath(projectDir), 'utf8'));
    if (inv && typeof inv === 'object' && Array.isArray(inv.paths)) return inv;
  } catch { /* absent or unparseable — treat as no inventory */ }
  return null;
}

/**
 * resolveNoBaseline — the point-8 judgment call, isolated so it has exactly one
 * home. Given a file that has NO cache baseline at all, decide whether writing
 * it now is a safe first write (CORE created it this session) or must be held
 * (it pre-existed the session and CORE has genuinely never reconciled it).
 *
 *   - No inventory recorded  → { safe:true,  reason:'no-session-inventory' }
 *       Graceful degradation: without a preflight there is no signal to tell
 *       the two apart, so preserve the established first-write-is-safe behaviour
 *       rather than block the normal graduation→decoration path. (This is the
 *       exact failure point 8 warns against — a brand-new unit written this
 *       session must NOT get stuck in no-baseline limbo.)
 *   - Path in the inventory  → { safe:false, reason:'pre-existing-uncached' }
 *       The file already existed when the session began and still has no cache
 *       stamp — CORE never wrote or reconciled it, so it might be a real user
 *       creation. Fail closed: surface it, do not silently auto-write over it.
 *   - Path not in inventory  → { safe:true,  reason:'created-this-session' }
 *       The file did not exist at session start, so CORE created it this
 *       session (graduation, a first render). This is exactly how a baseline
 *       gets established for a legitimately new file.
 */
export function resolveNoBaseline(projectDir, absPath, { sessionInventory } = {}) {
  const inv = sessionInventory === undefined ? readSessionInventory(projectDir) : sessionInventory;
  if (!inv) return { safe: true, reason: 'no-session-inventory' };
  const abs = resolve(absPath);
  const present = inv.paths.some(p => resolve(p) === abs);
  return present
    ? { safe: false, reason: 'pre-existing-uncached' }
    : { safe: true, reason: 'created-this-session' };
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
 *   - No cache stamp at all → defer to resolveNoBaseline (point 8).
 *   - Cache stamp present but the region diverged ('outside-changed') or can't
 *     be proven ('no-baseline' with a stamp that predates outside_hash) →
 *     refuse; it is an unreconciled edit in flight and must not be laundered.
 *   - Otherwise (region byte-identical to the baseline) → proceed.
 */
export function writeGuardDecision({ cachedStamp, classification, projectDir, absPath, sessionInventory }) {
  if (!cachedStamp) {
    const nb = resolveNoBaseline(projectDir, absPath, { sessionInventory });
    return nb.safe
      ? { proceed: true, classification: 'no-baseline', reason: nb.reason }
      : { proceed: false, classification: 'no-baseline', reason: nb.reason };
  }
  if (classification === 'outside-changed' || classification === 'no-baseline') {
    return { proceed: false, classification, reason: classification };
  }
  return { proceed: true, classification };
}
