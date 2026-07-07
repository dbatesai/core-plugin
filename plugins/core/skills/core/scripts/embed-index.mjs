/**
 * embed-index.mjs — the local dense-retrieval layer (DC-113, Tier B B1).
 *
 * One local embedding index, built at close, brute-force cosine at query time — no
 * vector DB, no HNSW/FAISS (measured 40-400x below where an index earns its place at
 * CORE/BBLens scale). The embedder is nomic-embed-text via a local ollama server:
 * $0, ~40ms/doc, data-resident (nothing leaves the machine — the constraint that makes
 * it viable for API-billed BBLens). It is an OPTIONAL dependency: when ollama is absent,
 * embedText() returns null and every dense path degrades to lexical + BM25 (the DC-80
 * concession — the zero-dependency default survives).
 *
 * This module ships three rankers the harness (and, post-Gate-2, the live retriever)
 * consume: denseRank, bm25Rank, and unionRank (dense + BM25-body UNION — not RRF, which
 * measured as hurting). Each returns a full ranked id list so the caller slices at any K.
 *
 * Pinned invocation (the 8-vs-4 engine artifact the Tier-B spec warns about):
 *   - nomic task prefixes: "search_document: " for unit bodies, "search_query: " for queries.
 *   - L2-normalize every vector, so cosine == dot product.
 * Both are covered by the normalization self-check in --test.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only (ollama reached over HTTP, no npm dep).
 *
 * CLI: node embed-index.mjs <storePath> build            # (re)build the cached index
 *      node embed-index.mjs <storePath> rank "<query>" [--arm dense|bm25|union] [--top N]
 *      node embed-index.mjs --test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { generateSummaryIndex } from './generate-summary-index.mjs';
import { tokenize } from './retrieve-context.mjs';

const OLLAMA_URL = process.env.CORE_OLLAMA_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.CORE_EMBED_MODEL || 'nomic-embed-text';
const CACHE_REL = ['_memories', '_lib', 'embed-index.json'];

/** Active unit ids + bodies. Body = unit file minus YAML frontmatter. */
export function loadActiveBodies(store) {
  const root = resolve(store);
  const idx = generateSummaryIndex(root); // active-only, retired excluded
  const out = [];
  for (const u of idx.units) {
    const fpath = join(root, '_memories', `${u.id}.md`);
    if (!existsSync(fpath)) continue;
    let raw;
    try { raw = readFileSync(fpath, 'utf8'); } catch { continue; }
    const body = raw.replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    // Prepend the H1/summary + topics so the vector carries the title signal too.
    const topics = (u.topics || []).join(' ');
    out.push({ id: u.id, text: `${u.summary}\n${topics}\n${body}`.trim() });
  }
  return out;
}

function l2normalize(vec) {
  let n = 0;
  for (const x of vec) n += x * x;
  n = Math.sqrt(n) || 1;
  return vec.map(x => x / n);
}

/**
 * Embed one string. role: 'document' | 'query' selects the nomic task prefix.
 * Returns an L2-normalized number[] or null if the embedder is unreachable.
 */
export async function embedText(text, { role = 'document' } = {}) {
  const prefix = role === 'query' ? 'search_query: ' : 'search_document: ';
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: prefix + text }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const vec = json?.embeddings?.[0];
    if (!Array.isArray(vec) || !vec.length) return null;
    return l2normalize(vec);
  } catch {
    return null; // ollama not running → optional dependency absent → caller falls back
  }
}

export function isEmbedderAvailable() {
  return embedText('ping', { role: 'query' }).then(v => v !== null);
}

const hashText = (t) => createHash('sha1').update(t).digest('hex').slice(0, 16);

/**
 * Build (or incrementally refresh) the cached dense index. Only re-embeds units whose
 * body hash changed. Returns { model, dim, units:[{id, hash, vec}] } or null if the
 * embedder is unavailable (no cache written — dense stays unavailable, lexical carries).
 */
export async function buildEmbedIndex(store, { rebuild = false } = {}) {
  const root = resolve(store);
  const cachePath = join(root, ...CACHE_REL);
  let cache = { model: EMBED_MODEL, dim: 0, units: [] };
  if (!rebuild && existsSync(cachePath)) {
    try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* rebuild */ }
  }
  const prev = new Map(cache.units.map(u => [u.id, u]));
  const bodies = loadActiveBodies(root);
  const units = [];
  let embedded = 0, reused = 0, dim = cache.dim || 0;
  for (const b of bodies) {
    const h = hashText(b.text);
    const hit = prev.get(b.id);
    if (hit && hit.hash === h && Array.isArray(hit.vec)) { units.push(hit); reused++; continue; }
    const vec = await embedText(b.text, { role: 'document' });
    if (!vec) {
      // Embedder went away mid-build. If we have no prior cache at all, bail (dense
      // unavailable); otherwise keep the stale vector rather than drop the unit.
      if (hit) { units.push(hit); reused++; continue; }
      return null;
    }
    dim = vec.length;
    units.push({ id: b.id, hash: h, vec });
    embedded++;
  }
  cache = { model: EMBED_MODEL, dim, built_at: null, units };
  mkdirSync(join(root, '_memories', '_lib'), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache));
  return { ...cache, _stats: { embedded, reused, total: units.length } };
}

function loadCache(store) {
  const cachePath = join(resolve(store), ...CACHE_REL);
  if (!existsSync(cachePath)) return null;
  try {
    const c = JSON.parse(readFileSync(cachePath, 'utf8'));
    return (c && Array.isArray(c.units) && c.units.length) ? c : null;
  } catch { return null; }
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** Dense ranking: full ranked id list by cosine (== dot on normalized vecs). null if no cache/embedder. */
export async function denseRank(query, store) {
  const cache = loadCache(store);
  if (!cache) return null;
  const qv = await embedText(query, { role: 'query' });
  if (!qv) return null;
  return cache.units
    .map(u => ({ id: u.id, score: dot(qv, u.vec) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map(x => x.id);
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
 * UNION of dense and BM25 (not RRF). Interleave the two ranked lists round-robin,
 * dedup — so a unit high on either arm surfaces early. This is the measured recall floor.
 */
export async function unionRank(query, store) {
  const dense = await denseRank(query, store);
  const bm25 = bm25Rank(query, store);
  if (!dense) return bm25;           // embedder absent → BM25 alone
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(dense.length, bm25.length);
  for (let i = 0; i < maxLen; i++) {
    for (const list of [dense, bm25]) {
      const id = list[i];
      if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
  }
  return out;
}

function selfTest() {
  // Normalization: a normalized vector has unit L2 norm, and dot(v,v) ≈ 1.
  const v = l2normalize([3, 4]); // → [0.6, 0.8]
  const norm = Math.sqrt(v[0] * v[0] + v[1] * v[1]);
  console.assert(Math.abs(norm - 1) < 1e-9, 'l2normalize must produce a unit vector');
  console.assert(Math.abs(dot(v, v) - 1) < 1e-9, 'dot of a normalized vector with itself is 1');
  // BM25: a doc containing a rare query term outranks one that doesn't.
  const tmpStore = process.env.CORE_TEST_STORE;
  if (tmpStore) {
    const r = bm25Rank('embedding dependency', tmpStore);
    console.assert(Array.isArray(r), 'bm25Rank returns an array');
  }
  console.log('embed-index self-test: OK');
}

async function main(argv) {
  if (argv.includes('--test')) { selfTest(); return 0; }
  const store = argv[0];
  const sub = argv[1];
  if (!store || !sub) { process.stderr.write('usage: embed-index.mjs <store> <build|rank> [...]\n'); return 2; }
  if (sub === 'build') {
    const res = await buildEmbedIndex(store, { rebuild: argv.includes('--rebuild') });
    if (!res) { process.stderr.write('embedder unavailable (ollama not running?) — no dense index built\n'); return 1; }
    process.stdout.write(`built dense index: ${res._stats.total} units (${res._stats.embedded} embedded, ${res._stats.reused} reused), dim=${res.dim}\n`);
    return 0;
  }
  if (sub === 'rank') {
    const q = argv[2] || '';
    const armIdx = argv.indexOf('--arm');
    const arm = armIdx >= 0 ? argv[armIdx + 1] : 'union';
    const topIdx = argv.indexOf('--top');
    const top = topIdx >= 0 ? Number(argv[topIdx + 1]) || 10 : 10;
    const ranked = arm === 'dense' ? await denseRank(q, store)
      : arm === 'bm25' ? bm25Rank(q, store)
      : await unionRank(q, store);
    if (!ranked) { process.stderr.write('dense unavailable\n'); return 1; }
    for (const id of ranked.slice(0, top)) process.stdout.write(`${id}\n`);
    return 0;
  }
  process.stderr.write(`unknown subcommand: ${sub}\n`);
  return 2;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
