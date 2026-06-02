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
 * dual-write to `<project>/_metrics/traces/<session-id>.jsonl`. Per spec
 * §17.7 the transition is six-week dual-write; existing analyzers continue
 * reading the legacy `_sessions/<date>/<filename>.jsonl` files until the
 * OTel substrate is proven, then `analyze-retrieval-quality.mjs` gets a
 * one-shot rewrite.
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
 * Privacy gate for the Layer 2/3 metrics interpretation passes (spec §18).
 *
 * Metrics capture logs the content of prompts, responses, and context sources —
 * by CORE's own taxonomy a smuggling tripwire (data-storage.md). So it is
 * DEFAULT-OFF and opt-in, never on by default for a plugin-distributed install:
 *   - `CORE_METRICS_ENABLED` env var truthy (1/true/yes), OR
 *   - `<project>/workspace.json` carries `"metrics_enabled": true`.
 * `CORE_METRICS_ENABLED=0`/false force-disables even if the workspace flag is set,
 * so a user can hard-off it per shell. Returns false on any ambiguity — the
 * privacy-safe default. The owner opts in per workspace; everyone else captures
 * nothing unless they choose to.
 */
export function metricsEnabled({ project, env = process.env } = {}) {
  const flag = (env.CORE_METRICS_ENABLED || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false; // explicit hard-off wins
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    try {
      const p = JSON.parse(readFileSync(join(project, 'workspace.json'), 'utf8'));
      if (p && p.metrics_enabled === true) return true;
    } catch { /* fall through */ }
  }
  return false; // privacy-safe default
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
    attributes[`core.${k}`] = v;
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

export function logEvent(projectDir, filename, event, { today, now, sessionId, workspaceId } = {}) {
  if (!existsSync(projectDir)) return;
  const date = today || todayUTC();
  const sessionDir = join(projectDir, '_sessions', date);
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch { return; }
  const ts = now || new Date().toISOString();
  const record = { ts, ...event };

  // 1. Legacy write (unchanged — existing analyzers depend on this exact shape).
  try {
    appendFileSync(join(sessionDir, filename), JSON.stringify(record) + '\n');
  } catch {
    // Don't crash hosts on disk errors — emit is best-effort by design.
  }

  // 2. OTel-format dual-write per spec §17.7 transition path.
  //    Storage path resolves via resolveStoragePath() — honors the (g.5)
  //    AppData redirect that metrics-init.mjs pinned at scaffold time.
  //    Session id resolves via resolveSessionId() — Claude Code, then Codex,
  //    then sentinel (RC Turn evt-c97d).
  //    Best-effort, never blocks or throws. Failure here doesn't affect
  //    the legacy write above (already succeeded).
  try {
    const sid = resolveSessionId({ explicit: sessionId });
    const storageBase = resolveStoragePath(projectDir, { workspaceId });
    const tracesDir = join(storageBase, 'traces');
    mkdirSync(tracesDir, { recursive: true });
    const span = eventToOtelSpan(event, { ts, sessionId: sid });
    appendFileSync(join(tracesDir, `${sid}.jsonl`), JSON.stringify(span) + '\n');
  } catch {
    // Silent — dual-write is opt-in transition substrate; legacy path is authoritative.
  }
}
