/**
 * bm25.mjs — deterministic body-BM25 ranking + tokenizer + the rank-union combiner.
 *
 * CORE runs NO local models: this module is the model-free ranking the live
 * retriever actually uses. Query-time retrieval stays deterministic and dependency-free
 *; the recall gap closes via write-time enrichment, not
 * a query-time model.
 *
 * Bodies are loaded through the
 * recursive path-bearing index via loadFreshIndex() — nested units (observations/
 * <YYYY-MM>/…) are in the population, paths come from the index (never
 * reconstructed as `_memories/<id>.md`), and freshness is validated on EVERY
 * public call, so the standalone CLI/harness path cannot serve a retired
 * unit from a stale cache. tokenize/STOPWORDS live here (not retrieve-context)
 * so the import graph is acyclic: retrieve-context → bm25 → generate-summary-index.
 *
 * Cost honesty: bm25Rank re-reads unit bodies and rebuilds term statistics on
 * every call — the INDEX is cached; bodies and statistics are not. Measured
 *: warm p50 ~6ms at
 * 200 units, ~13ms at 400, ~63ms at 2,000. Acceptable at CORE/BBLens scale;
 * precompute document statistics into the index if a store outgrows that.
 *
 * Exports consumed by retrieve-context.mjs (the live retriever) and
 * retrieval-harness.mjs (the offline Recall@K instrument):
 *   - tokenize(text) / STOPWORDS      — the shared lexical tokenizer
 *   - loadActiveBodies(store)         — active unit ids + tiers + bodies (index paths)
 *   - bm25Scores(query, store)        — [{id, tier, score}] sorted desc (magnitudes)
 *   - bm25Rank(query, store)          — ranked id list (ids of bm25Scores)
 *
 * CLI: node bm25.mjs <storePath> rank "<query>" [--top N]
 *      node bm25.mjs --test
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFreshIndex, loadUnitBodies } from './generate-summary-index.mjs';

// Small, conventional English stopword set — enough to stop "the/on/of" from
// dominating overlap counts. Deliberately not exhaustive (no dependency, by design).
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

/**
 * Active unit ids + authority tiers + bodies. Body = unit file minus YAML frontmatter.
 * Files are resolved through the index's per-unit `path` — the only correct location
 * for nested units. Freshness is the loader's job (loadFreshIndex validates the
 * recursive source signature on every call).
 */
export function loadActiveBodies(store, preloadedIndex = null) {
  // A caller holding a request-scoped snapshot passes its index so every
  // reader in the request sees the same bytes; standalone callers still get a
  // sig-validated fresh load (active-only, retired excluded). The walk itself
  // has ONE owner: generate-summary-index.mjs loadUnitBodies.
  const idx = preloadedIndex || loadFreshIndex(resolve(store));
  return loadUnitBodies(store, idx);
}

/**
 * BM25 over unit bodies. Returns [{id, tier, score}] sorted desc — magnitude scores,
 * which retrieve-context's normalized union needs (rank positions can't express
 * "a neighbor of a STRONG hit beats a weak direct hit"). Deterministic, no dependency.
 *
 * Pass `snapshot` (a loadSnapshot(..., {captureBodies:true}) result) and the
 * ranking consumes ONLY captured bytes — zero live file reads after the id.
 */
export function bm25Scores(query, store, { k1 = 1.5, b = 0.75, preloadedIndex = null, snapshot = null } = {}) {
  const bodies = snapshot?.bodies || loadActiveBodies(store, snapshot?.index || preloadedIndex);
  return bm25DocumentScores(query, bodies, { k1, b });
}

/** Score an already-captured document arm without touching the filesystem. */
export function bm25DocumentScores(query, documents, { k1 = 1.5, b = 0.75 } = {}) {
  const docs = (documents || []).map(d => ({ id: d.id, tier: d.tier, toks: tokenize(d.text) }));
  const N = docs.length || 1;
  const df = new Map();
  let totalLen = 0;
  for (const d of docs) {
    totalLen += d.toks.length;
    for (const t of new Set(d.toks)) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgdl = totalLen / N || 1;
  const qToks = [...new Set(tokenize(query))];
  const idf = (t) => Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  return docs.map(d => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    const dl = d.toks.length;
    let s = 0;
    for (const t of qToks) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
    }
    return { id: d.id, tier: d.tier, score: s };
  })
    .filter(x => x.score > 0)
    .sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id));
}

/** BM25 ranked id list (ids of bm25Scores). Kept for arms/CLI that want ranks only. */
export function bm25Rank(query, store, opts = {}) {
  return bm25Scores(query, store, opts).map(x => x.id);
}

function selfTest() {
  // BM25: returns a ranked array when a store is supplied.
  const tmpStore = process.env.CORE_TEST_STORE;
  if (tmpStore) {
    const r = bm25Rank('embedding dependency', tmpStore);
    console.assert(Array.isArray(r), 'bm25Rank returns an array');
  }
  // Tokenizer: lowercases, splits, drops stopwords.
  console.assert(JSON.stringify(tokenize('The Alpha-Beta of it')) === JSON.stringify(['alpha', 'beta']), 'tokenize drops stopwords');
  console.log('bm25 self-test: OK');
}

function main(argv) {
  if (argv.includes('--test')) { selfTest(); return 0; }
  const store = argv[0];
  const sub = argv[1];
  if (!store || !sub) { process.stderr.write('usage: bm25.mjs <store> rank "<query>" [--top N]\n'); return 2; }
  if (sub === 'rank') {
    const q = argv[2] || '';
    const topIdx = argv.indexOf('--top');
    const top = topIdx >= 0 ? Number(argv[topIdx + 1]) || 10 : 10;
    for (const r of bm25Scores(q, store).slice(0, top)) process.stdout.write(`${r.id}\t${r.tier}\t${r.score.toFixed(3)}\n`);
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${sub}\n`);
  return 2;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
