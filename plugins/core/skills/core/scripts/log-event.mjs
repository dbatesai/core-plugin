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

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { containedPath } from './trusted-home.mjs';
import { homedir } from 'node:os';
import { captureDisabledMarkerCandidates, EXTERNAL_MARKER } from './metrics-init.mjs';
import { projectRootFor, stateDir, detectStateHarness, readManifest, manifestOptsOutUnverified, readCaptureOptOuts, readPinSigned, readHeldSigned, historyRecordFolders, stateHarnessesPartial, stateLocations, registryShapeProblem, readSignedFileAt, canonical as canonicalPath, METRICS_OWNER_FILE, pathPresence } from './project-state.mjs';
import { legacyMetricsPins } from './migrate-workspace-state.mjs';
import { ensureStoreIgnores, METRICS_IGNORE, SESSIONS_IGNORE } from './store-ignores.mjs';
import { STATE_DIRNAME } from './state-dirname.mjs';

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

/** The project's `_metrics/`, made with its ignore file in place before any lock or data is written there. */
export function prepareStorageDir(projectDir) {
  const base = resolveStoragePath(projectDir);
  mkdirSync(base, { recursive: true });
  ensureStoreIgnores(projectDir, { families: [METRICS_IGNORE], verify: false });
  return base;
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

/** Retired classified copies under this project's local key, across both harnesses.
 * Read-only discovery: refuse unsafe parent chains and retain uncertainty for disclosure. */
export function localClassifiedHistory(projectDir, { home = homedir(), env = process.env } = {}) {
  const folders = [], problems = [];
  try {
    const coreDir = join(home, '.core'), root = projectRootFor(projectDir, { home, coreDir });
    const listing = stateHarnessesPartial({ root, coreDir, include: [detectStateHarness(env)] });
    problems.push(...listing.problems);
    for (const harness of listing.harnesses) {
      const places = stateLocations({ root, harness, coreDir });
      problems.push(...places.problems);
      for (const loc of places.locations.filter(l => l.kind === 'local')) {
        const folder = join(loc.dir, 'metrics', 'classified');
        try { if (checkMetricsParentChain(home, folder)) folders.push(folder); }
        catch (e) { problems.push({ what: folder, reason: e.code || e.message }); }
      }
    }
  } catch (e) { problems.push({ what: projectDir, reason: e.code || e.message }); }
  return { folders: [...new Set(folders)], problems };
}

/** The error code of the first path that can't be resolved for a reason other than absence, or null. */
function unresolvable(...paths) {
  for (const p of paths) {
    try { realpathSync.native(p); }
    catch (e) { if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) return (e && e.code) || 'error'; }
  }
  return null;
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
  const unknown = [];
  let error = null;
  try {
    const root = projectRootFor(projectDir, { home, coreDir });
    // Listing problems are reported by metricsHistoryHeld; the names that could be seen are read.
    const { harnesses } = stateHarnessesPartial({ root, coreDir, include: [detectStateHarness(env)] });
    // One harness whose records can't be read does not discard what the others name.
    for (const harness of harnesses) {
      try { named.push(...historyRecordFolders({ root, harness, coreDir })); } catch (e) { error = error || e; }
    }
    const legacy = legacyMetricsPins(root, { coreDir, home });
    named.push(...legacy.folders);
    unknown.push(...legacy.unknown);
  } catch (e) { error = e; }
  const appData = join(home, 'AppData', 'Local', 'core-metrics');
  const seen = new Set();
  const folders = [];
  for (const { folder } of named) {
    if (typeof folder !== 'string' || !isAbsolute(folder) || containedPath(own, folder) || seen.has(folder)) continue;
    seen.add(folder);
    // Only the old Windows redirect location was ever a metrics home outside the project.
    if (!containedPath(appData, folder)) {
      // Not provably inside: outside, or a root or folder that can't be resolved. Only the second
      // is unknown; a missing one is absent.
      const blind = unresolvable(appData, folder);
      if (blind) unknown.push({ what: folder, code: blind });
      continue;
    }
    const presence = pathPresence(folder);
    if (presence.state === 'unknown') { unknown.push({ what: folder, code: presence.code }); continue; }
    if (presence.state === 'absent') continue;
    folders.push(claimedByAnother(folder, projectDir) ? { folder, foreign: true } : { folder });
  }
  return { folders, unknown, error };
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
  // Every problem and every known folder is reported together: one place that can't be read
  // never hides what the others name.
  if (registryProblem) {
    held.push({ what: join(coreDir, 'projects.json'), reason: `the project registry is malformed (${registryProblem}), so this project's records of older external folders cannot be trusted as complete` });
  }
  // A folder that can't be listed is reported, and every harness seen in the others is still read.
  const { harnesses, problems: listing } = stateHarnessesPartial({ root, coreDir, include: [detectStateHarness(env)] });
  for (const p of listing) held.push({ what: p.what, reason: `this project's state folders here could not be listed (${p.code}), so whether it has records of older external folders is unknown` });
  // Every place each harness's state can be, not only the one routing picks today: a place that
  // can't be read as this project's hides any record in it, so it is held.
  const places = [];
  for (const harness of harnesses) {
    try {
      const { locations, problems } = stateLocations({ root, harness, coreDir });
      for (const p of problems) held.push({ what: p.what, reason: `${p.reason}, so any record of an older external folder in it is hidden; nothing was moved` });
      places.push(...locations);
    } catch (e) {
      held.push({ what: join(root, STATE_DIRNAME, harness), reason: `this project's ${harness} state could not be read (${String(e.code || e.message).slice(0, 80)})` });
    }
  }
  const { folders, unknown, error } = historyDiscovery(projectDir, { home, env });
  for (const h of folders) {
    held.push({ what: h.folder, reason: h.foreign
      ? 'earlier rows outside the project folder, in a folder another project claims; CORE does not delete outside the project'
      : "earlier rows named by this project's records, outside the project folder; CORE does not delete outside the project, and it cannot prove every row there is this project's, so whether to delete the folder is your call" });
  }
  for (const u of unknown) {
    held.push({ what: u.what, reason: `this could not be read (${u.code}), so whether it holds or names earlier rows is unknown` });
  }
  if (error) {
    held.push({ what: projectDir, reason: `this project's records of older external folders could not be read (${String(error.code || error.message).slice(0, 80)}), so whether any exist is unknown` });
  }
  for (const { dir } of places) {
    const meta = join(dir, 'metrics');
    const unverified = (d, name, verifies) => {
      const states = [join(d, name), join(d, `${name}.mac`)].map((p) => [p, pathPresence(p)]);
      const blind = states.find(([, p]) => p.state === 'unknown');
      if (blind) { held.push({ what: blind[0], reason: `a record of an older external folder could not be looked at (${blind[1].code}), so whether it names one is unknown` }); return; }
      if (states.every(([, p]) => p.state === 'absent')) return;
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
 * New data lives in the project's per-harness state (`_core/<harness>/metrics`).
 * Unsupported state routes throw STATE_NO_PROJECT_PLACE; any older local copy
 * is read-only history. Ground-truth traces/payloads stay project-scoped via resolveStoragePath.
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

/** The metrics dir when trustworthy state already exists; null otherwise. Never writes.
 * guardReadParents opts strict consumers into selected-parent checks and visible IO errors. */
export function trustedMetricsDir(projectDir, { home = homedir(), env = process.env, harness, guardReadParents = false } = {}) {
  try {
    if (guardReadParents) home = realpathSync(home); // Account-root aliases are allowed.
    const coreDir = join(home, '.core');
    if (guardReadParents) checkMetricsParentChain(home, coreDir);
    const root = projectRootFor(projectDir, { home, coreDir });
    const readDirectoryGuard = guardReadParents ? dir => {
      const fromProject = relative(root, dir);
      const anchor = fromProject !== '..' && !fromProject.startsWith('..' + sep) && !isAbsolute(fromProject) ? root : home;
      return checkMetricsParentChain(anchor, dir);
    } : undefined;
    const s = stateDir({ root, harness: harness || detectStateHarness(env), kind: 'hot', coreDir, readDirectoryGuard });
    if (!s) return null;
    const dir = join(s.dir, 'metrics');
    if (readDirectoryGuard) readDirectoryGuard(dir);
    return dir;
  } catch (e) { if (guardReadParents) throw e; return null; }
}

// Walk from a canonical, caller-owned root without following a linked parent.
// Genuine absence is empty evidence; all other IO errors stay distinguishable.
function checkMetricsParentChain(anchor, dir) {
  const rel = relative(anchor, dir);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw Object.assign(new Error('metrics directory escapes its selected root'), { code: 'METRICS_DIRECTORY_CUSTODY' });
  let current = anchor;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let st;
    try { st = lstatSync(current); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw Object.assign(new Error('metrics parent is not a real directory'), { code: 'METRICS_DIRECTORY_CUSTODY' });
  }
  return true;
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
 *   4. the project's trusted manifest (`_core/<harness>/workspace.json`) `"metrics_enabled": false` → OFF — per-project opt-out.
 *   5. the same manifest `"metrics_enabled": true`  → ON — explicit opt-in (redundant with the default).
 *      A manifest whose stamp does not verify (planted by a clone) is not read.
 *   6. this harness's manifest says `"metrics_enabled": false` but doesn't verify → OFF,
 *      or a `workspace.json` at the project root says so → OFF.
 *      It may be committed by the repo's owner, so it is untrusted, and an untrusted
 *      source can only ever switch capture off, never on.
 *   7. default → ON.
 * A failure while reading the project list or manifest → OFF on the default path. The explicit
 * environment opt-in (step 3) is the user's own word and is decided before those reads.
 */
export function metricsEnabled({ project, env = process.env, home = homedir() } = {}) {
  const flag = (env.CORE_METRICS_ENABLED || '').toString().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(flag)) return false; // explicit hard-off wins
  // Everything below reads the project list and the project's manifest. When one of those reads
  // fails (an unreadable or malformed project list), whether this project opted out is unknown,
  // and unknown is OFF: capture never proceeds on a guess.
  try { const on = metricsEnabledFromState({ project, env, home, flag }); metricsGateFailure = null; return on; }
  catch (e) {
    // OFF, and said once per process on stderr so the failure stays visible: a defect in this path
    // must not look like an ordinary opt-out.
    metricsGateFailure = String(e?.code || e?.name || 'error');
    if (!gateFailureSaid) { gateFailureSaid = true; try { process.stderr.write(`CORE metrics gate: could not read project state (${metricsGateFailure}); capture is off for this run\n`); } catch { /* stderr closed */ } }
    return false;
  }
}

/** Why the most recent gate call failed to read project state, or null when that call read it. */
export let metricsGateFailure = null;
let gateFailureSaid = false;

function metricsEnabledFromState({ project, env, home, flag }) {
  if (project && captureDisabledMarkerPath(project, { home, env })) return false; // fail-closed pin failure beats opt-in
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true;
  if (project) {
    const coreDir = join(home, '.core');
    const m = readManifest({ root: projectRootFor(project, { home, coreDir }),
      harness: detectStateHarness(env), coreDir, throwReadErrors: true });
    if (m && m.metrics_enabled === false) return false; // per-project opt-out
    if (m && m.metrics_enabled === true) return true;   // per-project opt-in (explicit)
    const root = projectRootFor(project, { home, coreDir: join(home, '.core') });
    // Read even beside a trusted manifest: an older `.core` left in the project may still say off.
    if (manifestOptsOutUnverified({ root, harness: detectStateHarness(env) })) return false;
    if (readCaptureOptOuts(join(root, 'workspace.json')).metrics_enabled === false) return false;
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
  // Machine telemetry stays out of git from its first line; the rest of `_sessions/` stays visible.
  ensureStoreIgnores(projectDir, { families: [SESSIONS_IGNORE], verify: false });
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
