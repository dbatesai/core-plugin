/**
 * capability-history.mjs — append-only capability-row history with advisory lock.
 *
 * v2.7.0 deliverable (ratified collab consensus, session 52). Stores each
 * session's capability rows so drift and regression can be detected across
 * sessions (analyze-capability-drift.mjs is the consumer).
 *
 * Storage: ~/.core/workspaces/<id>/capability-history.jsonl
 *   One JSON object per line:
 *   { observed_at, runner_version, schema_version, workspace_id,
 *     session_id, row_content_hash, row }
 *
 * STORAGE DECISION (HK pushback, HC-accepted with conditions, session 52):
 * JSONL + advisory lock, NOT Maildir. The single-writer-per-workspace
 * assumption is guarded by an advisory lock with stale recovery, and a
 * two-writer test fixture proves no lost history. See the v2.7 plan §rev.
 *
 * Retention: byte-cap (default 512KB). On breach, keep the most recent
 * RETENTION_PER_CAPABILITY entries per capability_id; older drop.
 *
 * Atomic writes: temp-file + rename (same pattern as collab events).
 */

import {
  readFileSync, writeFileSync, existsSync,
  mkdirSync, rmSync, openSync, closeSync, statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const BYTE_CAP = 512 * 1024;           // 512KB per workspace
export const RETENTION_PER_CAPABILITY = 80;   // entries kept per capability_id on cap breach
export const LOCK_TIMEOUT_MS = 1000;          // bounded wait (MET-011 — was a 5s spin on the startup path)
export const LOCK_RETRY_INTERVAL_MS = 25;     // sleep slice between lock-acquire retries
export const STALE_LOCK_MS = 30000;           // a lock older than 30s is presumed stale

function historyPath(workspaceId, home = homedir()) {
  return join(home, '.core', 'workspaces', workspaceId, 'capability-history.jsonl');
}

function lockPath(workspaceId, home = homedir()) {
  return join(home, '.core', 'workspaces', workspaceId, 'capability-history.lock');
}

function projectHistoryPath(project, workspaceId) {
  return join(project, '_metrics', 'capability-history', `${workspaceId}.jsonl`);
}

function projectLockPath(project, workspaceId) {
  return join(project, '_metrics', 'capability-history', `${workspaceId}.lock`);
}

function resolveStorePaths(workspaceId, opts = {}) {
  if (opts.project) {
    return {
      file: projectHistoryPath(opts.project, workspaceId),
      lock: projectLockPath(opts.project, workspaceId),
    };
  }
  const home = opts.home || homedir();
  return { file: historyPath(workspaceId, home), lock: lockPath(workspaceId, home) };
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
 * tradeoff (MET-011); the busy-wait it replaces burned a core for up to 5s. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire an advisory lock via exclusive file creation (wx flag).
 * Recovers stale locks (older than STALE_LOCK_MS). Returns a release function.
 * Throws if it can't acquire within timeoutMs — bounded retries with a
 * CPU-yielding sleep between attempts (MET-011), never a busy-spin.
 */
export function acquireLock(lockFile, { now = Date.now, timeoutMs = LOCK_TIMEOUT_MS, staleMs = STALE_LOCK_MS, sleep = sleepSync } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx');     // fails if exists
      writeFileSync(fd, String(now()));
      closeSync(fd);
      return () => { try { rmSync(lockFile); } catch { /* already gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Lock exists — check staleness
      let stale = false;
      try {
        const age = now() - statSync(lockFile).mtimeMs;
        if (age > staleMs) stale = true;
      } catch { stale = true; } // lock vanished between check and stat
      if (stale) { try { rmSync(lockFile); } catch { /* race */ } continue; }
      if (now() >= deadline) {
        throw new Error(`capability-history: could not acquire lock ${lockFile} within ${timeoutMs}ms`);
      }
      sleep(Math.min(LOCK_RETRY_INTERVAL_MS, Math.max(1, deadline - now())));
    }
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
 * Append capability rows to the workspace history file under an advisory lock.
 * @param {string} workspaceId
 * @param {object[]} rows — capability rows (each carries capability_id, identity_status, evidence, etc.)
 * @param {object} meta — { runner_version, schema_version, session_id }
 * @param {object} opts — { home, now } for testability
 * @returns {{ appended: number, truncated: number, path: string }}
 */
export function appendRows(workspaceId, rows, meta = {}, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const { file, lock } = resolveStorePaths(workspaceId, opts);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const release = acquireLock(lock, opts.lockOpts);
  try {
    const observedAt = now();
    const newLines = rows.map(row => JSON.stringify({
      observed_at: observedAt,
      runner_version: meta.runner_version ?? null,
      schema_version: meta.schema_version ?? null,
      workspace_id: workspaceId,
      session_id: meta.session_id ?? null,
      row_content_hash: canonicalRowHash(row),
      row,
    }));

    const existing = existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter(l => l.trim())
      : [];
    const all = [...existing, ...newLines];
    const { kept, truncated } = applyRetention(all, opts.retentionOpts);

    // M8: use the shared atomic writer rather than a hand-rolled temp+rename that
    // had no temp-file cleanup on failure (an orphaned .tmp-* per failed append).
    atomicWriteFileSync(file, kept.join('\n') + '\n');

    return { appended: newLines.length, truncated, path: file };
  } finally {
    release();
  }
}

/**
 * Read all history entries for a workspace (parsed). Returns [] if absent.
 */
export function readHistory(workspaceId, opts = {}) {
  const { file } = resolveStorePaths(workspaceId, opts);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export { historyPath, lockPath, projectHistoryPath, projectLockPath };
