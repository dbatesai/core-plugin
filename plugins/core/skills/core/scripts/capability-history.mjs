/**
 * capability-history.mjs — append-only capability-row history with advisory lock.
 *
 * Stores each
 * session's capability rows so drift and regression can be detected across
 * sessions (analyze-capability-drift.mjs is the consumer).
 *
 * Storage: the project's per-harness state, `<project>/_core/<harness>/capability-history.jsonl`
 *   (or ~/.core/local/<slug>/<harness>/ for a synced, read-only or another install's project),
 *   with a project fallback at `<project>/_metrics/capability-history/<harness>.jsonl`.
 *   One JSON object per line:
 *   { observed_at, runner_version, schema_version, harness,
 *     session_id, row_content_hash, row }
 *
 * STORAGE: JSONL + advisory lock, NOT Maildir. The single-writer-per-project-and-harness
 * assumption is guarded by an advisory lock with stale recovery, and a
 * two-writer test fixture proves no lost history.
 *
 * Retention: byte-cap (default 512KB). On breach, keep the most recent
 * RETENTION_PER_CAPABILITY entries per capability_id; older drop.
 *
 * Atomic writes: temp-file + rename (same pattern as collab events).
 */

import {
  readFileSync, existsSync, mkdirSync, chmodSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { stateDir, assertHarnessName } from './project-state.mjs';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { acquireFileLock, withAcquiredFileLock } from './file-lock.mjs';

export const BYTE_CAP = 512 * 1024;           // 512KB per workspace
export const RETENTION_PER_CAPABILITY = 80;   // entries kept per capability_id on cap breach
export const LOCK_TIMEOUT_MS = 1000;          // bounded wait on the startup path
export const LOCK_RETRY_INTERVAL_MS = 25;     // sleep slice between lock-acquire retries
export const STALE_LOCK_MS = 30000;           // a lock older than 30s is presumed stale

// Capability rows carry workspace paths, session ids, and executable identities — a map
// of the machine. The store is owner-only, as is the directory holding it.
const EVIDENCE_FILE_MODE = 0o600;
const EVIDENCE_DIR_MODE = 0o700;

function projectHistoryPath(project, harness) {
  return join(project, '_metrics', 'capability-history', `${assertHarnessName(harness)}.jsonl`);
}

function projectLockPath(project, harness) {
  return join(project, '_metrics', 'capability-history', `${assertHarnessName(harness)}.lock`);
}

/**
 * Where a history lives. `target` is { root, harness }. With opts.project the
 * project-local fallback store is used. Returns null for a read when no
 * trustworthy state exists yet.
 */
function resolveStorePaths(target, opts = {}, { forWrite = false } = {}) {
  const { root, harness } = target || {};
  assertHarnessName(harness);
  if (opts.project) {
    return { file: projectHistoryPath(opts.project, harness), lock: projectLockPath(opts.project, harness) };
  }
  if (!root) throw new Error('capability-history: target.root is required');
  const home = opts.home || homedir();
  const s = stateDir({ root, harness, kind: 'hot', coreDir: join(home, '.core'), forWrite });
  if (!s) return null;
  return { file: join(s.dir, 'capability-history.jsonl'), lock: join(s.dir, 'capability-history.lock') };
}

/**
 * Canonical JSON for hashing: sorted keys, no whitespace, evidence sorted by
 * source. `observed_at` is excluded so the same row in two sessions hashes equal.
 */
export function canonicalRowHash(row) {
  const clone = JSON.parse(JSON.stringify(row));
  delete clone.observed_at;
  if (Array.isArray(clone.evidence)) {
    clone.evidence = [...clone.evidence].sort((a, b) =>
      String(a.source ?? '').localeCompare(String(b.source ?? '')));
  }
  const sortKeys = (obj) => {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj && typeof obj === 'object') {
      return Object.keys(obj).sort().reduce((acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {});
    }
    return obj;
  };
  const canonical = JSON.stringify(sortKeys(clone));
  return createHash('sha256').update(canonical).digest('hex');
}

/** CPU-yielding synchronous sleep. Atomics.wait blocks without spinning — the
 * callers are short-lived CLI processes, so blocking-but-idle is the honest
 * tradeoff; a busy-wait would burn a core for the whole timeout. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an advisory lock via exclusive file creation (wx flag).
 * Recovers stale locks (older than STALE_LOCK_MS). Returns a checked release function.
 * The release function may take an operation callback, so appendRows can preserve
 * its completed outcome and original error using the shared completion logic.
 * Throws if it can't acquire within timeoutMs — bounded retries with a
 * CPU-yielding sleep between attempts, never a busy-spin.
 */
export function acquireLock(lockFile, { now = Date.now, timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS, sleep = sleepSync } = {}) {
  const deadline = now() + timeoutMs;
  // Delegates entirely to file-lock.mjs (one lock implementation,
  // not three). Generation model: acquisition is winning the exclusive create of
  // the next generation file; release tombstones our OWN generation only; a stale
  // lock's owner is respected while its pid is alive (fail closed), with the 10×
  // hard ceiling as the recycled-pid escape. This file keeps only the bounded
  // retry/timeout loop and its injectable now/sleep test seams.
  for (;;) {
    const got = acquireFileLock(lockFile, { now: now(), staleMs, hardStaleMs: staleMs * 10 });
    if (got.ok) {
      let completed = false, failed = false, caught;
      return (operation = () => undefined) => {
        if (completed) { if (failed) throw caught; return; }
        completed = true; // even a failed release must never replay the material operation
        try { return withAcquiredFileLock(lockFile, got.nonce, operation); }
        catch (e) { failed = true; caught = e; throw e; }
      };
    }
    if (now() >= deadline) {
      throw new Error(`capability-history: could not acquire lock ${lockFile} within ${timeoutMs}ms`);
    }
    sleep(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - now())));
  }
}

/**
 * Apply byte-cap retention. If the file exceeds BYTE_CAP, keep the most recent
 * RETENTION_PER_CAPABILITY entries per capability_id (by observed_at).
 * Returns { truncated: number } count of dropped entries.
 */
export function applyRetention(lines, { byteCap = BYTE_CAP, perCapability = RETENTION_PER_CAPABILITY } = {}) {
  const joined = lines.join('\n');
  if (Buffer.byteLength(joined, 'utf8') <= byteCap) return { kept: lines, truncated: 0 };

  // Parse, group by capability_id, keep most recent N each.
  const parsed = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { parsed.push({ line, obj: JSON.parse(line) }); } catch { /* drop malformed */ }
  }
  const byCap = new Map();
  for (const p of parsed) {
    const id = p.obj?.row?.capability_id ?? '__unknown__';
    if (!byCap.has(id)) byCap.set(id, []);
    byCap.get(id).push(p);
  }
  const kept = [];
  for (const [, entries] of byCap) {
    entries.sort((a, b) => String(a.obj.observed_at ?? '').localeCompare(String(b.obj.observed_at ?? '')));
    kept.push(...entries.slice(-perCapability));
  }
  // Restore global chronological order
  kept.sort((a, b) => String(a.obj.observed_at ?? '').localeCompare(String(b.obj.observed_at ?? '')));
  return { kept: kept.map(k => k.line), truncated: parsed.length - kept.length };
}

/**
 * Append capability rows to the project's history file under an advisory lock.
 * @param {{root: string, harness: string}} target
 * @param {object[]} rows — capability rows (each carries capability_id, identity_status, evidence, etc.)
 * @param {object} meta — { runner_version, schema_version, session_id }
 * @param {object} opts — { home, now } for testability
 * @returns {{ appended: number, truncated: number, path: string }}
 */
export function appendRows(target, rows, meta = {}, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const { file, lock } = resolveStorePaths(target, opts, { forWrite: true });
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: EVIDENCE_DIR_MODE });
  try { chmodSync(dir, EVIDENCE_DIR_MODE); } catch { /* pre-existing dir, other owner */ }

  const release = acquireLock(lock, opts.lockOpts);
  return release(() => {
    const observedAt = now();
    const newLines = rows.map(row => JSON.stringify({
      observed_at: observedAt,
      runner_version: meta.runner_version ?? null,
      schema_version: meta.schema_version ?? null,
      harness: target.harness,
      session_id: meta.session_id ?? null,
      row_content_hash: canonicalRowHash(row),
      row,
    }));

    const existing = existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
      : [];
    const all = [...existing, ...newLines];
    const { kept, truncated } = applyRetention(all, opts.retentionOpts);

    // Use the shared atomic writer rather than a hand-rolled temp+rename that
    // had no temp-file cleanup on failure (an orphaned .tmp-* per failed append).
    atomicWriteFileSync(file, kept.join('\n') + '\n');
    try { chmodSync(file, EVIDENCE_FILE_MODE); } catch { /* filesystem without POSIX modes */ }

    return { appended: newLines.length, truncated, path: file };
  });
}

/**
 * Read all history entries for a project and harness (parsed). Returns [] if absent.
 *
 * Unreadable rows ride back as `.rejected` on the returned array. Dropping them
 * silently makes a partly-corrupt history indistinguishable from a shorter clean one,
 * and drift analysis reads that difference as a capability changing.
 */
export function readHistory(target, opts = {}) {
  const paths = resolveStorePaths(target, opts);
  const entries = [];
  let rejected = 0;
  if (!paths || !existsSync(paths.file)) return Object.assign(entries, { rejected });
  const { file } = paths;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { rejected += 1; continue; }
    if (parsed) entries.push(parsed); else rejected += 1;
  }
  return Object.assign(entries, { rejected });
}

export { projectHistoryPath, projectLockPath, resolveStorePaths };
