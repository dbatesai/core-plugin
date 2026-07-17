/**
 * log-event.mjs — shared structured-logging helper.
 *
 * Phase 1b substrate per David's 2026-05-24 reframe: PROJECT.md management
 * is agent-managed; effectiveness is measured via structured event emission,
 * not user review. This helper centralizes the JSONL append discipline used
 * by hot-section.mjs (retrieval-log.jsonl) and demote-moves.mjs +
 * compact-project.mjs (hygiene-log.jsonl).
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Phase 2 (2026-05-26, T1 of metrics & observability v1): adds OTel-format
 * dual-write to `<project>/_metrics/traces/<session-id>.jsonl`. STATUS
 * (2026-06-09): the trace write is a COLLECTION STUB — no analyzer reads the
 * OTel rows yet; every consumer (`analyze-retrieval-quality.mjs` etc.) still
 * reads the legacy `_sessions/<date>/<filename>.jsonl` files. Until a trace
 * reader ships, the OTel side is corpus accumulation, not a substrate; the
 * planned one-shot analyzer rewrite lands with that reader.
 *
 * Dual-write overhead: +26 µs per event per Probe 3 (2026-05-26 metrics probes).
 * Negligible at any realistic event rate.
 *
 * Library usage:
 *   import { logEvent, eventLogPath, traceLogPath } from './log-event.mjs';
 *   logEvent('<project>', 'hygiene-log.jsonl', { kind: 'demote-moves', ... });
 *
 * Failure mode discipline: silent skip when projectDir doesn't exist. Hosts
 * that emit events shouldn't crash if their target dir is misconfigured —
 * the missing log will surface separately when the analyzer runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SCHEMA_VERSION = '1.0.0';

/**
 * Resolve where the metrics storage lives — honors what `metrics-init.mjs`
 * pinned at scaffold time per matrix (+g.5) + (+m).
 *
 * Reads `~/.core/workspaces/<workspaceId>/metrics/storage-path.txt` if the
 * workspace has been scaffolded. Falls back to `<projectDir>/_metrics/` if
 * the pin file is absent (scaffold not run yet, or workspace id unknown).
 *
 * Per RM Turn 16 (evt-cc56): without this, dual-write hardcodes project-local
 * and bypasses (g.5)'s AppData redirect on Windows+OneDrive.
 */
export function resolveStoragePath(projectDir, { workspaceId } = {}) {
  if (workspaceId) {
    const pinFile = join(homedir(), '.core', 'workspaces', workspaceId, 'metrics', 'storage-path.txt');
    if (existsSync(pinFile)) {
      try {
        const pinned = readFileSync(pinFile, 'utf8').trim();
        if (pinned) return pinned;
      } catch {
        // Fall through to default
      }
    }
  }
  return join(projectDir, '_metrics');
}

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolve the workspace id for a project from its <project>/workspace.json
 * pointer. Falls back to the project basename slug when the pointer is absent.
 * Layer-2/3 metrics derivatives (classified, detectors, rollups) live under the
 * operational-meta dir keyed by this id (spec §17.6).
 */
export function resolveWorkspaceId(projectDir) {
  try {
    const p = JSON.parse(readFileSync(join(projectDir, 'workspace.json'), 'utf8'));
    if (p && p.workspace_id) return p.workspace_id;
  } catch { /* fall through */ }
  return (projectDir.split(/[\\/]/).pop() || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

/**
 * Operational-meta metrics dir for a workspace (spec §17.6): the derived,
 * regeneratable side of the split — classified/, detectors/, rollups/, etc.
 * Ground-truth traces/payloads stay project-scoped via resolveStoragePath.
 */
export function operationalMetricsDir(workspaceId, { home = homedir() } = {}) {
  return join(home, '.core', 'workspaces', workspaceId, 'metrics');
}

/**
 * Capture gate for the Layer 2/3 metrics interpretation passes (spec §18).
 *
 * DEFAULT-ON, opt-out (DC-107, David 2026-06-04). The instrumented-memory thesis
 * needs the corpus — under the old default-off the calibration gate starved
 * (CORE-on-CORE is too small to ever reach ~100 labeled turns), so the feedback
 * loop the system exists to close couldn't close. Capture stays LOCAL (no network
 * exfil); the accepted tradeoff is that a fresh marketplace install classifies its
 * own conversation content into local artifacts unless the user opts out.
 *
 * Precedence (first match wins):
 *   1. `CORE_METRICS_ENABLED` env false (0/false/no/off) → OFF — hard opt-out, beats everything.
 *   2. `CORE_METRICS_ENABLED` env true  (1/true/yes/on)  → ON.
 *   3. `<project>/workspace.json` `"metrics_enabled": false` → OFF — per-workspace opt-out.
 *   4. `<project>/workspace.json` `"metrics_enabled": true`  → ON — explicit opt-in (redundant now).
 *   5. default → ON.
 */
export function metricsEnabled({ project, env = process.env } = {}) {
  const flag = (env.CORE_METRICS_ENABLED || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false; // explicit hard-off wins
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    try {
      const p = JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8'));
      if (p && p.metrics_enabled === false) return false; // per-workspace opt-out
      if (p && p.metrics_enabled === true) return true;   // per-workspace opt-in (explicit)
    } catch { /* fall through */ }
  }
  return true; // default-ON (DC-107): instrument by default; opt out via env or workspace flag
}

export function eventLogPath(projectDir, filename, { today } = {}) {
  const date = today || todayUTC();
  return join(projectDir, '_sessions', date, filename);
}

/**
 * Path for the per-session OTel trace JSONL. Session id comes from the
 * harness's session env var; if absent we use a sentinel so Layer 2 can
 * still attribute the data to a synthetic bucket.
 *
 * Storage base honors the scaffold-time pin per `resolveStoragePath`.
 */
export function traceLogPath(projectDir, { sessionId, workspaceId } = {}) {
  const sid = resolveSessionId({ explicit: sessionId });
  const base = resolveStoragePath(projectDir, { workspaceId });
  return join(base, 'traces', `${sid}.jsonl`);
}

/**
 * Resolve the session id for trace bucketing.
 *
 * Chain per RC Turn evt-c97d empirical confirmation:
 *   1. explicit option
 *   2. CLAUDE_CODE_SESSION_ID (Claude Code's native env var per Probe 2)
 *   3. CODEX_THREAD_ID (Codex Desktop on Windows; observed `019e6287-...` shape — RC Turn c97d)
 *   4. sentinel `no-session-context`
 *
 * Codex's THREAD_ID is per-thread/per-conversation, good enough for trace
 * grouping and cross-event correlation. Not semantically identical to Claude
 * Code's session.id — name it as `codex-thread-id-fallback` in tests so the
 * provenance stays visible.
 */
export function resolveSessionId({ explicit } = {}) {
  if (explicit) return explicit;
  if (process.env.CLAUDE_CODE_SESSION_ID) return process.env.CLAUDE_CODE_SESSION_ID;
  if (process.env.CODEX_THREAD_ID) return process.env.CODEX_THREAD_ID;
  return 'no-session-context';
}

// MET-010: bound and sanitize what lands in metrics payloads. Project content
// (unit ids, file paths, free text) reaches logEvent calls; without a cap, an
// adversarial or just-huge value is serialized verbatim into the trace JSONL.
export const MAX_ATTRIBUTE_STRING = 1000;
const MAX_ATTRIBUTE_DEPTH = 4;
const MAX_ATTRIBUTE_ENTRIES = 100;
// C0 controls except \n (0x0A) and \t (0x09), plus DEL. JSON escaping makes them
// inert on disk, but downstream renderers of the trace are not guaranteed to.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitizeAttributeValue(value, { maxLen = MAX_ATTRIBUTE_STRING, maxDepth = MAX_ATTRIBUTE_DEPTH } = {}) {
  if (typeof value === 'string') {
    const stripped = value.replace(CONTROL_CHARS_RE, '');
    return stripped.length > maxLen
      ? `${stripped.slice(0, maxLen)}…[truncated ${stripped.length - maxLen} chars]`
      : stripped;
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (maxDepth <= 0) return '[depth-capped]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ATTRIBUTE_ENTRIES).map((v) => sanitizeAttributeValue(v, { maxLen, maxDepth: maxDepth - 1 }));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, MAX_ATTRIBUTE_ENTRIES)) {
      out[sanitizeAttributeValue(k, { maxLen: 200, maxDepth: 1 })] = sanitizeAttributeValue(v, { maxLen, maxDepth: maxDepth - 1 });
    }
    return out;
  }
  return sanitizeAttributeValue(String(value), { maxLen, maxDepth });
}

/**
 * Convert a legacy event record into an OTel-format span line.
 *
 * The `kind` field becomes the span name (`core.<kind>`); all other event
 * fields land under the `core.*` attribute namespace per matrix AS-12
 * (CORE-specific extensions only; native LLM/resource attrs come from
 * Claude Code's own emission).
 */
export function eventToOtelSpan(event, { ts, sessionId } = {}) {
  const nowNs = BigInt(Date.parse(ts) || Date.now()) * 1000000n;
  const kind = event.kind || 'event';
  const attributes = { 'core.event_kind': kind };
  if (sessionId) attributes['session.id'] = sessionId;
  for (const [k, v] of Object.entries(event)) {
    if (k === 'kind') continue;
    attributes[`core.${k}`] = sanitizeAttributeValue(v);
  }
  return {
    schema_version: SCHEMA_VERSION,
    span_name: `core.${kind}`,
    start_time_unix_nano: nowNs.toString(),
    end_time_unix_nano: nowNs.toString(),
    attributes,
    events: [],
  };
}

// Returns a write outcome — {legacy, otel, reason?} — so producers can tell a
// delivered event from a silently-swallowed one (Hale live-hook audit,
// 2026-07-17: "the writer reports a normalized record even if both writes
// silently fail"). Still best-effort: never throws, never blocks the host.
export function logEvent(projectDir, filename, event, { today, now, sessionId, workspaceId } = {}) {
  const outcome = { legacy: false, otel: false };
  if (!existsSync(projectDir)) { outcome.reason = 'project-dir-missing'; return outcome; }
  const date = today || todayUTC();
  const sessionDir = join(projectDir, '_sessions', date);
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch { outcome.reason = 'session-dir-create-failed'; return outcome; }
  const ts = now || new Date().toISOString();
  const record = { ts, ...event };

  // 1. Legacy write (unchanged shape — existing analyzers depend on it).
  try {
    appendFileSync(join(sessionDir, filename), JSON.stringify(record) + '\n');
    outcome.legacy = true;
  } catch {
    outcome.reason = 'legacy-append-failed'; // best-effort by design — reported, not thrown
  }

  // 2. OTel-format dual-write per spec §17.7 transition path.
  //    Storage path resolves via resolveStoragePath() — honors the (g.5)
  //    AppData redirect that metrics-init.mjs pinned at scaffold time.
  //    Session id resolves via resolveSessionId() — Claude Code, then Codex,
  //    then sentinel (RC Turn evt-c97d).
  //    Best-effort, never blocks or throws.
  try {
    const sid = resolveSessionId({ explicit: sessionId });
    const storageBase = resolveStoragePath(projectDir, { workspaceId });
    const tracesDir = join(storageBase, 'traces');
    mkdirSync(tracesDir, { recursive: true });
    const span = eventToOtelSpan(event, { ts, sessionId: sid });
    appendFileSync(join(tracesDir, `${sid}.jsonl`), JSON.stringify(span) + '\n');
    outcome.otel = true;
  } catch {
    // Silent — dual-write is transition substrate; legacy path is authoritative.
  }
  return outcome;
}
