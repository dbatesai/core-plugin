/**
 * Workspace-fork check — detect copied workspaces and auto-fork.
 *
 * Per DC-77, workspace identity stability is a critical surface inference
 * can't be trusted on alone. The Round-3 Codex re-probe (2026-05-21) showed
 * the agent reading the prose, narrating the mismatch, and still operating
 * under the source identity. This script ships the fork as deterministic code;
 * the agent's job drops to "run this script, echo its output."
 *
 * Behavior:
 *   1. Read <cwd>/workspace.json — if missing, no-op.
 *   2. Read <core-dir>/index.json — if missing, no-op.
 *   3. Path-match first: any entry with path === cwd → no fork needed
 *      (idempotent on re-orient after a prior fork).
 *   4. ID-mismatch: workspace_id resolves to an entry whose path !== cwd
 *      → perform fork (slugify cwd basename, collision-resolve, rewrite local
 *      workspace.json, register in index, create new meta dir).
 *   5. Print exactly one line to stdout.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/workspace-fork-check.mjs
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/workspace-fork-check.mjs --cwd <dir>
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/workspace-fork-check.mjs --cwd <dir> --core-dir <dir>
 */

import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// An index entry's registered project path. STANDARDIZED on `path` 2026-06-01:
// the live index, startup.md's prose path-match, this script's index writer, and
// now the schema + manifest writer all use `path`. `project_path` was a minority
// patch (it was what the schema documented while reality used `path`), and a
// `project_path`-keyed entry invisible to a `path`-only read is what re-forked a
// workspace on every startup (Meridian, R11, 2026-05-31: local-llm-build-r11 ->
// -2 -> -3 ...). This read stays tolerant of legacy `project_path` through
// v3.7.0 for back-compat; the fallback gets removed in v3.8.0. `path` is preferred.
export function entryPath(entry) {
  return entry.path || entry.project_path || null;
}

// Canonicalize a path for identity comparison. The CLI entry guard already uses
// realpathSync (see _cliEntryCanonical below); the fork decision must match it.
// resolve() alone is NOT equivalent: under a symlinked project root (macOS
// /tmp -> /private/tmp, OneDrive/Dropbox sync roots, a symlinked ~/Projects) the
// live cwd and the registered index path can be the symlink form vs the real
// form, resolve() returns them unequal, and an already-registered workspace
// re-forks on every startup. realpathSync collapses both to the real path. Falls
// back to resolve() when the path doesn't exist on disk (stale index entry, a
// different machine's path) — those legitimately can't be realpath'd and a plain
// resolve-compare is the right behavior there.
export function canonicalPath(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

export function resolveCollision(slug, existingIds) {
  if (!existingIds.has(slug)) return slug;
  let n = 2;
  while (existingIds.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

export function parseArgv(argv) {
  let cwd = null;
  let coreDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--core-dir') coreDir = argv[++i];
  }
  return { cwd, coreDir };
}

export function checkFork({ cwd, coreDir, now = new Date(), dryRun = false }) {
  const localPointer = join(cwd, 'workspace.json');
  if (!existsSync(localPointer)) return { action: 'no-fork', reason: 'no-pointer' };

  const indexPath = join(coreDir, 'index.json');
  if (!existsSync(indexPath)) return { action: 'no-fork', reason: 'no-index' };

  let pointer, index;
  try { pointer = JSON.parse(readFileSync(localPointer, 'utf8')); }
  catch (e) { return { action: 'error', error: `pointer-parse: ${e.message}` }; }
  try { index = JSON.parse(readFileSync(indexPath, 'utf8')); }
  catch (e) { return { action: 'error', error: `index-parse: ${e.message}` }; }
  if (!Array.isArray(index)) return { action: 'error', error: 'index-not-array' };

  const cwdResolved = canonicalPath(cwd);
  const pathMatch = index.find(e => entryPath(e) && canonicalPath(entryPath(e)) === cwdResolved);
  if (pathMatch) return { action: 'no-fork', reason: 'path-match', workspace_id: pathMatch.workspace_id };

  const localId = pointer.workspace_id;
  if (!localId) return { action: 'no-fork', reason: 'pointer-missing-id' };

  const idMatch = index.find(e => e.workspace_id === localId);
  if (!idMatch) return { action: 'no-fork', reason: 'unregistered-id' };

  const idMatchPath = entryPath(idMatch);
  const registeredPath = idMatchPath ? canonicalPath(idMatchPath) : null;
  if (registeredPath === cwdResolved) return { action: 'no-fork', reason: 'path-match', workspace_id: localId };

  const baseSlug = slugify(basename(cwdResolved));
  const existingIds = new Set(index.map(e => e.workspace_id).filter(Boolean));
  const newId = resolveCollision(baseSlug, existingIds);

  // Non-mutating detection path: configure-project --dry-run needs the fork
  // decision without performing the multi-file mutation. Return the plan; write
  // nothing.
  if (dryRun) {
    return { action: 'would-fork', original_id: localId, new_id: newId };
  }

  const nowIso = now.toISOString();
  // Expanded absolute path (HARNESS-007): Node never expands ~, so the pointer
  // must carry a consumer-usable path. coreDir honors --core-dir overrides.
  const newDataPath = join(coreDir, 'workspaces', newId) + '/';

  // H3: the fork mutates three surfaces. checkFork resolves PATH-MATCH (an index entry whose
  // path == cwd) BEFORE id-match, so the index entry is what makes a fork "stick" on the next
  // run. Write order is therefore meta-dir+manifest → index entry → local pointer (last), and
  // every write is atomic (temp-file + rename, no torn file). The ordering enforces the
  // invariant "an index entry always implies its meta dir exists":
  //   • crash before the index entry → pointer still names the copied-from id, no path-match →
  //     clean re-fork next session (a leftover empty meta dir is harmless litter, reused on the
  //     re-fork's same id);
  //   • crash after the index but before the pointer → path-match resolves to a fully-present
  //     (index + meta) newId; only the pointer's id is stale, and resolution doesn't depend on it.
  // The shared index.json is atomic too, so a torn write can't break fork-detection for EVERY
  // workspace (the prior bare writeFileSync could).
  const newMetaDir = join(coreDir, 'workspaces', newId);
  mkdirSync(newMetaDir, { recursive: true });
  const newManifest = {
    schema_version: 'v2',
    workspace_id: newId,
    name: pointer.name || newId,
    path: cwdResolved,
    created: nowIso,
    last_active: nowIso,
    dm_notes: `Auto-forked from ${localId} on ${nowIso} — copied workspace detected at ${cwdResolved}.`,
  };
  atomicWriteFileSync(join(newMetaDir, 'workspace.json'), JSON.stringify(newManifest, null, 2) + '\n');

  index.push({
    name: pointer.name || newId,
    path: cwdResolved,
    workspace_id: newId,
    last_active: nowIso,
  });
  atomicWriteFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

  const newPointer = {
    ...pointer,
    workspace_id: newId,
    data_path: newDataPath,
    created: pointer.created || nowIso,
  };
  atomicWriteFileSync(localPointer, JSON.stringify(newPointer, null, 2) + '\n');

  return {
    action: 'forked',
    original_id: localId,
    new_id: newId,
    new_meta_dir: newMetaDir,
  };
}

export function main(argv) {
  const { cwd: cwdArg, coreDir: coreDirArg } = parseArgv(argv);
  const cwd = cwdArg ? resolve(cwdArg) : process.cwd();
  const coreDir = coreDirArg ? resolve(coreDirArg) : join(homedir(), '.core');

  let result;
  try { result = checkFork({ cwd, coreDir }); }
  catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }

  if (result.action === 'error') {
    process.stderr.write(`error: ${result.error}\n`);
    return 2;
  }
  if (result.action === 'forked') {
    console.log(`forked ${result.original_id} -> ${result.new_id}; registered at ${result.new_meta_dir}/`);
    return 0;
  }
  console.log('(no fork needed)');
  return 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
