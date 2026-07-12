/**
 * retrieve-context.mjs — deterministic per-turn retrieval (DC-94a; v3.11 product path).
 *
 * Given a query and a store, return the top-N most relevant active units as
 * {id, summary, tier, score}. Model-free (DC-114) and cheap enough to run on every
 * turn from a shell hook. This is the "retrieve the right thing" half of the
 * north-star: the literal/lexical tier. Abstract matches (value→instance) that
 * lexical can't bridge are the reasoning tier's job; the obligation-3 ladder
 * measures the gap between them.
 *
 * Ranking (productRankedScores — THE product function; the measurement harness's
 * `live` arm calls the same code): two magnitude arms — title/topics term overlap
 * (title 3x, topics 2x) and body BM25 (bm25.mjs) — each normalized by its own max,
 * combined per unit as the max of the two. Then one-hop edge expansion from the
 * top hits at a 0.5x discount on the parent's normalized score, competing in the
 * final sort (a neighbor of a strong hit can beat a weak direct hit — DC-94a).
 *
 * Reads the recursive path-bearing index via loadFreshIndex (freshness validated
 * every call). Edge data isn't in the index, so expansion reads the top-hit unit
 * files directly, resolved through the index's per-unit path (nested units included).
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node retrieve-context.mjs <storePath> "<query>" [--top N]
 */

import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFreshIndex } from './generate-summary-index.mjs';
import { loadUnit, extractEdges } from './priority.mjs';
import { bm25Scores, tokenize, STOPWORDS } from './bm25.mjs';

// The tokenizer moved to bm25.mjs (v3.11 remediation — breaks the retrieve-context ⇄
// bm25 import cycle Hale flagged). Re-exported here so existing importers keep working.
export { tokenize, STOPWORDS };

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
 * Full lexical ranking — every active unit that scores > 0, ranked, ids only.
 * Same scorer as retrieveContext (title 3x + topics 2x) but WITHOUT the topN slice
 * or edge expansion, so a caller (the Recall@K harness) can slice at any K. This is
 * the shipped lexical arm's read path, exposed for offline measurement.
 * @returns {string[]} ranked unit ids
 */
export function lexicalRankedIds(query, storePath) {
  const root = resolve(storePath);
  if (!existsSync(join(root, '_memories'))) return [];
  const index = loadFreshIndex(root);
  const queryTokens = tokenize(query);
  return index.units
    .map(u => ({ id: u.id, score: scoreUnit(queryTokens, u) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(s => s.id);
}

/**
 * productRankedScores — THE product ranking. One function, called by the live
 * retriever (retrieveContext), the per-turn hook (through retrieveContext), and the
 * measurement harness's `live` arm — so a harness number describes what actually
 * ships (Gate-0 product/harness identity, Hale 2026-07-11 §2).
 *
 * Scoring: two lexical arms produce MAGNITUDE scores — the title/topics overlap
 * scorer and body BM25. Each arm is normalized by its own maximum (scale-free), and
 * a unit's combined score is the max of its normalized arm scores. Magnitudes are
 * preserved (not flattened to rank positions) because the one-hop edge discount
 * needs ratios: "a neighbor of a STRONG hit beats a WEAK direct hit" is only
 * expressible when 0.5 × parent-strength can exceed another unit's strength — the
 * v3.10 semantic the synthetic rank scores broke (Hale 2026-07-11 §3).
 *
 * @returns {Array<{id, tier, score}>} every unit scoring > 0 on either arm, sorted
 *   desc by combined normalized score (ties by id), score ∈ (0, 1].
 */
export function productRankedScores(query, storePath, preloadedIndex = null) {
  const root = resolve(storePath);
  if (!existsSync(join(root, '_memories'))) return [];
  const index = preloadedIndex || loadFreshIndex(root);
  const queryTokens = tokenize(query);

  const combined = new Map(); // id -> {id, tier, score}
  const titleScored = index.units
    .map(u => ({ id: u.id, tier: u.tier || 'canonical', score: scoreUnit(queryTokens, u) }))
    .filter(s => s.score > 0);
  const titleMax = Math.max(0, ...titleScored.map(s => s.score));
  for (const s of titleScored) {
    combined.set(s.id, { id: s.id, tier: s.tier, score: s.score / titleMax });
  }

  let bodyScored = [];
  try {
    bodyScored = bm25Scores(query, root);
    _lastBm25Error = null;
  } catch (err) {
    // Fail-open (title-only) but never silent: the degradation is visible on stderr
    // (hook logs) and via storeHealth() — a product that quietly halves its recall
    // is a health incident, not a fallback (Hale re-review §6).
    _lastBm25Error = String(err && err.message || err);
    process.stderr.write(`retrieve-context: body-BM25 arm failed (${_lastBm25Error}) — degraded to title-only for this query\n`);
  }
  const bodyMax = Math.max(0, ...bodyScored.map(s => s.score));
  for (const s of bodyScored) {
    const norm = s.score / bodyMax;
    const prev = combined.get(s.id);
    if (!prev || norm > prev.score) combined.set(s.id, { id: s.id, tier: s.tier, score: norm });
  }

  return [...combined.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Ranked id list of productRankedScores — the ranking-substrate arm for offline measurement. */
export function productRankedIds(query, storePath) {
  return productRankedScores(query, storePath).map(s => s.id);
}

let _lastBm25Error = null;

/**
 * storeHealth — cheap, non-mutating health read for hook/UI surfaces. Reads the
 * CACHED index only (no regeneration; call after a retrieval so it's fresh) and
 * reports the degraded state a silent fallback would otherwise hide: duplicate-id
 * conflicts (an observation shadowing canonical truth) and the last BM25 failure.
 */
export function storeHealth(storePath) {
  const root = resolve(storePath);
  let degraded = false, conflicts = [];
  try {
    const raw = JSON.parse(readFileSync(join(root, '_memories', '_lib', 'unit-summaries.json'), 'utf8'));
    degraded = !!raw.degraded;
    conflicts = raw.duplicate_conflicts || [];
  } catch { /* no cache yet — nothing to report */ }
  return { degraded, duplicate_conflicts: conflicts, bm25_error: _lastBm25Error };
}

/**
 * @returns {Array<{id, summary, score}>}
 */
export function retrieveContext(query, storePath, { topN = 3 } = {}) {
  const root = resolve(storePath);
  // The per-turn hook runs in every directory the user opens. If there's no CORE
  // store here, retrieve nothing and — critically — write nothing: generating the
  // index would mkdir -p _memories/_lib and litter unit-summaries.json into an
  // unrelated repo. No store, no retrieval, no side effect.
  if (!existsSync(join(root, '_memories'))) return [];
  // loadFreshIndex validates the recursive source signature on every call —
  // missing, corrupt, or stale (added/deleted/edited/retired unit, top-level OR
  // nested) regenerates. A stale index lingering retired units in the retrieval
  // surface is the anti-resurrection hole (DC-94b R1).
  const index = loadFreshIndex(root);
  const byId = new Map(index.units.map(u => [u.id, u]));

  // The product ranking: title/topics ∪ body-BM25, magnitudes preserved via
  // per-arm max-normalization (see productRankedScores). Measured 2026-07-07,
  // dev-set: the body arm lifts recall@10 ~0.68→0.86 on CORE and rescues the
  // abstract/value rung (DC-113 Tier-A T3, model-free per DC-114).
  const scored = productRankedScores(query, root, index);

  const top = scored.slice(0, topN).map(s => ({
    id: s.id, summary: byId.get(s.id)?.summary, tier: s.tier, score: s.score,
  }));

  // One-hop edge expansion from the top hits, at a 0.5x discount on the parent's
  // normalized score — so a neighbor of a strong hit COMPETES with (and can beat)
  // weak direct hits in the final ranking, the DC-94a semantic the synthetic rank
  // scores of the first union rewrite broke (regression caught by Hale 2026-07-11;
  // edge-bearing fixture now guards it). Edges live in the unit files, not the
  // index — read only the top hits (bounded, cheap), resolved via the index PATH
  // (never `_memories/<id>.md`, which is wrong for nested units).
  const seen = new Set(top.map(t => t.id));
  const expanded = [];
  for (const hit of top) {
    const rel = byId.get(hit.id)?.path;
    const unitPath = join(root, '_memories', ...(rel ? rel.split('/') : [`${hit.id}.md`]));
    if (!existsSync(unitPath)) continue;
    let edges;
    try { edges = extractEdges(loadUnit(unitPath)); } catch { continue; }
    for (const e of edges) {
      const targetId = String(e.target).replace(/\.md$/, '');
      if (seen.has(targetId)) continue;
      const target = byId.get(targetId); // only active units are in the index
      if (!target) continue;             // retired/missing target → skip (anti-resurrection)
      seen.add(targetId);
      expanded.push({ id: target.id, summary: target.summary, tier: target.tier, score: hit.score * 0.5 });
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
