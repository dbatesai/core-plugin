/**
 * memory-accessed-probe.mjs — v2.9 memory-authority store-selection probe.
 *
 * The observed-access tier, between memory-file-present (it exists on disk) and
 * memory-visible (it was injected into context). This asks a different question the
 * other two miss: did the agent actually REACH FOR the CORE store this session, or
 * did it only touch harness-native scratch memory? That gap is the store-selection
 * failure: a store can hold dozens of CORE units while the agent reaches for
 * native harness memory several times as often. Corpus present !=
 * corpus reached — a recognition-failure cousin that neither file-present nor
 * an injection canary can detect.
 *
 * Honest boundary: this reports OBSERVED ACCESS (a tool read/grep of a CORE surface
 * shows in the transcript). accessed != reasoned-over — like memory-visible, it does
 * NOT prove the content was used. It is one tier stronger than present, one weaker
 * than use.
 *
 * Consumes the read-transcript adapter verb (skills/core/scripts/read-transcript.mjs)
 * so harness-specific transcript paths/schemas stay in the adapter layer, not here
 *. Claude Code: VERIFIED — tool events carry path/command text. Codex: now also
 * VERIFIED (v2.9 Slice F) — read-transcript extracts function_call/custom_tool_call, so
 * this probe classifies on Codex too (PASS on CORE reach, DEGRADED on store-selection).
 * UNKNOWN is now reserved for the genuine cases: no transcript available, or a future
 * Codex build whose tool schema drifts (extraction fails open to no tool events). It
 * never claims "not accessed" when it cannot see tool calls.
 *
 * Ships with the plugin as a script; .mjs only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTranscript } from '../read-transcript.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const CAPABILITY_ID = 'memory-accessed';

// CORE store surfaces (the retrieval ladder's targets) vs harness-native scratch memory.
// A PRECEDING-char boundary (space/quote/slash/start) keeps real path embeds — `grep foo
// _memories/`, `"path":"_memories/"`, `Read PROJECT.md` — while rejecting word-internal
// look-alikes like `my_memories/`. A TRAILING guard `(?![.\w])` rejects extension look-
// alikes — `PROJECT.md.bak`, `MEMORY.md.bak`, `PROJECT.markdown` — which `\b` let through
// (HC blocker #2, evt-202605291319). `_memories[/\\]` already excludes `_memories-old/` /
// `_memories_archive/` (no slash immediately after `_memories`).
// Exported as the single source of truth for "a tool touched a CORE store surface" —
// reused by analyze-retrieval-skip.mjs (v2.9 Slice B) so the two consumers can't drift.
export const CORE_SURFACE_RE = /(?:^|[\s/\\"'])(?:_memories[/\\]|PROJECT\.md(?![.\w]))/;
const NATIVE_SURFACE_RE = /(?:\.codex[/\\]memories|(?:^|[\s/\\"'])MEMORY\.md(?![.\w]))/;

/** Pure classifier over normalized transcript events. */
export function classifyAccess({ harness: _harness, transcriptAvailable, toolExtractionPending, events, coreStorePresent }) {
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

// row-schema.md §"Producer expectations" #2: observed_at, harness, cwd, env_signals are
// unconditional; workspace_id is part of the evidence-field contract. memory-accessed
// omitted env_signals + workspace_id (HC blocker #4, evt-202605291319) — added here so
// every row this probe emits satisfies the producer contract that drift/regression read.
const ENV_SIGNAL_KEYS = ['CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];

function gatherEnvSignals(env = {}) {
  const out = {};
  for (const k of ENV_SIGNAL_KEYS) out[k] = env[k] ?? null;
  return out;
}

function readWorkspaceId(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'workspace.json'), 'utf8')).workspace_id ?? null;
  } catch { return null; }
}

export async function probe(opts = {}) {
  const home = opts.home || homedir();
  const cwd = opts.cwd || process.cwd();
  const env = opts.env || process.env;
  const harness = opts.harness || 'claude-code';
  const observed_at = new Date().toISOString();

  const t = readTranscript({ harness, cwd, home, override: opts.transcriptPath });
  const toolExtractionPending = t.meta?.codex_tool_extraction === 'pending-hc-spec';
  const coreStorePresent = opts.coreStorePresent != null ? opts.coreStorePresent : coreStorePresentAt(cwd);

  const r = classifyAccess({
    harness, transcriptAvailable: t.available, toolExtractionPending, events: t.events, coreStorePresent,
  });
  return buildRow({
    ...r, harness, transcriptAvailable: t.available, coreStorePresent, cwd, observed_at,
    workspace_id: readWorkspaceId(cwd), env_signals: gatherEnvSignals(env),
  });
}

function buildRow({ identity_status, reason, core = null, native = null, harness, transcriptAvailable, coreStorePresent, cwd, observed_at, workspace_id = null, env_signals = {} }) {
  return {
    schema_version: SCHEMA_VERSION,
    capability_id: CAPABILITY_ID,
    capability_name: 'Memory accessed — observed CORE-store reach in transcript (store-selection; NOT proof of use)',
    capability_kind: 'observation',
    freshness: 'session-stable',
    refresh_policy: 'per-session',
    observed_at,
    harness,
    workspace_id,
    cwd,
    env_signals,
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
