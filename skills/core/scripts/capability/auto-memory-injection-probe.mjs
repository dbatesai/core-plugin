/**
 * auto-memory-injection-probe.mjs — v2.7.0 Claude-Code-specific capability.
 *
 * Probes whether the harness's auto-loaded memory surface is present and carries
 * its expected structure. On Claude Code, that's
 * ~/.claude/projects/<mapped-cwd>/memory/MEMORY.md — loaded automatically at
 * session start. This is the file-present + canary check; it does NOT prove the
 * agent actually loaded the content into context (that's v3.0's
 * memory-visible-in-agent-context with a dynamic per-session canary).
 *
 * Called by capability-probe.mjs when the descriptor declares
 * delegate: 'capability/auto-memory-injection-probe.mjs'.
 *
 * Why this matters: DC-94 named recognition-failure (the agent has memory loaded
 * but doesn't reach for it) as upstream of retrieval failure. This row is the
 * first observable signal that the auto-memory surface even exists for this cwd.
 *
 * Identity_status:
 *   PASS     — MEMORY.md exists AND contains the canary marker
 *   DEGRADED — MEMORY.md exists but the canary marker is absent (structure drift)
 *   NOT-YET  — MEMORY.md does not exist for this mapped cwd
 *   UNKNOWN  — could not resolve the mapped path (no HOME, etc.)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'auto-memory-injection';
// Structural marker every CORE-managed MEMORY.md carries (written by /finalize Step 5).
export const CANARY = '## Recent activity';

/**
 * Map an absolute cwd to the Claude Code project-memory directory name.
 * Claude Code replaces every '/' in the absolute path with '-'.
 * /Users/dbates/Documents/Projects/CORE → -Users-dbates-Documents-Projects-CORE
 */
export function mappedMemoryPath(cwd, home = homedir()) {
  const mapped = cwd.replace(/\//g, '-');
  return join(home, '.claude', 'projects', mapped, 'memory', 'MEMORY.md');
}

/**
 * Pure classifier — given file-existence and content, return status + evidence.
 * Separated from IO so it's unit-testable without touching the filesystem.
 */
export function classifyMemoryState({ pathResolved, fileExists, content }) {
  if (!pathResolved) {
    return {
      identity_status: 'UNKNOWN',
      evidence: [{ source: 'mapped-path', value: 'could not resolve mapped memory path', agrees_with_others: false, weight: 'conflicting' }],
    };
  }
  if (!fileExists) {
    return {
      identity_status: 'NOT-YET',
      evidence: [{ source: 'file-presence', value: 'MEMORY.md not found for mapped cwd', agrees_with_others: true, weight: 'supporting' }],
    };
  }
  const hasCanary = typeof content === 'string' && content.includes(CANARY);
  if (!hasCanary) {
    return {
      identity_status: 'DEGRADED',
      evidence: [
        { source: 'file-presence', value: 'MEMORY.md exists', agrees_with_others: true, weight: 'supporting' },
        { source: 'canary', value: `canary "${CANARY}" absent — structure drift`, agrees_with_others: false, weight: 'conflicting' },
      ],
    };
  }
  return {
    identity_status: 'PASS',
    evidence: [
      { source: 'file-presence', value: 'MEMORY.md exists', agrees_with_others: true, weight: 'supporting' },
      { source: 'canary', value: `canary "${CANARY}" present`, agrees_with_others: true, weight: 'supporting' },
    ],
  };
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  let pathResolved = true;
  let memPath = null;
  try {
    memPath = mappedMemoryPath(cwd, home);
  } catch {
    pathResolved = false;
  }
  const fileExists = pathResolved && memPath ? existsSync(memPath) : false;
  let content = null;
  if (fileExists) {
    try { content = readFileSync(memPath, 'utf8'); } catch { content = null; }
  }
  const { identity_status, evidence } = classifyMemoryState({ pathResolved, fileExists, content });

  return buildRow({ identity_status, evidence, cwd, memPath, observed_at: new Date().toISOString() });
}

function buildRow({ identity_status, evidence, cwd, memPath, observed_at }) {
  // auto-memory-injection is observation-only; it never permits a mutation.
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Auto-memory injection (MEMORY.md presence + canary)',
    capability_kind: 'content',
    freshness: 'content-volatile',     // changes whenever the user edits memory
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    workspace_id: null,
    cwd,
    env_signals: {},
    memory_path: memPath,
    identity_status,
    mutation_permitted: false,
    mutation_block_reason: 'observation-only-capability',
    evidence,
  };
}
