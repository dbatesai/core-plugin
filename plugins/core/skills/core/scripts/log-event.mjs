/**
 * log-event.mjs — shared structured-logging helper.
 *
 * PROJECT.md management is agent-managed; effectiveness is measured via
 * structured event emission, not user review. This helper centralizes the
 * JSONL append discipline used by hot-section.mjs (retrieval-log.jsonl) and
 * demote-moves.mjs + compact-project.mjs (hygiene-log.jsonl).
 *
 * The script ships with the plugin (not per-project) by design.
 * The plugin ships Node.js (.mjs) only, zero dependencies.
 *
 * The `_sessions/<date>/<filename>.jsonl` JSONL logs are the sole event
 * substrate — there is no OTel or other dual-write.
 *
 * Library usage:
 *   import { logEvent, eventLogPath } from './log-event.mjs';
 *   logEvent('<project>', 'hygiene-log.jsonl', { kind: 'demote-moves', ... });
 *
 * Failure mode discipline: silent skip when projectDir doesn't exist. Hosts
 * that emit events shouldn't crash if their target dir is misconfigured —
 * the missing log will surface separately when the analyzer runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Resolve where the metrics storage lives — honors what `metrics-init.mjs`
 * pinned at scaffold time per matrix (+g.5) + (+m).
 *
 * Reads `~/.core/workspaces/<workspaceId>/metrics/storage-path.txt` if the
 * workspace has been scaffolded. Falls back to `<projectDir>/_metrics/` if
 * the pin file is absent (scaffold not run yet, or workspace id unknown).
 *
 * Without this, writers would hardcode a project-local path and bypass
 * (g.5)'s AppData redirect on Windows+OneDrive.
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
 * DEFAULT-ON, opt-out. The instrumented-memory thesis needs the corpus — a
 * default-off gate starves calibration (a single project rarely reaches ~100
 * labeled turns), so the feedback loop the system exists to close could
 * never close. Capture stays LOCAL (no network
 * exfil); the accepted tradeoff is that a fresh marketplace install classifies its
 * own conversation content into local artifacts unless the user opts out.
 *
 * Precedence (first match wins):
 *   1. `CORE_METRICS_ENABLED` env false (0/false/no/off) → OFF — hard opt-out, beats everything.
 *   2. `CORE_METRICS_ENABLED` env true  (1/true/yes/on)  → ON.
 *   3. `<project>/workspace.json` `"metrics_enabled": false` → OFF — per-workspace opt-out.
 *   4. `<project>/workspace.json` `"metrics_enabled": true`  → ON — explicit opt-in (redundant with the default).
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
  return true; // default-ON: instrument by default; opt out via env or workspace flag
}

export function eventLogPath(projectDir, filename, { today } = {}) {
  const date = today || todayUTC();
  return join(projectDir, '_sessions', date, filename);
}

/**
 * Resolve the session id for trace bucketing.
 *
 * Resolution chain, in order:
 *   1. explicit option
 *   2. CLAUDE_CODE_SESSION_ID (Claude Code's native env var)
 *   3. CODEX_THREAD_ID (Codex Desktop on Windows; a `019e6287-...`-shaped id)
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

// Returns a write outcome — {legacy, reason?} — so producers can tell a
// delivered event from a silently-swallowed one. Still best-effort: never
// throws, never blocks the host.
export function logEvent(projectDir, filename, event, { today, now } = {}) {
  const outcome = { legacy: false };
  if (!existsSync(projectDir)) { outcome.reason = 'project-dir-missing'; return outcome; }
  const date = today || todayUTC();
  const sessionDir = join(projectDir, '_sessions', date);
  try {
    mkdirSync(sessionDir, { recursive: true });
  } catch { outcome.reason = 'session-dir-create-failed'; return outcome; }
  const ts = now || new Date().toISOString();
  const record = { ts, ...event };

  try {
    appendFileSync(join(sessionDir, filename), JSON.stringify(record) + '\n');
    outcome.legacy = true;
  } catch {
    outcome.reason = 'legacy-append-failed'; // best-effort by design — reported, not thrown
  }
  return outcome;
}
