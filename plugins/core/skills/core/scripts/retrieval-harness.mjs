/**
 * retrieval-harness.mjs — offline Recall@K gold harness (DC-113, Tier A T1 / Gate 1+2).
 *
 * THE measurement instrument. Given a pre-registered gold set (queries → correct unit
 * ids + forbidden ids + difficulty rung), score each retrieval arm on the SAME store:
 * Recall@K for K∈{5,10,30,100}, MRR, and forbidden-retrieval-rate. Deterministic and
 * offline — the arm functions are the shipped read paths, so the number reflects real
 * behavior, not a more-generous simulation.
 *
 * Arms, labeled by what they actually measure (no arm overclaims "the product path"):
 *   - lexical   — title+topics overlap only (the pre-T3 baseline)
 *   - ranking   — the RANKING SUBSTRATE: productRankedIds, the function
 *                 retrieveContext ranks with, BEFORE edge expansion and topN
 *   - context3  — the FINAL PRODUCT CONTEXT: retrieveContext topN=3, the exact
 *                 id set the per-turn hook injects (edges + slice included);
 *                 only R@3 is meaningful on this arm
 *   - bm25      — the summary+topics+body BM25 arm (NOT body-only: the loader
 *                 prepends title/topics so the vector carries the title signal)
 * Dense/union arms were removed with the ollama embedder per DC-114 (no local
 * models); dense measurement, if it returns, is a pinned-embedder ceremony arm
 * (DC-115), not shipped plugin code.
 * One ranking pass per arm: metrics, raw ranks (through the largest reported K),
 * and p50/p95 latency all come from the same observations. Every run emits a
 * provenance manifest: plugin version, source commit (when in a git checkout),
 * harness self-hash, gold sha256, content-derived corpus hash, arm params.
 *
 * Corpus-normalization (Crest's 2026-07-07 "retrieval is not corpus-portable" finding):
 * every run prints store size, K-as-fraction-of-store, and the unit-type mix, and the
 * rung breakdown — so a cross-corpus reader can see the base-rate effects instead of
 * comparing raw Recall@K across differently-shaped stores. Compare a corpus to ITSELF
 * over time; treat cross-corpus raw numbers as suspect.
 *
 * Gold-set schema (JSON): { queries: [ {id, query, rung, expected:[ids], forbidden:[ids]} ] }
 * rung ∈ literal | category | value | cross-domain.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node retrieval-harness.mjs <store> [--gold <path>] [--json <outpath>]
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateSummaryIndex, computeSourceSignature } from './generate-summary-index.mjs';
import { lexicalRankedIds, productRankedIds, retrieveContext } from './retrieve-context.mjs';
import { bm25Rank } from './bm25.mjs';

const KS = [5, 10, 30, 100];
const FORBIDDEN_K = 10; // depth at which a surfaced forbidden id counts as contamination

export function recallAtK(ranked, expected, k) {
  if (!expected.length) return null;
  const top = new Set(ranked.slice(0, k));
  const hit = expected.filter(e => top.has(e)).length;
  return hit / expected.length;
}

export function firstRelevantRank(ranked, expected) {
  const exp = new Set(expected);
  for (let i = 0; i < ranked.length; i++) if (exp.has(ranked[i])) return i + 1;
  return 0; // not found
}

// (scoreArm — the ranker-callback scorer — was folded into scoreRankedLists below,
// so metrics and raw evidence always come from one observation set.)

export function unitTypeMix(store) {
  const idx = generateSummaryIndex(resolve(store));
  const mix = {};
  for (const u of idx.units) {
    const t = (u.id.match(/^([a-z]+)-/) || [])[1] || 'other';
    mix[t] = (mix[t] || 0) + 1;
  }
  return { total: idx.units.length, mix };
}

function fmt(v) { return v === null || v === undefined ? '  —  ' : v.toFixed(2); }

export async function runHarness(store, goldPath) {
  const goldRaw = readFileSync(goldPath, 'utf8');
  const gold = JSON.parse(goldRaw).queries;
  const arms = {
    lexical: (q) => lexicalRankedIds(q, store),    // title+topics only (pre-T3 baseline)
    ranking: (q) => productRankedIds(q, store),    // RANKING SUBSTRATE — the function retrieveContext ranks with, BEFORE edge expansion/topN (not the final context)
    context3: (q) => retrieveContext(q, store, { topN: 3 }).map(h => h.id), // FINAL product context — the exact top-3 the hook injects (edges + slice included); only R@3 is meaningful here
    bm25: (q) => bm25Rank(q, store),               // summary+topics+body BM25 arm (not body-only — the loader prepends title/topics)
  };
  // ONE ranking pass per arm: metrics, raw ranks, and latency all come from the
  // SAME observations (the re-review caught the double-run emitting raw evidence
  // that wasn't the run the metrics were computed from).
  const results = {};
  const rawRanks = {};   // per-arm, per-query — through the LARGEST reported K (100)
  const latency = {};    // per-arm p50/p95 ms over the gold queries
  for (const [name, ranker] of Object.entries(arms)) {
    const rankedByQuery = {};
    const times = [];
    for (const q of gold) {
      const t0 = process.hrtime.bigint();
      let ranked;
      try { ranked = await ranker(q.query); } catch { ranked = null; }
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      rankedByQuery[q.id] = ranked;
    }
    results[name] = scoreRankedLists(rankedByQuery, gold);
    rawRanks[name] = Object.fromEntries(Object.entries(rankedByQuery)
      .map(([qid, r]) => [qid, r === null ? null : r.slice(0, Math.max(...KS))]));
    times.sort((a, b) => a - b);
    latency[name] = {
      p50_ms: +(times[Math.floor(times.length / 2)] || 0).toFixed(1),
      p95_ms: +(times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] || 0).toFixed(1),
    };
  }
  const { total, mix } = unitTypeMix(store);
  // Provenance manifest (Gate 0): a number without these fields is not a baseline.
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch { /* dev tree layouts vary; version stays null rather than guessed */ }
  let sourceCommit = null;
  try {
    const { execFileSync } = await import('node:child_process');
    sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: 'utf8' }).trim();
  } catch { /* not a git checkout (packaged install) — stays null, never guessed */ }
  const manifest = {
    plugin_version: pluginVersion,
    source_commit: sourceCommit,
    harness_sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    entry_points: {
      ranking: 'productRankedIds (pre-expansion ranking substrate)',
      context3: 'retrieveContext topN=3 (the exact injected product context)',
    },
    gold_path: resolve(goldPath),
    gold_sha256: createHash('sha256').update(goldRaw).digest('hex'),
    corpus_content_sha256: createHash('sha256').update(computeSourceSignature(store)).digest('hex'), // content-derived (sha1-per-file signature), not mtime
    arm_params: { bm25: { k1: 1.5, b: 0.75 }, context3: { topN: 3 } },
  };
  return { store: resolve(store), manifest, latency, total, mix, nQueries: gold.length, gold, rawRanks, results };
}

/** Score pre-computed ranked lists (one observation set for metrics AND raw evidence). */
export function scoreRankedLists(rankedByQuery, gold) {
  const recall = Object.fromEntries(KS.map(k => [k, []]));
  let mrrSum = 0, mrrN = 0, forbiddenHits = 0, forbiddenQ = 0, unavailable = false;
  const perRung = {};
  for (const q of gold) {
    const ranked = rankedByQuery[q.id];
    if (ranked === null || ranked === undefined) { unavailable = true; break; }
    const expected = q.expected || [];
    const forbidden = q.forbidden || [];
    for (const k of KS) {
      const r = recallAtK(ranked, expected, k);
      if (r !== null) {
        recall[k].push(r);
        (perRung[q.rung] ||= Object.fromEntries(KS.map(kk => [kk, []])))[k].push(r);
      }
    }
    const fr = firstRelevantRank(ranked, expected);
    if (expected.length) { mrrSum += fr ? 1 / fr : 0; mrrN++; }
    if (forbidden.length) {
      forbiddenQ++;
      if (ranked.slice(0, FORBIDDEN_K).some(id => forbidden.includes(id))) forbiddenHits++;
    }
  }
  if (unavailable) return { unavailable: true };
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const recallMean = Object.fromEntries(KS.map(k => [k, mean(recall[k])]));
  const rungMean = {};
  for (const [rung, byK] of Object.entries(perRung)) rungMean[rung] = Object.fromEntries(KS.map(k => [k, mean(byK[k])]));
  return {
    recall: recallMean,
    mrr: mrrN ? mrrSum / mrrN : null,
    forbiddenRate: forbiddenQ ? forbiddenHits / forbiddenQ : null,
    perRung: rungMean,
  };
}

function renderText(out) {
  const lines = [];
  lines.push(`\nRetrieval Recall@K — ${out.store}`);
  lines.push(`plugin: v${out.manifest.plugin_version ?? 'unresolved'} · commit ${out.manifest.source_commit ? out.manifest.source_commit.slice(0, 8) : 'n/a'} · gold sha256 ${out.manifest.gold_sha256.slice(0, 12)}… · corpus content ${out.manifest.corpus_content_sha256.slice(0, 12)}…`);
  lines.push('arms: ranking = pre-expansion substrate (productRankedIds) · context3 = FINAL injected top-3 (retrieveContext; only R@3 meaningful) · bm25 = summary+topics+body');
  lines.push(`latency: ${Object.entries(out.latency).map(([a, l]) => `${a} p50 ${l.p50_ms}ms / p95 ${l.p95_ms}ms`).join(' · ')}`);
  lines.push(`store: ${out.total} active units · gold: ${out.nQueries} queries`);
  lines.push(`unit-type mix: ${Object.entries(out.mix).map(([t, n]) => `${t}:${n}`).join(' ')}`);
  lines.push(`K as fraction of store: ${KS.map(k => `${k}=${(k / out.total * 100).toFixed(0)}%`).join('  ')}  (Crest: compare a corpus to itself, not cross-corpus raw)`);
  lines.push('');
  lines.push(`arm       R@5   R@10  R@30  R@100  MRR   forbid@${FORBIDDEN_K}`);
  for (const [name, r] of Object.entries(out.results)) {
    if (r.unavailable) { lines.push(`${name.padEnd(9)} (arm unavailable)`); continue; }
    lines.push(`${name.padEnd(9)} ${fmt(r.recall[5])} ${fmt(r.recall[10])} ${fmt(r.recall[30])} ${fmt(r.recall[100])}  ${fmt(r.mrr)}  ${fmt(r.forbiddenRate)}`);
  }
  // Per-rung R@10, the rung where lexical is known to collapse.
  lines.push('\nR@10 by rung:');
  const rungs = ['literal', 'category', 'value', 'cross-domain'];
  lines.push(`arm       ${rungs.map(x => x.slice(0, 8).padEnd(8)).join(' ')}`);
  for (const [name, r] of Object.entries(out.results)) {
    if (r.unavailable) continue;
    lines.push(`${name.padEnd(9)} ${rungs.map(rg => fmt(r.perRung[rg]?.[10]).padEnd(8)).join(' ')}`);
  }
  return lines.join('\n');
}

async function main(argv) {
  const store = argv[0];
  if (!store) { process.stderr.write('usage: retrieval-harness.mjs <store> [--gold <path>] [--json <outpath>]\n'); return 2; }
  const goldIdx = argv.indexOf('--gold');
  const goldPath = goldIdx >= 0 ? argv[goldIdx + 1] : join(resolve(store), '_tests', 'retrieval-gold-set.json');
  if (!existsSync(goldPath)) { process.stderr.write(`gold set not found: ${goldPath}\n`); return 1; }
  const out = await runHarness(store, goldPath);
  process.stdout.write(renderText(out) + '\n');
  const jsonIdx = argv.indexOf('--json');
  if (jsonIdx >= 0) {
    const p = argv[jsonIdx + 1];
    // Full payload on purpose: gold + rawRanks + manifest are the evidence trail —
    // a JSON report that strips them can't be independently re-scored (Hale 2026-07-11).
    writeFileSync(p, JSON.stringify(out, null, 2));
    process.stdout.write(`\njson: ${p}\n`);
  }
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
