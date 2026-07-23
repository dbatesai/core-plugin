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
 * rung ∈ literal | category | value | cross-domain | temporal | abstention.
 * (temporal + abstention were added for the blind self-test, self-test-round.mjs —
 * the field treats them as table-stakes memory abilities. abstention scores through
 * the existing expected:[] + forbiddenRate path with no scorer change; the enum just
 * had to admit the label so per-rung reporting can name it.)
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node retrieval-harness.mjs <store> [--gold <path>] [--json <outpath>]
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from './generate-summary-index.mjs';
import { lexicalRankedIds, productRankedIds, retrieveContext, buildFinalContextPack } from './retrieve-context.mjs';
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

// Round-13 audit: this used to call generateSummaryIndex(store) — a FULL live
// re-read of every unit AFTER the run's snapshot was minted. It now derives the
// mix from an index object; runHarness passes its captured snapshot's index.
//
// K09 (Hale's audit, 2026-07-16): this used to derive the type key from the
// unit ID's leading alpha run (id.match(/^([a-z]+)-/)) rather than the unit's
// actual `type:` frontmatter field. A project's own id-naming convention is
// project-specific vocabulary — a bespoke prefix leaks straight through this
// "generic CORE vocabulary" mix into the shareable aggregate receipt (the
// whitelist/refusal-scan boundary aggregate-receipt.mjs exists to enforce),
// since MIX_KEY_RE there only checks shape (lowercase, <=24 chars), not
// membership in the actual closed CORE type set. Fixed at the source: use the
// real `type` field the index already carries, closed CORE vocabulary only.
export function unitTypeMix(index) {
  const mix = {};
  for (const u of index.units) {
    const t = u.type && u.type.trim() ? u.type.trim() : 'other';
    mix[t] = (mix[t] || 0) + 1;
  }
  return { total: index.units.length, mix };
}

function fmt(v) { return v === null || v === undefined ? '  —  ' : v.toFixed(2); }

export async function runHarness(store, goldPath, { snapshot: injectedSnapshot = null } = {}) {
  const goldRaw = readFileSync(goldPath, 'utf8');
  const gold = JSON.parse(goldRaw).queries;
  // A5 strictness: the Recall@K instrument refuses an under-declared gold set and
  // an unclassifiable store the same way the tier sweep does — zero silent skips.
  validateGold(gold);
  // Blocker 2 (Hale verdict §2): ONE immutable captured corpus — index AND body
  // bytes — minted before any measurement; every arm and every policy consumes it.
  // No reader below touches live unit files after snapshot_id is computed, so a
  // store mutation mid-run cannot change what any number describes. An injected
  // snapshot (round 13) makes that a TESTABLE end-to-end property: two runs with
  // the same capture must be identical regardless of on-disk mutation.
  const snapshot = injectedSnapshot || loadSnapshot(store, { captureBodies: true });
  assertKnownTiers(snapshot.index);
  const arms = {
    lexical: { run: (q) => lexicalRankedIds(q, store, { snapshot }) },   // title+topics only (pre-T3 baseline)
    ranking: { run: (q) => productRankedIds(q, store, { snapshot }) },   // RANKING SUBSTRATE — the function retrieveContext ranks with, BEFORE edge expansion/topN (not the final context)
    // FINAL product context — DELIVERED identities, not selection: routed through
    // buildFinalContextPack so the byte cap participates (Train A A4 — a hit
    // retrieveContext selects but the cap drops is NOT counted as delivered).
    // Reported at K=3 ONLY (Hale close path §6): the delivered list is at most
    // three items, so R@5/R@10/… on it would relabel R@3 as deeper recall.
    context3: { run: (q) => buildFinalContextPack(retrieveContext(q, store, { topN: 3, snapshot })).accepted.map(a => a.id), ks: [3] },
    bm25: { run: (q) => bm25Rank(q, store, { snapshot }) },              // summary+topics+body BM25 arm (not body-only — the loader prepends title/topics)
  };
  // ONE ranking pass per arm: metrics, raw ranks, and latency all come from the
  // SAME observations (the re-review caught the double-run emitting raw evidence
  // that wasn't the run the metrics were computed from).
  const results = {};
  const rawRanks = {};   // per-arm, per-query — through the LARGEST reported K (100)
  const latency = {};    // per-arm p50/p95 ms over the gold queries
  for (const [name, arm] of Object.entries(arms)) {
    const rankedByQuery = {};
    const times = [];
    for (const q of gold) {
      const t0 = process.hrtime.bigint();
      let ranked;
      try { ranked = await arm.run(q.query); } catch { ranked = null; }
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      rankedByQuery[q.id] = ranked;
    }
    results[name] = scoreRankedLists(rankedByQuery, gold, arm.ks || KS);
    rawRanks[name] = Object.fromEntries(Object.entries(rankedByQuery)
      .map(([qid, r]) => [qid, r === null ? null : r.slice(0, Math.max(...KS))]));
    times.sort((a, b) => a - b);
    latency[name] = {
      p50_ms: +(times[Math.floor(times.length / 2)] || 0).toFixed(1),
      p95_ms: +(times[Math.min(times.length - 1, Math.ceil(times.length * 0.95) - 1)] || 0).toFixed(1),
    };
  }
  const { total, mix } = unitTypeMix(snapshot.index);
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
  // A5 (Crest correction #6): a receipt without hashes is not reproducible.
  // Product-function hashes cover the three modules the pipeline runs; the
  // built-artifact hash is null in a dev tree BY DESIGN (it names the packaged
  // archive; the packet's freeze step supplies it — never guessed here).
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const fileHash = (name) => {
    try { return createHash('sha256').update(readFileSync(join(scriptsDir, name))).digest('hex'); }
    catch { return null; }
  };
  const manifest = {
    receipt_schema: 'train-a-evaluator/1',
    plugin_version: pluginVersion,
    source_commit: sourceCommit,
    harness_sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    product_function_sha256: {
      'retrieve-context.mjs': fileHash('retrieve-context.mjs'),
      'bm25.mjs': fileHash('bm25.mjs'),
      'generate-summary-index.mjs': fileHash('generate-summary-index.mjs'),
    },
    // The CONTENT-MANIFEST sha256 from artifact-identity.mjs (sorted
    // relpath:sha256(bytes) over the frozen subtree) — ONE meaning everywhere
    // (Hale round 7: this comment used to say "packaged-archive hash" while
    // validation.md said content-manifest, recreating the tar-byte ambiguity).
    // Supplied by the freeze step at the pin via aggregate-receipt's
    // --artifact-sha; never computed from a dev tree.
    built_artifact_sha256: null,
    snapshot_id: snapshot.snapshotId, // the content-addressed store snapshot ALL arms ran against
    entry_points: {
      ranking: 'productRankedIds (pre-expansion ranking substrate)',
      context3: 'buildFinalContextPack(retrieveContext topN=3).accepted (delivered identities — byte cap included)',
    },
    gold_path: resolve(goldPath),
    gold_sha256: createHash('sha256').update(goldRaw).digest('hex'),
    // Definitionally equal to snapshot_id (both are sha256 of the content-derived
    // per-file signature) — and taken FROM the capture: the old computation
    // re-walked the live store after the snapshot was minted (round-13 audit).
    corpus_content_sha256: snapshot.snapshotId,
    arm_params: { bm25: { k1: 1.5, b: 0.75 }, context3: { topN: 3 } },
    counts: {
      queries: gold.length,
      no_answer: gold.filter(q => q.no_answer === true).length,
      declared_supports: gold.reduce((s, q) => s + (q.expected || []).length, 0),
    },
  };
  return { store: resolve(store), manifest, latency, total, mix, nQueries: gold.length, gold, rawRanks, results };
}

/** Score pre-computed ranked lists (one observation set for metrics AND raw evidence). */
export function scoreRankedLists(rankedByQuery, gold, ks = KS) {
  const recall = Object.fromEntries(ks.map(k => [k, []]));
  let mrrSum = 0, mrrN = 0, forbiddenHits = 0, forbiddenQ = 0, unavailable = false;
  const perRung = {};
  for (const q of gold) {
    const ranked = rankedByQuery[q.id];
    if (ranked === null || ranked === undefined) { unavailable = true; break; }
    const expected = q.expected || [];
    const forbidden = q.forbidden || [];
    for (const k of ks) {
      const r = recallAtK(ranked, expected, k);
      if (r !== null) {
        recall[k].push(r);
        (perRung[q.rung] ||= Object.fromEntries(ks.map(kk => [kk, []])))[k].push(r);
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
  const recallMean = Object.fromEntries(ks.map(k => [k, mean(recall[k])]));
  const rungMean = {};
  for (const [rung, byK] of Object.entries(perRung)) rungMean[rung] = Object.fromEntries(ks.map(k => [k, mean(byK[k])]));
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
  // Per-rung R@10, the rung where lexical is known to collapse. Only rungs
  // actually present in the results are shown, so the extended enum (temporal,
  // abstention) surfaces on self-test sets without cluttering a classic 4-rung run.
  lines.push('\nR@10 by rung:');
  const RUNG_ORDER = ['literal', 'category', 'value', 'cross-domain', 'temporal', 'abstention'];
  const present = new Set();
  for (const r of Object.values(out.results)) for (const k of Object.keys(r.perRung || {})) present.add(k);
  const rungs = RUNG_ORDER.filter(r => present.has(r));
  lines.push(`arm       ${rungs.map(x => x.slice(0, 8).padEnd(8)).join(' ')}`);
  for (const [name, r] of Object.entries(out.results)) {
    if (r.unavailable) continue;
    lines.push(`${name.padEnd(9)} ${rungs.map(rg => fmt(r.perRung[rg]?.[10]).padEnd(8)).join(' ')}`);
  }
  return lines.join('\n');
}

/**
 * validateGold — completeness/shape gate before any measurement (Crest 2026-07-12 #5):
 * declared query set present, no duplicate ids, expected/forbidden are arrays. Throws
 * loudly rather than silently skipping a malformed query.
 */
export function validateGold(gold) {
  if (!Array.isArray(gold) || !gold.length) throw new Error('gold set is empty');
  const seen = new Set();
  for (const q of gold) {
    if (!q.id || typeof q.id !== 'string') throw new Error('gold query missing string id');
    if (seen.has(q.id)) throw new Error(`duplicate gold query id: ${q.id}`);
    seen.add(q.id);
    if (!q.query || typeof q.query !== 'string' || !q.query.trim()) throw new Error(`${q.id}: missing query text`);
    if (q.expected !== undefined && !Array.isArray(q.expected)) throw new Error(`${q.id}: expected must be an array`);
    if (q.forbidden !== undefined && !Array.isArray(q.forbidden)) throw new Error(`${q.id}: forbidden must be an array`);
    // A5 strictness (Crest correction #2): every query DECLARES its support — at
    // least one expected id, or an explicit no_answer:true. An empty expected with
    // no declaration is how a gold set silently shrinks its own denominator.
    const expected = q.expected || [];
    if (!expected.length && q.no_answer !== true) {
      throw new Error(`${q.id}: no expected support and not marked no_answer:true — declare the support or the absence, never neither`);
    }
    if (expected.length && q.no_answer === true) {
      throw new Error(`${q.id}: no_answer:true contradicts a non-empty expected list`);
    }
    for (const field of ['expected', 'forbidden']) {
      const vals = q[field] || [];
      for (const v of vals) {
        if (typeof v !== 'string' || !v.trim()) throw new Error(`${q.id}: ${field} entries must be non-empty strings`);
      }
      // Blocker-4 fail-closed (Hale verdict §4): duplicate supports double-count a
      // hit and silently inflate recall's numerator — refuse, don't dedupe.
      if (new Set(vals).size !== vals.length) {
        throw new Error(`${q.id}: duplicate ids in ${field} — evaluator refuses (dedupe the gold set deliberately)`);
      }
    }
    // Blocker-4: an id in BOTH expected and forbidden makes the measurement
    // undefined (a hit is simultaneously success and contamination). Refuse.
    const forb = new Set(q.forbidden || []);
    const overlap = (q.expected || []).filter(id => forb.has(id));
    if (overlap.length) {
      throw new Error(`${q.id}: ids in both expected and forbidden (${overlap.join(', ')}) — contradictory gold, measurement undefined`);
    }
    // Blocker-4: rung is a closed reporting enum. An unknown rung disappears from
    // fixed reporting surfaces (perRung) or becomes an exporter-controlled key —
    // both are silent. Require a declared, known rung on every query.
    if (!GOLD_RUNGS.has(q.rung)) {
      throw new Error(`${q.id}: rung '${q.rung ?? '(missing)'}' not in {${[...GOLD_RUNGS].join(', ')}} — evaluator fails closed (extend the enum deliberately)`);
    }
  }
  return true;
}

// The closed difficulty-rung vocabulary (header contract, line "rung ∈ …").
// temporal + abstention were added deliberately (not defaulted) for the blind
// self-test — the fail-closed contract this enum enforces is exactly "extend the
// enum deliberately, don't default", which this is.
export const GOLD_RUNGS = new Set(['literal', 'category', 'value', 'cross-domain', 'temporal', 'abstention']);

/**
 * assertKnownTiers — evaluator-side fail-closed authority enum (A5, Crest correction
 * #5). The PRODUCT path tolerates unknown tiers (defaults canonical — a ranking path
 * never throws); the MEASUREMENT path must not: an unknown tier silently classified
 * as canonical would corrupt every tier-policy number. Throws on the first unknown.
 */
export function assertKnownTiers(index) {
  const VALID_TIERS = new Set(['canonical', 'observation']);
  for (const u of index.units) {
    // Blocker-4 fail-closed (Hale verdict §4): a MISSING/empty tier must refuse
    // like an unknown one — product code defaults missing tiers to canonical, so
    // an unmeasured unit would silently join the highest-authority class in every
    // tier-policy number. Absence is not a tier.
    if (!u.tier) {
      throw new Error(`missing authority tier on unit ${u.id} — evaluator fails closed (the product path may default; the measurement path must not)`);
    }
    if (!VALID_TIERS.has(u.tier)) {
      throw new Error(`unknown authority tier '${u.tier}' on unit ${u.id} — evaluator fails closed (extend the enum deliberately, don't default)`);
    }
  }
  return true;
}

/**
 * runTierPolicySweep — the CORRECTED tier-policy evaluator (Crest 2026-07-12).
 *
 * Measures P0-P3 on the REAL final injected context by calling the imported product
 * function `retrieveContext(..., {tierPolicy})` — edge expansion, re-sort, topN cap
 * and all — NOT a substrate slice (the defect in the withdrawn standalone). Bands are
 * assigned by COUNTERFACTUAL execution (run every policy, see what actually moves the
 * final context), not inferred from a rank interval. Multi-valued relevance is
 * preserved by recallAtK (fractional over all expected). Product-path by construction:
 * the tier function is imported, never hand-copied.
 *
 * @returns aggregate only — R@3/forbidden@3 per policy + a per-query band label. The
 *   caller decides what leaves an approved environment; row ids stay with the caller.
 */
export function runTierPolicySweep(store, gold, { topN = 3, snapshot: injectedSnapshot = null } = {}) {
  validateGold(gold);
  // A5 fail-closed: measurement refuses a store whose authority tiers it can't
  // classify, and every sweep number is pinned to the snapshot it was computed on.
  // Blocker 2: the snapshot is a FULL capture (index + body bytes) and every
  // policy run below consumes it — no live reads after the id. Injectable for
  // the round-13 whole-harness barrier proof.
  const snapshot = injectedSnapshot || loadSnapshot(store, { captureBodies: true });
  assertKnownTiers(snapshot.index);
  const POLICIES = [
    ['P0', { tierPolicy: 'P0' }], ['P1', { tierPolicy: 'P1' }], ['P2', { tierPolicy: 'P2' }],
    ['P3_w0.8', { tierPolicy: 'P3', tierWeight: 0.8 }], ['P3_w0.6', { tierPolicy: 'P3', tierWeight: 0.6 }],
  ];
  const finalCtx = {}; // policy -> {qid -> [ids]}
  for (const [label, opts] of POLICIES) {
    finalCtx[label] = {};
    // Delivered identities (pack-accepted), not selection — same A4 routing as the context3 arm.
    for (const q of gold) finalCtx[label][q.id] = buildFinalContextPack(retrieveContext(q.query, store, { topN, ...opts, snapshot })).accepted.map(a => a.id);
  }
  const perPolicy = POLICIES.map(([label]) => {
    let recalls = [], forbid = 0, forbidQ = 0;
    for (const q of gold) {
      const ctx = finalCtx[label][q.id];
      const r = recallAtK(ctx, q.expected || [], topN);
      if (r !== null) recalls.push(r);
      if ((q.forbidden || []).length) { forbidQ++; if (ctx.slice(0, topN).some(id => q.forbidden.includes(id))) forbid++; }
    }
    const mean = recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : null;
    return { policy: label, r3: mean === null ? null : +mean.toFixed(3), n: recalls.length, forbidden3: forbidQ ? +(forbid / forbidQ).toFixed(3) : 0 };
  });
  // Counterfactual bands on P0 misses: RUN the policies, don't infer from rank.
  // A5 (Crest correction #3): banding is per (query, gold) pair over ALL declared
  // supports — first-support-only banding collapsed the multi-valued estimand
  // (recallAtK is fractional over all expected; the bands must match it).
  const bands = [];
  for (const q of gold) {
    for (const g of (q.expected || [])) {
      const p0hit = (finalCtx['P0'][q.id] || []).includes(g);
      if (p0hit) continue;
      const rescuer = POLICIES.slice(1).find(([label]) => (finalCtx[label][q.id] || []).includes(g));
      let band;
      if (rescuer) band = `tier-ordering (rescued by ${rescuer[0]})`;
      else {
        const inSubstrate = productRankedIds(q.query, store, { snapshot }).includes(g); // round 13: Hale's fourth reader — banding must consume the sweep's own capture
        band = inSubstrate ? 'deep-but-present (topN x tier coupled; no policy reaches at this topN)' : 'recall (absent from ranking; enrichment/reasoning, not tier)';
      }
      bands.push({ query: q.id, gold: g, band }); // ids are the caller's local gold labels
    }
  }
  const declaredSupports = gold.reduce((s, q) => s + (q.expected || []).length, 0);
  return {
    kind: 'final-context', topN, evaluator: 'buildFinalContextPack(retrieveContext(tierPolicy)).accepted — imported product path, delivered identities',
    snapshot_id: snapshot.snapshotId,
    perPolicy, bands,
    counts: {
      queries: gold.length,
      scored: perPolicy[0].n,
      no_answer: gold.filter(q => q.no_answer === true).length,
      declared_supports: declaredSupports,
    },
  };
}

async function main(argv) {
  const store = argv[0];
  if (!store) { process.stderr.write('usage: retrieval-harness.mjs <store> [--gold <path>] [--json <outpath>] [--tier-policies]\n'); return 2; }
  const goldIdx = argv.indexOf('--gold');
  const goldPath = goldIdx >= 0 ? argv[goldIdx + 1] : join(resolve(store), '_tests', 'retrieval-gold-set.json');
  if (!existsSync(goldPath)) { process.stderr.write(`gold set not found: ${goldPath}\n`); return 1; }
  if (argv.includes('--tier-policies')) {
    const gold = JSON.parse(readFileSync(goldPath, 'utf8')).queries;
    const sweep = runTierPolicySweep(resolve(store), gold);
    process.stdout.write(`\nTier-policy sweep — ${sweep.kind} (topN=${sweep.topN}), ${sweep.evaluator}\n`);
    process.stdout.write('policy    R@3    forbidden@3\n');
    for (const p of sweep.perPolicy) process.stdout.write(`${p.policy.padEnd(9)} ${p.r3 ?? ' — '}   ${p.forbidden3}\n`);
    process.stdout.write('\ncounterfactual bands (P0 misses):\n');
    for (const b of sweep.bands) process.stdout.write(`  ${b.query}: ${b.band}\n`);
    return 0;
  }
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
