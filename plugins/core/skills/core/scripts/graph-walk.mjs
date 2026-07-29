/**
 * Tier 2 edge-graph walk for CORE memory retrieval, per retrieval.md.
 *
 * Given a seed unit, walks typed edges up to a hop cap, applying the R·S proxy
 * from priority.mjs for branch pruning. Deterministic alternative to LLM-by-hand
 * edge traversal — by design, graph traversal logic ships in the plugin.
 *
 * The plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { walk } from './graph-walk.mjs';
 *   const candidates = walk('_memories/dc-67-no-mcp.md',
 *                           { memoriesDir: '_memories', hops: 2,
 *                             sessionTopics: ['memory-architecture'] });
 *
 * Validity-suppression: invalidated units (t_invalid in the past) are excluded
 * from the candidate set the same way retired units are, and the branch stops
 * there. Pass --include-invalid (or includeInvalidated:true) to walk cold history.
 *
 * CLI:
 *   node graph-walk.mjs <seed-unit-path> [--memories <dir>] [--hops 2]
 *                       [--budget 15] [--intent t1,t2] [--prune 0.3]
 *                       [--include-invalid] [--include-observations]
 *                       [--format json|text]
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadUnit, scoreProxyRS, extractEdges, parseIsoDate, isInvalidated,
  SCORE_PRUNE_THRESHOLD,
} from './priority.mjs';
import { isActiveStatus } from './unit-vocab.mjs';
import { regularFileWithin } from './trusted-home.mjs';

/**
 * Every hop target is project-authored frontmatter, so a candidate counts only
 * when its REAL path is a regular file beneath realpath(memoriesDir). An
 * absolute target, a `..` spelling, and a link out of the store all resolve to
 * nothing rather than pulling foreign markdown into agent context.
 */
const containedUnit = (memoriesDir, candidate) => regularFileWithin(memoriesDir, candidate);

function resolveTarget(target, memoriesDir, includeObservations = false, includeInvalidated = false) {
  const t = target.trim();
  const stem = t.replace(/\.md$/, '');
  const c1 = containedUnit(memoriesDir, join(memoriesDir, `${stem}.md`));
  if (c1) return c1;
  const c2 = containedUnit(memoriesDir, join(memoriesDir, t));
  if (c2) return c2;
  // Archive is out of scope for a default walk:
  // an archived unit can carry status:active with no t_invalid, so neither
  // downstream suppression check (isInvalidated / isActiveStatus) would ever
  // catch it -- resolving the path at all is what has to be gated, not just
  // whether it later surfaces. Cold-history walks (includeInvalidated:true)
  // still need it, same as the inverse-edge archive scan below.
  if (includeInvalidated) {
    const c3 = containedUnit(memoriesDir, join(memoriesDir, 'archive', `${stem}.md`));
    if (c3) return c3;
  }
  if (includeObservations) {
    // Without this branch, edges pointing into observations/<YYYY-MM>/ resolve to null.
    const obsRoot = join(memoriesDir, 'observations');
    const flat = containedUnit(memoriesDir, join(obsRoot, `${stem}.md`));
    if (flat) return flat;
    let months;
    try { months = readdirSync(obsRoot, { withFileTypes: true }); } catch { months = []; }
    for (const m of months) {
      if (!m.isDirectory()) continue;
      const c = containedUnit(memoriesDir, join(obsRoot, m.name, `${stem}.md`));
      if (c) return c;
    }
  }
  return null;
}

// Build an inverse edge index: target-stem -> [{sourcePath, sourceId, edgeType}].
// Top-level scan by default; includeObservations also scans observations/ and
// its month subdirs so observation units can appear as inbound neighbors.
export function buildInverseEdgeIndex(memoriesDir, { includeObservations = false, includeInvalidated = false } = {}) {
  const inverse = new Map();
  const scanDir = (dir) => {
    let files;
    try { files = readdirSync(dir); } catch { return; }
    for (const fname of files) {
      if (!fname.endsWith('.md')) continue;
      if (fname.startsWith('_') || fname.startsWith('INDEX')) continue;
      const filePath = containedUnit(memoriesDir, join(dir, fname));
      if (!filePath) continue; // a link out of the store is not an indexable unit
      let unit;
      try { unit = loadUnit(filePath); } catch { continue; }
      for (const e of extractEdges(unit)) {
        const stem = String(e.target).trim().replace(/\.md$/, '');
        if (!inverse.has(stem)) inverse.set(stem, []);
        inverse.get(stem).push({ sourcePath: filePath, sourceId: unit.id, edgeType: e.type });
      }
    }
  };
  scanDir(memoriesDir);
  if (includeObservations) {
    const obsRoot = join(memoriesDir, 'observations');
    scanDir(obsRoot);
    let months;
    try { months = readdirSync(obsRoot, { withFileTypes: true }); } catch { months = []; }
    for (const m of months) if (m.isDirectory()) scanDir(join(obsRoot, m.name));
  }
  // Cold-history walks (--include-invalid) need an archived unit's OWN
  // outgoing edges indexed too, so traversal can continue FROM a retired
  // unit that got physically relocated -- not just resolve edges pointing
  // AT it (resolveTarget's job). Default walks never scan archive/.
  if (includeInvalidated) scanDir(join(memoriesDir, 'archive'));
  return inverse;
}

function inverseLookup(inverse, unitId, unitPath) {
  // Match by id first, then by filename stem (so units with no `id:` frontmatter
  // or with id-vs-filename mismatch still resolve).
  const out = [];
  if (unitId && inverse.has(unitId)) out.push(...inverse.get(unitId));
  const stem = basename(String(unitPath)).replace(/\.md$/, '');
  if (stem && stem !== unitId && inverse.has(stem)) out.push(...inverse.get(stem));
  return out;
}

export function walk(seedPath, {
  memoriesDir = '_memories',
  hops = 2,
  budget = 15,
  sessionTopics: _sessionTopics = [],
  pruneThreshold = SCORE_PRUNE_THRESHOLD,
  today = null,
  includeInvalidated = false,
  includeObservations = false,
  stats = null,
  now = null,
} = {}) {
  // UTC calendar fields, not local ones: the validity policy is UTC, and local
  // getters shift the day by one either side of midnight in a non-UTC zone.
  const n = now || new Date();
  const t = today || new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  const mDir = resolve(memoriesDir);
  const seed = loadUnit(seedPath);
  // Canonical, so the seed matches the canonical paths every hop resolves to and
  // is never re-emitted as its own neighbor.
  const seedResolved = containedUnit(mDir, seedPath) || resolve(String(seedPath));
  const inverse = buildInverseEdgeIndex(mDir, { includeObservations, includeInvalidated });

  // Validity-suppression: a unit whose t_invalid is in the past is excluded from
  // the "currently valid" candidate set — the same rule that suppresses retired
  // units — and the walk does not traverse through it (a superseded fact's
  // successor is reachable directly via the supersedes edge). Cold history stays
  // reachable with includeInvalidated:true (the --as-of / explicit-history case).
  let suppressedInvalidated = 0;
  let suppressedRetired = 0;

  const visited = new Set([seedResolved]);
  const queue = []; // [hop, path, edgeType, sourceId, direction]

  for (const e of extractEdges(seed)) {
    const tp = resolveTarget(e.target, mDir, includeObservations, includeInvalidated);
    if (tp && !visited.has(resolve(tp))) {
      queue.push([1, tp, e.type, seed.id, 'outbound']);
    }
  }
  for (const src of inverseLookup(inverse, seed.id, seedResolved)) {
    if (!visited.has(resolve(src.sourcePath))) {
      queue.push([1, src.sourcePath, src.edgeType, seed.id, 'inbound']);
    }
  }

  const results = [];

  while (queue.length && results.length < budget) {
    const [hop, path, edgeType, sourceId, direction] = queue.shift();
    const resolved = resolve(path);
    if (visited.has(resolved)) continue;
    visited.add(resolved);

    let unit;
    try { unit = loadUnit(path); } catch { continue; }

    // Suppress invalidated units beside the R·S prune — and stop the branch, so
    // we don't traverse a stale fact's neighbors into the valid candidate set.
    if (!includeInvalidated && isInvalidated(unit, t)) { suppressedInvalidated++; continue; }

    // Suppress terminal-status (retired/archived/superseded) units the same way —
    // a user-deleted fact must not surface, and it isn't a gateway (its live
    // successor is reachable directly via the supersedes edge). Retiring bumps
    // `updated`, so without this a fresh retired unit clears the R·S prune and
    // ranks first — the anti-resurrection rule silently failed here before.
    if (!includeInvalidated && !isActiveStatus(unit.fm || {})) { suppressedRetired++; continue; }

    const rs = scoreProxyRS(unit, t);
    if (rs < pruneThreshold) continue;

    results.push({
      unit_id: unit.id,
      path,
      hop,
      rs_score: rs,
      via_edge_type: edgeType,
      via_source: sourceId,
      edge_direction: direction,
    });

    if (hop < hops) {
      for (const e of extractEdges(unit)) {
        const tp = resolveTarget(e.target, mDir, includeObservations, includeInvalidated);
        if (tp && !visited.has(resolve(tp))) {
          queue.push([hop + 1, tp, e.type, unit.id, 'outbound']);
        }
      }
      for (const src of inverseLookup(inverse, unit.id, resolved)) {
        if (!visited.has(resolve(src.sourcePath))) {
          queue.push([hop + 1, src.sourcePath, src.edgeType, unit.id, 'inbound']);
        }
      }
    }
  }

  results.sort((a, b) => a.hop - b.hop || b.rs_score - a.rs_score);
  if (stats) { stats.suppressed_invalidated = suppressedInvalidated; stats.suppressed_retired = suppressedRetired; }
  return results;
}

export function main(argv) {
  let seedArg = null;
  let memoriesArg = null;
  let hops = 2;
  let budget = 15;
  let intentStr = '';
  let prune = SCORE_PRUNE_THRESHOLD;
  let todayArg = null;
  let format = 'json';
  let includeInvalidated = false;
  let includeObservations = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memories') { memoriesArg = argv[++i]; }
    else if (a === '--hops') { hops = parseInt(argv[++i], 10); }
    else if (a === '--budget') { budget = parseInt(argv[++i], 10); }
    else if (a === '--intent') { intentStr = argv[++i]; }
    else if (a === '--prune') { prune = parseFloat(argv[++i]); }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (a === '--format') { format = argv[++i]; }
    else if (a === '--include-invalid') { includeInvalidated = true; }
    else if (a === '--include-observations') { includeObservations = true; }
    else if (!a.startsWith('--')) { seedArg = a; }
  }

  if (!seedArg) { process.stderr.write('usage: node graph-walk.mjs <seed-unit-path> [options]\n'); return 2; }

  const seedPath = resolve(seedArg);
  if (!existsSync(seedPath)) { process.stderr.write(`error: seed unit not found: ${seedPath}\n`); return 2; }

  const memoriesDir = memoriesArg ? resolve(memoriesArg) : dirname(seedPath);
  const today = todayArg ? (parseIsoDate(todayArg) || new Date()) : null;
  const sessionTopics = intentStr ? intentStr.split(',').map(s => s.trim()).filter(Boolean) : [];

  const stats = {};
  const candidates = walk(seedPath, { memoriesDir, hops, budget, sessionTopics, pruneThreshold: prune, today, includeInvalidated, includeObservations, stats });

  if (format === 'json') {
    const out = candidates.map(c => ({
      unit_id: c.unit_id,
      path: String(c.path),
      hop: c.hop,
      rs_score: Math.round(c.rs_score * 10000) / 10000,
      via_edge_type: c.via_edge_type,
      via_source: c.via_source,
      edge_direction: c.edge_direction,
    }));
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`Walk from: ${basename(seedPath)}  hops=${hops}  prune=${prune}`);
    console.log(`Date: ${(today || new Date()).toISOString().slice(0, 10)}  memories: ${memoriesDir}`);
    console.log('-'.repeat(72));
    for (const c of candidates) {
      console.log(`  hop=${c.hop}  rs=${c.rs_score.toFixed(3)}  [${c.via_edge_type}]  ${c.unit_id}  (via ${c.via_source})`);
    }
    console.log(`\n${candidates.length} candidates (budget=${budget})`);
    if (stats.suppressed_invalidated) {
      console.log(`${stats.suppressed_invalidated} invalidated unit(s) suppressed (use --include-invalid to include cold history)`);
    }
  }
  return 0;
}

// CLI entry guard. Set CORE_DEBUG_CLI_ENTRY=1 to log both strings if invocation
// silently no-ops (path-normalization, symlinks, OneDrive virtualization, etc.).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
