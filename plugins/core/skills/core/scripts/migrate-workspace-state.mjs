#!/usr/bin/env node
/**
 * migrate-workspace-state.mjs — move per-project state from the legacy
 * ~/.core/workspaces/<id>/ folders into <project>/.core/<harness>/.
 *
 * --manifest (dry run) classifies every legacy workspace folder and
 * ~/.core/index.json entry and reports; it writes nothing but --out.
 *
 * --apply migrates ONE project for ONE harness (the one running it). It holds
 * the project's close lock for the whole run, re-classifies under the global
 * manifest lock (so workspaces an older install registered since the last run
 * are seen), copies — never moves — the live workspace into the project's state
 * and duplicates into superseded/<old-id>/, verifies every copy by SHA-256 and
 * writes the migrated-from.json receipt last. A run that finds the receipt does
 * nothing; a run interrupted mid-copy has no receipt and redoes the copy. Only
 * once EVERY harness registered for the path has migrated does it write MOVED.md
 * into the old folders, turn the root workspace.json pointer into a moved note
 * (left alone when git tracks it), and mark the index.json entries migrated —
 * an older install that still reads them keeps working until then.
 *
 * Lock order: the project's close lock, then the global manifest lock, then the
 * registry lock. Nothing is deleted.
 *
 * Classes (exactly one per workspace id):
 *   migrate              registered, path exists, harness known — becomes the live state
 *   supersede            another registration of the same path and harness; kept, not live
 *   orphan-gone          registered, but the path no longer exists
 *   orphan-unregistered  a workspace folder with no registry entry that holds data
 *   empty                a workspace folder with no registry entry and no data
 *   hold                 needs a person: harness unknown, or duplicates with no tie-break
 *
 * The harness comes from an explicit table (--table), never from the id's
 * spelling; a workspace.json `harness` field is the fallback for workspaces the
 * table predates. Without either, a workspace is claimed by the harness running
 * the apply only when it is the sole registration for its path; otherwise it is
 * held. Duplicate tie-break: the id the project's root workspace.json pointer
 * names, then the newer last-active; otherwise every duplicate is held.
 *
 * CLI:
 *   node migrate-workspace-state.mjs --manifest [--core-dir <dir>] [--table <file>] [--harness <h>] [--out <file>]
 *   node migrate-workspace-state.mjs --apply [--root <dir>] [--harness <h>] [--core-dir <dir>] [--table <file>]
 *
 * Ships with the plugin by convention; .mjs (Node.js) only, node:* imports only.
 */

import { existsSync, readdirSync, readFileSync, lstatSync, mkdirSync, copyFileSync, statSync, appendFileSync, openSync, readSync, closeSync, rmSync, truncateSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { isCliEntry } from './cli-entry.mjs';
import {
  canonical, defaultCoreDir, stateDir, updateManifest, detectStateHarness, assertHarnessName, resolveProjectRoot,
  writeSignedFile, writePinSigned, writeHeldSigned, readSignedFile, duringMigration, MIGRATING_MARKER, metricsStorageAllowed, otherProjectsNamingFolder, registryEntryPath, markMetricsEverExternal,
} from './project-state.mjs';
import { acquireFileLock, releaseFileLock, withFileLock } from './file-lock.mjs';
import { mutateIndex, mutateProjects } from './index-registry.mjs';
import { assertSafeWorkspaceId, containedPath } from './trusted-home.mjs';

// Bookkeeping, not data: a folder holding only these has nothing worth migrating.
const BOOKKEEPING = [/^\.DS_Store$/, /^last-active$/, /^last-bootstrap\.json$/, /\.lock(\.g\d+)?(\.done)?$/, /^visibility-canary\.json$/];
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readTextOrNull(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// A legacy workspace is read for two different jobs. Classifying it only needs to know
// whether it holds data, so an unreadable corner is skipped. Copying it has to be exact:
// `strict` makes an unreadable folder, an unstatable entry or any symlink stop the walk,
// because a partial list would be copied and then signed off as complete, and a symlink
// would be followed out of the workspace by the copy.
class LegacyStateError extends Error {
  constructor(code, path, detail) {
    super(`legacy state cannot be migrated safely: ${detail}: ${path}`);
    this.code = code; this.path = path;
  }
}

function listFiles(dir, { strict = false } = {}) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); }
    catch (e) { if (strict) throw new LegacyStateError('LEGACY_UNREADABLE', d, `cannot list (${e.code || e.message})`); return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); }
      catch (e) { if (strict) throw new LegacyStateError('LEGACY_UNREADABLE', p, `cannot stat (${e.code || e.message})`); continue; }
      if (strict && st.isSymbolicLink()) throw new LegacyStateError('LEGACY_SYMLINK', p, 'symlink inside the legacy workspace');
      if (st.isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out;
}

function dataFiles(dir) {
  return listFiles(dir).filter((f) => {
    const base = f.split('/').pop();
    return !BOOKKEEPING.some((re) => re.test(base));
  });
}

function expandHome(p, home) {
  return p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p;
}

function lastActive(coreDir, id, indexEntry) {
  const file = join(coreDir, 'workspaces', id, 'last-active');
  try {
    const t = Date.parse(readFileSync(file, 'utf8').trim());
    if (!Number.isNaN(t)) return t;
  } catch { /* fall back to the registry field */ }
  const t = Date.parse(indexEntry?.last_active || '');
  return Number.isNaN(t) ? null : t;
}

/** Build the manifest. Pure read. */
export function buildManifest({ coreDir = defaultCoreDir(), table = { entries: {} }, now = new Date(), applyHarness = null } = {}) {
  const home = join(coreDir, '..');
  const index = readJson(join(coreDir, 'index.json'), []);
  const byId = new Map();
  for (const e of Array.isArray(index) ? index : []) if (e && e.workspace_id) byId.set(e.workspace_id, e);

  const wsRoot = join(coreDir, 'workspaces');
  const dirs = existsSync(wsRoot)
    ? readdirSync(wsRoot).filter((n) => { try { return lstatSync(join(wsRoot, n)).isDirectory(); } catch { return false; } })
    : [];
  const ids = [...new Set([...dirs, ...byId.keys()])].sort();

  const entries = ids.map((id) => {
    const reg = byId.get(id) || null;
    const dir = join(wsRoot, id);
    const dirExists = dirs.includes(id);
    const manifest = dirExists ? readJson(join(dir, 'workspace.json'), {}) : {};
    const files = dirExists ? dataFiles(dir) : [];
    const rawPath = registryEntryPath(reg);
    const path = rawPath ? canonical(expandHome(rawPath, home)) : null;
    const pathExists = path ? existsSync(path) : false;

    const tableEntry = table.entries?.[id];
    let harness = 'unknown';
    let harnessEvidence = 'not in the harness table and no harness field recorded';
    if (tableEntry && HARNESS_RE.test(tableEntry.harness || '') && tableEntry.harness !== 'unknown') {
      harness = tableEntry.harness; harnessEvidence = `table: ${tableEntry.evidence || 'no evidence recorded'}`;
    } else if (tableEntry && tableEntry.harness === 'unknown') {
      harnessEvidence = `table marks unknown: ${tableEntry.evidence || 'no evidence recorded'}`;
    } else if (typeof manifest.harness === 'string' && HARNESS_RE.test(manifest.harness)) {
      harness = manifest.harness; harnessEvidence = 'workspace.json harness field';
    }
    const unlabeled = harness === 'unknown' && !(tableEntry && tableEntry.harness === 'unknown');

    const e = {
      workspace_id: id, registered: !!reg, dir_exists: dirExists, path, path_exists: pathExists,
      harness, harness_evidence: harnessEvidence, data_files: files.length,
      sample_files: files.slice(0, 5), class: null, reason: null,
      _unlabeled: unlabeled,
    };
    if (!reg) {
      e.class = files.length ? 'orphan-unregistered' : 'empty';
      e.reason = files.length ? 'workspace folder with data but no registry entry' : 'no registry entry and no data';
    } else if (!pathExists) {
      e.class = 'orphan-gone'; e.reason = 'registered path no longer exists';
    }
    e._last = lastActive(coreDir, id, reg);
    return e;
  });

  // General harness rule for workspaces with no recorded harness: the harness
  // running the apply claims one only when it is the sole registration for its path.
  const perPath = new Map();
  for (const e of entries) {
    if (e.class || !e.path) continue;
    perPath.set(e.path, (perPath.get(e.path) || 0) + 1);
  }
  for (const e of entries) {
    if (e.class || e.harness !== 'unknown') continue;
    if (e._unlabeled && applyHarness && perPath.get(e.path) === 1) {
      e.harness = applyHarness;
      e.harness_evidence = `general rule: sole registration for its path, claimed by ${applyHarness}`;
    } else {
      e.class = 'hold';
      e.reason = e._unlabeled && perPath.get(e.path) > 1 ? 'harness-unknown: path has several unlabeled registrations' : 'harness-unknown';
    }
  }

  // Duplicate registrations: same canonical path and harness.
  const groups = new Map();
  for (const e of entries) {
    if (e.class) continue;
    const key = `${e.path}\u0000${e.harness}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const group of groups.values()) {
    if (group.length === 1) { group[0].class = 'migrate'; group[0].reason = 'single registration'; continue; }
    const pointer = readJson(join(group[0].path, 'workspace.json'), {});
    let live = group.find((e) => e.workspace_id === pointer.workspace_id);
    let why = live ? `project pointer names ${live.workspace_id}` : null;
    if (!live) {
      const dated = group.filter((e) => e._last !== null).sort((a, b) => b._last - a._last);
      if (dated.length === group.length && dated[0]._last !== dated[1]._last) {
        live = dated[0]; why = `newest last-active (${new Date(live._last).toISOString()})`;
      }
    }
    for (const e of group) {
      if (!live) { e.class = 'hold'; e.reason = `duplicate-no-tiebreak with ${group.filter((x) => x !== e).map((x) => x.workspace_id).join(', ')}`; }
      else if (e === live) { e.class = 'migrate'; e.reason = `live duplicate: ${why}`; }
      else { e.class = 'supersede'; e.reason = `duplicate of ${live.workspace_id}: ${why}`; }
    }
  }

  for (const e of entries) { delete e._last; delete e._unlabeled; }
  const counts = {};
  for (const e of entries) counts[e.class] = (counts[e.class] || 0) + 1;
  const flagged = entries.filter((e) => e.class === 'hold' || e.class === 'orphan-unregistered')
    .map((e) => ({ workspace_id: e.workspace_id, class: e.class, reason: e.reason, harness_evidence: e.harness_evidence, sample_files: e.sample_files }));
  return { generated_at: now.toISOString(), core_dir: coreDir, table_version: table.version ?? null, counts, flagged, entries };
}

// ---------- apply ----------

// Statuses that mean the project's state is not migrated and needs attention or a retry.
const BLOCKED_STATUSES = new Set(['legacy-held', 'migration-incomplete', 'receipt-unverified', 'lock-held']);
const LOCK_STALE_MS = 15 * 60 * 1000;
const RECEIPT = 'migrated-from.json';
const LEGACY_MANIFEST = 'legacy-workspace.json';
// Per-project records the new layout keeps; lock artifacts and the retired canary are not copied.
const SKIP_ON_COPY = [/\.lock(\.g\d+)?(\.done)?$/, /\.lock\.g\d+\.done$/, /^\.DS_Store$/, /^visibility-canary\.json$/];
// Files that belong in the 'hot' state location (append-heavy or lock-bearing).
const HOT_TOP = new Set(['metrics', 'capability-history.jsonl', 'capability-state.json']);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function copyTree(src, dest, recorded) {
  for (const rel of listFiles(src, { strict: true })) {
    const base = rel.split('/').pop();
    if (SKIP_ON_COPY.some((re) => re.test(base))) continue;
    const from = join(src, rel);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    recorded.push({ from, to, sha256: sha256(from), length: statSync(from).size });
  }
}

/**
 * A receipt is only a claim. `complete: true` says nothing about whether the files it
 * lists are there, and a destination it names is only safe to write to if it lies inside
 * this project's own state. So it is trusted only when this install signed it (a forged,
 * copied or git-tracked receipt reads as unsigned), every destination resolves inside the
 * state, and every listed file exists. Files are checked by existence, not hash: the
 * project's copies legitimately change after migration. Returns { ok, receipt, problems }.
 */
function verifiedReceipt({ root, harness, coreDir, stateDirs }) {
  const raw = readSignedFile({ root, harness, name: RECEIPT, coreDir });
  if (raw === null) return { ok: false, problems: ['receipt is not signed by this install, or git tracks it'] };
  let receipt;
  try { receipt = JSON.parse(raw); } catch { return { ok: false, problems: ['receipt is not valid JSON'] }; }
  if (!receipt || receipt.complete !== true) return { ok: false, receipt, problems: ['receipt does not say complete'] };
  if (!Array.isArray(receipt.files)) return { ok: false, receipt, problems: ['receipt has no file list'] };
  const problems = [];
  for (const f of receipt.files) {
    if (!f || typeof f.to !== 'string') { problems.push('a receipt entry has no destination'); continue; }
    if (!stateDirs.some((d) => containedPath(d, f.to))) { problems.push(`destination outside this project's state: ${f.to}`); continue; }
    let st;
    try { st = lstatSync(f.to); } catch { if (!f.pending) problems.push(`missing: ${f.to}`); continue; }
    if (!st.isFile()) problems.push(`not a regular file: ${f.to}`);
  }
  return { ok: problems.length === 0, receipt, problems };
}

/**
 * Settle an append an earlier drift check recorded but may not have finished, before
 * anything new is appended. The recorded range of the source is re-read and must still
 * hash to what was recorded. In the project's copy, whatever sits past the recorded offset
 * is one of: the whole tail (done), part of the tail (cut back to the offset and append it
 * whole), or nothing (append it). Anything else is not ours to overwrite.
 * Returns { known } (the entry as if the append had completed) or { conflict: true }.
 */
function resolvePendingAppend({ from, known }) {
  const { from_offset: fromOffset, from_length: fromLength, to_offset: toOffset, tail_sha: tailSha } = known.pending;
  const source = readFileSync(from);
  const tail = source.subarray(fromOffset, fromLength);
  if (source.length < fromLength || createHash('sha256').update(tail).digest('hex') !== tailSha) return { conflict: true };
  const to = known.to;
  const current = existsSync(to) ? readFileSync(to) : Buffer.alloc(0);
  if (current.length < toOffset) return { conflict: true };
  const extra = current.subarray(toOffset);
  if (!(extra.length >= tail.length && extra.subarray(0, tail.length).equals(tail))) {
    if (!tail.subarray(0, extra.length).equals(extra)) return { conflict: true };
    if (extra.length) truncateSync(to, toOffset);
    appendFileSync(to, tail);
  }
  return { known: { from, to, sha256: createHash('sha256').update(source.subarray(0, fromLength)).digest('hex'), length: fromLength } };
}

function manifestPath(coreDir) { return join(coreDir, 'migration-manifest.json'); }

/**
 * Re-classify and merge the persisted "migrated" marks, under the global manifest
 * lock. `mutate(manifest)` may add marks; the merged manifest is written back.
 */
function withManifest(coreDir, table, applyHarness, mutate) {
  return withFileLock(join(coreDir, 'migration-manifest.lock'), () => {
    const prior = readJson(manifestPath(coreDir), null);
    const marks = new Map();
    for (const e of prior?.entries || []) if (e.migrated_at) marks.set(e.workspace_id, { migrated_at: e.migrated_at, migrated_to: e.migrated_to, migrated_by: e.migrated_by });
    const m = buildManifest({ coreDir, table, applyHarness });
    for (const e of m.entries) if (marks.has(e.workspace_id)) Object.assign(e, marks.get(e.workspace_id));
    const out = mutate ? mutate(m) : undefined;
    atomicWriteFileSync(manifestPath(coreDir), JSON.stringify(m, null, 2) + '\n');
    return { manifest: m, out };
  }, { retries: 80, retryDelayMs: 100 });
}

function gitTracks(root, rel) {
  try {
    execFileSync('git', ['-C', root, 'ls-files', '--error-unmatch', rel], { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch { return false; }
}

/**
 * Migrate one project root for one harness. Returns a summary:
 *   { status: 'migrated' | 'already-migrated' | 'nothing-to-migrate' | 'held' | 'lock-held', ... }
 */
export function applyMigration(opts = {}) {
  try { return duringMigration(() => applyMigrationInner(opts)); }
  catch (e) {
    // The marker stays, so nothing reads the half-copied state; the old workspace is untouched.
    if (e instanceof LegacyStateError) return { status: 'legacy-held', root: canonical(opts.root), code: e.code, path: e.path, reason: e.message };
    throw e;
  }
}

function applyMigrationInner({ root, harness = detectStateHarness(), coreDir = defaultCoreDir(), table = { entries: {} }, now = new Date() } = {}) {
  assertHarnessName(harness);
  const real = canonical(root);
  const iso = now.toISOString();
  const lockFile = join(real, '_memories', '_close.lock');
  mkdirSync(dirname(lockFile), { recursive: true });
  const lock = acquireFileLock(lockFile, { extra: { session_id: `migrate-${harness}` }, staleMs: LOCK_STALE_MS, hardStaleMs: 2 * LOCK_STALE_MS });
  if (!lock.ok) return { status: 'lock-held', root: real, reason: lock.reason };
  try {
    const { manifest } = withManifest(coreDir, table, harness);
    const mine = manifest.entries.filter((e) => e.path === real && e.harness === harness);
    const held = manifest.entries.filter((e) => e.path === real && e.class === 'hold');
    const live = mine.find((e) => e.class === 'migrate');
    const dups = mine.filter((e) => e.class === 'supersede');
    if (!live && !dups.length) {
      const marker = join(real, '.core', harness, MIGRATING_MARKER);
      if (existsSync(marker)) return { status: 'migration-incomplete', root: real, harness, reason: 'an earlier migration stopped part-way and there is no legacy state left to finish it from' };
      return { status: held.length ? 'held' : 'nothing-to-migrate', root: real, harness, held: held.map((e) => ({ workspace_id: e.workspace_id, reason: e.reason })) };
    }

    const durable = stateDir({ root: real, harness, kind: 'durable', coreDir, forWrite: true });
    const hot = stateDir({ root: real, harness, kind: 'hot', coreDir, forWrite: true });
    const receiptFile = join(durable.dir, RECEIPT);
    let copies = [];
    let metricsHeld = null;
    let metricsMarkerFailed = null;
    const markerFile = join(durable.dir, MIGRATING_MARKER);
    if (existsSync(receiptFile)) {
      // A receipt that claims success but does not match the disk is never trusted and
      // never repaired over: the project's copies may have moved on since. A person decides.
      const checked = verifiedReceipt({ root: real, harness, coreDir, stateDirs: [durable.dir, hot.dir] });
      if (!checked.ok) return { status: 'receipt-unverified', root: real, harness, problems: checked.problems.slice(0, 10) };
      // A workspace an older install registered after the receipt was written is not covered
      // by it. It is copied, as a kept duplicate and never over live state, before anything is
      // marked migrated or released.
      const covered = new Set([checked.receipt.live, ...(checked.receipt.superseded || [])].filter(Boolean));
      const late = [...(live ? [live] : []), ...dups].filter((e) => !covered.has(e.workspace_id));
      if (late.length) {
        atomicWriteFileSync(markerFile, `${iso}\n`);
        const lateCopies = [];
        for (const e of late) {
          assertSafeWorkspaceId(e.workspace_id);
          const src = join(coreDir, 'workspaces', e.workspace_id);
          if (existsSync(src)) copyTree(src, join(durable.dir, 'superseded', e.workspace_id), lateCopies);
        }
        for (const c of lateCopies) {
          if (sha256(c.to) !== c.sha256) throw new Error(`copy verification failed: ${c.to}`);
        }
        writeSignedFile({ dir: durable.dir, name: RECEIPT, coreDir, body: JSON.stringify({
          ...checked.receipt,
          superseded: [...(checked.receipt.superseded || []), ...late.map((e) => e.workspace_id)],
          files: [...checked.receipt.files, ...lateCopies.map((c) => ({ from: c.from, to: c.to, sha256: c.sha256, length: c.length }))],
          late_registered_at: iso,
        }, null, 2) + '\n' });
      }
      rmSync(markerFile, { force: true });
      copies = null;
    }

    if (copies) {
      atomicWriteFileSync(markerFile, `${iso}\n`);
      const toCopy = [...(live ? [{ e: live, superseded: false }] : []), ...dups.map((e) => ({ e, superseded: true }))];
      for (const { e, superseded } of toCopy) {
        assertSafeWorkspaceId(e.workspace_id);
        const src = join(coreDir, 'workspaces', e.workspace_id);
        if (!existsSync(src)) continue;
        if (superseded) {
          copyTree(src, join(durable.dir, 'superseded', e.workspace_id), copies);
          continue;
        }
        // Live workspace: hot files to the hot location, everything else to durable.
        for (const name of readdirSync(src)) {
          const from = join(src, name);
          let st;
          try { st = lstatSync(from); } catch (e) { throw new LegacyStateError('LEGACY_UNREADABLE', from, `cannot stat (${e.code || e.message})`); }
          if (st.isSymbolicLink()) throw new LegacyStateError('LEGACY_SYMLINK', from, 'symlink inside the legacy workspace');
          const target = HOT_TOP.has(name) ? hot.dir : durable.dir;
          if (st.isDirectory()) { copyTree(from, join(target, name), copies); continue; }
          if (SKIP_ON_COPY.some((re) => re.test(name))) continue;
          // The legacy manifest is kept verbatim beside the live one, which is built from its fields.
          const to = join(target, name === 'workspace.json' ? LEGACY_MANIFEST : name);
          if (name === 'last-bootstrap.json') {
            // A control file: carried over with its MAC so it verifies in the new layout.
            writeSignedFile({ dir: target, name, body: readFileSync(from), coreDir, mode: 0o600 });
          } else {
            copyFileSync(from, to);
          }
          copies.push({ from, to, sha256: sha256(from), length: statSync(from).size });
        }
      }
      for (const c of copies) {
        const got = sha256(c.to);
        if (got !== c.sha256) throw new Error(`copy verification failed: ${c.to}`);
      }
      // The legacy metrics pin arrives unsigned. It is signed here only if it names a place metrics
      // may live; anything else stays unsigned, which readers ignore.
      if (live) {
        const pinFile = join(hot.dir, 'metrics', 'storage-path.txt');
        if (existsSync(pinFile)) {
          const pinned = readFileSync(pinFile, 'utf8').trim();
          const homeDir = dirname(coreDir);
          // A peer that has not migrated yet still keeps its pin in its old workspace, where the
          // project scan cannot see it, so those are read here: a folder two projects' pins name
          // is signed for neither, whichever migrates first.
          const legacyPeers = manifest.entries.filter((e) => e.path !== real && e.dir_exists && readTextOrNull(join(coreDir, 'workspaces', e.workspace_id, 'metrics', 'storage-path.txt')) === pinned);
          const otherProjects = otherProjectsNamingFolder(pinned, { projectDir: real, home: homeDir, env: { CORE_HARNESS: harness } });
          if (metricsStorageAllowed(pinned, { projectDir: real, home: homeDir }) && !legacyPeers.length && !otherProjects.length) {
            writePinSigned({ dir: dirname(pinFile), path: pinned, root: real, coreDir });
            // Same durable marker a fresh scaffold writes, so losing this carried pin later is caught
            // the same way. A failure here does not undo the file copy this migration already did —
            // that succeeded. The pin is deliberately NOT rolled back on a marker failure: removing it
            // would erase the one signal that this project was ever redirected, and a project whose
            // real path carries no redirect signal of its own would then read as clean rather than
            // refused — a false purge/false-clean-stats result, not a fixed one (caught by review
            // against a real fault fixture). Left signed, storagePinInvalid's own backfill sees a
            // valid pin with no marker on the very next read, tries the same write, fails the same
            // way, and refuses — closed immediately, not only after a later loss. Named in the
            // result either way.
            try {
              markMetricsEverExternal({ projectDir: real, harness, home: homeDir, coreDir, folder: pinned });
            } catch (e) {
              metricsMarkerFailed = { folder: pinned, err: String(e && e.message) };
            }
          } else if (metricsStorageAllowed(pinned, { projectDir: real, home: homeDir })) {
            // Ambiguous: left unsigned, and recorded so the scaffold and the readiness summary can say so.
            metricsHeld = { folder: pinned, also_named_by: [...legacyPeers.map((e) => e.path), ...otherProjects] };
            writeHeldSigned({ dir: dirname(pinFile), folder: pinned, alsoNamedBy: metricsHeld.also_named_by, coreDir });
          }
        }
      }

      // The migrated manifest keeps the old workspace id as project_id (export
      // pseudonym continuity) and the pointer's opt-outs.
      const pointer = readJson(join(real, 'workspace.json'), {});
      const carry = {};
      for (const k of ['metrics_enabled', 'turn_capture']) if (typeof pointer[k] === 'boolean') carry[k] = pointer[k];
      if (live) {
        const legacy = readJson(join(coreDir, 'workspaces', live.workspace_id, 'workspace.json'), {});
        const { workspace_id: _id, path: _path, project_path: _pp, ...kept } = legacy && typeof legacy === 'object' ? legacy : {};
        updateManifest({ root: real, harness, coreDir, fields: { ...kept, ...carry, project_id: live.workspace_id, harness, migrated_from: live.workspace_id } });
      }

      writeSignedFile({ dir: durable.dir, name: RECEIPT, coreDir, body: JSON.stringify({
        complete: true, migrated_at: iso, harness, root: real,
        live: live ? live.workspace_id : null, superseded: dups.map((e) => e.workspace_id),
        files: copies.map((c) => ({ from: c.from, to: c.to, sha256: c.sha256, length: c.length })),
      }, null, 2) + '\n' });
      rmSync(markerFile, { force: true });
    }

    // Record the marks, then release the old surfaces once every harness on the path has migrated.
    const ids = [...(live ? [live.workspace_id] : []), ...dups.map((e) => e.workspace_id)];
    const { out: release } = withManifest(coreDir, table, harness, (m) => {
      for (const e of m.entries) {
        if (ids.includes(e.workspace_id) && !e.migrated_at) Object.assign(e, { migrated_at: iso, migrated_to: durable.dir, migrated_by: harness });
      }
      const onPath = m.entries.filter((e) => e.path === real && e.registered && (e.class === 'migrate' || e.class === 'supersede' || e.class === 'hold'));
      return { allDone: onPath.length > 0 && onPath.every((e) => e.migrated_at), onPath };
    });

    mutateProjects(coreDir, (entries) => {
      if (entries.some((e) => e && typeof e.path === 'string' && canonical(e.path) === real)) return entries;
      return [...entries, { path: real, registered_at: iso }];
    });

    let released = false;
    if (release.allDone) {
      for (const e of release.onPath) {
        const dir = join(coreDir, 'workspaces', e.workspace_id);
        if (existsSync(dir) && !existsSync(join(dir, 'MOVED.md'))) {
          atomicWriteFileSync(join(dir, 'MOVED.md'), `This workspace's CORE state now lives in ${e.migrated_to} (migrated ${e.migrated_at}). Nothing here was deleted.\n`);
        }
      }
      const pointerFile = join(real, 'workspace.json');
      if (existsSync(pointerFile) && !gitTracks(real, 'workspace.json')) {
        atomicWriteFileSync(pointerFile, JSON.stringify({ moved: '.core/', note: 'CORE state for this project now lives in .core/<harness>/.' }) + '\n');
      }
      const onIds = new Set(release.onPath.map((e) => e.workspace_id));
      mutateIndex(coreDir, (entries) => entries.map((e) => (e && onIds.has(e.workspace_id) && !e.migrated ? { ...e, migrated: true, migrated_at: iso } : e)));
      released = true;
    }

    return {
      status: copies === null ? 'already-migrated' : 'migrated',
      root: real, harness, live: live ? live.workspace_id : null, superseded: dups.map((e) => e.workspace_id),
      files: copies ? copies.length : 0, released, ...(metricsHeld ? { metrics_held: metricsHeld } : {}), ...(metricsMarkerFailed ? { metrics_marker_failed: metricsMarkerFailed } : {}),
    };
  } finally {
    releaseFileLock(lockFile, lock.nonce);
  }
}

// ---------- old builds after migration ----------

function sha256Prefix(file, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const n = readSync(fd, buf, off, length - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === length ? createHash('sha256').update(buf).digest('hex') : null;
  } finally { closeSync(fd); }
}

function readRange(file, start) {
  const bytes = readFileSync(file);
  return bytes.subarray(start);
}

/**
 * An older build of the same harness (a rollback, or a second machine) can keep
 * writing to the legacy workspace after migration. Compare each legacy file with the
 * receipt: an append-only log (*.jsonl) whose recorded prefix is unchanged gets its new
 * tail appended to the in-project copy; anything else that changed or appeared is
 * copied to superseded/legacy-<date>/. The receipt is updated so a re-run is a no-op.
 * Returns { status, root, harness, appended: [...], superseded: [...] }.
 */
export function checkLegacyDrift(opts = {}) {
  try { return checkLegacyDriftInner(opts); }
  catch (e) {
    if (e instanceof LegacyStateError) return { status: 'legacy-held', root: canonical(opts.root), code: e.code, path: e.path, reason: e.message };
    throw e;
  }
}

function checkLegacyDriftInner({ root, harness = detectStateHarness(), coreDir = defaultCoreDir(), now = new Date() } = {}) {
  assertHarnessName(harness);
  const real = canonical(root);
  const durable = stateDir({ root: real, harness, kind: 'durable', coreDir });
  if (!durable) return { status: 'no-state', root: real, harness };
  const receiptFile = join(durable.dir, RECEIPT);
  if (!existsSync(receiptFile)) return { status: 'not-migrated', root: real, harness };
  const hotDir = stateDir({ root: real, harness, kind: 'hot', coreDir, forWrite: true });
  const checked = verifiedReceipt({ root: real, harness, coreDir, stateDirs: [durable.dir, hotDir.dir] });
  if (!checked.ok && !checked.receipt) return { status: 'receipt-unverified', root: real, harness, problems: checked.problems.slice(0, 10) };
  if (!checked.receipt.complete) return { status: 'not-migrated', root: real, harness };
  if (!checked.ok) return { status: 'receipt-unverified', root: real, harness, problems: checked.problems.slice(0, 10) };
  const receipt = checked.receipt;

  const lockFile = join(real, '_memories', '_close.lock');
  mkdirSync(dirname(lockFile), { recursive: true });
  const lock = acquireFileLock(lockFile, { extra: { session_id: `legacy-drift-${harness}` }, staleMs: LOCK_STALE_MS, hardStaleMs: 2 * LOCK_STALE_MS });
  if (!lock.ok) return { status: 'lock-held', root: real, reason: lock.reason };
  try {
    const hot = hotDir;
    const byFrom = new Map((receipt.files || []).map((f) => [f.from, f]));
    const sources = [
      ...(receipt.live ? [{ id: receipt.live, superseded: false }] : []),
      ...(receipt.superseded || []).map((id) => ({ id, superseded: true })),
    ];
    const day = now.toISOString().slice(0, 10);
    const appended = [];
    const superseded = [];
    const persistReceipt = () => writeSignedFile({ dir: durable.dir, name: RECEIPT, coreDir, body: JSON.stringify({ ...receipt, files: [...byFrom.values()], legacy_checked_at: now.toISOString() }, null, 2) + '\n' });
    // Every source is listed before anything is written: an unreadable folder or a symlink
    // must stop the check with the project's copies and the receipt still as they were.
    const listed = sources.map(({ id, superseded: isSup }) => {
      assertSafeWorkspaceId(id);
      const src = join(coreDir, 'workspaces', id);
      return { id, isSup, src, rels: existsSync(src) ? listFiles(src, { strict: true }) : [] };
    });
    for (const { id, isSup, src, rels } of listed) {
      for (const rel of rels) {
        const base = rel.split('/').pop();
        if (base === 'MOVED.md' || SKIP_ON_COPY.some((re) => re.test(base))) continue;
        const from = join(src, rel);
        const size = statSync(from).size;
        let known = byFrom.get(from);
        if (known && known.pending) {
          const resolved = resolvePendingAppend({ from, known });
          if (resolved.conflict) {
            // The recorded range is gone from the source, or the project's copy holds something
            // that is neither the tail nor a part of it: keep the legacy bytes aside and say so.
            const aside = join(durable.dir, 'superseded', `legacy-${day}`, id, rel);
            mkdirSync(dirname(aside), { recursive: true });
            copyFileSync(from, aside);
            superseded.push({ from, to: aside, reason: 'unresolved-pending-append' });
            byFrom.set(from, { from, to: known.to, sha256: sha256(from), length: statSync(from).size });
            persistReceipt();
            continue;
          }
          known = resolved.known;
          byFrom.set(from, known);
          persistReceipt();
        }
        if (known && known.sha256 === sha256(from)) continue;

        const top = rel.split('/')[0];
        const defaultTo = isSup
          ? join(durable.dir, 'superseded', id, rel)
          : join(HOT_TOP.has(top) ? hot.dir : durable.dir, rel === 'workspace.json' ? LEGACY_MANIFEST : rel);
        const to = known ? known.to : defaultTo;
        const priorLen = known && typeof known.length === 'number' ? known.length : 0;
        const appendOnly = base.endsWith('.jsonl') && size >= priorLen
          && (!known || known.pending || (typeof known.length === 'number' && sha256Prefix(from, priorLen) === known.sha256));

        if (appendOnly) {
          mkdirSync(dirname(to), { recursive: true });
          const tail = readRange(from, priorLen);
          // Write ahead: the intent reaches the signed receipt before the bytes reach the copy.
          byFrom.set(from, { from, to, sha256: known ? known.sha256 : null, length: priorLen, pending: {
            from_offset: priorLen, from_length: size, to_offset: existsSync(to) ? statSync(to).size : 0,
            tail_sha: createHash('sha256').update(tail).digest('hex'),
          } });
          persistReceipt();
          appendFileSync(to, tail);
          appended.push({ from, to, bytes: size - priorLen });
          byFrom.set(from, { from, to, sha256: sha256(from), length: size });
          persistReceipt();
        } else {
          const aside = join(durable.dir, 'superseded', `legacy-${day}`, id, rel);
          mkdirSync(dirname(aside), { recursive: true });
          copyFileSync(from, aside);
          superseded.push({ from, to: aside });
          byFrom.set(from, { from, to: known ? known.to : aside, sha256: sha256(from), length: size });
        }
      }
    }
    if (appended.length || superseded.length) persistReceipt();
    return { status: appended.length || superseded.length ? 'brought-in' : 'unchanged', root: real, harness, appended, superseded };
  } finally {
    releaseFileLock(lockFile, lock.nonce);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = true;
    else if (a === '--drift-check') out.driftCheck = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--harness') out.harness = argv[++i];
    else if (a === '--core-dir') out.coreDir = argv[++i];
    else if (a === '--table') out.table = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

if (isCliEntry(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.manifest && !args.apply && !args.driftCheck) {
      throw new Error('usage: migrate-workspace-state.mjs --manifest|--apply|--drift-check [--root <dir>] [--harness <h>] [--core-dir <dir>] [--table <file>] [--out <file>]');
    }
    const coreDir = args.coreDir || defaultCoreDir();
    const tableFile = args.table || join(coreDir, 'migrate-harness-table.json');
    const table = existsSync(tableFile) ? JSON.parse(readFileSync(tableFile, 'utf8')) : { entries: {} };
    let result;
    if (args.apply || args.driftCheck) {
      const harness = args.harness || detectStateHarness();
      let root = args.root;
      if (!root) {
        const found = resolveProjectRoot(process.cwd(), { home: dirname(coreDir), coreDir });
        root = found.root || process.cwd();
      }
      result = args.apply ? applyMigration({ root, harness, coreDir, table }) : checkLegacyDrift({ root, harness, coreDir });
    } else {
      result = buildManifest({ coreDir, table, applyHarness: args.harness || null });
    }
    const text = JSON.stringify(result, null, 2) + '\n';
    if (args.out) atomicWriteFileSync(args.out, text);
    else process.stdout.write(text);
    // A migration that could not finish is not a clean run: exit 3 so a caller sees it.
    process.exit(BLOCKED_STATUSES.has(result.status) ? 3 : 0);
  } catch (err) {
    process.stderr.write(`migrate-workspace-state: ${err.message}\n`);
    process.exit(2);
  }
}
