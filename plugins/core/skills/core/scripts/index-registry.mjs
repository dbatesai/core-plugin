/**
 * index-registry.mjs — the ONLY sanctioned writer of ~/.core/index.json.
 *
 * Why this exists (shared-write concurrency spec, 2026-07-12 + adversarial pass):
 * the registry's contended writers were LLM freehand read-modify-writes told by
 * protocol prose to "update index.json" — writes no lock can reach. A lock only
 * helps if every writer takes it, so the fix is to REMOVE freehand writes: every
 * mutation routes through this script, which does the full read-decide-write
 * under the nonce-CAS lock from file-lock.mjs. The prose sites now call the CLI;
 * protocols/data-storage.md forbids hand-editing index.json.
 *
 * last_active is NOT a registry field anymore (the hot-path hazard): it lives in
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
 *   node index-registry.mjs last-active <workspace_id>                       [--core-dir <dir>]
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only, node:* imports only.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { trustedHome } from './trusted-home.mjs';

export function defaultCoreDir() {
  return join(trustedHome() || homedir(), '.core');
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
  return withFileLock(lockPath(dir), () => {
    const entries = readIndex(dir);
    const out = mutator(entries);
    const next = Array.isArray(out) ? out : out.entries;
    const result = Array.isArray(out) ? undefined : out.result;
    atomicWriteFileSync(indexPath(dir), JSON.stringify(next, null, 2) + '\n');
    return result;
  });
}

export function addWorkspace(coreDir, entry) {
  if (!entry || !entry.workspace_id) throw new Error('addWorkspace: entry.workspace_id required');
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

const lastActivePath = (coreDir, id) => join(coreDir, 'workspaces', id, 'last-active');

/** Stamp the workspace's last-active time. Full overwrite of a single-owner file. */
export function touchWorkspace(coreDir, workspaceId, when = new Date().toISOString()) {
  const dir = coreDir || defaultCoreDir();
  mkdirSync(join(dir, 'workspaces', workspaceId), { recursive: true });
  atomicWriteFileSync(lastActivePath(dir, workspaceId), when + '\n');
  return { workspace_id: workspaceId, last_active: when };
}

/** Read last-active: per-workspace file first, index.json field as the one-release tolerant fallback. */
export function readLastActive(coreDir, workspaceId) {
  const dir = coreDir || defaultCoreDir();
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
      case 'last-active': {
        const v = readLastActive(coreDir, id);
        process.stdout.write((v || '(none)') + '\n'); return v ? 0 : 1;
      }
      default:
        process.stderr.write('usage: index-registry.mjs <add|update|remove|touch|last-active> [id] [--json ...] [--when ISO] [--core-dir dir]\n');
        return 2;
    }
  } catch (e) {
    process.stderr.write(`index-registry: ${e.message}\n`);
    return 1;
  }
}

// CLI entry guard (same pattern as sibling scripts — realpath both sides).
try {
  const self = realpathSync(fileURLToPath(import.meta.url));
  const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
  if (self === invoked) process.exit(main());
} catch { /* imported as a module — no CLI */ }
