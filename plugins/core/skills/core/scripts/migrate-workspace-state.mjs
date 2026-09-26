#!/usr/bin/env node
/**
 * migrate-workspace-state.mjs — classify every legacy ~/.core/workspaces/<id>/
 * folder and ~/.core/index.json entry before per-project state moves into
 * <project>/.core/<harness>/. This is the dry run: it reads, classifies, and
 * reports. It never writes to a workspace, a project, or the registry.
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
 * table predates. Duplicate tie-break: the id the project's root workspace.json
 * pointer names, then the newer last-active; otherwise every duplicate is held.
 *
 * CLI:
 *   node migrate-workspace-state.mjs --manifest [--core-dir <dir>] [--table <file>] [--out <file>]
 *
 * Ships with the plugin by convention; .mjs (Node.js) only, node:* imports only.
 */

import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { isCliEntry } from './cli-entry.mjs';
import { canonical, defaultCoreDir } from './project-state.mjs';

// Bookkeeping, not data: a folder holding only these has nothing worth migrating.
const BOOKKEEPING = [/^\.DS_Store$/, /^last-active$/, /^last-bootstrap\.json$/, /\.lock(\.g\d+)?(\.done)?$/, /^visibility-canary\.json$/];
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
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
export function buildManifest({ coreDir = defaultCoreDir(), table = { entries: {} }, now = new Date() } = {}) {
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
    const rawPath = reg?.path || null;
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

    const e = {
      workspace_id: id, registered: !!reg, dir_exists: dirExists, path, path_exists: pathExists,
      harness, harness_evidence: harnessEvidence, data_files: files.length,
      sample_files: files.slice(0, 5), class: null, reason: null,
    };
    if (!reg) {
      e.class = files.length ? 'orphan-unregistered' : 'empty';
      e.reason = files.length ? 'workspace folder with data but no registry entry' : 'no registry entry and no data';
    } else if (!pathExists) {
      e.class = 'orphan-gone'; e.reason = 'registered path no longer exists';
    } else if (harness === 'unknown') {
      e.class = 'hold'; e.reason = 'harness-unknown';
    }
    e._last = lastActive(coreDir, id, reg);
    return e;
  });

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

  for (const e of entries) delete e._last;
  const counts = {};
  for (const e of entries) counts[e.class] = (counts[e.class] || 0) + 1;
  const flagged = entries.filter((e) => e.class === 'hold' || e.class === 'orphan-unregistered')
    .map((e) => ({ workspace_id: e.workspace_id, class: e.class, reason: e.reason, harness_evidence: e.harness_evidence, sample_files: e.sample_files }));
  return { generated_at: now.toISOString(), core_dir: coreDir, table_version: table.version ?? null, counts, flagged, entries };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = true;
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
    if (!args.manifest) throw new Error('usage: migrate-workspace-state.mjs --manifest [--core-dir <dir>] [--table <file>] [--out <file>]');
    const coreDir = args.coreDir || defaultCoreDir();
    const tableFile = args.table || join(coreDir, 'migrate-harness-table.json');
    const table = existsSync(tableFile) ? JSON.parse(readFileSync(tableFile, 'utf8')) : { entries: {} };
    const manifest = buildManifest({ coreDir, table });
    const text = JSON.stringify(manifest, null, 2) + '\n';
    if (args.out) atomicWriteFileSync(args.out, text);
    else process.stdout.write(text);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`migrate-workspace-state: ${err.message}\n`);
    process.exit(2);
  }
}
