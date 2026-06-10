/**
 * unit-vocab.mjs — the ONE canonical vocabulary for unit frontmatter.
 *
 * Before this module, the enforcement scripts carried four diverging copies of
 * the status vocabulary (SYN-005 / MEM-006 / SCH-003):
 *   check-units VALID_STATUSES              active/retired/archived/superseded
 *   bitemporal TERMINAL_STATUSES            retired/superseded/archived
 *   demote-moves TERMINAL_STATUSES          resolved/archived/superseded/closed
 *   demote-state-narrative TERMINAL_STATUSES resolved/archived/superseded/closed
 *   metrics-detectors STABLE_STATUSES       final/stable/foundational/closed/…
 *
 * Reconciliation (2026-06-09):
 *   - VALID_STATUSES stays the schema's four: active/retired/archived/superseded.
 *   - TERMINAL_STATUSES = VALID_STATUSES minus 'active'. 'retired' units now
 *     demote their PROJECT.md bullets — they never did, which stranded every
 *     retired-backed bullet on the agenda.
 *   - 'resolved' and 'closed' are NOT blessed: never in the schema, zero units
 *     used them on the 2026-05-27 corpus check, and check-units already WARNs
 *     status-value on them. Stores carrying them should normalize to 'retired'
 *     (work finished) or 'superseded' (replaced).
 *   - confidence-level / stability-class values come straight from
 *     references/external-sources/source-registration-framework.md.
 *
 * This module imports NOTHING, so any script — including priority.mjs, the
 * base unit module — can depend on it without an import cycle.
 */

export const VALID_STATUSES = new Set(['active', 'retired', 'archived', 'superseded']);

// Every valid status except 'active'. A terminal unit's fact is no longer
// load-bearing: demotion treats its citations as closed, and the bitemporal
// writer may stamp t_invalid on it when a supersedes edge confirms the
// transition the status already acknowledges.
export const TERMINAL_STATUSES = new Set(['retired', 'archived', 'superseded']);

export const VALID_TYPES = new Set([
  'decision', 'risk', 'person', 'deliverable', 'principle',
  'explainer', 'review-finding', 'observation', 'topic', 'reference',
  'feedback', 'memory', 'open-question',
]);

export const VALID_EDGE_TYPES = new Set([
  'cites', 'supersedes', 'superseded-by', 'depends-on', 'conflicts-with',
  'references-person', 'references-topic',
  'depended-on-by', 'supersedes-claim',
  // Blessed 2026-06-03 (2-corpus evidence, obs-20260603-edge-type-validation-gap-cross-corpus):
  // both are semantically distinct from supersedes — 'refines' sharpens/elaborates a prior
  // decision without replacing it (CORE); 'amends' modifies specific parts while the prior
  // stands (local-llm-build / BBLens). Distinct intent → first-class, not relabeled away.
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
