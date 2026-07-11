/**
 * bm25.mjs — deterministic body-BM25 ranking + the rank-union combiner.
 *
 * Extracted from embed-index.mjs when DC-114 (2026-07-08, reversing DC-113)
 * ruled that CORE runs NO local models: the dense/ollama arm was deleted rather
 * than shipped dormant; this module keeps the model-free half the live retriever
 * actually uses. Query-time retrieval stays deterministic and dependency-free
 * (DC-80); the recall gap closes via write-time enrichment (DC-114/DC-115), not
 * a query-time model.
 *
 * Exports consumed by retrieve-context.mjs (the live title ∪ body-BM25 union)
 * and retrieval-harness.mjs (the offline Recall@K instrument):
 *   - loadActiveBodies(store)  — active unit ids + frontmatter-stripped bodies
 *   - bm25Rank(query, store)   — full ranked id list over unit bodies
 *   - interleaveRanked(...lists) — round-robin UNION combiner (not RRF, which
 *     measured as hurting)
 *
 * CLI: node bm25.mjs <storePath> rank "<query>" [--top N]
 *      node bm25.mjs --test
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSummaryIndex } from './generate-summary-index.mjs';
import { tokenize } from './retrieve-context.mjs';

/**
 * Read the active-unit index WITHOUT rewriting it. generateSummaryIndex() writes the
 * index file as a side effect; calling it from a read path (bm25Rank on every turn)
 * would rewrite the index each call and defeat the "retrieval stays cheap" invariant.
 * Read the cache when present; only generate when it's missing. The live retriever
 * regenerates-when-stale upstream, so the cache bm25 reads here is already fresh.
 */
function loadActiveIndex(root) {
  const indexPath = join(root, '_memories', '_lib', 'unit-summaries.json');
  if (existsSync(indexPath)) {
    try {
      const idx = JSON.parse(readFileSync(indexPath, 'utf8'));
      if (idx && Array.isArray(idx.units)) return idx;
    } catch { /* fall through to generate */ }
  }
  return generateSummaryIndex(root);
}

/** Active unit ids + bodies. Body = unit file minus YAML frontmatter. */
export function loadActiveBodies(store) {
  const root = resolve(store);
  const idx = loadActiveIndex(root); // active-only, retired excluded; read-cached (no write)
  const out = [];
  for (const u of idx.units) {
    const fpath = join(root, '_memories', `${u.id}.md`);
    if (!existsSync(fpath)) continue;
    let raw;
    try { raw = readFileSync(fpath, 'utf8'); } catch { continue; }
    const body = raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    // Prepend the H1/summary + topics so the ranking carries the title signal too.
    const topics = (u.topics || []).join(' ');
    out.push({ id: u.id, text: `${u.summary}\n${topics}\n${body}`.trim() });
  }
  return out;
}

/** BM25 over unit bodies. Full ranked id list. Deterministic, no dependency. */
export function bm25Rank(query, store, { k1 = 1.5, b = 0.75 } = {}) {
  const bodies = loadActiveBodies(store);
  const docs = bodies.map(d => ({ id: d.id, toks: tokenize(d.text) }));
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
  const scored = docs.map(d => {
    const tf = new Map();
    for (const t of d.toks) tf.set(t, (tf.get(t) || 0) + 1);
    const dl = d.toks.length;
    let s = 0;
    for (const t of qToks) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgdl));
    }
    return { id: d.id, score: s };
  });
  return scored
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(x => x.id);
}

/**
 * Round-robin interleave of N ranked id lists, dedup — so a unit high on ANY input
 * list surfaces early. This is the UNION combiner (not RRF, which measured as hurting).
 * Used by the live retriever (title + bm25-body).
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
    for (const id of bm25Rank(q, store).slice(0, top)) process.stdout.write(`${id}\n`);
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${sub}\n`);
  return 2;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
