/**
 * index-registry.mjs — the ONLY sanctioned writer of ~/.core/index.json.
 *
 * Why this exists: a lock only helps if every writer takes it — a freehand
 * LLM read-modify-write of index.json is a write no lock can reach. So there
 * are no freehand writes: every
 * mutation routes through this script, which does the full read-decide-write
 * under the nonce-CAS lock from file-lock.mjs. Protocol prose calls this CLI;
 * protocols/data-storage.md forbids hand-editing index.json.
 *
 * last_active is NOT a registry field (the hot-path hazard): it lives in
 * the per-workspace single-owner file ~/.core/workspaces/<id>/last-active, a
 * full-overwrite write that needs no coordination. The index.json last_active
 * field stays a tolerant READ fallback for one release; nothing writes it.
 *
 * Lock order (documented total order): callers holding a per-project lock (e.g.
 * close-pass's _close.lock) take THIS lock inside it, never the reverse.
 *
 * CLI:
 *   node index-registry.mjs add    --json '{"workspace_id":"x","name":"X","path":"/p"}' [--core-dir <dir>]
 *   node index-registry.mjs update <workspace_id> --json '{"name":"New"}'   [--core-dir <dir>]
 *   node index-registry.mjs remove <workspace_id>                            [--core-dir <dir>]
 *   node index-registry.mjs touch  <workspace_id> [--when <ISO>]             [--core-dir <dir>]
 *   node index-registry.mjs bootstrap <workspace_id> [--session-started <ISO>] [--core-dir <dir>]
 *   node index-registry.mjs last-active <workspace_id>                       [--core-dir <dir>]
 *
 * Ships with the plugin by convention; .mjs (Node.js) only, node:* imports only.
 */

import { readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { requireTrustedHome, assertSafeWorkspaceId, isSafeWorkspaceId } from './trusted-home.mjs';
import { isCliEntry } from './cli-entry.mjs';

/**
 * The operational root, anchored to the OS-account home. An unresolvable
 * trusted home throws: the registry is a trust decision, and homedir() is the
 * environment-controlled value that anchor exists to avoid.
 */
export function defaultCoreDir(opts) {
  return join(requireTrustedHome(opts), '.core');
}

const lockPath = (coreDir) => join(coreDir, 'index.lock');
const indexPath = (coreDir) => join(coreDir, 'index.json');

function readIndex(coreDir) {
  const p = indexPath(coreDir);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(readFileSync(p, 'utf8')); // parse errors surface loudly — never silently rebuild the registry
  if (!Array.isArray(parsed)) throw new Error(`index.json is not an array: ${p}`);
  return parsed;
}

/**
 * The one write path. Runs `mutator(entries)` under the registry lock with a
 * fresh read; the mutator returns { entries, result } (or just entries). The
 * whole read-decide-write is inside the lock, so id-collision resolution and
 * duplicate checks see the true current state.
 */
export function mutateIndex(coreDir, mutator) {
  const dir = coreDir || defaultCoreDir();
  mkdirSync(dir, { recursive: true });
  // Registry writes are rare, short, and must-succeed: give contention a patient
  // (still bounded, still loud) 8s budget rather than the 2s default — under full
  // CPU load (test suites, parallel session startups) 2s produced spurious
  // LOCK_HELD failures from writers that would have succeeded moments later.
  return withFileLock(lockPath(dir), () => {
    const entries = readIndex(dir);
    const out = mutator(entries);
    const next = Array.isArray(out) ? out : out.entries;
    const result = Array.isArray(out) ? undefined : out.result;
    atomicWriteFileSync(indexPath(dir), JSON.stringify(next, null, 2) + '\n');
    return result;
  }, { retries: 80, retryDelayMs: 100 });
}

export function addWorkspace(coreDir, entry) {
  if (!entry || !entry.workspace_id) throw new Error('addWorkspace: entry.workspace_id required');
  assertSafeWorkspaceId(entry.workspace_id);
  return mutateIndex(coreDir, (entries) => {
    if (entries.some(e => e.workspace_id === entry.workspace_id)) {
      throw new Error(`addWorkspace: id already registered: ${entry.workspace_id}`);
    }
    return { entries: [...entries, entry], result: entry };
  });
}

export function updateWorkspace(coreDir, workspaceId, fields) {
  return mutateIndex(coreDir, (entries) => {
    const i = entries.findIndex(e => e.workspace_id === workspaceId);
    if (i === -1) throw new Error(`updateWorkspace: unknown id: ${workspaceId}`);
    const updated = { ...entries[i], ...fields };
    const next = entries.slice(); next[i] = updated;
    return { entries: next, result: updated };
  });
}

export function removeWorkspace(coreDir, workspaceId) {
  return mutateIndex(coreDir, (entries) => {
    const next = entries.filter(e => e.workspace_id !== workspaceId);
    if (next.length === entries.length) throw new Error(`removeWorkspace: unknown id: ${workspaceId}`);
    return { entries: next, result: { removed: workspaceId } };
  });
}

// ---------- last_active (per-workspace single-owner file; no lock needed) ----------

// The id arrives from project-controlled workspace.json, so it is validated as a
// single directory segment BEFORE it can contribute to a path under ~/.core.
const workspaceDir = (coreDir, id) => join(coreDir, 'workspaces', assertSafeWorkspaceId(id));
const lastActivePath = (coreDir, id) => join(workspaceDir(coreDir, id), 'last-active');

/** Stamp the workspace's last-active time. Full overwrite of a single-owner file. */
export function touchWorkspace(coreDir, workspaceId, when = new Date().toISOString()) {
  const dir = coreDir || defaultCoreDir();
  mkdirSync(workspaceDir(dir, workspaceId), { recursive: true });
  atomicWriteFileSync(lastActivePath(dir, workspaceId), when + '\n');
  return { workspace_id: workspaceId, last_active: when };
}

// ---------- bootstrap record (per-workspace single-owner file) ----------

const lastBootstrapPath = (coreDir, id) => join(workspaceDir(coreDir, id), 'last-bootstrap.json');

/**
 * Record that bootstrap ran, and for which session. `session_started_at` is the
 * first-user-message timestamp the dedup check in protocols/startup.md compares
 * against; a torn or half-written record there reads as "bootstrap never ran"
 * and costs a wrongly repeated startup, so the write is temp-file + rename and
 * the file is owner-only like every other per-workspace record.
 */
export function recordBootstrap(coreDir, workspaceId, { sessionStartedAt, completedAt = new Date().toISOString() } = {}) {
  const dir = coreDir || defaultCoreDir();
  mkdirSync(workspaceDir(dir, workspaceId), { recursive: true });
  const path = lastBootstrapPath(dir, workspaceId);
  const record = { session_started_at: sessionStartedAt ?? null, bootstrap_completed_at: completedAt };
  atomicWriteFileSync(path, JSON.stringify(record, null, 2) + '\n');
  try { chmodSync(path, 0o600); } catch { /* Windows: mode is advisory */ }
  return { path, record };
}


/** Read last-active: per-workspace file first, index.json field as the one-release tolerant fallback. */
export function readLastActive(coreDir, workspaceId) {
  const dir = coreDir || defaultCoreDir();
  if (!isSafeWorkspaceId(workspaceId)) return null;
  try { return readFileSync(lastActivePath(dir, workspaceId), 'utf8').trim() || null; } catch { /* fall back */ }
  try {
    const entry = readIndex(dir).find(e => e.workspace_id === workspaceId);
    return entry?.last_active || null;
  } catch { return null; }
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = argv[++i];
    else if (a === '--core-dir') out.coreDir = argv[++i];
    else if (a === '--when') out.when = argv[++i];
    else if (a === '--session-started') out.sessionStarted = argv[++i];
    else out._.push(a);
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const [sub, id] = args._;
  const coreDir = args.coreDir ? args.coreDir : defaultCoreDir();
  const parsedJson = () => {
    if (!args.json) throw new Error(`${sub}: --json required`);
    return JSON.parse(args.json);
  };
  try {
    switch (sub) {
      case 'add': {
        const entry = addWorkspace(coreDir, parsedJson());
        process.stdout.write(`registered ${entry.workspace_id}\n`); return 0;
      }
      case 'update': {
        const updated = updateWorkspace(coreDir, id, parsedJson());
        process.stdout.write(`updated ${updated.workspace_id}\n`); return 0;
      }
      case 'remove': {
        removeWorkspace(coreDir, id);
        process.stdout.write(`removed ${id}\n`); return 0;
      }
      case 'touch': {
        const r = touchWorkspace(coreDir, id, args.when || undefined);
        process.stdout.write(`${r.workspace_id} last-active ${r.last_active}\n`); return 0;
      }
      case 'bootstrap': {
        const r = recordBootstrap(coreDir, id, { sessionStartedAt: args.sessionStarted || null });
        process.stdout.write(`${r.path}\n`); return 0;
      }
      case 'last-active': {
        const v = readLastActive(coreDir, id);
        process.stdout.write((v || '(none)') + '\n'); return v ? 0 : 1;
      }
      default:
        process.stderr.write('usage: index-registry.mjs <add|update|remove|touch|bootstrap|last-active> [id] [--json ...] [--when ISO] [--session-started ISO] [--core-dir dir]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`index-registry: ${e.message}\n`);
    return 1;
  }
}

if (isCliEntry(import.meta.url)) process.exit(main());
