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
 *
 * Row shape mirrors capability/row-schema.md: capability_kind 'observation'
 * (reports whether an observation surface is reachable), evidence weights drawn
 * from {primary, corroborating, conflicting}, and the observation-only row never
 * permits a mutation (mutation_block_reason: 'read-only-context').
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { mapProjectPathToSlug } from '../project-slug.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'auto-memory-injection';
// Structural marker every CORE-managed MEMORY.md carries (written by /finalize Step 5).
export const CANARY = '## Recent activity';

/**
 * Map an absolute cwd to the Claude Code project-memory directory name.
 * Claude Code replaces every '/', '\', '.', and ':' in the absolute path with '-'.
 * /Users/<user>/Documents/Projects/CORE → -Users-<user>-Documents-Projects-CORE
 */
export function mappedMemoryPath(cwd, home = homedir()) {
  // Build the path with explicit forward slashes (path.join emits backslashes on
  // Windows, which breaks the slug shape Claude Code's projects folder uses and the
  // cross-platform tests; Node's fs accepts forward slashes on Windows, so a
  // '/'-joined path still reads fine). The slug itself MUST come from the one
  // canonical encoder (project-slug.mjs) -- this file used to hand-roll its own
  // `.replace(/[/\\]/g, '-')`, which missed the Windows drive colon and any dot in
  // the path. Meridian (Windows harness) reproduced the resulting false-DEGRADED on
  // a real box, 2026-07-20: the probe reported memory not visible while the real
  // startup canary echoed clean. The mechanism worked; only this hand-rolled
  // duplicate encoder was wrong.
  const mapped = mapProjectPathToSlug(cwd);
  return [home, '.claude', 'projects', mapped, 'memory', 'MEMORY.md'].join('/');
}

/**
 * Pure classifier — given file-existence and content, return status + evidence.
 * Separated from IO so it's unit-testable without touching the filesystem.
 * Evidence weights follow row-schema.md: PASS carries a 'primary' entry,
 * DEGRADED carries a 'conflicting' entry. No 'supporting' (not a schema weight).
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
      evidence: [{ source: 'file-presence', value: 'MEMORY.md not found for mapped cwd', agrees_with_others: true, weight: 'corroborating' }],
    };
  }
  const hasCanary = typeof content === 'string' && content.includes(CANARY);
  if (!hasCanary) {
    return {
      identity_status: 'DEGRADED',
      evidence: [
        { source: 'file-presence', value: 'MEMORY.md exists', agrees_with_others: true, weight: 'corroborating' },
        { source: 'canary', value: `canary "${CANARY}" absent — structure drift`, agrees_with_others: false, weight: 'conflicting' },
      ],
    };
  }
  return {
    identity_status: 'PASS',
    evidence: [
      { source: 'file-presence', value: 'MEMORY.md exists', agrees_with_others: true, weight: 'primary' },
      { source: 'canary', value: `canary "${CANARY}" present`, agrees_with_others: true, weight: 'corroborating' },
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
    if (!memPath) pathResolved = false;
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
    capability_kind: 'observation',
    freshness: 'session-stable',       // determined at session start; stable for the session
    refresh_policy: 'per-session',
    observed_at,
    harness: 'claude-code',
    cwd,
    memory_path: memPath,
    identity_status,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    evidence,
  };
}
