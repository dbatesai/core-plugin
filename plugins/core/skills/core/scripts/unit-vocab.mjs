/**
 * unit-vocab.mjs — the ONE canonical vocabulary for unit frontmatter.
 *
 * Every enforcement script (check-units, bitemporal, demote-moves,
 * demote-state-narrative, metrics-detectors) imports its status vocabulary
 * from here, so the sets cannot diverge between consumers:
 *   - VALID_STATUSES is the schema's four: active/retired/archived/superseded.
 *   - TERMINAL_STATUSES = VALID_STATUSES minus 'active'. 'retired' units
 *     demote their PROJECT.md bullets like any other terminal status.
 *   - 'resolved' and 'closed' are NOT blessed: not in the schema, and
 *     check-units WARNs status-value on them. Stores carrying them should
 *     normalize to 'retired' (work finished) or 'superseded' (replaced).
 *   - confidence-level / stability-class values come straight from
 *     references/external-sources/source-registration-framework.md.
 *
 * This module imports NOTHING, so any script — including priority.mjs, the
 * base unit module — can depend on it without an import cycle.
 */

export const VALID_STATUSES = new Set(['active', 'retired', 'archived', 'superseded']);

// The one in-flight status, and it is INBOX-ONLY. An observation waiting on
// graduation is a block in inbox.md, not a unit in the store: check-inbox
// requires this value on the block, and graduation stamps 'active' when it
// writes the unit. Deliberately absent from VALID_STATUSES — a unit carrying it
// is a block that reached the store without graduating, which check-units
// reports as status-value. One name, so an extractor cannot invent another.
export const INBOX_DRAFT_STATUS = 'draft';

// Every valid status except 'active'. A terminal unit's fact is no longer
// load-bearing: demotion treats its citations as closed, and the bitemporal
// writer may stamp t_invalid on it when a supersedes edge confirms the
// transition the status already acknowledges.
export const TERMINAL_STATUSES = new Set(['retired', 'archived', 'superseded']);

// True when a unit's status makes it eligible for default retrieval — missing,
// empty, or 'active'. A terminal status (retired/archived/superseded) means the
// fact was removed or replaced and must NOT surface in the default candidate set.
// The one shared answer to "is this fact still showable?" — applied at every read
// site (graph-walk, rankUnits, the summary index) so the anti-resurrection rule
// can't hold in one consumer and silently fail in another.
export function isActiveStatus(fm) {
  const s = fm && (fm.status === undefined || fm.status === null)
    ? 'active'
    : String((fm && fm.status) || '').trim().toLowerCase();
  return s === '' || s === 'active';
}

export const VALID_TYPES = new Set([
  'decision', 'risk', 'person', 'deliverable', 'principle',
  'explainer', 'review-finding', 'observation', 'topic', 'reference',
  'feedback', 'memory', 'open-question', 'premise',
]);

// Premises are axioms, not trade-offs: a decision that violates a premise is wrong
// by definition (distinct from 'principle', which guides). They live on the always-
// loaded Critical Premises surface and do not decay — the staleness/archive-candidate
// check exempts them (a premise that's rarely touched is settled, not stale). See the
// EXEMPT_FROM_STALENESS set below.
export const EXEMPT_FROM_STALENESS = new Set(['premise']);

export const VALID_EDGE_TYPES = new Set([
  'cites', 'supersedes', 'superseded-by', 'depends-on', 'conflicts-with',
  'references-person', 'references-topic',
  'depended-on-by', 'supersedes-claim',
  // Both are semantically distinct from supersedes — 'refines' sharpens/elaborates a prior
  // decision without replacing it; 'amends' modifies specific parts while the prior
  // stands. Distinct intent → first-class, not relabeled away.
  'refines', 'amends',
]);

// Weak/informal edge types that carry no distinct semantics — normalize to a committed type
// rather than blessing a near-synonym. The /process-memory safe-fix flow applies these as an
// applyable relabel; the validator names the target in the edge-unknown-type detail so the
// fix is mechanical, not a guess.
export const EDGE_TYPE_NORMALIZE = {
  'relates': 'cites',
  'relates-to': 'cites',
  'related': 'cites',
};

// source-registration-framework.md §Annotation frameworks:
//   confidence-level: sourced | inferred | reconstructed
//   stability-class:  durably-correct | durably-suspect
export const VALID_CONFIDENCE_LEVELS = new Set(['sourced', 'inferred', 'reconstructed']);
export const VALID_STABILITY_CLASSES = new Set(['durably-correct', 'durably-suspect']);

// decorate-graph.mjs's generated-edges markers. Shared here (not defined in
// decorate-graph.mjs itself) so generate-summary-index.mjs can strip the
// block from the BM25-facing body derivation without an import cycle
// (decorate-graph.mjs imports loadSnapshot FROM generate-summary-index.mjs).
export const EDGES_BEGIN = '<!-- CORE:BEGIN_EDGES -->';
export const EDGES_END = '<!-- CORE:END_EDGES -->';
