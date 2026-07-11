/**
 * bm25.mjs — deterministic body-BM25 ranking + tokenizer + the rank-union combiner.
 *
 * Extracted from embed-index.mjs when DC-114 (2026-07-08, reversing DC-113)
 * ruled that CORE runs NO local models: the dense/ollama arm was deleted rather
 * than shipped dormant; this module keeps the model-free half the live retriever
 * actually uses. Query-time retrieval stays deterministic and dependency-free
 * (DC-80); the recall gap closes via write-time enrichment (DC-114/DC-115), not
 * a query-time model.
 *
 * v3.11 remediation (Hale 2026-07-11 §1/§4): bodies are loaded through the
 * recursive path-bearing index via loadFreshIndex() — nested units (observations/
 * <YYYY-MM>/…) are in the population, paths come from the index (never
 * reconstructed as `_memories/<id>.md`), and freshness is validated on EVERY
 * public call, so the standalone CLI/harness path can no longer serve a retired
 * unit from a stale cache. tokenize/STOPWORDS live here (not retrieve-context)
 * so the import graph is acyclic: retrieve-context → bm25 → generate-summary-index.
 *
 * Cost honesty: bm25Rank re-reads unit bodies and rebuilds term statistics on
 * every call — the INDEX is cached; bodies and statistics are not. Measured
 * (Hale, 2026-07-11, M-series Mac, synthetic 180-token bodies): warm p50 ~6ms at
 * 200 units, ~13ms at 400, ~63ms at 2,000. Acceptable at CORE/BBLens scale;
 * precompute document statistics into the index if a store outgrows that.
 *
 * Exports consumed by retrieve-context.mjs (the live retriever) and
 * retrieval-harness.mjs (the offline Recall@K instrument):
 *   - tokenize(text) / STOPWORDS      — the shared lexical tokenizer
 *   - loadActiveBodies(store)         — active unit ids + tiers + bodies (index paths)
 *   - bm25Scores(query, store)        — [{id, tier, score}] sorted desc (magnitudes)
 *   - bm25Rank(query, store)          — ranked id list (ids of bm25Scores)
 *   - interleaveRanked(...lists)      — round-robin UNION combiner (not RRF,
 *     which measured as hurting)
 *
 * CLI: node bm25.mjs <storePath> rank "<query>" [--top N]
 *      node bm25.mjs --test
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFreshIndex } from './generate-summary-index.mjs';

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

/**
 * Active unit ids + authority tiers + bodies. Body = unit file minus YAML frontmatter.
 * Files are resolved through the index's per-unit `path` — the only correct location
 * for nested units. Freshness is the loader's job (loadFreshIndex validates the
 * recursive source signature on every call).
 */
export function loadActiveBodies(store) {
  const root = resolve(store);
  const idx = loadFreshIndex(root); // active-only, retired excluded, sig-validated
  const out = [];
  for (const u of idx.units) {
    const fpath = join(root, '_memories', ...(u.path ? u.path.split('/') : [`${u.id}.md`]));
    if (!existsSync(fpath)) continue;
    let raw;
    try { raw = readFileSync(fpath, 'utf8'); } catch { continue; }
    const body = raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    // Prepend the H1/summary + topics so the ranking carries the title signal too.
    const topics = (u.topics || []).join(' ');
    out.push({ id: u.id, tier: u.tier || 'canonical', text: `${u.summary}\n${topics}\n${body}`.trim() });
  }
  return out;
}

/**
 * BM25 over unit bodies. Returns [{id, tier, score}] sorted desc — magnitude scores,
 * which retrieve-context's normalized union needs (rank positions can't express
 * "a neighbor of a STRONG hit beats a weak direct hit"). Deterministic, no dependency.
 */
export function bm25Scores(query, store, { k1 = 1.5, b = 0.75 } = {}) {
  const bodies = loadActiveBodies(store);
  const docs = bodies.map(d => ({ id: d.id, tier: d.tier, toks: tokenize(d.text) }));
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

/**
 * Round-robin interleave of N ranked id lists, dedup — so a unit high on ANY input
 * list surfaces early. This is the UNION combiner (not RRF, which measured as hurting).
 * Rank-only view; the live retriever ranks by normalized magnitudes (retrieve-context).
 */
export function interleaveRanked(...lists) {
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const id = list[i];
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

function selfTest() {
  // BM25: returns a ranked array when a store is supplied.
  const tmpStore = process.env.CORE_TEST_STORE;
  if (tmpStore) {
    const r = bm25Rank('embedding dependency', tmpStore);
    console.assert(Array.isArray(r), 'bm25Rank returns an array');
  }
  // Union combiner: round-robin, dedup, order-stable.
  const u = interleaveRanked(['a', 'b', 'c'], ['b', 'd']);
  console.assert(JSON.stringify(u) === JSON.stringify(['a', 'b', 'd', 'c']), 'interleaveRanked round-robins and dedups');
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
