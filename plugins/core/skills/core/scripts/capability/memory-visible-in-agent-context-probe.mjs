/**
 * memory-visible-in-agent-context-probe.mjs — Claude-Code-specific capability.
 *
 * Answers the question the visibility canary used to answer before it was removed
 * (v3.18.0, per user instruction): did MEMORY.md actually reach the agent's context this session, not
 * merely exist on disk? auto-memory-injection-probe.mjs checks file-presence + a
 * structural marker on disk — it cannot see whether the harness attached the file.
 * This probe reads the harness's OWN record of what it attached: Claude Code writes a
 * top-level transcript line (`type: 'attachment'`, `attachment.type: 'instructions'`) at
 * session start listing every file it loaded into context, with a `type: 'AutoMem'`
 * entry for the auto-loaded MEMORY.md and its exact injected content. That is stronger
 * evidence than a text search over message content: it is the harness's own accounting,
 * not an inference from what the model happened to say.
 *
 * Honest boundary: this proves INJECTION (the file was attached, with N bytes of
 * content), not USE. Whether the agent reaches for what it was given is the recognition
 * question memory-accessed-probe.mjs measures separately.
 *
 * No known analogous attachment-record mechanism on Codex — declared UNKNOWN for any
 * harness other than claude-code rather than silently faking a signal that doesn't
 * exist there (cross-harness honesty rule).
 *
 * Called by capability-probe.mjs when the descriptor declares
 * delegate: 'capability/memory-visible-in-agent-context-probe.mjs'.
 *
 * Identity_status:
 *   PASS     — an AutoMem attachment entry was found with non-empty content
 *   DEGRADED — MEMORY.md exists but no AutoMem attachment entry was observed
 *              (or the entry's content was empty) — injection did not happen or was lost
 *   NOT-YET  — no MEMORY.md exists for this project — nothing to inject
 *   UNKNOWN  — transcript unavailable, or harness has no known attachment-record mechanism
 *
 * Row shape mirrors capability/row-schema.md.
 * The script ships with the plugin by convention. The plugin ships .mjs (Node.js) only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { readTranscript } from '../read-transcript.mjs';
import { mappedMemoryPath } from './auto-memory-injection-probe.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'memory-visible-in-agent-context';

// The harness records native separators (backslashes on Windows) while mappedMemoryPath
// joins with '/'; Windows paths are also case-insensitive.
export function samePath(a, b, platform = process.platform) {
  const norm = (p) => {
    const s = String(p).replace(/\\/g, '/');
    return platform === 'win32' ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/** Find the AutoMem entry in a set of parsed 'attachment' events, if any. */
export function findAutoMemEntry(attachmentEvents, expectedPath) {
  for (const e of attachmentEvents || []) {
    if (e.kind !== 'attachment' || !Array.isArray(e.files)) continue;
    for (const f of e.files) {
      if (f && f.type === 'AutoMem' && (!expectedPath || samePath(f.path, expectedPath))) return f;
    }
  }
  return null;
}

/**
 * Pure classifier — given transcript availability and the AutoMem entry (if any),
 * return status + reason. Separated from IO so it's unit-testable without touching
 * the filesystem or a real transcript.
 */
export function classifyVisibility({ transcriptAvailable, autoMemEntry, fileExistsNow, currentContent }) {
  if (!transcriptAvailable) {
    return { identity_status: 'UNKNOWN', reason: 'transcript unavailable — cannot observe injection this session' };
  }
  if (!autoMemEntry) {
    if (!fileExistsNow) {
      return { identity_status: 'NOT-YET', reason: 'no MEMORY.md for this project — nothing to inject' };
    }
    return { identity_status: 'DEGRADED', reason: 'MEMORY.md exists but no AutoMem attachment record was observed in the transcript — injection not observed', injected_length: 0 };
  }
  const injectedLen = typeof autoMemEntry.content === 'string' ? autoMemEntry.content.length : 0;
  if (injectedLen === 0) {
    return { identity_status: 'DEGRADED', reason: 'AutoMem attachment recorded but its content was empty', injected_length: 0 };
  }
  const currentLen = typeof currentContent === 'string' ? currentContent.length : null;
  // Drift is expected mid-session — the file keeps changing as memory gets written after
  // the moment it was injected. This is informational, not a failure signal.
  const driftNote = currentLen == null
    ? 'current file unreadable for comparison'
    : currentLen === injectedLen
      ? 'unchanged since injection'
      : `file is now ${currentLen} bytes vs ${injectedLen} injected (drift expected mid-session as memory gets written)`;
  return {
    identity_status: 'PASS',
    reason: `AutoMem attachment observed, ${injectedLen} bytes injected — ${driftNote}`,
    injected_length: injectedLen,
    current_length: currentLen,
  };
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const harness = opts.harness || 'claude-code';
  const observed_at = new Date().toISOString();

  if (harness !== 'claude-code') {
    return buildRow({
      identity_status: 'UNKNOWN',
      reason: `no attachment-record mechanism known for harness '${harness}'`,
      harness, cwd, observed_at, memPath: null, transcriptAvailable: null,
    });
  }

  let memPath = null;
  try { memPath = mappedMemoryPath(cwd, home); } catch { memPath = null; }
  const fileExistsNow = memPath ? existsSync(memPath) : false;
  let currentContent = null;
  if (fileExistsNow) {
    try { currentContent = readFileSync(memPath, 'utf8'); } catch { currentContent = null; }
  }

  const t = readTranscript({ harness, cwd, home, override: opts.transcriptPath, sessionId: opts.sessionId, env: opts.env });
  const attachmentEvents = t.events.filter((e) => e.kind === 'attachment');
  const autoMemEntry = findAutoMemEntry(attachmentEvents, memPath);
  const r = classifyVisibility({ transcriptAvailable: t.available, autoMemEntry, fileExistsNow, currentContent });

  return buildRow({ ...r, harness, cwd, observed_at, memPath, transcriptAvailable: t.available });
}

function buildRow({ identity_status, reason, injected_length = null, current_length = null, harness, cwd, observed_at, memPath, transcriptAvailable }) {
  // memory-visible-in-agent-context is observation-only; it never permits a mutation.
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Memory visible in agent context (transcript-observed AutoMem injection)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness,
    cwd,
    memory_path: memPath,
    identity_status,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    evidence: [
      { source: 'transcript', value: { available: transcriptAvailable }, agrees_with_others: !!transcriptAvailable, weight: transcriptAvailable ? 'corroborating' : 'conflicting' },
      { source: 'attachment-record', value: { injected_length, current_length, reason }, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'primary' : 'conflicting' },
    ],
  };
}
