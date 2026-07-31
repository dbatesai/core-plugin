/**
 * outcome-vocab.mjs — the read-side vocabulary and authority resolver for
 * retrieval-outcome rows.
 *
 * Outcome rows live in per-session `outcome-log.jsonl` files; stores can carry
 * them from earlier producers, and readers (analyze-retrieval-quality.mjs,
 * metrics-package.mjs) still fold them into resolved outcomes. The WRITER
 * (record-retrieval-outcome.mjs and the per-turn pending-marker mechanism)
 * was deleted from the shipped tree; this module keeps only what reading
 * historical rows requires.
 *
 * Ships with the plugin as a script; .mjs only.
 */

// Contract: 'unknown' is a first-class honest state; evidence AUTHORITY is
// carried separately from the outcome so weak attribution can never look
// confirmed.
export const USEFULNESS_OUTCOMES = new Set(['useful', 'partial', 'noisy', 'miss', 'unknown']);
export const EVIDENCE_AUTHORITY = new Set(['user-confirmed', 'objective-task-success', 'corrective-retry', 'agent-attribution', 'unobservable']);

// Shared authority resolver — ONE resolver across consumers.
// Every consumer that folds multiple outcome
// rows for one retrieval_id down to a single resolved outcome must go
// through this — analyze-retrieval-quality.mjs and metrics-package.mjs both
// do. Highest evidence_authority wins; a tie among top-ranked rows that
// disagree resolves to 'unknown' rather than picking arbitrarily.
export const AUTHORITY_RANK = { 'user-confirmed': 4, 'objective-task-success': 3, 'corrective-retry': 2, 'agent-attribution': 1, 'unobservable': 0 };

export function resolveOutcomeAuthority(rows) {
  if (!rows || !rows.length) return null;
  // An authority outside the closed set is not weak evidence, it is unrecognized
  // evidence. Ranking it at 0 put it level with the honest 'unobservable' floor, where
  // a drifted or hand-edited row could win a tie and set the resolved outcome.
  const ranked = rows
    .filter((r) => r && USEFULNESS_OUTCOMES.has(r.usefulness_outcome) && EVIDENCE_AUTHORITY.has(r.evidence_authority))
    .map((r) => ({ outcome: r.usefulness_outcome, rank: AUTHORITY_RANK[r.evidence_authority] }));
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.rank - a.rank);
  const top = ranked.filter((r) => r.rank === ranked[0].rank);
  const distinct = new Set(top.map((r) => r.outcome));
  return distinct.size === 1 ? top[0].outcome : 'unknown';
}
