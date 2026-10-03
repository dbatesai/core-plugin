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
import { isAbsolute, join } from 'node:path';
import { containedPath } from './trusted-home.mjs';
import { homedir } from 'node:os';
import { captureDisabledMarkerCandidates, EXTERNAL_MARKER } from './metrics-init.mjs';
import { projectRootFor, stateDir, detectStateHarness, readManifest, manifestOptsOutUnverified, readPinSigned, readHeldSigned, historyRecordFolders, stateHarnesses, stateLocations, registryShapeProblem, readSignedFileAt, canonical as canonicalPath, METRICS_OWNER_FILE } from './project-state.mjs';

/**
 * Capture gate for a typed `capture-disabled.json` marker an earlier scaffold left when it could
 * not pin storage. Returns the marker path when capture is disabled, null otherwise; the next
 * metrics-init clears it.
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
 * Where captured rows, scorecards and health files are written: the project's own `_metrics/`,
 * on every platform. A folder an earlier version used outside the project is history (see
 * `metricsHistoryFolders`) and is never written to.
 */
export function resolveStoragePath(projectDir) {
  return join(projectDir, '_metrics');
}

/**
 * The folders outside the project that earlier versions wrote this project's captured rows to
 * (a Windows OneDrive redirect to AppData), read-only history now. Found from the project's
 * signed records under every harness that has state for it: the storage pin, the held record, and
 * the ever-external marker. CORE never deletes them: the notice names them, `/metrics` counts
 * their rows, and an explicit purge lists them for the user to delete. `foreign` marks a folder
 * whose `.project-root` names another project; the notice does not call those rows this project's.
 *
 * @returns {{folder: string, foreign?: boolean}[]}
 */
export function metricsHistoryFolders(projectDir, { home = homedir(), env = process.env } = {}) {
  return historyDiscovery(projectDir, { home, env }).folders;
}

/** True when a history folder's `.project-root` is readable and names a different project. */
function claimedByAnother(folder, projectDir) {
  let text;
  try { text = readFileSync(join(folder, METRICS_OWNER_FILE), 'utf8').trim(); } catch { return false; }
  return !!text && canonicalPath(text) !== canonicalPath(projectDir);
}

/**
 * The history folders plus whether discovery itself could run. `error` is set when the project's
 * records of older folders could not be read at all (an unreadable registry or state), which is
 * different from a project that simply has none.
 */
function historyDiscovery(projectDir, { home, env }) {
  const coreDir = join(home, '.core');
  const own = join(projectDir, '_metrics');
  const named = [];
  let error = null;
  try {
    const root = projectRootFor(projectDir, { home, coreDir });
    for (const harness of stateHarnesses({ root, coreDir, include: [detectStateHarness(env)] })) {
      named.push(...historyRecordFolders({ root, harness, coreDir }));
    }
  } catch (e) { error = e; }
  const appData = join(home, 'AppData', 'Local', 'core-metrics');
  const seen = new Set();
  const folders = [];
  for (const { folder } of named) {
    if (typeof folder !== 'string' || !isAbsolute(folder) || containedPath(own, folder) || seen.has(folder)) continue;
    seen.add(folder);
    // Only the old Windows redirect location was ever a metrics home outside the project.
    if (!containedPath(appData, folder) || !existsSync(folder)) continue;
    folders.push(claimedByAnother(folder, projectDir) ? { folder, foreign: true } : { folder });
  }
  return { folders, error };
}

/**
 * What an explicit purge does not cover, named so it never reports itself complete over them:
 * every older folder outside the project (CORE does not delete outside the project folder); this project's own state under any harness when it exists but cannot be read as its
 * own (unverified, another install's, a relocation awaiting an answer, or mid-migration), since
 * any record of an older folder in it is hidden; records that exist but do not verify; and a
 * discovery that could not run. A purge that leaves any of these reports it instead of "purged".
 *
 * @returns {{what: string, reason: string}[]}
 */
export function metricsHistoryHeld(projectDir, { home = homedir(), env = process.env } = {}) {
  const coreDir = join(home, '.core');
  const held = [];
  let root;
  try { root = projectRootFor(projectDir, { home, coreDir }); }
  catch (e) { return [{ what: projectDir, reason: `this project's records of older external folders could not be read (${String(e.code || e.message).slice(0, 80)}), so whether any exist is unknown` }]; }
  const registryProblem = registryShapeProblem({ coreDir });
  if (registryProblem) {
    return [{ what: join(coreDir, 'projects.json'), reason: `the project registry is malformed (${registryProblem}), so this project's records of older external folders cannot be trusted as complete` }];
  }
  let harnesses;
  try { harnesses = stateHarnesses({ root, coreDir, include: [detectStateHarness(env)] }); }
  catch (e) { return [{ what: join(root, '.core'), reason: `this project's state folders could not be listed (${String(e.code || e.message).slice(0, 80)}), so whether it has records of older external folders is unknown` }]; }
  // Every place each harness's state can be, not only the one routing picks today: a place that
  // can't be read as this project's hides any record in it, so it is held.
  const places = [];
  for (const harness of harnesses) {
    try {
      const { locations, problems } = stateLocations({ root, harness, coreDir });
      for (const p of problems) held.push({ what: p.what, reason: `${p.reason}, so any record of an older external folder in it is hidden; nothing was moved` });
      places.push(...locations);
    } catch (e) {
      held.push({ what: join(root, '.core', harness), reason: `this project's ${harness} state could not be read (${String(e.code || e.message).slice(0, 80)})` });
    }
  }
  if (held.length) return held;
  const { folders, error } = historyDiscovery(projectDir, { home, env });
  for (const h of folders) {
    held.push({ what: h.folder, reason: h.foreign
      ? 'earlier rows outside the project folder, in a folder another project claims; CORE does not delete outside the project'
      : "earlier rows named by this project's records, outside the project folder; CORE does not delete outside the project, and it cannot prove every row there is this project's, so whether to delete the folder is your call" });
  }
  if (error) {
    held.push({ what: projectDir, reason: `this project's records of older external folders could not be read (${String(error.code || error.message).slice(0, 80)}), so whether any exist is unknown` });
    return held;
  }
  for (const { dir } of places) {
    const meta = join(dir, 'metrics');
    const unverified = (d, name, verifies) => {
      if (!(existsSync(join(d, name)) || existsSync(join(d, `${name}.mac`)))) return;
      if (!verifies()) held.push({ what: join(d, name), reason: 'a record of an older external folder exists but does not verify, so the folder it names cannot be found' });
    };
    unverified(meta, 'storage-path.txt', () => readPinSigned({ dir: meta, root, coreDir }) !== null);
    unverified(meta, 'held-legacy-folder.txt', () => readHeldSigned({ dir: meta, coreDir }) !== null);
    unverified(dir, EXTERNAL_MARKER, () => readSignedFileAt({ dir, name: EXTERNAL_MARKER, coreDir }) !== null);
  }
  return held;
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
