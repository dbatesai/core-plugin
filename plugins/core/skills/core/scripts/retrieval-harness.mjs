/**
 * retrieval-harness.mjs — offline Recall@K gold harness (DC-113, Tier A T1 / Gate 1+2).
 *
 * THE measurement instrument. Given a pre-registered gold set (queries → correct unit
 * ids + forbidden ids + difficulty rung), score each retrieval arm on the SAME store:
 * Recall@K for K∈{5,10,30,100}, MRR, and forbidden-retrieval-rate. Deterministic and
 * offline — the arm functions are the shipped read paths, so the number reflects real
 * behavior, not a more-generous simulation.
 *
 * Arms: lexical (title+topics, the pre-T3 baseline), live (the SHIPPED title ∪ body-BM25
 * union), bm25 (body only). Dense/union arms were removed with the ollama embedder per
 * DC-114 (no local models); dense measurement, if it returns, is a pinned-embedder
 * ceremony arm (DC-115), not shipped plugin code.
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
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSummaryIndex } from './generate-summary-index.mjs';
import { lexicalRankedIds } from './retrieve-context.mjs';
import { bm25Rank, interleaveRanked } from './bm25.mjs';

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

/** Score one arm (a ranker: query -> ranked ids, possibly async/null) over the gold set. */
export async function scoreArm(ranker, gold) {
  const recall = Object.fromEntries(KS.map(k => [k, []]));
  let mrrSum = 0, mrrN = 0, forbiddenHits = 0, forbiddenQ = 0, unavailable = false;
  const perRung = {};
  for (const q of gold) {
    const ranked = await ranker(q.query);
    if (ranked === null) { unavailable = true; break; }
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
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')).queries;
  const arms = {
    lexical: (q) => lexicalRankedIds(q, store),                                  // title+topics only (pre-T3 baseline)
    live: (q) => interleaveRanked(lexicalRankedIds(q, store), bm25Rank(q, store)), // SHIPPED retriever (title ∪ body-BM25)
    bm25: (q) => bm25Rank(q, store),
  };
  const results = {};
  for (const [name, ranker] of Object.entries(arms)) results[name] = await scoreArm(ranker, gold);
  const { total, mix } = unitTypeMix(store);
  return { store: resolve(store), total, mix, nQueries: gold.length, gold, results };
}

function renderText(out) {
  const lines = [];
  lines.push(`\nRetrieval Recall@K — ${out.store}`);
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
    const { gold, ...slim } = out;
    writeFileSync(p, JSON.stringify(slim, null, 2));
    process.stdout.write(`\njson: ${p}\n`);
  }
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
