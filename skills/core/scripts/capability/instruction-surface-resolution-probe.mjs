/**
 * instruction-surface-resolution-probe.mjs — v2.7.0 §5 Claude-Code observability.
 *
 * Reports which CLAUDE.md instruction files Claude Code would load for the current
 * cwd, and in what precedence order. This is the instruction-surface analogue of
 * the auto-memory probe: it OBSERVES the surface (which files load); it does not
 * generate or normalize it — that's v3.0's instruction-surface adapter.
 *
 * Precedence chain (this probe's model of Claude Code's load order):
 *   1. user-global  ~/.claude/CLAUDE.md
 *   2. project      every CLAUDE.md from filesystem root down to cwd
 *      (root first, nearest-cwd last = highest precedence)
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
  ancestors.reverse();
  for (const d of ancestors) chain.push({ path: join(d, 'CLAUDE.md'), scope: 'project' });
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
    capability_name: 'Instruction surface resolution (CLAUDE.md precedence chain)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    cwd,
    instruction_chain,           // ordered resolved files, precedence order
    identity_status,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    evidence,
  };
}
