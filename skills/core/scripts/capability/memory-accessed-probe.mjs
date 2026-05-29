/**
 * memory-accessed-probe.mjs — v2.9 memory-authority store-selection probe.
 *
 * The observed-access tier, between memory-file-present (it exists on disk) and
 * memory-visible (it was injected into context). This asks a different question the
 * other two miss: did the agent actually REACH FOR the CORE store this session, or
 * did it only touch harness-native scratch memory? That gap is the store-selection
 * failure surfaced empirically on core-codex (2026-05-29): 46 CORE units present, yet
 * the agent reached native ~/.codex/memories 11x vs CORE units 4x. Corpus present !=
 * corpus reached — a recognition-failure cousin (DC-94) that neither file-present nor
 * an injection canary can detect.
 *
 * Honest boundary: this reports OBSERVED ACCESS (a tool read/grep of a CORE surface
 * shows in the transcript). accessed != reasoned-over — like memory-visible, it does
 * NOT prove the content was used. It is one tier stronger than present, one weaker
 * than use.
 *
 * Consumes the read-transcript adapter verb (skills/core/scripts/read-transcript.mjs)
 * so harness-specific transcript paths/schemas stay in the adapter layer, not here
 * (DC-75). Claude Code: VERIFIED — tool events carry path/command text. Codex: the
 * tool/shell extraction is NOT-YET (read-transcript flags codex_tool_extraction
 * pending-hc-spec), so on Codex this probe returns UNKNOWN rather than a false
 * negative — never claims "not accessed" when it simply cannot see Codex tool calls.
 *
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTranscript } from '../read-transcript.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'memory-accessed';

// CORE store surfaces (the retrieval ladder's targets) vs harness-native scratch memory.
// Boundaries are liberal on the PRECEDING char (space/quote/slash/start) because tool
// inputs embed paths in prose, JSON, and shell args — a leading-slash requirement misses
// `grep foo _memories/`, `"path":"_memories/"`, and `Read PROJECT.md`.
const CORE_SURFACE_RE = /(_memories[/\\]|(?:^|[\s/\\"'])PROJECT\.md\b)/;
const NATIVE_SURFACE_RE = /(\.codex[/\\]memories|(?:^|[\s/\\"'])MEMORY\.md\b)/;

/** Pure classifier over normalized transcript events. */
export function classifyAccess({ harness, transcriptAvailable, toolExtractionPending, events, coreStorePresent }) {
  if (!coreStorePresent) {
    return { identity_status: 'NOT-YET', reason: 'no CORE store at this project (no _memories/ or PROJECT.md) — nothing to access' };
  }
  if (!transcriptAvailable) {
    return { identity_status: 'UNKNOWN', reason: 'transcript unavailable — cannot observe access this session' };
  }
  if (toolExtractionPending) {
    // Codex tool/shell extraction not yet implemented — refuse a false "not accessed".
    return { identity_status: 'UNKNOWN', reason: 'tool extraction pending for this harness — access not mechanically observable yet' };
  }
  const tools = events.filter((e) => e.kind === 'tool');
  let core = 0, native = 0;
  for (const e of tools) {
    const t = String(e.text || '');
    if (CORE_SURFACE_RE.test(t)) core += 1;
    if (NATIVE_SURFACE_RE.test(t)) native += 1;
  }
  if (core > 0) {
    return { identity_status: 'PASS', reason: `CORE store reached this session (${core} access${core === 1 ? '' : 'es'}; ${native} native) — observed access, NOT proof of use`, core, native };
  }
  if (native > 0) {
    return { identity_status: 'DEGRADED', reason: `store-selection: ${native} native-memory access(es), 0 CORE — store present but not reached (recognition-failure signature)`, core, native };
  }
  return { identity_status: 'DEGRADED', reason: 'no memory access of either kind observed in transcript', core, native };
}

function coreStorePresentAt(cwd) {
  return existsSync(join(cwd, '_memories')) || existsSync(join(cwd, 'PROJECT.md'));
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const harness = opts.harness || 'claude-code';
  const observed_at = new Date().toISOString();

  const t = readTranscript({ harness, cwd, home, override: opts.transcriptPath });
  const toolExtractionPending = t.meta?.codex_tool_extraction === 'pending-hc-spec';
  const coreStorePresent = opts.coreStorePresent != null ? opts.coreStorePresent : coreStorePresentAt(cwd);

  const r = classifyAccess({
    harness, transcriptAvailable: t.available, toolExtractionPending, events: t.events, coreStorePresent,
  });
  return buildRow({ ...r, harness, transcriptAvailable: t.available, coreStorePresent, cwd, observed_at });
}

function buildRow({ identity_status, reason, core = null, native = null, harness, transcriptAvailable, coreStorePresent, cwd, observed_at }) {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Memory accessed — observed CORE-store reach in transcript (store-selection; NOT proof of use)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness,
    cwd,
    mutation_permitted: false,
    mutation_block_reason: 'read-only-context',
    identity_status,
    evidence: [
      { source: 'core-store-present', value: coreStorePresent, agrees_with_others: coreStorePresent, weight: coreStorePresent ? 'primary' : 'conflicting' },
      { source: 'transcript', value: { available: transcriptAvailable }, agrees_with_others: transcriptAvailable, weight: transcriptAvailable ? 'corroborating' : 'conflicting' },
      { source: 'access-counts', value: { core_accesses: core, native_accesses: native }, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'primary' : 'conflicting' },
      { source: 'classification', value: reason, agrees_with_others: identity_status === 'PASS', weight: identity_status === 'PASS' ? 'corroborating' : 'conflicting' },
    ],
  };
}
