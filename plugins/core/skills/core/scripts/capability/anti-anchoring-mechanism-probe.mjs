/**
 * anti-anchoring-mechanism-probe.mjs — v2.7.0 R-17 honest demotion (Claude Code).
 *
 * Reports the mechanism behind CORE's adversarial anti-anchoring discipline. On
 * Claude Code today it is TRUST-BASED: when the protocol runs the Critic before
 * it sees the Generator's output, the discipline depends on the Critic agent
 * voluntarily not reading the Generator's artifacts. There is no per-agent
 * working-directory isolation in Claude Code's task spawn, so the harness cannot
 * mechanically enforce it. This row exists to stop that gap from reading as an
 * implicit PASS.
 *
 * Per v2.7.0 plan §6: emit identity_status DEGRADED with mechanism 'trust-based',
 * evidence pointing at the R-17 risk unit, and a stated closure target. The
 * stronger two-row split (staged-initial-frame-isolation PASS +
 * physical-filesystem-isolation NOT-YET) plus the negative-read proof ship in
 * v2.8.0 — see docs/plans/2026-05-28-v2.8.0-multi-agent-validation-layer.md §7.
 *
 * Called by capability-probe.mjs when the descriptor declares
 * delegate: 'capability/anti-anchoring-mechanism-probe.mjs'.
 *
 * Identity_status: always DEGRADED on Claude Code until the isolation mechanism ships (unscheduled).
 * This is a deliberate honest demotion, not a dynamic check — the negative-read
 * proof that could earn PASS is a v2.8.0 deliverable.
 *
 * The script ships with the plugin by design. The plugin ships .mjs only, zero dependencies.
 */

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'anti-anchoring-mechanism';
// MET-007 honesty: 'v2.9+' became a stale promise — v2.9 through v3.7 all shipped
// without closing R-17. No version promise until the isolation mechanism is actually
// scheduled; CLOSURE_REQUIREMENT carries the real bar. The row stays in the startup
// run deliberately: the descriptor's adversarial-run-gate action fail-closes on this
// capability, and that gate is the row's consumer. Its per-session DEGRADED entries
// are bounded by the history retention cap and deduped by row_content_hash.
export const CLOSURE_TARGET = 'unscheduled';
export const CLOSURE_REQUIREMENT =
  'requires physical anti-anchoring isolation (per-agent working-directory) + initial-frame-before-peer-exposure staging before closure; no target version is promised until that work is scheduled';
export const CLOSURE_MECHANISM_PLANNED =
  'per-agent working-directory isolation (native Workflow/Agent isolation:"worktree" is a candidate primitive — local-llm-build uses it) + initial-frame-before-peer-exposure staging';
// The risk unit this row points at (must stay in sync with <project>/_memories/).
export const RISK_UNIT = 'risk-17-trust-based-anti-anchoring-claude-code';

export async function probe(opts = {}) {
  return buildRow({ observed_at: new Date().toISOString(), cwd: opts.cwd || process.cwd() });
}

function buildRow({ observed_at, cwd }) {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Anti-anchoring mechanism (adversarial Critic-before-Generator)',
    capability_kind: 'runtime',          // reports what the harness CAN mechanically enforce
    mechanism: 'trust-based',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    cwd,
    identity_status: 'DEGRADED',
    // DEGRADED identity necessarily blocks any mutation that would require it.
    mutation_permitted: false,
    mutation_block_reason: 'identity-degraded',
    closure_target: CLOSURE_TARGET,
    closure_requirement: CLOSURE_REQUIREMENT,
    closure_mechanism_planned: CLOSURE_MECHANISM_PLANNED,
    evidence: [
      {
        source: 'harness-affordance',
        value: 'no per-agent working-directory isolation in Claude Code task spawn; Critic-before-Generator is voluntary, not enforced',
        agrees_with_others: false,
        weight: 'conflicting',           // this is what blocks PASS
      },
      {
        source: 'risk-unit-pointer',
        value: RISK_UNIT,
        agrees_with_others: true,
        weight: 'corroborating',
      },
    ],
  };
}
