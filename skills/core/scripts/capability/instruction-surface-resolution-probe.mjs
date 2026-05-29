/**
 * instruction-surface-resolution-probe.mjs — v2.7.0 §5 Claude-Code observability.
 *
 * A PARTIAL filesystem heuristic over the documented Claude Code memory surfaces
 * for the current cwd — user/project/.claude/local CLAUDE.md files — reported in
 * precedence order. It OBSERVES a partial surface; it does NOT resolve @imports,
 * managed-policy memory, excludes, or .claude/rules, and it does not generate or
 * normalize instructions (that's v3.0's instruction-surface adapter). The row
 * carries documented_surfaces_not_probed so it never overclaims full "resolution"
 * (HC_614 #2). Docs: https://docs.anthropic.com/en/docs/claude-code/memory
 *
 * Precedence chain (partial, filesystem-only):
 *   1. user-global  ~/.claude/CLAUDE.md
 *   2. project      CLAUDE.md, .claude/CLAUDE.md, CLAUDE.local.md at every dir
 *                   from filesystem root down to cwd (nearest-cwd = highest precedence)
 *   NOT probed: managed-policy memory, @imports + max-depth, excludes, .claude/rules
 *
 * Identity_status (honest):
 *   PASS     — chain resolved; ≥1 readable, non-empty instruction file
 *   DEGRADED — a file in the chain exists but is empty or unreadable (present-but-unusable)
 *   NOT-YET  — no CLAUDE.md anywhere in the chain
 *   UNKNOWN  — could not resolve home/cwd
 *
 * Called by capability-probe.mjs when the descriptor declares
 * delegate: 'capability/instruction-surface-resolution-probe.mjs'.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'instruction-surface-resolution';

/**
 * Build the ordered precedence chain of CLAUDE.md paths for a cwd: user-global
 * first, then project files from root down to cwd (nearest-cwd last). Pure path
 * construction — no IO — so it's testable on its own.
 */
export function buildPrecedenceChain(cwd, home) {
  const chain = [{ path: join(home, '.claude', 'CLAUDE.md'), scope: 'user-global' }];
  const ancestors = [];
  let dir = cwd;
  // Walk cwd → root, then reverse so the chain reads root → cwd.
  // Bounded by the filesystem root (dirname(root) === root).
  for (let i = 0; i < 256; i++) {
    ancestors.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  ancestors.reverse(); // root → cwd (nearest-cwd last = highest precedence)
  for (const d of ancestors) {
    chain.push({ path: join(d, 'CLAUDE.md'), scope: 'project' });
    chain.push({ path: join(d, '.claude', 'CLAUDE.md'), scope: 'project-claude-dir' });
    chain.push({ path: join(d, 'CLAUDE.local.md'), scope: 'local' });
  }
  return chain;
}

function fileState(path) {
  if (!existsSync(path)) return 'absent';
  try {
    return readFileSync(path, 'utf8').trim().length > 0 ? 'present' : 'empty';
  } catch {
    return 'unreadable';
  }
}

/**
 * Pure classifier over the chain's per-file states. Separated from IO for testing.
 * @param {{path:string, scope:string, state:string}[]} chainStates
 */
export function classifyInstructionSurface(chainStates) {
  const present = chainStates.filter((c) => c.state === 'present');
  const degraded = chainStates.filter((c) => c.state === 'empty' || c.state === 'unreadable');

  if (present.length === 0 && degraded.length === 0) {
    return {
      identity_status: 'NOT-YET',
      evidence: [{ source: 'instruction-chain', value: 'no CLAUDE.md found in user-global or project chain', agrees_with_others: true, weight: 'corroborating' }],
    };
  }

  const evidence = [];
  // highest-precedence present file (nearest cwd, i.e. last) gets primary
  present.forEach((c, i) => evidence.push({
    source: 'instruction-file',
    value: { path: c.path, scope: c.scope, state: 'present' },
    agrees_with_others: true,
    weight: i === present.length - 1 ? 'primary' : 'corroborating',
  }));
  degraded.forEach((c) => evidence.push({
    source: 'instruction-file',
    value: { path: c.path, scope: c.scope, state: c.state },
    agrees_with_others: false,
    weight: 'conflicting',
  }));

  return { identity_status: degraded.length > 0 ? 'DEGRADED' : 'PASS', evidence };
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const observed_at = new Date().toISOString();

  let chain;
  try {
    chain = buildPrecedenceChain(cwd, home);
  } catch {
    return buildRow({
      identity_status: 'UNKNOWN',
      evidence: [{ source: 'precedence-chain', value: 'could not resolve home/cwd', agrees_with_others: false, weight: 'conflicting' }],
      cwd, instruction_chain: [], observed_at,
    });
  }

  const chainStates = chain.map((c) => ({ ...c, state: fileState(c.path) }));
  const { identity_status, evidence } = classifyInstructionSurface(chainStates);
  const resolved = chainStates.filter((c) => c.state !== 'absent').map((c) => ({ path: c.path, scope: c.scope, state: c.state }));

  return buildRow({ identity_status, evidence, cwd, instruction_chain: resolved, observed_at });
}

function buildRow({ identity_status, evidence, cwd, instruction_chain, observed_at }) {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Instruction surface — partial CLAUDE.md filesystem heuristic (user/project/.claude/local; not imports, managed-policy, or .claude/rules)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    cwd,
    instruction_chain,           // ordered resolved files, precedence order (partial)
    // Honest residual (HC_614 #2): documented Claude Code memory surfaces this
    // filesystem heuristic does NOT probe — so the row never reads as full resolution.
    documented_surfaces_not_probed: ['managed-policy-memory', '@imports', 'excludes', '.claude/rules'],
    identity_status,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    evidence,
  };
}
