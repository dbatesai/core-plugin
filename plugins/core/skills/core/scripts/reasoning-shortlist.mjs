/**
 * reasoning-shortlist.mjs — the per-turn reasoning escalation, model-free half.
 *
 * Three pure pieces the per-turn hook and the offline harness share:
 *   thinSignal / shouldEscalate — decides when keyword retrieval is too thin to trust,
 *   buildReasoningShards        — orders the exhaustive candidate shards so the likely
 *                                 units come first (enrichment arm, then substrate),
 *   renderEscalationPack        — the byte-capped text the hook injects.
 * No model runs here. The agent that receives the pack does the reasoning.
 * Ships with the plugin; Node only.
 */
import { resolve } from 'node:path';
import { tokenize, bm25Scores, bm25DocumentScores } from './bm25.mjs';
import { productRankedScores } from './retrieve-context.mjs';
import { loadSnapshot } from './generate-summary-index.mjs';

// Trigger defaults. `flatTop` is the second-best raw body-BM25 score divided by the best:
// a literal question has one clear winner (well under 0.8); an abstract question has a
// crowd of equally weak matches (0.8 and up). Scale-free, so it carries across stores.
export const MIN_TERMS_DEFAULT = 4;
export const FLAT_FLOOR_DEFAULT = 0.8;

const QUESTION_OPENERS = /^\s*(should|can|could|is|are|do|does|did|what|which|how|why|when|where|would|will|has|have|was|were|any|if)\b/i;
const QUESTION_SHAPES = /\b(should i|should we|can i|can we|do i|do we|is it|are we|is there)\b/i;

/** A prompt shaped like a question. Slash commands and imperatives are not questions. */
export function isQuestionPrompt(text) {
  const t = String(text || '').trim();
  if (!t || t.startsWith('/')) return false;
  return /\?\s*$/.test(t) || QUESTION_OPENERS.test(t) || QUESTION_SHAPES.test(t);
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Thresholds, env-overridable for harness sweeps; never read from the project store. */
export function escalationThresholds() {
  return {
    minTerms: envNumber('CORE_ESCALATION_MIN_TERMS', MIN_TERMS_DEFAULT),
    flatFloor: envNumber('CORE_ESCALATION_FLAT_FLOOR', FLAT_FLOOR_DEFAULT),
  };
}

/** How thin the keyword result is for this prompt on this store. */
export function thinSignal(query, storePath, { snapshot = null } = {}) {
  const root = resolve(storePath);
  const snap = snapshot || loadSnapshot(root, { captureBodies: true });
  const qterms = new Set(tokenize(query)).size;
  const body = bm25Scores(query, root, { snapshot: snap }).map(s => s.score).sort((a, b) => b - a);
  const top = body[0] || 0;
  const second = body[1] || 0;
  const substrate = productRankedScores(query, root, null, snap);
  return {
    qterms,
    isQuestion: isQuestionPrompt(query),
    top: +top.toFixed(4),
    flatTop: top > 0 ? +(second / top).toFixed(4) : 1,
    zeroHit: substrate.length === 0,
  };
}

/** Escalate on an empty result, or on a question whose keyword ranking has no clear winner. */
export function shouldEscalate(signal, thresholds = escalationThresholds()) {
  if (!signal) return false;
  if (signal.zeroHit) return true;
  return Boolean(signal.isQuestion) && signal.qterms >= thresholds.minTerms && signal.flatTop >= thresholds.flatFloor;
}

const SUMMARY_CLIP = 160;
const clip = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > SUMMARY_CLIP ? `${t.slice(0, SUMMARY_CLIP - 1)}…` : t;
};

/**
 * The first `shards` candidate shards over the active corpus, ordered so the likely
 * units come first: enrichment-arm score (descending), then the shipped substrate
 * rank, then unit id. With no enrichment sidecar this is exactly the exhaustive
 * shard plan `select-relevant-units.mjs` emits, so an unenriched store degrades to
 * today's order. The union of all shards is every active unit exactly once.
 */
export function buildReasoningShards(query, storePath, { shards = 2, shardSize = 80, snapshot = null } = {}) {
  const root = resolve(storePath);
  const snap = snapshot || loadSnapshot(root, { captureBodies: true });
  const units = snap.index.units;
  const enrichment = new Map(
    bm25DocumentScores(query, snap.enrichments?.documents || []).filter(s => s.score > 0).map(s => [s.id, s.score]),
  );
  const substrateRank = new Map(productRankedScores(query, root, null, snap).map((s, i) => [s.id, i]));
  const rankOf = (id) => (substrateRank.has(id) ? substrateRank.get(id) : Infinity);
  const ordered = [...units].sort((a, b) =>
    (enrichment.get(b.id) || 0) - (enrichment.get(a.id) || 0)
    || rankOf(a.id) - rankOf(b.id)
    || a.id.localeCompare(b.id));
  const size = Math.max(1, shardSize);
  const total = Math.ceil(ordered.length / size);
  const out = [];
  for (let i = 0; i < Math.min(Math.max(0, shards), total); i++) {
    const slice = ordered.slice(i * size, (i + 1) * size);
    out.push({
      shard: i,
      shard_count: total,
      units_total: ordered.length,
      rows: slice.map(u => ({ id: u.id, tier: u.tier || 'canonical', summary: clip(u.summary) })),
    });
  }
  return out;
}

// The injected pack's budget. Two shards of 80 rows at ~180 bytes is ~29KB (~7K
// tokens), paid only on escalated turns. The env override can lower it, never raise it.
export const ESCALATION_BYTE_CAP = 32768;
export const ESCALATION_HEADER = 'CORE memory escalation: the keyword search was thin for this prompt. Before answering, read the candidate memory units below (id — summary), pick the ones that actually bear on the question by reasoning about what it asks (the situation, the judgment, the analogy), Read those units in full, and cite them. If none apply, say so; do not invent memory.';

export function escalationByteCap() {
  const raw = Number(process.env.CORE_ESCALATION_BYTE_CAP);
  return Number.isFinite(raw) && raw > 0 ? Math.min(ESCALATION_BYTE_CAP, Math.floor(raw)) : ESCALATION_BYTE_CAP;
}

/** The text the hook injects: the header, then one `id — summary` row per unit, cut at a whole row. */
export function renderEscalationPack(shards, { byteCap = escalationByteCap() } = {}) {
  const lines = [ESCALATION_HEADER];
  let bytes = Buffer.byteLength(ESCALATION_HEADER, 'utf8');
  let rows = 0;
  let truncated = false;
  for (const shard of shards || []) {
    for (const r of shard.rows || []) {
      const line = `${r.id} — ${r.summary}`;
      const add = Buffer.byteLength(line, 'utf8') + 1;
      if (bytes + add > byteCap) { truncated = true; break; }
      lines.push(line);
      bytes += add;
      rows += 1;
    }
    if (truncated) break;
  }
  return { text: `${lines.join('\n')}\n`, rows, truncated };
}
