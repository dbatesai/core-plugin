/**
 * Tier 2 edge-graph walk for CORE memory retrieval, per DC-68/retrieval.md.
 *
 * Given a seed unit, walks typed edges up to a hop cap, applying the R·S proxy
 * from priority.mjs for branch pruning. Deterministic alternative to LLM-by-hand
 * edge traversal — per DC-77, graph traversal logic ships in the plugin.
 *
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { walk } from './graph-walk.mjs';
 *   const candidates = walk('_memories/dc-67-no-mcp.md',
 *                           { memoriesDir: '_memories', hops: 2,
 *                             sessionTopics: ['memory-architecture'] });
 *
 * CLI:
 *   node graph-walk.mjs <seed-unit-path> [--memories <dir>] [--hops 2]
 *                       [--budget 15] [--intent t1,t2] [--prune 0.3]
 *                       [--format json|text]
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadUnit, scoreProxyRS, extractEdges, parseIsoDate,
  SCORE_PRUNE_THRESHOLD,
} from './priority.mjs';

function resolveTarget(target, memoriesDir) {
  const t = target.trim();
  const direct = resolve(t);
  if (existsSync(direct)) return direct;
  const stem = t.replace(/\.md$/, '');
  const c1 = join(memoriesDir, `${stem}.md`);
  if (existsSync(c1)) return c1;
  const c2 = join(memoriesDir, t);
  if (existsSync(c2)) return c2;
  return null;
}

// Build an inverse edge index: target-stem -> [{sourcePath, sourceId, edgeType}]
// so walk() can surface inbound neighbors per Codex probe Round 2 finding.
// Scans top-level *.md files in memoriesDir (skips _prefixed and INDEX*).
export function buildInverseEdgeIndex(memoriesDir) {
  const inverse = new Map();
  let files;
  try { files = readdirSync(memoriesDir); } catch { return inverse; }
  for (const fname of files) {
    if (!fname.endsWith('.md')) continue;
    if (fname.startsWith('_') || fname.startsWith('INDEX')) continue;
    const filePath = join(memoriesDir, fname);
    let unit;
    try { unit = loadUnit(filePath); } catch { continue; }
    for (const e of extractEdges(unit)) {
      const stem = String(e.target).trim().replace(/\.md$/, '');
      if (!inverse.has(stem)) inverse.set(stem, []);
      inverse.get(stem).push({
        sourcePath: filePath,
        sourceId: unit.id,
        edgeType: e.type,
      });
    }
  }
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
  sessionTopics = [],
  pruneThreshold = SCORE_PRUNE_THRESHOLD,
  today = null,
} = {}) {
  const n = new Date();
  const t = today || new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
  const mDir = resolve(memoriesDir);
  const seed = loadUnit(seedPath);
  const seedResolved = resolve(String(seedPath));
  const inverse = buildInverseEdgeIndex(mDir);

  const visited = new Set([seedResolved]);
  const queue = []; // [hop, path, edgeType, sourceId, direction]

  for (const e of extractEdges(seed)) {
    const tp = resolveTarget(e.target, mDir);
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
        const tp = resolveTarget(e.target, mDir);
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

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memories') { memoriesArg = argv[++i]; }
    else if (a === '--hops') { hops = parseInt(argv[++i], 10); }
    else if (a === '--budget') { budget = parseInt(argv[++i], 10); }
    else if (a === '--intent') { intentStr = argv[++i]; }
    else if (a === '--prune') { prune = parseFloat(argv[++i]); }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (a === '--format') { format = argv[++i]; }
    else if (!a.startsWith('--')) { seedArg = a; }
  }

  if (!seedArg) { process.stderr.write('usage: node graph-walk.mjs <seed-unit-path> [options]\n'); return 2; }

  const seedPath = resolve(seedArg);
  if (!existsSync(seedPath)) { process.stderr.write(`error: seed unit not found: ${seedPath}\n`); return 2; }

  const memoriesDir = memoriesArg ? resolve(memoriesArg) : dirname(seedPath);
  const today = todayArg ? (parseIsoDate(todayArg) || new Date()) : null;
  const sessionTopics = intentStr ? intentStr.split(',').map(s => s.trim()).filter(Boolean) : [];

  const candidates = walk(seedPath, { memoriesDir, hops, budget, sessionTopics, pruneThreshold: prune, today });

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
  }
  return 0;
}

// CLI entry guard. Set CORE_DEBUG_CLI_ENTRY=1 to log both strings if invocation
// silently no-ops (path-normalization, symlinks, OneDrive virtualization, etc.).
const _cliEntryArgv1 = process.argv[1];
const _cliEntrySelf = fileURLToPath(import.meta.url);
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
