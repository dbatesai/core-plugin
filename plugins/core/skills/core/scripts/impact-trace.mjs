/**
 * impact-trace.mjs — Phase 4 layer 6: impact propagation over the dependency graph.
 *
 * "If this fact changes, what's affected?" CORE already carries `depends-on` edges
 * (and their inverse `depended-on-by`). This walks them in the affects-direction —
 * given a unit X, the transitive set of units that depend on X — so a change or a
 * supersession of X surfaces its blast radius instead of leaving it implicit.
 *
 * Deliberately rides the EXISTING edge types. The realreal scoped a distinct
 * `affects` edge type, but DC-68 fixes the committed-edge set at six and "a seventh
 * requires a new DC" — so the dedicated semantic defers to the bi-temporal contract
 * and a future DC. The depends-on walk is the generic mechanism CORE can run today.
 *
 * Pairs with bitemporal.mjs: traceSupersededImpact() reports, for every unit whose
 * t_invalid is now in the past, what still depends on it — the review candidates a
 * supersession creates. CORE produces these edges and consumes this walk.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Fail-open.
 *
 * CLI:
 *   node impact-trace.mjs <project> --of <unit-id>        downstream blast radius of a unit
 *   node impact-trace.mjs <project> --superseded-impact   review candidates from invalidated units
 */

import { realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEdges, isInvalidated } from './priority.mjs';
import { iterActiveUnits } from './check-units.mjs';

export const IMPACT_VERSION = '1.0.0';

/**
 * Build the affects-adjacency: affects[X] = set of units that depend on X (so a
 * change to X affects them). Reads both edge directions:
 *   - unit U has `depends-on` → T   ⟹  T affects U     (affects[T] += U)
 *   - unit U has `depended-on-by` → T ⟹  U affects T   (affects[U] += T)
 */
export function buildAffectsGraph(units) {
  const affects = new Map();
  const add = (k, v) => { if (!affects.has(k)) affects.set(k, new Set()); affects.get(k).add(v); };
  for (const u of units) {
    const uid = basename(u.path, '.md');
    for (const e of extractEdges(u)) {
      const target = String(e.target).replace(/\.md$/, '');
      if (e.type === 'depends-on') add(target, uid);
      else if (e.type === 'depended-on-by') add(uid, target);
    }
  }
  return affects;
}

/** Transitive set of units affected by a change to `startId` (excludes start). Cycle-safe. */
export function downstreamOf(startId, affects) {
  const seen = new Set();
  const queue = [...(affects.get(startId) || [])];
  while (queue.length) {
    const cur = queue.shift();
    if (seen.has(cur) || cur === startId) continue;
    seen.add(cur);
    for (const next of affects.get(cur) || []) if (!seen.has(next)) queue.push(next);
  }
  return [...seen].sort();
}

/**
 * For every unit invalidated as of `today` (bi-temporal t_invalid in the past),
 * the set of units that still depend on it — the review candidates a supersession
 * created. A non-empty downstream on an invalidated fact is the signal worth surfacing.
 */
export function traceSupersededImpact(units, today) {
  const affects = buildAffectsGraph(units);
  const out = [];
  for (const u of units) {
    if (!isInvalidated(u, today)) continue;
    const uid = basename(u.path, '.md');
    const downstream = downstreamOf(uid, affects);
    if (downstream.length) out.push({ invalidated: uid, t_invalid: String(u.fm.t_invalid).trim(), dependents: downstream });
  }
  return out;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const today = new Date();
  let units;
  try { units = iterActiveUnits(join(project, '_memories')); } catch { units = []; }

  if (argv.includes('--of')) {
    const id = opt('of');
    if (!id) { process.stdout.write('impact-trace: --of needs a unit id\n'); process.exit(1); }
    const down = downstreamOf(id, buildAffectsGraph(units));
    process.stdout.write(`impact-trace: ${down.length} unit(s) downstream of ${id} (affected if it changes)\n`);
    for (const d of down) process.stdout.write(`  → ${d}\n`);
    process.exit(0);
  }

  if (argv.includes('--superseded-impact')) {
    const traces = traceSupersededImpact(units, today);
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(traces, null, 2) + '\n'); process.exit(0); }
    if (!traces.length) { process.stdout.write('impact-trace: no invalidated units with live dependents — clean\n'); process.exit(0); }
    process.stdout.write(`impact-trace: ${traces.length} invalidated unit(s) with live dependents (review candidates):\n`);
    for (const t of traces) {
      process.stdout.write(`  ${t.invalidated} (invalid ${t.t_invalid}) ← still depended on by:\n`);
      for (const d of t.dependents) process.stdout.write(`      ${d}\n`);
    }
    process.exit(0);
  }

  process.stdout.write('impact-trace: --of <unit-id> | --superseded-impact [--json]\n');
  process.exit(1);
}
