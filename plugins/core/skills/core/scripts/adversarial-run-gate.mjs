/**
 * adversarial-run-gate.mjs — v2.7.0 consumer gate for multi-agent adversarial runs.
 *
 * This is the CONSUMER that makes the `anti-anchoring-mechanism` capability row
 * load-bearing. A row that says mutation_permitted=false is only worth anything
 * if something reads it; this module reads the actual row (not a policy string)
 * and turns it into a typed authority/advisory decision per HC's policy:
 *
 *   - fail-OPEN for advisory analysis/review generation — allowed, but loudly
 *     watermarked DEGRADED/trust-based; independent agent/human acceptance is
 *     required before any canonical mutation.
 *   - fail-CLOSED when the adversarial output is the AUTHORITY for a mutation
 *     (graduating a unit, rendering PROJECT.md, approving a release gate,
 *     merging/publishing, writing canonical plan state). Authority requires a
 *     PASS-grade anti-anchoring mechanism — which on Claude Code is DEGRADED
 *     (trust-based, R-17) until v2.8.0 staging lands.
 *
 * Boundary: this is v2.7 consumer ENFORCEMENT only. It does not provide the
 * v2.8 staged/physical isolation proof or any v3 memory-visibility proof.
 *
 * The script ships with the plugin by convention. The plugin ships .mjs (Node.js) only.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runPreAction } from './capability-probe.mjs';

export const ADVERSARIAL_ACTION = 'multi-agent-adversarial-run';
export const ADVISORY_WATERMARK =
  'DEGRADED/trust-based (R-17): advisory only — independent agent/human acceptance required before any canonical mutation';

// Machine-readable decision enum (HC_555 hardening): a consumer branches on the
// single `decision` string instead of re-deriving intent from the booleans +
// watermark, which is too easy to misread (ADVISORY must never look like AUTHORIZED).
export const ADVERSARIAL_DECISIONS = Object.freeze(['AUTHORIZED', 'ADVISORY', 'BLOCKED']);

/**
 * Read the anti-anchoring-mechanism row out of a runPreAction result and return
 * a typed decision. Pure function over the result shape — easy to test, and it
 * inspects the REAL row, so mutation_permitted=false is genuinely consumed.
 *
 * @param {{rows?: object[]}} preActionResult — output of runPreAction(ADVERSARIAL_ACTION, ...)
 * @returns {{authority_for_mutation: boolean, advisory_allowed: boolean, watermark: string|null, blocked_reason: string|null, anti_anchoring_status: string|null}}
 */
export function classifyAdversarialRun(preActionResult) {
  const rows = preActionResult?.rows || [];
  const row = rows.find((r) => r && r.capability_id === 'anti-anchoring-mechanism');

  // Row absent — the capability isn't even declared/probed. Don't silently allow
  // anything: we can't authorize a mutation, and we can't confirm an advisory
  // context either. Surface it as a setup anomaly.
  if (!row) {
    return {
      decision: 'BLOCKED',
      authority_for_mutation: false,
      advisory_allowed: false,
      watermark: 'anti-anchoring-mechanism row absent — cannot authorize or advise; check the descriptor',
      blocked_reason: 'anti-anchoring-row-absent',
      anti_anchoring_status: null,
    };
  }

  if (row.identity_status === 'PASS') {
    // M9 / Doctrine 4 (fail-closed mutation): identity PASS alone is NOT authority.
    // runPreAction applies operation-scoped gates (authority, harness, signal-weight)
    // and sets row.mutation_permitted=false with a stable mutation_block_reason when an
    // otherwise-PASS row is denied for THIS action — e.g. the adversarial action declares
    // allowed_harnesses, so an unknown/mismatched consuming harness blocks mutation even on
    // a PASS identity. A consumer is mandated (HC_555) to branch on `decision`, so the
    // operation-scoped denial has to be folded INTO `decision` or it's invisible: AUTHORIZED
    // would mutate on a gate the runner already closed. Only an explicit `false` blocks —
    // an undefined field (identity-only row, e.g. startup mode) keeps the AUTHORIZED path.
    if (row.mutation_permitted === false) {
      return {
        decision: 'ADVISORY',
        authority_for_mutation: false,
        advisory_allowed: true,
        watermark: ADVISORY_WATERMARK,
        blocked_reason: row.mutation_block_reason || 'mutation-gate-denied',
        anti_anchoring_status: 'PASS',
      };
    }
    return {
      decision: 'AUTHORIZED',
      authority_for_mutation: true,
      advisory_allowed: true,
      watermark: null,
      blocked_reason: null,
      anti_anchoring_status: 'PASS',
    };
  }

  // DEGRADED / UNKNOWN / NOT-YET — advisory runs are fail-open (allowed, watermarked);
  // mutation authority is fail-closed (blocked). UNKNOWN explicitly does NOT grant authority.
  return {
    decision: 'ADVISORY',
    authority_for_mutation: false,
    advisory_allowed: true,
    watermark: ADVISORY_WATERMARK,
    blocked_reason: `identity-${String(row.identity_status).toLowerCase()}`,
    anti_anchoring_status: row.identity_status,
  };
}

/**
 * Full consumer entry point: run the pre-action gate for the adversarial action,
 * then classify. opts is passed through to runPreAction (harness, descriptor,
 * _importer test seam, etc.).
 */
export async function evaluateAdversarialRun(opts = {}) {
  const preAction = await runPreAction(ADVERSARIAL_ACTION, opts);
  const decision = classifyAdversarialRun(preAction);
  return { ...decision, gate: { permitted: preAction.permitted, block_reason: preAction.block_reason } };
}

// --- CLI entry --------------------------------------------------------------
// Library-only through v3.2.x: the gate had no runnable entry, so analysis.md
// (its only consumer) couldn't actually invoke it and the gate shipped dormant.
// This entry makes it runnable from a skill via Bash and prints the typed
// `decision` so the protocol branches on one string instead of re-deriving
// intent from booleans (the HC_555 hazard).

function parseFlags(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++; }
    else flags.set(key, true);
  }
  return flags;
}

function renderMd(d) {
  const lines = [
    `# Adversarial-run gate: ${d.decision}`,
    '',
    `- authority for canonical mutation: ${d.authority_for_mutation ? 'yes' : 'NO'}`,
    `- advisory/review generation: ${d.advisory_allowed ? 'allowed' : 'NOT allowed'}`,
    `- anti-anchoring status: ${d.anti_anchoring_status ?? 'n/a'}`,
  ];
  if (d.watermark) lines.push('', `> ${d.watermark}`);
  return lines.join('\n') + '\n';
}

export async function main(argv) {
  const flags = parseFlags(argv);
  const harness = typeof flags.get('harness') === 'string' ? flags.get('harness') : undefined;
  let decision;
  try {
    decision = await evaluateAdversarialRun({ harness });
  } catch (err) {
    process.stderr.write(`error: adversarial-run-gate failed: ${err.message}\n`);
    return 2;
  }
  process.stdout.write(flags.get('md') ? renderMd(decision) : `${JSON.stringify(decision, null, 2)}\n`);
  // Exit code lets a shell caller branch without parsing: BLOCKED (setup
  // anomaly — no decidable row) is non-zero; AUTHORIZED and ADVISORY are 0
  // (advisory runs are fail-open by design — allowed, just watermarked).
  return decision.decision === 'BLOCKED' ? 1 : 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_cliEntryCanonical(process.argv[1]) === _cliEntryCanonical(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
