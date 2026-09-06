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
