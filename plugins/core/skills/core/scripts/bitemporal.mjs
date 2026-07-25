/**
 * bitemporal.mjs — the validity dimension's hygiene + query operations.
 *
 * Validity (t_valid/t_invalid) is a dimension on units, not a separate subsystem.
 * Its read predicates (effectiveValidity / validAt / isInvalidated) live in
 * priority.mjs — the canonical unit module — and its field-validation lives in
 * check-units.mjs, beside every other frontmatter field. What remains here is the
 * dimension's WRITE and READOUT operations, which are genuinely their own acts:
 *   --stamp    a hygiene write (set t_invalid on supersession; finalize/process-memory)
 *   --as-of    a point-in-time query mode over the shared predicates
 *   --metrics  a storage-health readout (the storage half of the metrics loop)
 * No second store-walk, no parallel "bi-temporal layer" — just these ops over the
 * predicates priority.mjs owns (re-exported below for back-compat).
 *
 * CORE units already carry record-time (`created`/`updated` — when CORE wrote the
 * fact). The validity dimension adds a *world-time* interval alongside it:
 *
 *   t_valid    when the fact became true in the world.   Defaults to `created`
 *              (computed at read-time, NOT stored) — for a fact born from a
 *              conversation or a local file, "when it became true" is when CORE
 *              recorded it, so created is the honest proxy. Written explicitly
 *              only when world-time genuinely diverges from record-time (the
 *              overlay case: an extractor reading a source's own timestamp).
 *   t_invalid  when the fact stopped being true. Empty while the fact holds;
 *              stamped by supersession (B supersedes A ⇒ A.t_invalid = B.t_valid).
 *
 * This is additive and source-agnostic: CORE populates from its simple
 * sources (conversation + local files, via the created-default + supersession),
 * an overlay populates t_valid from its richer registered sources via the
 * `world-time-policy` registration field. Same dimension, same readers.
 *
 * Three readers consume the dimension so it is never write-only:
 *   - asOf(date)        point-in-time reconstruction of the valid set
 *   - storageMetrics()  usable storage-health signal (churn, stale, intervals)
 *   - (stale-context detector in metrics-detectors.mjs reads t_invalid directly)
 *
 * Suppression invariant: a unit whose t_invalid is in the past is invalidated —
 * excluded from the "currently valid" set the same way retired units are. Cold
 * history stays reachable by asOf() or an explicit supersedes-edge walk.
 *
 * Ships with the plugin as prescriptive code; .mjs only. Fail-open.
 *
 * CLI:
 *   node bitemporal.mjs <project> --stamp [--apply]   stamp t_invalid on superseded units (dry-run unless --apply)
 *   node bitemporal.mjs <project> --as-of <YYYY-MM-DD> point-in-time valid set
 *   node bitemporal.mjs <project> --metrics            storage-health rollup
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import {
  extractEdges, parseIsoDate,
  effectiveValidity, validAt, isInvalidated, iterArchivedUnits,
} from './priority.mjs';
import { iterActiveUnits } from './check-units.mjs';

export const BITEMPORAL_VERSION = '1.0.0';

// The read-time validity predicates (effectiveValidity / validAt / isInvalidated)
// now live in priority.mjs — the canonical unit module — so every reader shares
// one definition (validity-dimension consolidation, 2026-06-02). Re-exported here
// for back-compat: this module's CLI, its writer/metrics functions, and any
// existing importer keep working against the same single source.
export { effectiveValidity, validAt, isInvalidated };

// ---------- supersession classification (shared by writer + metrics) ----------

// Shared terminal-status contract (SYN-005): one definition in unit-vocab.mjs.
export { TERMINAL_STATUSES } from './unit-vocab.mjs';
import { TERMINAL_STATUSES } from './unit-vocab.mjs';

/**
 * Walk every supersedes edge B→A and classify it. A supersedes edge alone does
 * NOT mean A's fact stopped being true — CORE's corpus carries loose/partial
 * supersessions where the target is still active (a refinement mis-typed as a
 * supersession, or a status-hygiene gap). So t_invalid is stamped ONLY when A's
 * status is already terminal — t_invalid then records the world-time of a
 * transition the corpus already acknowledges via status. The loose edges
 * (supersedes → still-active target) are surfaced as a consistency signal, never
 * auto-invalidated. Confirmed stamps dedupe by target and take the EARLIEST
 * superseder t_valid (the fact stopped being true when the first thing replaced it).
 *
 * @returns {{ confirmed: Array, loose: Array }}
 */
export function classifySupersessions(units) {
  const byId = new Map();
  for (const u of units) byId.set(basename(u.path, '.md'), u);

  const confirmedByTarget = new Map(); // targetId -> { target, t_invalid (earliest), superseders[], path }
  const loose = [];

  for (const b of units) {
    for (const e of extractEdges(b)) {
      if (e.type !== 'supersedes' && e.type !== 'supersedes-claim') continue;
      const targetId = String(e.target).replace(/\.md$/, '');
      const a = byId.get(targetId);
      if (!a) continue; // dangling target — integrity check's job, not ours
      const bId = basename(b.path, '.md');
      const aStatus = String(a.fm.status || 'active').toLowerCase();
      const bValid = effectiveValidity(b).t_valid;

      if (!TERMINAL_STATUSES.has(aStatus)) {
        loose.push({ target: targetId, superseded_by: bId, target_status: aStatus });
        continue;
      }
      if (a.fm.t_invalid) continue; // explicit value already set — never overwrite
      if (!bValid) continue;
      const cur = confirmedByTarget.get(targetId);
      if (!cur) {
        confirmedByTarget.set(targetId, { target: targetId, t_invalid: bValid, superseders: [bId], path: a.path });
      } else {
        cur.superseders.push(bId);
        if (bValid < cur.t_invalid) cur.t_invalid = bValid; // earliest wins
      }
    }
  }

  // Invariant guard: a stamped t_invalid must not predate the target's own
  // effective t_valid — that would make the unit valid-nowhere (validAt false
  // for every date) and silently drop it from the valid set. check-units
  // enforces t_valid <= t_invalid on the stored field; the writer must not
  // create the violation in the first place. The offending supersession (an
  // explicit world-time t_valid that postdates its earliest superseder) is a
  // real conflict — surfaced for the user, never auto-stamped.
  const confirmed = [];
  const conflicts = [];
  for (const c of confirmedByTarget.values()) {
    const a = byId.get(c.target);
    const aValid = a ? effectiveValidity(a).t_valid : null;
    if (aValid && c.t_invalid < aValid) {
      conflicts.push({ target: c.target, superseded_by: c.superseders.join(', '), t_invalid_candidate: c.t_invalid, t_valid: aValid });
    } else {
      confirmed.push(c);
    }
  }
  return { confirmed, loose, conflicts };
}

// ---------- writer: supersession stamps t_invalid ----------

/**
 * The confirmed t_invalid stamps to apply (target status terminal, no explicit
 * value yet). See classifySupersessions for the conservative rationale.
 */
export function planSupersessionStamps(units) {
  return classifySupersessions(units).confirmed.map((c) => ({
    target: c.target,
    t_invalid: c.t_invalid,
    superseded_by: c.superseders.join(', '),
    path: c.path,
  }));
}

/** Insert or replace a top-level scalar frontmatter field, preserving the rest. */
export function setFrontmatterField(text, key, value) {
  // Normalize CRLF -> LF before matching. A unit authored with CRLF endings
  // (Windows/OneDrive) opens with `---\r\n`, which an LF-only fence regex can't
  // match — the stamp would be silently dropped. The sibling readers
  // (parseFrontmatter in priority.mjs, parseFlatFrontmatter) normalize the same
  // way, and .gitattributes pins *.md to eol=lf, so LF-on-write is canonical.
  const normalized = text.replace(/\r\n/g, '\n');
  const m = normalized.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!m) return text; // no frontmatter — leave the ORIGINAL untouched
  const [, open, body, close] = m;
  const lines = body.split('\n');
  const keyRe = new RegExp(`^${key}\\s*:`);
  const idx = lines.findIndex((l) => keyRe.test(l));
  if (idx >= 0) {
    lines[idx] = `${key}: ${value}`;
  } else {
    // Insert after `updated:` if present (keeps temporal fields together), else after `created:`, else at end.
    let anchor = lines.findIndex((l) => /^updated\s*:/.test(l));
    if (anchor < 0) anchor = lines.findIndex((l) => /^created\s*:/.test(l));
    if (anchor >= 0) lines.splice(anchor + 1, 0, `${key}: ${value}`);
    else lines.push(`${key}: ${value}`);
  }
  return normalized.replace(m[0], `${open}${lines.join('\n')}${close}`);
}

/** Apply the planned stamps to disk. Returns count written. */
export function applySupersessionStamps(stamps) {
  let written = 0;
  for (const s of stamps) {
    try {
      const text = readFileSync(s.path, 'utf8');
      const next = setFrontmatterField(text, 't_invalid', s.t_invalid);
      if (next !== text) { atomicWriteFileSync(s.path, next); written += 1; }
    } catch { /* best-effort per-unit */ }
  }
  return written;
}

// ---------- readers ----------

/** Units valid at a point in time. Returns sorted unit ids. */
export function asOf(units, dateStr) {
  return units.filter((u) => validAt(u, dateStr)).map((u) => basename(u.path, '.md')).sort();
}

/**
 * Storage-health rollup over the validity dimension — the usable storage metric
 * that tells us whether the store is churning, accumulating stale facts, etc.
 * All computable on CORE's own corpus from supersession + created.
 */
export function storageMetrics(units, today) {
  let invalidated = 0;
  let withExplicitValid = 0;
  const intervals = []; // closed-interval lengths in days, for invalidated facts

  for (const u of units) {
    const { t_valid, t_invalid } = effectiveValidity(u);
    if (u.fm.t_valid) withExplicitValid += 1;
    if (isInvalidated(u, today)) {
      invalidated += 1;
      const a = parseIsoDate(t_valid);
      const b = parseIsoDate(t_invalid);
      if (a && b) intervals.push(Math.round((b.getTime() - a.getTime()) / 86_400_000));
    }
  }

  // Consistency signals the conservative writer surfaces instead of silently
  // corrupting: loose edges (supersedes → still-active target — a mis-typed edge
  // or status-hygiene gap) and validity conflicts (a supersession whose stamp
  // would predate the target's own t_valid — surfaced, never stamped).
  const { loose: looseEdges, conflicts } = classifySupersessions(units);

  // SYN-006 consistency signal: a unit already terminal by status but with no
  // t_invalid and no incoming supersedes/supersedes-claim edge can NEVER be
  // stamped by the conservative writer — its t_invalid needs manual population
  // (or the missing supersedes edge). Surfaced, never auto-stamped.
  const supersededTargets = new Set();
  for (const u of units) {
    for (const e of extractEdges(u)) {
      if (e.type === 'supersedes' || e.type === 'supersedes-claim')
        supersededTargets.add(String(e.target).replace(/\.md$/, ''));
    }
  }
  const unstampedTerminal = [];
  for (const u of units) {
    const status = String(u.fm.status || 'active').toLowerCase();
    if (!TERMINAL_STATUSES.has(status)) continue;
    if (u.fm.t_invalid) continue;
    const id = basename(u.path, '.md');
    if (!supersededTargets.has(id)) unstampedTerminal.push(id);
  }
  unstampedTerminal.sort();

  const total = units.length;
  const validNow = total - invalidated;
  intervals.sort((x, y) => x - y);
  const median = intervals.length ? intervals[Math.floor(intervals.length / 2)] : null;
  const mean = intervals.length ? Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length) : null;

  return {
    schema_version: BITEMPORAL_VERSION,
    total,
    valid_now: validNow,
    invalidated,
    explicit_t_valid: withExplicitValid,             // overlay/world-time-divergent facts
    loose_supersession_edges: looseEdges.length,     // supersedes → still-active target (hygiene signal)
    loose_edges: looseEdges,
    validity_conflicts: conflicts.length,            // supersession stamp would predate target t_valid (surfaced, never stamped)
    conflicts,
    unstamped_terminal: unstampedTerminal.length,    // terminal status, no t_invalid, no incoming supersedes — manual-population candidates
    unstamped_terminal_units: unstampedTerminal,
    churn_rate: total ? Math.round((invalidated / total) * 1000) / 1000 : 0,
    closed_interval_days: { count: intervals.length, mean, median, min: intervals[0] ?? null, max: intervals[intervals.length - 1] ?? null },
  };
}

// ---------- CLI ----------

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const memoriesDir = join(project, '_memories');
  const today = new Date();
  let units;
  try { units = iterActiveUnits(memoriesDir); } catch { units = []; }

  if (argv.includes('--stamp')) {
    const stamps = planSupersessionStamps(units);
    const apply = argv.includes('--apply');
    const { conflicts } = classifySupersessions(units);
    if (conflicts.length) {
      process.stdout.write(`bitemporal: ⚠ ${conflicts.length} validity conflict(s) — supersession would stamp t_invalid before the target's t_valid; surfaced, NOT stamped:\n`);
      for (const c of conflicts) process.stdout.write(`      ${c.superseded_by} supersedes ${c.target}: candidate t_invalid ${c.t_invalid_candidate} < t_valid ${c.t_valid}\n`);
    }
    if (!stamps.length) { process.stdout.write('bitemporal: no supersession stamps needed (no superseding units, or all already stamped)\n'); process.exit(0); }
    process.stdout.write(`bitemporal: ${stamps.length} supersession stamp(s)${apply ? ' — APPLYING' : ' — DRY RUN (pass --apply to write)'}:\n`);
    for (const s of stamps) process.stdout.write(`  ${s.target}.t_invalid = ${s.t_invalid}  (superseded by ${s.superseded_by})\n`);
    if (apply) { const n = applySupersessionStamps(stamps); process.stdout.write(`bitemporal: wrote ${n} unit(s)\n`); }
    process.exit(0);
  }

  if (argv.includes('--as-of')) {
    const date = opt('as-of');
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { process.stdout.write('bitemporal: --as-of needs a YYYY-MM-DD date\n'); process.exit(1); }
    // A point-in-time reconstruction is inherently a historical query -- it
    // must see units the archive action has physically relocated to
    // archive/, or asOf() silently loses everything valid in the past that's
    // since been archived. --stamp/--metrics
    // above stay on the active-only pool; only --as-of needs the merge.
    const ids = asOf(units.concat(iterArchivedUnits(memoriesDir)), date);
    process.stdout.write(`bitemporal: ${ids.length} unit(s) valid as of ${date}\n`);
    for (const id of ids) process.stdout.write(`  ${id}\n`);
    process.exit(0);
  }

  if (argv.includes('--metrics')) {
    const m = storageMetrics(units, today);
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(m, null, 2) + '\n'); process.exit(0); }
    process.stdout.write(`bitemporal storage metrics (${m.total} active units):\n`);
    process.stdout.write(`  valid now: ${m.valid_now} | invalidated: ${m.invalidated} | churn: ${(m.churn_rate * 100).toFixed(1)}%\n`);
    process.stdout.write(`  explicit t_valid (world-time-divergent): ${m.explicit_t_valid}\n`);
    if (m.loose_supersession_edges > 0) {
      process.stdout.write(`  ⚠ ${m.loose_supersession_edges} loose supersedes edge(s) — target still active (mis-typed edge or status-hygiene gap):\n`);
      for (const l of m.loose_edges) process.stdout.write(`      ${l.superseded_by} supersedes ${l.target} (status: ${l.target_status})\n`);
    }
    if (m.unstamped_terminal > 0) {
      process.stdout.write(`  ⚠ ${m.unstamped_terminal} terminal unit(s) with no t_invalid and no incoming supersedes edge — populate t_invalid manually or add the supersedes edge:\n`);
      for (const id of m.unstamped_terminal_units) process.stdout.write(`      ${id}\n`);
    }
    if (m.closed_interval_days.count) process.stdout.write(`  validity intervals (days): median ${m.closed_interval_days.median}, mean ${m.closed_interval_days.mean}, range ${m.closed_interval_days.min}–${m.closed_interval_days.max}\n`);
    process.exit(0);
  }

  process.stdout.write('bitemporal: --stamp [--apply] | --as-of <YYYY-MM-DD> | --metrics [--json]\n');
  process.exit(1);
}
