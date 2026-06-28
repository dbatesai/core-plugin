/**
 * retrieve-context.mjs — deterministic per-turn retrieval (DC-94a).
 *
 * Given a query and a store, return the top-N most relevant active units as
 * {id, summary, score}. Pure lexical + one-hop edge expansion — no LLM call, so it
 * is cheap enough to run on every turn from a shell hook (Task 9). This is the
 * "retrieve the right thing" half of the north-star: the literal/lexical tier.
 * Abstract matches (value→instance) that lexical can't bridge are the Task 10
 * reasoning prototype's job; the obligation-3 ladder measures the gap between them.
 *
 * Scoring: tokenize the query and each unit's title+topics+summary, count term
 * overlap weighted (title 3x, topics 2x, summary 1x), sort desc, take topN, then
 * one-hop edge expansion — pull the edge-targets of the top lexical hits in at a
 * 0.5x discount (they're context-adjacent even when they don't lexically match).
 *
 * Reads the compact index from generate-summary-index.mjs (_lib/unit-summaries.json),
 * generating it if missing. Edge data isn't in the index, so edge expansion reads the
 * top-hit unit files directly (bounded to the top lexical hits — cheap).
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node retrieve-context.mjs <storePath> "<query>" [--top N]
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSummaryIndex, computeSourceSignature } from './generate-summary-index.mjs';
import { loadUnit, extractEdges } from './priority.mjs';

// Small, conventional English stopword set — enough to stop "the/on/of" from
// dominating overlap counts. Deliberately not exhaustive (no dependency, DC-80).
export const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this', 'that', 'these', 'those',
  'as', 'by', 'from', 'into', 'about', 'our', 'we', 'i', 'you', 'he', 'she', 'they',
  'what', 's', 'whats',
]);

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t && !STOPWORDS.has(t));
}

function scoreUnit(queryTokens, unit) {
  // unit.summary doubles as the title proxy (it's the H1). topics weighted between.
  const titleToks = new Set(tokenize(unit.summary));
  const topicToks = new Set((unit.topics || []).flatMap(t => tokenize(t)));
  let score = 0;
  for (const qt of queryTokens) {
    if (titleToks.has(qt)) score += 3;       // title/H1 overlap weighted highest
    if (topicToks.has(qt)) score += 2;       // topic overlap
  }
  return score;
}

/**
 * @returns {Array<{id, summary, score}>}
 */
export function retrieveContext(query, storePath, { topN = 3 } = {}) {
  const root = resolve(storePath);
  const indexPath = join(root, '_memories', '_lib', 'unit-summaries.json');
  let index;
  if (existsSync(indexPath)) {
    try { index = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { index = null; }
  }
  // Regenerate when missing, corrupt, or STALE. Staleness = the source signature no
  // longer matches the store's current units (added / deleted / edited-in-place,
  // including a retire). Reusing a stale index lingered retired/deleted units in the
  // retrieval surface — an anti-resurrection hole (DC-94b R1). A pre-signature index
  // (no source_sig) is treated as stale so it gets re-stamped once.
  if (!index || !Array.isArray(index.units) || index.source_sig === undefined ||
      index.source_sig !== computeSourceSignature(root)) {
    index = generateSummaryIndex(root);
  }

  const units = index.units;
  const byId = new Map(units.map(u => [u.id, u]));
  const queryTokens = tokenize(query);

  // Lexical tier.
  const scored = units
    .map(u => ({ id: u.id, summary: u.summary, score: scoreUnit(queryTokens, u) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const top = scored.slice(0, topN);

  // One-hop edge expansion from the top lexical hits, at a 0.5x discount. Edges
  // live in the unit files, not the index — read only the top hits (bounded, cheap).
  const seen = new Set(top.map(t => t.id));
  const expanded = [];
  for (const hit of top) {
    const unitPath = join(root, '_memories', `${hit.id}.md`);
    if (!existsSync(unitPath)) continue;
    let edges;
    try { edges = extractEdges(loadUnit(unitPath)); } catch { continue; }
    for (const e of edges) {
      const targetId = String(e.target).replace(/\.md$/, '');
      if (seen.has(targetId)) continue;
      const target = byId.get(targetId); // only active units are in the index
      if (!target) continue;             // retired/missing target → skip (anti-resurrection)
      seen.add(targetId);
      expanded.push({ id: target.id, summary: target.summary, score: hit.score * 0.5 });
    }
  }

  return [...top, ...expanded].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topN);
}

function main(argv) {
  const args = argv.filter(a => a !== '--top');
  const topIdx = argv.indexOf('--top');
  const topN = topIdx >= 0 ? Number(argv[topIdx + 1]) || 3 : 3;
  const storePath = args[0];
  const query = args[1] || '';
  if (!storePath) { process.stderr.write('usage: retrieve-context.mjs <storePath> "<query>" [--top N]\n'); return 2; }
  const hits = retrieveContext(query, storePath, { topN });
  for (const h of hits) process.stdout.write(`[${h.score.toFixed(1)}] ${h.id} — ${h.summary}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
