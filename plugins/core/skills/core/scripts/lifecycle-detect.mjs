#!/usr/bin/env node
/**
 * lifecycle-detect.mjs — the lifecycle REPORTING preflight and the CORE
 * creation-baseline seam.
 *
 * TWO honest jobs, and no more:
 *
 *   1. REPORTING preflight (`detectStore`/`classifyFileLifecycle`). Runs at
 *      startup / `/process-memory` / `/finalize` / close catch-up and returns a
 *      machine-readable, per-file classification of the store so the AGENT can
 *      narrate real user edits in the readiness summary instead of absorbing
 *      them blind. This is REPORTING ONLY — it is NOT the safety boundary and
 *      never resets a baseline. Each writer independently self-refuses at its
 *      own atomic write via `lifecycle-core.mjs` `writeGuardDecision` against
 *      the pre-write cache baseline; a skipped preflight therefore degrades
 *      safely (the writers still fail closed on their own). The writers do NOT
 *      consult this module's output — it exists for the human-facing narrative,
 *      not as a programmatic gate. (Correcting the earlier header, which claimed
 *      a production gate role the product never actually wired — a review point.)
 *
 *   2. CREATION-BASELINE seam (`stampCreatedBaseline`/`createFile`). The ONLY
 *      safe way a no-baseline file becomes writable by decorate/hot-section/
 *      compact: the CREATING CORE writer stamps the exact bytes it just wrote,
 *      at creation time. `createFile` writes a brand-new CORE-authored file AND
 *      stamps its baseline in one operation; `stampCreatedBaseline` stamps a
 *      file the agent has just written by hand (graduation / PROJECT.md render,
 *      via the `--stamp-created` CLI). Absent this stamp, every downstream
 *      writer refuses the file (no timing inference — see `lifecycle-core.mjs`
 *      header). Missing the stamp fails CLOSED: the file is HELD and surfaced,
 *      never silently rewritten.
 *
 *      SECOND, NARROWER exception to "creation time only": `adoptExistingStore`
 *      (`--adopt-existing-store`) is a one-time, explicitly-invoked ceremony for
 *      a store that predates the stamping seam entirely — every unit hits
 *      no-baseline on first contact, not because anyone forgot to stamp
 *      anything, but because the seam didn't exist yet on that store's
 *      baseline. It stamps the CURRENT bytes of every currently-no-baseline
 *      unit as the adoption baseline going forward — the same operation as
 *      calling `--stamp-created` once per file, just batched, and requiring
 *      the same explicit `--apply` a human or agent must actually choose to
 *      pass (dry-run reports the count/list by default). It does NOT decide
 *      whether those bytes are CORE-authored versus user-authored — same as
 *      the single-file path, it can't. What it establishes is only "these are
 *      the bytes as of the adoption moment"; any subsequent divergence is
 *      caught the same way `pending-edit` catches it for any other unit. This
 *      is deliberately not automatic and not silent: run it once, on purpose,
 *      when adopting a pre-existing store into this stamping regime.
 *
 * Per-file classification (the point-1 enum):
 *   clean          — matches the last CORE baseline byte-for-byte.
 *   generated-only — only the marker-delimited generated region changed
 *                    (CORE's own hot-section/edges block); human region intact.
 *   pending-edit   — the human-authored region diverged from the last baseline;
 *                    an unreconciled user edit. Reconcile before any writer runs.
 *   no-baseline    — no cache stamp. ALWAYS a needs-attention item now: either a
 *                    user file to reconcile, or a CORE-created file whose creating
 *                    writer failed to stamp it (a bug to surface, not paper over).
 *                    The `pre_existing` flag is a NON-AUTHORITATIVE diagnostic
 *                    hint only (see the session-inventory note below); it drives
 *                    no safety decision.
 *   missing        — the file had a baseline but is gone now.
 *   malformed      — ambiguous/duplicate markers; refuse to parse or guess.
 *   read-only      — couldn't read it (permission/IO); can't determine state.
 *
 * SESSION INVENTORY — DIAGNOSTIC ONLY, NON-AUTHORITATIVE. `--record-session-start`
 * snapshots which user-sensitive files existed at session start. It drives no
 * safety decision ("absent from inventory => CORE-created => safe" would be
 * unsound). The inventory only annotates a
 * no-baseline file with a `pre_existing` hint for the agent's narrative. Because
 * it drives no decision, concurrency/staleness of the
 * single global inventory file doesn't matter — a wrong hint is harmless.
 *
 * CLI:
 *   node lifecycle-detect.mjs <project> [--record-session-start <id>] [--json]
 *   node lifecycle-detect.mjs <project> --stamp-created <path> [--kind unit|project] [--by <label>]
 *   node lifecycle-detect.mjs <project> --adopt-existing-store [--apply] [--json]
 *     --record-session-start <id>  Snapshot which user-sensitive files exist NOW
 *                                  (diagnostic hint only — see above).
 *     --stamp-created <path>       Establish the first CORE-authored baseline for
 *                                  a file CORE just created (graduation, PROJECT.md
 *                                  render). --kind selects the domain block hasher
 *                                  (default 'unit'); --by sets last_written_by.
 *
 * Ships with the plugin as prescriptive code; .mjs only.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { readProjectCache, hashText, stampFile, CACHE_CORRUPT } from './state-cache.mjs';
import { findExistingBlock as hotScan, classifyProjectMdChange, hashOutsideHotBlock } from './hot-section.mjs';
import { findExistingEdgesBlock as edgesScan, classifyUnitChange, hashOutsideEdgesBlock } from './decorate-graph.mjs';

// ---------- session-start inventory (diagnostic only, non-authoritative) ----------

export function sessionInventoryPath(projectDir) {
  return join(resolve(projectDir), '_memories', '_lib', '.lifecycle-session.json');
}

/**
 * Read the session-start inventory, or `null` when none has been recorded.
 * Consumed ONLY as a non-authoritative diagnostic hint (the `pre_existing`
 * annotation on a no-baseline file). No safety decision depends on it.
 */
export function readSessionInventory(projectDir) {
  try {
    const inv = JSON.parse(readFileSync(sessionInventoryPath(projectDir), 'utf8'));
    if (inv && typeof inv === 'object' && Array.isArray(inv.paths)) return inv;
  } catch { /* absent or unparseable — treat as no inventory */ }
  return null;
}

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

/** Record (overwrite) the session-start inventory. Diagnostic snapshot only. */
export function recordSessionStart(projectDir, { sessionId = null, now = new Date().toISOString() } = {}) {
  const inv = { session: sessionId, started_at: now, paths: inventoryPaths(projectDir) };
  const path = sessionInventoryPath(projectDir);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(inv, null, 2) + '\n');
  return inv;
}

// ---------- creation-baseline seam (the ONLY safe first-write) ----------

/**
 * stampCreatedBaseline — establish the FIRST CORE-authored baseline for a file
 * CORE is creating right now. This is the creation-time stamp the review root fix
 * requires: the creating writer records the exact bytes it just wrote, so every
 * downstream writer (decorate/hot-section/compact) recognizes the file as
 * CORE-authored instead of refusing it as no-baseline. `kind` selects the
 * domain block hasher so the stamped `outside_hash` matches what the downstream
 * classifier will compute: 'unit' → hashOutsideEdgesBlock, 'project' →
 * hashOutsideHotBlock. Returns state-cache.mjs's truthful stamp outcome (a
 * stamp failure surfaces as attribution-unknown/recovery-required, per the
 * review requirement) — it never throws into the creator.
 */
export function stampCreatedBaseline(projectDir, absPath, { kind = 'unit', lastWrittenBy, now, home } = {}) {
  const abs = resolve(absPath);
  const text = readFileSync(abs, 'utf8');
  const outsideHash = kind === 'project' ? hashOutsideHotBlock(text) : hashOutsideEdgesBlock(text);
  const by = lastWrittenBy || (kind === 'project' ? 'project-create' : 'unit-create');
  return stampFile(projectDir, abs, hashText(text), by, { now, home, extra: { outside_hash: outsideHash } });
}

/**
 * createFile — write a brand-new CORE-authored file AND stamp its baseline in
 * one operation. THE creation code path: a freshly-created unit or PROJECT.md is
 * immediately decoratable/writable in the same session with no timing inference,
 * because the baseline exists the instant the bytes land. Tests exercise this
 * exact function (not a hand fixture that skips the stamp) so the legitimate
 * same-session-creation case is proven end to end.
 */
export function createFile(projectDir, absPath, content, { kind = 'unit', lastWrittenBy, now, home } = {}) {
  const abs = resolve(absPath);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteFileSync(abs, content);
  return stampCreatedBaseline(projectDir, abs, { kind, lastWrittenBy, now, home });
}

// ---------- per-file classification (reporting) ----------

/**
 * classifyFileLifecycle — the point-1 classifier for one file. `kind` selects
 * the domain scanner/classifier: 'project' (PROJECT.md hot block) or 'unit'
 * (a unit's edges block). Reuses the existing classifiers verbatim; invents no
 * new notion of "changed". A no-baseline file is uniformly a needs-attention
 * item; `pre_existing` is a non-authoritative diagnostic hint only.
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
    // Non-authoritative diagnostic: was this no-baseline file present at session
    // start (likely a user file to reconcile) or did it appear this session
    // (likely a CORE-created file whose creator forgot to stamp it)? A hint for
    // the agent's narrative; it changes nothing about how the file is treated —
    // every no-baseline file is held and surfaced.
    const inv = sessionInventory === undefined ? readSessionInventory(projectDir) : sessionInventory;
    const preExisting = inv ? inv.paths.some(p => resolve(p) === abs) : null;
    return { path: abs, classification: 'no-baseline', pre_existing: preExisting, reason: 'no-baseline' };
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
 * read-only, missing, and EVERY no-baseline file (no timing exemption).
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
    f.classification === 'no-baseline');

  return {
    project: root,
    has_session_inventory: !!inv,
    // A corrupt baseline classifies every file as no-baseline, which reads like
    // a brand-new store. The status travels with the report so the caller states
    // UNKNOWN instead of that plausible-but-wrong story.
    baseline_status: cache.status,
    baseline_trustworthy: cache.status !== CACHE_CORRUPT,
    counts: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, v.length])),
    needs_attention: needsAttention,
    files,
  };
}

/**
 * adoptExistingStore — the one-time batch-adoption ceremony (see the module
 * header's second exception). Classifies the whole store exactly like
 * `detectStore`, then — ONLY when `apply` is true — stamps every currently
 * `no-baseline` file's CURRENT bytes as its adoption baseline via the same
 * `stampCreatedBaseline` the single-file `--stamp-created` path uses, tagged
 * `lastWrittenBy: 'adopt-existing-store'` so the adoption event is
 * distinguishable in the cache from an ordinary creation stamp.
 *
 * Dry-run (`apply` false, the default) touches nothing — it only reports which
 * files WOULD be adopted, so the caller can narrate the count before anyone
 * commits to it. This mirrors `--stamp-created`'s own honest failure
 * reporting: a file that fails to stamp is listed under `failed`, not silently
 * dropped, and the overall result still reports `stamped_count` accurately for
 * what actually landed.
 */
export function adoptExistingStore(projectDir, { apply = false, now, home } = {}) {
  const root = resolve(projectDir);
  const detected = detectStore(root);
  const candidates = detected.files.filter(f => f.classification === 'no-baseline');
  const pmPath = resolve(join(root, 'PROJECT.md'));

  if (!apply) {
    return {
      project: root,
      applied: false,
      candidate_count: candidates.length,
      candidates: candidates.map(f => f.path),
    };
  }

  const stamped = [];
  const failed = [];
  for (const f of candidates) {
    const kind = resolve(f.path) === pmPath ? 'project' : 'unit';
    const outcome = stampCreatedBaseline(root, f.path, { kind, lastWrittenBy: 'adopt-existing-store', now, home });
    if (outcome && outcome.stamped === false) {
      failed.push({ path: f.path, outcome: outcome.outcome, reason: outcome.reason });
    } else {
      stamped.push(f.path);
    }
  }

  return {
    project: root,
    applied: true,
    candidate_count: candidates.length,
    stamped_count: stamped.length,
    stamped,
    failed,
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
    else if (a === '--stamp-created') { opts.stampCreated = argv[++i] ?? ''; }
    else if (a === '--kind') { opts.kind = argv[++i] ?? 'unit'; }
    else if (a === '--by') { opts.by = argv[++i] ?? ''; }
    else if (a.startsWith('--')) flags.add(a.slice(2));
    else positionals.push(a);
  }
  const projectDir = resolve(positionals[0] || process.cwd());

  // Creation-baseline stamp: establish the first CORE-authored baseline for a
  // file the agent just wrote (graduation / PROJECT.md render). Exits nonzero if
  // the stamp could not land, so a caller sees the attribution-unknown state.
  if (opts.stampCreated !== undefined) {
    const target = resolve(projectDir, opts.stampCreated);
    const kind = opts.kind === 'project' ? 'project' : 'unit';
    const outcome = stampCreatedBaseline(projectDir, target, { kind, lastWrittenBy: opts.by || undefined });
    if (outcome && outcome.stamped === false) {
      process.stderr.write(`lifecycle-detect: stamp-created FAILED for ${basename(target)} (${outcome.outcome}: ${outcome.reason}) — attribution unknown, recovery required.\n`);
      return 1;
    }
    if (!flags.has('json')) {
      process.stdout.write(`lifecycle-detect: stamped creation baseline for ${basename(target)} (kind: ${kind}).\n`);
    } else {
      process.stdout.write(JSON.stringify({ stamped: true, path: target, kind }, null, 2) + '\n');
    }
    return 0;
  }

  // One-time batch adoption: dry-run by default, stamps only with --apply.
  if (flags.has('adopt-existing-store')) {
    const report = adoptExistingStore(projectDir, { apply: flags.has('apply') });
    if (flags.has('json')) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (!report.applied) {
      process.stdout.write(report.candidate_count
        ? `lifecycle-detect: DRY RUN — ${report.candidate_count} file(s) would be adopted (re-run with --apply):\n${report.candidates.map(p => `  ${basename(p)}`).join('\n')}\n`
        : `lifecycle-detect: DRY RUN — nothing to adopt (0 no-baseline files).\n`);
    } else {
      process.stdout.write(`lifecycle-detect: adopted ${report.stamped_count}/${report.candidate_count} file(s) as of today's bytes.\n`);
      if (report.failed.length) {
        process.stdout.write(`  FAILED (attribution unknown, recovery required): ${report.failed.map(f => basename(f.path)).join(', ')}\n`);
        return 1;
      }
    }
    return 0;
  }

  if (opts.record !== undefined) {
    const inv = recordSessionStart(projectDir, { sessionId: opts.record || null });
    if (!flags.has('json')) {
      process.stdout.write(`lifecycle-detect: recorded session-start inventory (${inv.paths.length} user-sensitive files, diagnostic only).\n`);
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
    process.stdout.write(`lifecycle-detect: ${summary}\n`);
    for (const f of result.needs_attention) {
      const extra = f.classification === 'no-baseline'
        ? (f.pre_existing === true ? ' (no-baseline, pre-existing at session start)' : f.pre_existing === false ? ' (no-baseline, appeared this session — creator did not stamp?)' : ' (no-baseline)')
        : f.domain ? ` (${f.domain})` : '';
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
