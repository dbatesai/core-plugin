#!/usr/bin/env node
/**
 * lifecycle-detect.mjs — the ONE executable lifecycle detector (Hale's point 1,
 * 2026-07-22). Runs BEFORE any user-sensitive writer in startup, /process-memory,
 * /finalize, and close catch-up, and returns a machine-readable classification
 * per file so the caller reconciles a real user edit instead of silently
 * absorbing it.
 *
 * This is PREFLIGHT/REPORTING, not the only safety boundary (Hale's point 2):
 * each writer ALSO rechecks its own live preimage immediately before its atomic
 * write (see lifecycle-core.mjs `writeGuardDecision` + each writer's CAS). The
 * detector's job is to give the lifecycle a single, honest, machine-readable
 * read of the store's state so nothing user-authored gets written over blind.
 *
 * Per-file classification (Hale's point-1 enum):
 *   clean          — matches the last CORE baseline byte-for-byte.
 *   generated-only — only the marker-delimited generated region changed
 *                    (CORE's own hot-section/edges block); human region intact.
 *   pending-edit   — the human-authored region diverged from the last baseline;
 *                    an unreconciled user edit. Reconcile before any writer runs.
 *   no-baseline    — no cache stamp. `safeFirstWrite` disambiguates (point 8):
 *                    true  = created this session (normal first-write path),
 *                    false = pre-existing at session start, never reconciled
 *                            (conservative — surface, don't auto-write over it).
 *   missing        — the file had a baseline but is gone now.
 *   malformed      — ambiguous/duplicate markers; refuse to parse or guess.
 *   read-only      — couldn't read it (permission/IO); can't determine state.
 *
 * It NEVER resets an unresolved baseline — the detector only reads.
 *
 * CLI:
 *   node lifecycle-detect.mjs <project> [--record-session-start <id>] [--json]
 *     --record-session-start <id>  Snapshot which user-sensitive files exist
 *                                  NOW, as the session-start inventory that
 *                                  drives point-8 no-baseline disambiguation.
 *                                  Run this ONCE at session start, before any
 *                                  CORE write. Overwrites any prior snapshot.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { readProjectCache, hashText } from './state-cache.mjs';
import { resolveNoBaseline, readSessionInventory, sessionInventoryPath } from './lifecycle-core.mjs';
import { findExistingBlock as hotScan, classifyProjectMdChange } from './hot-section.mjs';
import { findExistingEdgesBlock as edgesScan, classifyUnitChange } from './decorate-graph.mjs';

// ---------- session-start inventory ----------

/** Absolute paths of the user-sensitive files that exist right now: PROJECT.md
 *  plus every top-level `_memories/*.md` unit (archive/, _lib/, and index files
 *  excluded — those aren't the human-authored surfaces the boundary protects). */
export function inventoryPaths(projectDir) {
  const root = resolve(projectDir);
  const out = [];
  const pm = join(root, 'PROJECT.md');
  if (existsSync(pm)) out.push(pm);
  const mem = join(root, '_memories');
  let names;
  try { names = readdirSync(mem); } catch { names = []; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('INDEX-')) continue; // generated index, not human-authored
    out.push(join(mem, name));
  }
  return out;
}

/** Record (overwrite) the session-start inventory. Run once at session start. */
export function recordSessionStart(projectDir, { sessionId = null, now = new Date().toISOString() } = {}) {
  const inv = { session: sessionId, started_at: now, paths: inventoryPaths(projectDir) };
  const path = sessionInventoryPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(inv, null, 2) + '\n');
  return inv;
}

// ---------- per-file classification ----------

/**
 * classifyFileLifecycle — the point-1 classifier for one file. `kind` selects
 * the domain scanner/classifier: 'project' (PROJECT.md hot block) or 'unit'
 * (a unit's edges block). Reuses the existing classifiers verbatim; invents no
 * new notion of "changed".
 */
export function classifyFileLifecycle(projectDir, absPath, { kind = 'project', sessionInventory, cache } = {}) {
  const abs = resolve(absPath);
  const c = cache || readProjectCache(projectDir);
  const cachedStamp = c.files[abs];

  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { path: abs, classification: 'missing', had_baseline: !!cachedStamp };
    return { path: abs, classification: 'read-only', reason: (e && e.code) || 'read-failed' };
  }

  const scan = kind === 'unit' ? edgesScan(text) : hotScan(text);
  if (!scan.ok) return { path: abs, classification: 'malformed' };

  if (!cachedStamp) {
    const nb = resolveNoBaseline(projectDir, abs, { sessionInventory });
    return { path: abs, classification: 'no-baseline', safeFirstWrite: nb.safe, reason: nb.reason };
  }

  const classify = kind === 'unit' ? classifyUnitChange : classifyProjectMdChange;
  const domain = classify(cachedStamp, text);
  if (domain === 'outside-changed' || domain === 'no-baseline') {
    return { path: abs, classification: 'pending-edit', domain };
  }
  // Generated-region-only change vs byte-identical to the last recorded write.
  const clean = typeof cachedStamp.last_hash === 'string' && hashText(text) === cachedStamp.last_hash;
  return { path: abs, classification: clean ? 'clean' : 'generated-only', domain };
}

/**
 * detectStore — classify PROJECT.md and every top-level unit against the
 * pre-write cache baseline, grouped for the caller. `needs_attention` collects
 * everything that must NOT be written over blind: pending-edit, malformed,
 * read-only, missing, and the conservative (pre-existing) no-baseline files.
 */
export function detectStore(projectDir, { sessionInventory } = {}) {
  const root = resolve(projectDir);
  const inv = sessionInventory === undefined ? readSessionInventory(root) : sessionInventory;
  const cache = readProjectCache(root);
  const files = [];

  const pm = join(root, 'PROJECT.md');
  if (existsSync(pm)) files.push(classifyFileLifecycle(root, pm, { kind: 'project', sessionInventory: inv, cache }));

  const mem = join(root, '_memories');
  let names;
  try { names = readdirSync(mem); } catch { names = []; }
  for (const name of names) {
    if (!name.endsWith('.md') || name.startsWith('INDEX-')) continue;
    files.push(classifyFileLifecycle(root, join(mem, name), { kind: 'unit', sessionInventory: inv, cache }));
  }

  const byClass = {};
  for (const f of files) (byClass[f.classification] ||= []).push(f);
  const needsAttention = files.filter(f =>
    f.classification === 'pending-edit' ||
    f.classification === 'malformed' ||
    f.classification === 'read-only' ||
    f.classification === 'missing' ||
    (f.classification === 'no-baseline' && f.safeFirstWrite === false));

  return {
    project: root,
    has_session_inventory: !!inv,
    counts: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])),
    needs_attention: needsAttention,
    files,
  };
}

// ---------- CLI ----------

function main(argv) {
  const flags = new Set();
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--record-session-start') { opts.record = argv[++i] ?? ''; }
    else if (a.startsWith('--')) flags.add(a.slice(2));
    else positionals.push(a);
  }
  const projectDir = resolve(positionals[0] || process.cwd());

  if (opts.record !== undefined) {
    const inv = recordSessionStart(projectDir, { sessionId: opts.record || null });
    if (!flags.has('json')) {
      process.stdout.write(`lifecycle-detect: recorded session-start inventory (${inv.paths.length} user-sensitive files).\n`);
    }
  }

  const result = detectStore(projectDir);

  if (flags.has('json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const c = result.counts;
    const summary = Object.keys(c).length
      ? Object.entries(c).map(([k, v]) => `${v} ${k}`).join(', ')
      : 'no files';
    process.stdout.write(`lifecycle-detect: ${summary}${result.has_session_inventory ? '' : ' (no session inventory — no-baseline files treated permissively)'}\n`);
    for (const f of result.needs_attention) {
      const extra = f.classification === 'no-baseline' ? ` (${f.reason})` : f.domain ? ` (${f.domain})` : '';
      process.stderr.write(`  needs attention: ${basename(f.path)} — ${f.classification}${extra}\n`);
    }
  }

  // Nonzero exit when anything needs a human/reconcile look — a caller can gate
  // on it, but it never blocks (the writers have their own refusal boundary).
  return result.needs_attention.length > 0 ? 1 : 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_cliEntryCanonical(process.argv[1] || '') === _cliEntryCanonical(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
