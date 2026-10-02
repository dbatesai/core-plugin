/**
 * metrics-init.mjs — storage scaffold for the metrics & observability layer
 *
 * What it does:
 *   - Storage: `<project>/_metrics/` on every platform, including projects inside OneDrive,
 *     iCloud Drive, Dropbox or Google Drive, so captured turns stay with the project and
 *     sync wherever the project syncs. A project whose signed pin already names an external
 *     folder (an earlier Windows OneDrive redirect to AppData) keeps that folder.
 *   - Per-scaffold forensic log line written to operational meta.
 *   - Stub README left at project location when storage is redirected.
 *   - Idempotent: re-runs leave existing content alone, just ensure structure.
 *
 * Library usage:
 *   import { initMetrics } from './metrics-init.mjs';
 *   const result = initMetrics({ projectDir: '/path/to/project' });
 *
 * CLI usage:
 *   node metrics-init.mjs <project-dir> <workspace-id>
 *
 * Failure mode discipline: never throws. Returns a result object with `ok: false`
 * and a `reason` when scaffolding can't proceed. Hosts treat scaffold failure as
 * non-fatal — metrics capture degrades, the session continues.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isCliEntry } from './cli-entry.mjs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createHash } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { operationalMetricsDir } from './log-event.mjs';
import { writePinSigned, readPinSigned, writeHeldSigned, readHeldSigned, metricsStorageAllowed, otherProjectsNamingFolder, projectRootFor, canonical, detectStateHarness, markMetricsEverExternal } from './project-state.mjs';

// Typed fail-closed marker. When the storage pin cannot be written, capture is
// DISABLED for this workspace — never silently redirected back into the synced
// project folder the redirect exists to avoid. The marker is what write-time
// consumers (log-event.mjs `metricsEnabled` → turn-capture) read to stay closed.
export const CAPTURE_DISABLED_MARKER = 'capture-disabled.json';

/**
 * Candidate locations for the fail-closed marker, in read/write order:
 * the operational meta dir first (the pin's own home), then the project-local
 * `_metrics/` dir — the common pin failure IS the meta dir being unwritable,
 * so a second, independent location keeps the marker landable. The marker is a
 * few bytes of metadata, not captured payload, so project-local is acceptable.
 */
export function captureDisabledMarkerCandidates({ projectDir, operationalMetaDir }) {
  return [
    ...(operationalMetaDir ? [join(operationalMetaDir, CAPTURE_DISABLED_MARKER)] : []),
    join(projectDir, '_metrics', CAPTURE_DISABLED_MARKER),
  ];
}

function writeCaptureDisabledMarker({ projectDir, operationalMetaDir, reason, err }) {
  const body = JSON.stringify({
    marker: 'core-capture-disabled',
    reason,
    error: String(err || ''),
    ts: new Date().toISOString(),
  }) + '\n';
  for (const path of captureDisabledMarkerCandidates({ projectDir, operationalMetaDir })) {
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      atomicWriteFileSync(path, body);
      return path;
    } catch { /* try the next location */ }
  }
  return null;
}

function clearCaptureDisabledMarkers({ projectDir, operationalMetaDir }) {
  for (const path of captureDisabledMarkerCandidates({ projectDir, operationalMetaDir })) {
    try { rmSync(path, { force: true }); } catch { /* best-effort; a stale marker only keeps capture off */ }
  }
}

/**
 * Run the scaffold for a workspace. Idempotent.
 *
 * @param {object} args
 * @param {string} args.projectDir - Absolute path to the project root.
 * @param {string} [args.home] - Home directory (tests); defaults to the OS home.
 * @param {object} [args.env] - Environment for harness detection.
 * @returns {object} - { ok, storagePath, detection, scaffold_log_line }
 */
export function initMetrics({ projectDir, home = homedir(), env = process.env }) {
  if (!projectDir) {
    return { ok: false, reason: 'missing-required-args' };
  }
  if (!existsSync(projectDir)) {
    return { ok: false, reason: 'project-dir-does-not-exist' };
  }

  let detection = detectStoragePath({ projectDir, home });
  let storagePath = detection.path;

  // Write the forensic line BEFORE any other work so a partial failure
  // still leaves a debug trail.
  let operationalMetaDir;
  try {
    operationalMetaDir = operationalMetricsDir(projectDir, { home, env });
    mkdirSync(operationalMetaDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'cannot-create-operational-meta-dir', err: err.message };
  }

  // A pin that already points at an existing external folder (one a migration carried in, or an
  // earlier scaffold chose) keeps pointing there: recomputing would leave the payloads written
  // so far at the old place while every reader and writer moved to the new one.
  let heldLegacyFolder = null;
  let reattachedLegacyFolder = null;
  let interimStorage = null;
  const coreDir = join(home, '.core');
  const earlier = readHeldSigned({ dir: operationalMetaDir, coreDir });
  let earlierOwner = null;
  if (earlier && existsSync(earlier.folder)) {
    try { earlierOwner = readFileSync(join(earlier.folder, APPDATA_OWNER_FILE), 'utf8').trim() || null; } catch { /* unclaimed */ }
  }
  if (earlierOwner && canonical(earlierOwner) === canonical(projectRootFor(projectDir, { home, coreDir })) && metricsStorageAllowed(earlier.folder, { projectDir, home })) {
    // A person decided this project owns the folder it was held off: capture goes back to it, the
    // pin is rewritten for it, and the hold is retired. What was captured in the meantime stays where it is.
    interimStorage = storagePath;
    reattachedLegacyFolder = earlier.folder;
    storagePath = earlier.folder;
    detection = { ...detection, path: earlier.folder, reason: 'held-legacy-folder-claimed-and-reattached' };
  } else {
    const pin = keptExternalPin({ operationalMetaDir, projectDir, home, env });
    if (pin && pin.path) {
      storagePath = pin.path;
      detection = { ...detection, path: pin.path, reason: 'existing-external-pin-kept' };
    } else if (!pin) {
      // A hold an earlier run or the migration recorded stays reported until somebody claims the folder.
      if (earlier && existsSync(earlier.folder) && !earlierOwner) {
        heldLegacyFolder = earlier;
        detection = { ...detection, reason: `${detection.reason}; legacy folder ${earlier.folder} held` };
      }
    } else if (pin.held) {
      heldLegacyFolder = pin.held;
      try { writeHeldSigned({ dir: operationalMetaDir, folder: pin.held.folder, alsoNamedBy: pin.held.also_named_by, coreDir }); } catch { /* the hold still applies to this run */ }
      detection = { ...detection, reason: `${detection.reason}; legacy folder ${pin.held.folder} held: also named by ${pin.held.also_named_by.join(', ')}` };
    }
  }

  const scaffoldLogLine = formatScaffoldLog({
    timestamp: new Date().toISOString(),
    project_dir: projectDir,
    detection_methods: detection.methods,
    chosen_storage: storagePath,
    chosen_reason: detection.reason,
  });

  try {
    appendFileSync(join(operationalMetaDir, 'scaffold.log'), scaffoldLogLine + '\n');
  } catch {
    // Don't fail scaffold on log-write failure; the directories still get created.
  }

  // Pin the resolved storage path to a sibling file so log-event.mjs (write-time)
  // honors what metrics-init.mjs (scaffold-time) chose. Without this, writers
  // would hardcode project-local and bypass the AppData redirect on Windows+OneDrive.
  //
  // The pin write is ATOMIC (sibling temp + rename) and its failure FAILS
  // CLOSED: a workspace whose pin can't be written gets capture DISABLED — one
  // loud stderr line plus a typed marker file that `metricsEnabled` reads —
  // never a silent fall-through that puts turn capture back into the synced
  // project folder the redirect exists to avoid.
  try {
    writePinSigned({ dir: operationalMetaDir, path: storagePath, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') });
    if (storagePath !== join(projectDir, '_metrics')) {
      // A durable marker, outside the hot metrics dir the pin itself lives in, so that losing the
      // pin's two files together still leaves evidence this project was ever redirected externally
      // — storagePinInvalid reads it to refuse rather than silently read an empty project-local folder.
      // Part of what "successfully scaffolded" means, not a side note: if this throws, it propagates
      // to the same fail-closed path a pin-write failure takes, rather than reporting success with
      // no marker behind it — and unlike a pin-write failure, the pin itself was already written, so
      // it's rolled back here rather than left pointing at an external folder with no marker behind it.
      try {
        markMetricsEverExternal({ projectDir, harness: env.CORE_HARNESS || detectStateHarness(env), home, coreDir: join(home, '.core'), folder: storagePath });
      } catch (markerErr) {
        for (const f of ['storage-path.txt', 'storage-path.txt.mac']) rmSync(join(operationalMetaDir, f), { force: true });
        throw markerErr;
      }
    }
    // The hold is retired only once the new pin is written and reads back as this folder; if the
    // write failed the record stays, so the next scaffold can still reattach.
    if (reattachedLegacyFolder && readPinSigned({ dir: operationalMetaDir, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') }) === storagePath) {
      for (const f of ['held-legacy-folder.txt', 'held-legacy-folder.txt.mac']) rmSync(join(operationalMetaDir, f), { force: true });
    }
    // A successful pin supersedes any stale fail-closed marker from an earlier
    // failed scaffold — clear it so capture re-enables on recovery.
    clearCaptureDisabledMarkers({ projectDir, operationalMetaDir });
  } catch (err) {
    const markerPath = writeCaptureDisabledMarker({
      projectDir,
      operationalMetaDir,
      reason: 'storage-pin-write-failed',
      err: err && (err.code || err.message),
    });
    process.stderr.write(
      `CORE-METRICS-PIN-FAILED: cannot pin metrics storage to ${storagePath} `
      + `(${err && (err.code || err.message)}); metrics capture is DISABLED for project ${projectDir} `
      + `(marker: ${markerPath || 'unwritable — both marker locations failed'}). `
      + 'Capture never falls back silently into the synced project folder. '
      + 'Fix the permissions on the project metrics dir and re-run metrics-init to re-enable.\n',
    );
    return {
      ok: false,
      reason: 'storage-pin-write-failed',
      err: err && err.message,
      storagePath,
      captureDisabled: true,
      captureDisabledMarker: markerPath,
      scaffold_log_line: scaffoldLogLine,
    };
  }

  // Create the storage root. Writers (scorecard-log.jsonl, capture files)
  // land directly under it; the retired OTel/push subdirectories (traces/,
  // payloads/, queue/) had no shipped producer or consumer and are no longer
  // scaffolded.
  try {
    mkdirSync(storagePath, { recursive: true });
    if (storagePath !== join(projectDir, '_metrics') && !existsSync(join(storagePath, APPDATA_OWNER_FILE))) {
      // Canonical, not raw: appDataStorePath's read-back compares this file's contents
      // against a canonical path too (a junction/alias spelling and the real path must
      // agree on ownership, or the redirect folder itself splits by spelling).
      writeFileSync(join(storagePath, APPDATA_OWNER_FILE), canonical(projectDir) + '\n');
    }
  } catch (err) {
    return { ok: false, reason: 'cannot-create-storage-dir', err: err.message, scaffoldLogLine };
  }

  // Also create the operational-meta subdirs that hooks will write to.
  for (const sub of ['classified', 'detectors', 'evaluations', 'rollups/daily', 'rollups/weekly', 'sessions-active']) {
    try {
      mkdirSync(join(operationalMetaDir, sub), { recursive: true });
    } catch {
      // Best-effort; the hook will recreate if missing.
    }
  }

  // Stub README when storage is redirected away from project-local
  const projectLocalPath = join(projectDir, '_metrics');
  if (storagePath !== projectLocalPath) {
    try {
      writeStubReadme({ projectDir, actualStoragePath: storagePath });
    } catch {
      // Best-effort; user can find storage via scaffold.log if README write fails.
    }
  }

  return {
    ok: true,
    held_legacy_folder: heldLegacyFolder,
    reattached_legacy_folder: reattachedLegacyFolder ? { folder: reattachedLegacyFolder, interim_storage: interimStorage } : null,
    storagePath,
    operationalMetaDir,
    detection,
    scaffold_log_line: scaffoldLogLine,
  };
}

/**
 * The folder a signed pin names, when it is an allowed external folder that exists and no other
 * project claimed. Returns { path }, { held } when another registered project's signed pin names
 * the same unclaimed folder (the old bytes may belong to either, and scaffold order is no
 * evidence of ownership, so nobody takes it), or null.
 */
function keptExternalPin({ operationalMetaDir, projectDir, home, env }) {
  if (process.env.CORE_METRICS_FORCE_PROJECT_LOCAL === '1') return null;
  // Only a pin this install signed is kept, and only inside the folders metrics may live in.
  const pinned = readPinSigned({ dir: operationalMetaDir, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') }) || '';
  if (!pinned || pinned === join(projectDir, '_metrics') || !metricsStorageAllowed(pinned, { projectDir, home })) return null;
  try { if (!statSync(pinned).isDirectory()) return null; } catch { return null; }
  try {
    const owner = readFileSync(join(pinned, '.project-root'), 'utf8').trim();
    return owner === projectDir ? { path: pinned } : null;
  } catch { /* unclaimed: fall through */ }
  const also = otherProjectsNamingFolder(pinned, { projectDir, home, env });
  return also.length ? { held: { folder: pinned, also_named_by: also } } : { path: pinned };
}

// Same name as METRICS_OWNER_FILE in project-state.mjs; kept literal here because this module and
// project-state load in a cycle and a module-level read of its exports would hit a not-yet-set binding.
const APPDATA_OWNER_FILE = '.project-root';
// Same name as METRICS_EXTERNAL_MARKER in project-state.mjs; kept literal here for the same reason
// as APPDATA_OWNER_FILE above (an import-cycle binding trap).
export const EXTERNAL_MARKER = 'metrics-ever-external.txt';

/**
 * The AppData folder for a project's redirected metrics. The readable slug maps `.`, `-`,
 * `/` and `:` all to `-`, so two projects (`a.b`, `a-b`) can share one slug, and who first
 * scaffolds a slug folder says nothing about whose bytes are in it. So a slug folder is used
 * only when this very project claimed it (`.project-root`); every other case gets a name with
 * a hash of the full path. An existing folder reaches a project the trustworthy way, through
 * the project's own earlier pin (see keptExternalPin), and is claimed there. A legacy folder
 * nobody claimed and no pin names is left alone for a person to sort out.
 */
function appDataStorePath(projectDir, home) {
  const legacy = join(home, 'AppData', 'Local', 'core-metrics', mapProjectPathToSlug(projectDir));
  try {
    if (readFileSync(join(legacy, APPDATA_OWNER_FILE), 'utf8').trim() === projectDir) return legacy;
  } catch { /* unclaimed or absent */ }
  return `${legacy}-${pathHash(projectDir)}`;
}

function pathHash(p) { return createHash('sha256').update(p).digest('hex').slice(0, 12); }

/**
 * Decide where storage lives for this project. Honors CORE_METRICS_FORCE_PROJECT_LOCAL=1
 * as a user escape hatch.
 */
export function detectStoragePath({ projectDir, home = homedir(), platformName = platform() }) {
  // Detection runs against the canonical root, not whatever spelling the caller passed in —
  // a symlink or Windows junction alias (e.g. a project reached both as `Documents/Projects/x`
  // and, through a junction, as `OneDrive/Documents/Projects/x`) must classify the same way
  // either way. On Windows this also normalizes to the backslash spelling the OneDrive .ini
  // settings scan (method c) and the substring check (method a) both expect — a forward-slash
  // `projectDir` (as Git Bash and CORE's own script calls pass) never matched either check
  // against a real OneDrive path before this, so only the substring check on an already-
  // OneDrive-spelled path was ever doing anything.
  const real = canonical(projectDir);
  const appDataPath = appDataStorePath(real, home);
  if (process.env.CORE_METRICS_FORCE_PROJECT_LOCAL === '1') {
    return {
      path: join(projectDir, '_metrics'),
      methods: { forced: 'project-local' },
      reason: 'forced-project-local-via-env',
    };
  }

  if (process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK === '1') {
    return {
      path: appDataPath,
      methods: { forced: 'appdata-fallback' },
      reason: 'forced-appdata-fallback-via-env',
    };
  }

  // Captured turns live with the project on every platform, synced folder or not.
  return {
    path: join(projectDir, '_metrics'),
    methods: { os: platformName },
    reason: 'project-local',
  };
}

/**
 * Write a README at <project>/_metrics/README.md pointing the user
 * at the actual storage location when redirected.
 */
export function writeStubReadme({ projectDir, actualStoragePath }) {
  const stubDir = join(projectDir, '_metrics');
  mkdirSync(stubDir, { recursive: true });
  const body = [
    '# _metrics — relocated',
    '',
    'On this Windows install, OneDrive sync was detected on this project path.',
    'To avoid cloud-syncing metrics payloads (estimated ~30MB/month per workspace),',
    'CORE redirects metrics storage to a non-synced location:',
    '',
    `    ${actualStoragePath}`,
    '',
    'Detection-method results are logged at:',
    '',
    '    <project>/.core/<harness>/metrics/scaffold.log',
    '',
    'If you want to force project-local storage instead (accepting cloud-sync of',
    'metrics payloads), set `CORE_METRICS_FORCE_PROJECT_LOCAL=1` in your shell',
    'environment and re-run the metrics scaffold.',
    '',
  ].join('\n');
  writeFileSync(join(stubDir, 'README.md'), body);
}

/**
 * Format the scaffold.log forensic line. One line per scaffold run.
 */
export function formatScaffoldLog({
  timestamp,
  project_dir,
  detection_methods,
  chosen_storage,
  chosen_reason,
}) {
  const methodSummary = Object.entries(detection_methods)
    .map(([k, v]) => `(${k})=${v}`)
    .join(' ');
  return `${timestamp} metrics-init project=${project_dir} methods: ${methodSummary} → ${chosen_storage} (${chosen_reason})`;
}

if (isCliEntry(import.meta.url)) {
  const [projectDir] = process.argv.slice(2);
  if (!projectDir) {
    console.error('usage: node metrics-init.mjs <project-dir>');
    process.exit(1);
  }
  const result = initMetrics({ projectDir });
  if (!result.ok) {
    console.error('metrics-init failed:', result.reason, result.err || '');
    process.exit(2);
  }
  if (result.held_legacy_folder) {
    // stderr, which startup does not discard: the readiness summary names it.
    console.error(`CORE-METRICS-LEGACY-FOLDER-HELD: ${result.held_legacy_folder.folder} is named by more than one project and was left untouched (also: ${(result.held_legacy_folder.also_named_by || []).join(', ') || 'unknown'})`);
  }
  if (result.reattached_legacy_folder) {
    console.error(`CORE-METRICS-LEGACY-FOLDER-REATTACHED: capture now writes to ${result.reattached_legacy_folder.folder}; what was captured meanwhile stays in ${result.reattached_legacy_folder.interim_storage} and is not merged`);
  }
  console.log(JSON.stringify(result, null, 2));
}
