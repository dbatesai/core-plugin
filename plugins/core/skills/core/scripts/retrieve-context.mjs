/**
 * retrieve-context.mjs — deterministic per-turn retrieval (the product path).
 *
 * Given a query and a store, return the top-N most relevant active units as
 * {id, summary, tier, score}. Model-free and cheap enough to run on every
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
 * final sort (a neighbor of a strong hit can beat a weak direct hit, by design).
 *
 * Reads the recursive path-bearing index via loadFreshIndex (freshness validated
 * every call). Edge data isn't in the index, so expansion reads the top-hit unit
 * files directly, resolved through the index's per-unit path (nested units included).
 *
 * Ships with the plugin as prescriptive code; .mjs only.
 *
 * CLI: node retrieve-context.mjs <storePath> "<query>" [--top N]
 */

import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadFreshIndex, loadSnapshot } from './generate-summary-index.mjs';
import { bm25DocumentScores, bm25Scores, tokenize, STOPWORDS } from './bm25.mjs';

export const ENRICHMENT_WEIGHT = 0.6;

// The tokenizer lives in bm25.mjs (avoids a retrieve-context ⇄ bm25 import
// cycle). Re-exported here so existing importers keep working.
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
export function lexicalRankedIds(query, storePath, { snapshot = null } = {}) {
  const root = resolve(storePath);
  if (!snapshot && !existsSync(join(root, '_memories'))) return [];
  const index = snapshot?.index || loadFreshIndex(root);
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
 * ships (the product/harness identity invariant).
 *
 * Scoring: two lexical arms produce MAGNITUDE scores — the title/topics overlap
 * scorer and body BM25. Each arm is normalized by its own maximum (scale-free), and
 * a unit's combined score is the max of its normalized arm scores. Magnitudes are
 * preserved (not flattened to rank positions) because the one-hop edge discount
 * needs ratios: "a neighbor of a STRONG hit beats a WEAK direct hit" is only
 * expressible when 0.5 × parent-strength can exceed another unit's strength.
 *
 * @returns {Array<{id, tier, score}>} every unit scoring > 0 on either arm, sorted
 *   desc by combined normalized score (ties by id), score ∈ (0, 1].
 */
export function productRankedScores(query, storePath, preloadedIndex = null, snapshot = null) {
  const root = resolve(storePath);
  if (!snapshot && !existsSync(join(root, '_memories'))) return [];
  // The product ranking always owns a content-addressed capture when its caller
  // did not supply one. Enrichment is part of that identity and may not be read
  // from a different instant than bodies/edges.
  const snap = snapshot || loadSnapshot(root, { captureBodies: true });
  const index = snap.index || preloadedIndex || loadFreshIndex(root);
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
    // The body arm reads through the SAME index as the title arm — one
    // request, one snapshot, every reader sees the same bytes. With a captured
    // snapshot, body BYTES come from the capture too — zero live reads.
    bodyScored = bm25Scores(query, root, { preloadedIndex: index, snapshot: snap });
    _lastBm25Error = null;
  } catch (err) {
    // Fail-open (title-only) but never silent: the degradation is visible on stderr
    // (hook logs) and via storeHealth() — a product that quietly halves its recall
    // is a health incident, not a fallback.
    _lastBm25Error = String(err && err.message || err);
    process.stderr.write(`retrieve-context: body-BM25 arm failed (${_lastBm25Error}) — degraded to title-only for this query\n`);
  }
  const bodyMax = Math.max(0, ...bodyScored.map(s => s.score));
  for (const s of bodyScored) {
    const norm = s.score / bodyMax;
    const prev = combined.get(s.id);
    if (!prev || norm > prev.score) combined.set(s.id, { id: s.id, tier: s.tier, score: norm });
  }

  // By design, write-time enrichment is a distinct, lower-weight arm. It
  // never contaminates authored body text, and stale/same-family records were
  // already excluded by the captured sidecar loader.
  const enrichmentScored = bm25DocumentScores(query, snap.enrichments?.documents || []);
  const enrichmentMax = Math.max(0, ...enrichmentScored.map((s) => s.score));
  for (const s of enrichmentScored) {
    const norm = (s.score / enrichmentMax) * ENRICHMENT_WEIGHT;
    const prev = combined.get(s.id);
    if (!prev || norm > prev.score) combined.set(s.id, { id: s.id, tier: s.tier, score: norm });
  }

  return [...combined.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** Ranked id list of productRankedScores — the ranking-substrate arm for offline measurement. */
export function productRankedIds(query, storePath, { snapshot = null } = {}) {
  return productRankedScores(query, storePath, null, snapshot).map(s => s.id);
}

/**
 * applyTierPolicy — authority-tier ranking policy, applied to a scored list.
 *
 * BUILT REVERSIBLE, DEFAULT-OFF (P0). Recursive
 * coverage can bury canonical answers under raw observations at the final injected
 * context. The joint contract v2 §7 pre-registers four policies decided BY the
 * ceremony's final-context numbers, not by prescription. This is the mechanism they
 * select from; nothing here activates until the product owner rules on the ceremony evidence.
 *
 *   P0 — flat ranking, tier is a label only (SHIPPED default; the control).
 *   P1 — canonical-preference tiebreak: within `epsilon` of normalized score, a
 *        canonical unit outranks an observation.
 *   P2 — slot reservation: if no canonical sits in the top-`topN` but a canonical
 *        with score > 0 exists, the highest-scoring one is promoted into the last
 *        reserved slot (topN-1).
 *   P3 — tier weighting: observation scores × `weight`, then re-sort.
 *
 * @param {Array<{id,tier,score}>} scored  desc-sorted product ranking
 * @returns {Array<{id,tier,score}>} re-ranked copy (input untouched)
 */
export function applyTierPolicy(scored, policy = 'P0', { topN = 3, epsilon = 0.05, weight = 0.8 } = {}) {
  const isCanon = (u) => (u.tier || 'canonical') === 'canonical';
  if (policy === 'P0' || !policy) return scored;
  if (policy === 'P1') {
    return [...scored].sort((a, b) => {
      if (Math.abs(a.score - b.score) <= epsilon && isCanon(a) !== isCanon(b)) return isCanon(a) ? -1 : 1;
      return b.score - a.score || a.id.localeCompare(b.id);
    });
  }
  if (policy === 'P2') {
    const out = [...scored];
    if (!out.slice(0, topN).some(isCanon)) {
      const bestCanonIdx = out.findIndex(u => isCanon(u) && u.score > 0);
      if (bestCanonIdx >= topN) {
        const [canon] = out.splice(bestCanonIdx, 1);
        out.splice(topN - 1, 0, canon); // reserve the last top-N slot
      }
    }
    return out;
  }
  if (policy === 'P3') {
    return scored
      .map(u => ({ ...u, score: isCanon(u) ? u.score : u.score * weight }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }
  return scored; // unknown policy → control (never throws in a ranking path)
}

let _lastBm25Error = null;

/**
 * storeHealth — cheap, non-mutating health read for hook/UI surfaces. Reads the
 * CACHED index only (no regeneration; call after a retrieval so it's fresh) and
 * reports the degraded state a silent fallback would otherwise hide: duplicate-id
 * conflicts (an observation shadowing canonical truth) and the last BM25 failure.
 */
export function storeHealth(storePath, { snapshot = null } = {}) {
  // With a snapshot, health comes from the CAPTURED index — degraded/conflicts
  // are fields the capture already carries (round-13 audit: the cached-file read
  // below described a possibly-different store state than the snapshot's id).
  if (snapshot?.index) {
    return {
      degraded: !!snapshot.index.degraded,
      duplicate_conflicts: snapshot.index.duplicate_conflicts || [],
      bm25_error: _lastBm25Error,
    };
  }
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
 * runRetrievalStages — the ONE retrieval pipeline, staged. retrieveContext
 * returns its `final`; buildRetrievalTrace records every stage. There is exactly one
 * implementation of the pipeline — a trace can never disagree with the product.
 * @returns {{snapshotId, substrate, policied, top, expanded, final}}
 */
function runRetrievalStages(query, root, { topN = 3, tierPolicy = 'P0', tierEpsilon, tierWeight, snapshot = null } = {}) {
  // ONE ATOMIC capture per request — id, index, AND body
  // bytes from a single read per file (captureBodies) — whether the caller is a
  // measurement (passes its run-scoped captured snapshot) or the product path
  // (captures fresh per request). Passing the NULLABLE caller snapshot
  // downstream would let the product path's body arm re-read live files while
  // the trace carries a snapshotId minted from different bytes — an
  // intra-request tear. `snap`, never `snapshot`,
  // flows to every reader below.
  const snap = snapshot || loadSnapshot(root, { captureBodies: true });
  const { index, snapshotId } = snap;
  const byId = new Map(index.units.map(u => [u.id, u]));

  // The product ranking: title/topics ∪ body-BM25, magnitudes preserved via
  // per-arm max-normalization (see productRankedScores). The body arm materially
  // lifts recall and rescues the abstract/value query rung (model-free by design).
  // tierPolicy defaults to 'P0' (identity), which leaves the ranking untouched; the
  // ceremony (joint contract v2 §7) selects an active policy from measured evidence.
  const substrate = productRankedScores(query, root, index, snap);
  const policied = applyTierPolicy(
    substrate,
    tierPolicy,
    { topN, ...(tierEpsilon !== undefined ? { epsilon: tierEpsilon } : {}), ...(tierWeight !== undefined ? { weight: tierWeight } : {}) },
  );

  const top = policied.slice(0, topN).map(s => ({
    id: s.id, summary: byId.get(s.id)?.summary, tier: s.tier, score: s.score,
  }));

  // One-hop edge expansion from the top hits, at a 0.5x discount on the parent's
  // normalized score — so a neighbor of a strong hit COMPETES with (and can beat)
  // weak direct hits in the final ranking (the neighbor-competes semantic; an
  // edge-bearing fixture guards it). Edges come FROM THE CAPTURE: re-reading
  // live unit files here would let a concurrent
  // edge change alter expanded/final results under an unchanged snapshot_id.
  // No filesystem access here.
  const seen = new Set(top.map(t => t.id));
  const expanded = [];
  for (const hit of top) {
    const edges = (snap.edges && snap.edges[hit.id]) || [];
    for (const e of edges) {
      const targetId = String(e.target).replace(/\.md$/, '');
      if (seen.has(targetId)) continue;
      const target = byId.get(targetId); // only active units are in the index
      if (!target) continue;             // retired/missing target → skip (anti-resurrection)
      seen.add(targetId);
      expanded.push({ id: target.id, summary: target.summary, tier: target.tier, score: hit.score * 0.5 });
    }
  }

  const final = [...top, ...expanded].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topN);
  // `snapshot: snap` rides the return so callers (buildRetrievalTrace's health
  // line) can consume the SAME capture instead of re-reading any store surface.
  return { snapshotId, substrate, policied, top, expanded, final, snapshot: snap };
}

/**
 * Candidate limits reach Array.prototype.slice, which accepts anything: a negative
 * limit counts from the END and silently drops results, a fractional or infinite one
 * produces a window nobody requested, and NaN collapses to the default so a mistyped
 * limit still answers confidently. A limit is a finite positive integer or it is an
 * error — never a clamp, which would be the same silent substitution one layer up.
 */
export function requirePositiveInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`invalid retrieval limit: ${name} must be a finite positive integer`);
  }
  return value;
}

/**
 * @returns {Array<{id, summary, score}>}
 */
export function retrieveContext(query, storePath, opts = {}) {
  if (opts.topN !== undefined) requirePositiveInt(opts.topN, 'topN');
  const root = resolve(storePath);
  // The per-turn hook runs in every directory the user opens. If there's no CORE
  // store here, retrieve nothing and — critically — write nothing: generating the
  // index would mkdir -p _memories/_lib and litter unit-summaries.json into an
  // unrelated repo. No store, no retrieval, no side effect. (A caller holding a
  // captured snapshot already proved the store existed at capture time.)
  if (!opts.snapshot && !existsSync(join(root, '_memories'))) return [];
  return runRetrievalStages(query, root, opts).final;
}

/**
 * buildRetrievalTrace — LOCAL-ONLY evidence record of one retrieval request.
 * Runs the SAME staged pipeline as
 * retrieveContext (imported, never reimplemented) and records: snapshot identity,
 * component identities, parameters, store health, ranked substrate, policy output,
 * expansion, the final candidates, the delivered pack (accepted/excluded/bytes), and
 * timing. Detailed traces stay on the machine that produced them — rows in this
 * object are project data; only the aggregate exporter produces shareable output.
 */
export function buildRetrievalTrace(query, storePath, { topN = 3, tierPolicy = 'P0', tierEpsilon, tierWeight, byteCap = 2048, snapshot = null } = {}) {
  requirePositiveInt(topN, 'topN');
  const root = resolve(storePath);
  const t0 = process.hrtime.bigint();
  // Storeless probe only when there is NO injected snapshot: a
  // caller holding a capture already proved the store existed at capture time,
  // and the trace must describe the CAPTURED state even if the live store
  // vanished afterward — an unconditional existsSync here returned `storeless`
  // for exactly the runs whose whole point was independence from live state.
  if (!snapshot && !existsSync(join(root, '_memories'))) {
    return { kind: 'retrieval-trace', local_only: true, store: root, storeless: true,
      query, snapshot_id: null, stages: null, pack: null, timing_ms: 0 };
  }
  const stages = runRetrievalStages(query, root, { topN, tierPolicy, tierEpsilon, tierWeight, snapshot });
  const health = storeHealth(root, { snapshot: stages.snapshot }); // round 13: health from the run's own capture, never the cached file
  const pack = buildFinalContextPack(stages.final, { byteCap, health });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const componentHash = (rel) => {
    try {
      return createHash('sha256')
        .update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel)))
        .digest('hex');
    } catch { return null; } // packaged layouts vary; never guessed
  };
  return {
    kind: 'retrieval-trace',
    local_only: true, // rows are project data; share only through the A2 aggregate exporter
    store: root,
    query,
    snapshot_id: stages.snapshotId,
    parameters: { topN, tierPolicy, ...(tierEpsilon !== undefined ? { tierEpsilon } : {}), ...(tierWeight !== undefined ? { tierWeight } : {}), byteCap },
    component_identity: {
      'retrieve-context.mjs': componentHash('./retrieve-context.mjs'),
      'bm25.mjs': componentHash('./bm25.mjs'),
      'generate-summary-index.mjs': componentHash('./generate-summary-index.mjs'),
      'enrichment-sidecar.mjs': componentHash('./enrichment-sidecar.mjs'),
    },
    health,
    stages: {
      substrate: stages.substrate,
      policy_output: stages.policied.slice(0, Math.max(topN * 2, 10)),
      top: stages.top,
      expansion: stages.expanded,
      final: stages.final,
    },
    // `text` rides the trace so a single pipeline run can serve BOTH the injection
    // (the hook prints it) and the evidence record — the per-turn hook is this
    // function's production caller.
    pack: { accepted: pack.accepted, excluded: pack.excluded, bytes: pack.bytes, warnings: pack.warnings, text: pack.text },
    timing_ms: +elapsedMs.toFixed(2),
  };
}

/**
 * buildFinalContextPack — THE final-context product function.
 * The SOLE implementation of final ordering,
 * context budget, authority labels, warnings, formatting, and UTF-8 byte
 * accounting for the per-turn injection. The installed hook is a thin adapter
 * around this; the evaluator imports the same function — so a measured number
 * describes the exact bytes the agent receives, never a pre-cap selection.
 *
 * Formatting: header line, one
 * `- <id>[ [observation]]: <summary>` line per accepted hit, first line that
 * would exceed the cap stops packing (no skip-and-continue), degraded-store
 * warning appended only if it fits.
 *
 * @param {Array<{id, summary, tier, score}>} hits  ranked hits (retrieveContext output)
 * @param {object} [opts]
 * @param {number} [opts.byteCap=2048]  UTF-8 byte budget for the whole pack
 * @param {{degraded, duplicate_conflicts}|null} [opts.health=null]  storeHealth() result
 * @returns {{text: string, bytes: number,
 *   accepted: Array<{id, tier, score}>,
 *   excluded: Array<{id, tier, score, reason: string}>,
 *   warnings: string[]}}
 */
export function buildFinalContextPack(hits, { byteCap = 2048, health = null } = {}) {
  const accepted = [], excluded = [], warnings = [];
  if (!hits || !hits.length) return { text: '', bytes: 0, accepted, excluded, warnings };

  const HEADER = 'Relevant stored context (CORE per-turn retrieval):\n';
  // The cap binds ABSOLUTELY. A cap smaller
  // than the header delivers an empty pack, every hit excluded, and the
  // constraint named in warnings — never bytes > byteCap in violation of the
  // pack's own contract.
  if (Buffer.byteLength(HEADER, 'utf8') > byteCap) {
    for (const h of hits) excluded.push({ id: h.id, tier: h.tier, score: h.score, reason: 'byte-cap' });
    warnings.push(`byteCap ${byteCap} is below the ${Buffer.byteLength(HEADER, 'utf8')}-byte pack header — nothing delivered`);
    return { text: '', bytes: 0, accepted, excluded, warnings };
  }

  let out = HEADER;
  let capped = false;
  for (const h of hits) {
    const tierTag = h.tier === 'observation' ? ' [observation]' : '';
    const line = `- ${h.id}${tierTag}: ${h.summary}\n`;
    if (capped || Buffer.byteLength(out + line, 'utf8') > byteCap) {
      capped = true; // first over-cap line stops packing — the shipped hook semantic
      excluded.push({ id: h.id, tier: h.tier, score: h.score, reason: 'byte-cap' });
      continue;
    }
    out += line;
    accepted.push({ id: h.id, tier: h.tier, score: h.score });
  }
  if (health && health.degraded) {
    const warn = `⚠ CORE memory index degraded: ${(health.duplicate_conflicts || []).length} duplicate unit id(s) — run generate-summary-index for detail.\n`;
    if (Buffer.byteLength(out + warn, 'utf8') <= byteCap) {
      out += warn;
      warnings.push(warn.trim());
    }
  }
  return { text: out, bytes: Buffer.byteLength(out, 'utf8'), accepted, excluded, warnings };
}

export function main(argv) {
  const pack = argv.includes('--pack');
  const topIdx = argv.indexOf('--top');
  let topN = 3;
  if (topIdx >= 0) {
    const raw = argv[topIdx + 1];
    // Number('') is 0 and Number(undefined) is NaN — both must reach the validator, so
    // parse without a `|| default` that would swallow the operator's mistake.
    topN = raw === undefined ? NaN : Number(raw);
    try { requirePositiveInt(topN, '--top'); } catch (e) {
      process.stderr.write(`error: ${e.message} (got ${JSON.stringify(raw ?? null)})\n`);
      return 2;
    }
  }
  // Strip recognized flags AND --top's own value, leaving positional args.
  const args = argv.filter((a, i) => a !== '--top' && a !== '--pack' && !(topIdx >= 0 && i === topIdx + 1));
  // An unrecognized flag like a
  // fat-fingered `--query` must not fall into the positional args and get
  // silently treated as the literal query text — that returns a confident top
  // result for garbage input with no error or abstention signal. Since the CLI
  // invokes the exact same function agents use, a silently-corrupted
  // query here is a silently-corrupted measurement anywhere this CLI is used to
  // probe delivered bytes. Fail loud on any unrecognized `--` flag instead.
  const unrecognized = args.filter(a => a.startsWith('--'));
  if (unrecognized.length) {
    process.stderr.write(`error: unrecognized flag(s) ${unrecognized.join(', ')} -- did you mean to pass the query as a plain positional argument? usage: retrieve-context.mjs <storePath> "<query>" [--top N] [--pack]\n`);
    return 2;
  }
  const storePath = args[0];
  const query = args[1] || '';
  if (!storePath) { process.stderr.write('usage: retrieve-context.mjs <storePath> "<query>" [--top N] [--pack]\n'); return 2; }
  const hits = retrieveContext(query, storePath, { topN });
  if (pack) {
    // --pack emits the EXACT delivered bytes: same function, same cap,
    // same health input as the installed hook — so the CLI is a truthful probe of
    // what the agent would receive, not a debug approximation of it.
    const built = buildFinalContextPack(hits, { health: storeHealth(storePath) });
    if (built.text) process.stdout.write(built.text);
    return 0;
  }
  // Default: human debug listing (scores visible). NOT a final-context surface —
  // use --pack for delivered bytes.
  for (const h of hits) process.stdout.write(`[${h.score.toFixed(1)}] ${h.id} — ${h.summary}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
