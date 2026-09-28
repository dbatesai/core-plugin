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
import { containedPath } from './trusted-home.mjs';
import { homedir } from 'node:os';
import { captureDisabledMarkerCandidates, EXTERNAL_MARKER, detectStoragePath } from './metrics-init.mjs';
import { projectRootFor, stateDir, detectStateHarness, readManifest, manifestOptsOutUnverified, readPinSigned, metricsStorageAllowed, otherProjectsNamingFolder, readSignedFileAt } from './project-state.mjs';

/**
 * Fail-closed capture gate. metrics-init.mjs writes a typed
 * `capture-disabled.json` marker when the storage pin cannot be written —
 * the state where write-time consumers could otherwise fall back silently
 * into the synced project folder the OneDrive redirect exists to avoid.
 * Returns the marker path when capture is disabled, null otherwise.
 */
export function captureDisabledMarkerPath(projectDir, { home = homedir(), env = process.env } = {}) {
  if (!projectDir) return null;
  const operationalMetaDir = trustedMetricsDir(projectDir, { home, env });
  for (const candidate of captureDisabledMarkerCandidates({ projectDir, operationalMetaDir })) {
    try { if (existsSync(candidate)) return candidate; } catch { /* unreadable location — keep checking */ }
  }
  return null;
}

/**
 * Resolve where the metrics storage lives — honors what `metrics-init.mjs`
 * pinned at scaffold time per matrix (+g.5) + (+m).
 *
 * Reads the signed `storage-path.txt` from the project's trusted metrics state if the
 * project has been scaffolded. Falls back to `<projectDir>/_metrics/` if
 * the pin file is absent or the state is untrusted (scaffold not run yet).
 *
 * Without this, writers would hardcode a project-local path and bypass
 * (g.5)'s AppData redirect on Windows+OneDrive.
 *
 * Fail-closed contract: when metrics-init could not WRITE the pin, it leaves
 * the typed capture-disabled marker and `metricsEnabled` returns false — so
 * capture producers never reach this fallback in that state. The fallback here
 * serves the legitimate pre-scaffold default and read-side path resolution.
 */
export function resolveStoragePath(projectDir, { home = homedir(), env = process.env } = {}) {
  const meta = trustedMetricsDir(projectDir, { home, env });
  if (meta) {
    // The pin decides where every prompt and context row is written, so it is read only if this
    // install signed it and it names the project's own _metrics/ or the AppData redirect.
    const pinned = readPinSigned({ dir: meta, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') }) || '';
    if (pinned && metricsStorageAllowed(pinned, { projectDir, home })) return pinned;
  }
  return join(projectDir, '_metrics');
}

/**
 * True when the project has a storage pin that no longer verifies: unsigned or tampered, or
 * naming somewhere metrics may not live or a folder another project owns. Capture stays off
 * until the next scaffold writes a fresh signed pin. Falling back to `<project>/_metrics` here
 * would quietly resume capture in the synced folder the redirect exists to avoid.
 */
export function storagePinInvalid(projectDir, { home = homedir(), env = process.env } = {}) {
  const meta = trustedMetricsDir(projectDir, { home, env });
  const bodyExists = !!meta && existsSync(join(meta, 'storage-path.txt'));
  const macExists = !!meta && existsSync(join(meta, 'storage-path.txt.mac'));
  if (!bodyExists && !macExists) {
    // No pin sits where one would be — no metrics state at all yet, or state exists with neither
    // file in it. A durable marker (kept outside the metrics dir, written the one time an external
    // pin was created) can still say this project was redirected before; losing both pin files at
    // once should not silently resume capture into the empty project-local folder.
    try {
      const durable = stateDir({ root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), harness: detectStateHarness(env), coreDir: join(home, '.core') });
      if (durable && readSignedFileAt({ dir: durable.dir, name: EXTERNAL_MARKER, coreDir: join(home, '.core') }) !== null) return true;
    } catch { /* no durable state yet: this really is a project that was never redirected */ }
    // No pin, no marker — but a project's path alone can say it needs the redirect (a synced
    // OneDrive folder on Windows), before it has ever been scaffolded. The very first capture can
    // land before startup's scaffold call runs. Refuse rather than let it land in that synced
    // folder even once; the scaffold, once it runs, both fixes this and clears it going forward.
    try {
      if (detectStoragePath({ projectDir, home }).path !== join(projectDir, '_metrics')) return true;
    } catch { /* detection itself failing is not grounds to refuse a project with no other signal */ }
    return false;
  }
  // A signature with no body, or a body with no signature (checked below via readPinSigned, which
  // needs both files to verify), is not a clean absence — it is what a partial loss of the pin's two
  // files looks like, and the folder it named cannot be recovered from what remains.
  const pinned = readPinSigned({ dir: meta, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') }) || '';
  if (!(pinned && metricsStorageAllowed(pinned, { projectDir, home }))) return true;
  // An AppData folder nobody claimed that another project's signed pin also names is not this
  // project's to write to; if that cannot be ruled out, capture stays off.
  if (containedPath(join(home, 'AppData', 'Local', 'core-metrics'), pinned) && !existsSync(join(pinned, '.project-root'))) {
    try { return otherProjectsNamingFolder(pinned, { projectDir, home, env }).length > 0; } catch { return true; }
  }
  return false;
}

export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Operational-meta metrics dir for a project (spec §17.6): the derived,
 * regeneratable side of the split — classified/, detectors/, rollups/, etc.
 * It lives in the project's per-harness state (`.core/<harness>/metrics`), or
 * under ~/.core/local/ when the project is synced, read-only, or another
 * install's. Ground-truth traces/payloads stay project-scoped via resolveStoragePath.
 * Creates the directory (stamping new state) — use trustedMetricsDir for a pure read.
 */
export function operationalMetricsDir(projectDir, { home = homedir(), env = process.env, harness } = {}) {
  const coreDir = join(home, '.core');
  const root = projectRootFor(projectDir, { home, coreDir });
  const s = stateDir({ root, harness: harness || detectStateHarness(env), kind: 'hot', coreDir, forWrite: true });
  const dir = join(s.dir, 'metrics');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The metrics dir when trustworthy state already exists for this project; null otherwise. Never writes. */
export function trustedMetricsDir(projectDir, { home = homedir(), env = process.env, harness } = {}) {
  try {
    const coreDir = join(home, '.core');
    const root = projectRootFor(projectDir, { home, coreDir });
    const s = stateDir({ root, harness: harness || detectStateHarness(env), kind: 'hot', coreDir });
    return s ? join(s.dir, 'metrics') : null;
  } catch { return null; }
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
 *   2. Fail-closed capture-disabled marker present → OFF. metrics-init could
 *      not pin the storage path, so capture cannot guarantee it stays out of a
 *      synced project folder. Privacy fail-closed beats even an explicit env
 *      opt-in — re-enabling is fixing the pin (re-run metrics-init), not
 *      overriding the marker.
 *   3. `CORE_METRICS_ENABLED` env true  (1/true/yes/on)  → ON.
 *   4. the project's trusted manifest (`.core/<harness>/workspace.json`) `"metrics_enabled": false` → OFF — per-project opt-out.
 *   5. the same manifest `"metrics_enabled": true`  → ON — explicit opt-in (redundant with the default).
 *      A manifest whose stamp does not verify (planted by a clone) is not read.
 *   6. this harness's manifest says `"metrics_enabled": false` but doesn't verify → OFF,
 *      or a `workspace.json` at the project root says so → OFF.
 *      It may be committed by the repo's owner, so it is untrusted, and an untrusted
 *      source can only ever switch capture off, never on.
 *   7. default → ON.
 */
export function metricsEnabled({ project, env = process.env, home = homedir() } = {}) {
  const flag = (env.CORE_METRICS_ENABLED || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false; // explicit hard-off wins
  if (project && captureDisabledMarkerPath(project, { home, env })) return false; // fail-closed pin failure beats opt-in
  if (project && storagePinInvalid(project, { home, env })) return false; // a pin that stops verifying never falls back to project-local
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    let m = null;
    try {
      const coreDir = join(home, '.core');
      m = readManifest({ root: projectRootFor(project, { home, coreDir }), harness: detectStateHarness(env), coreDir });
    } catch { m = null; }
    if (m && m.metrics_enabled === false) return false; // per-project opt-out
    if (m && m.metrics_enabled === true) return true;   // per-project opt-in (explicit)
    const root = projectRootFor(project, { home, coreDir: join(home, '.core') });
    if (!m && manifestOptsOutUnverified({ root, harness: detectStateHarness(env) })) return false;
    try {
      const rootManifest = JSON.parse(readFileSync(join(root, 'workspace.json'), 'utf8'));
      if (rootManifest && rootManifest.metrics_enabled === false) return false;
    } catch { /* absent or unreadable: no opt-out */ }
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

// Bound and sanitize what lands in metrics payloads. Project content
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
