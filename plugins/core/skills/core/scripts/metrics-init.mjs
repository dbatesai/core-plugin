/**
 * metrics-init.mjs — storage scaffold for the metrics & observability layer
 *
 * What it does:
 *   - Storage: `<project>/_metrics/` on every platform, including projects inside OneDrive,
 *     iCloud Drive, Dropbox or Google Drive, so captured turns stay with the project and
 *     sync wherever the project syncs. A folder an earlier version used outside the project
 *     (a Windows OneDrive redirect to AppData) is read-only history: it is never written to
 *     again, and `metricsHistoryFolders` in log-event.mjs names it for the purge and the notice.
 *   - Per-scaffold forensic log line written to operational meta.
 *   - Keeps the generated files in `_metrics/` out of git.
 *   - Idempotent: re-runs leave existing content alone, just ensure structure.
 *
 * Library usage:
 *   import { initMetrics } from './metrics-init.mjs';
 *   const result = initMetrics({ projectDir: '/path/to/project' });
 *
 * CLI usage:
 *   node metrics-init.mjs <project-dir>
 *
 * Failure mode discipline: never throws. Returns a result object with `ok: false`
 * and a `reason` when scaffolding can't proceed. Hosts treat scaffold failure as
 * non-fatal — metrics capture degrades, the session continues.
 */

import { existsSync, rmSync } from 'node:fs';
import { isCliEntry } from './cli-entry.mjs';
import { sep, join } from 'node:path';
import {  platform } from 'node:os';
import { operationalMetricsDir, prepareStorageDir, appendLeaf } from './log-event.mjs';
import { ensureRealFolders } from './store-ignores.mjs';
import { STATE_DIRNAME, LEGACY_STATE_DIRNAME } from './state-dirname.mjs';
import { coreHome } from './trusted-home.mjs';

// Typed marker an older scaffold wrote when it could not pin storage, and that capture read to
// stay off. Nothing writes it now; one left behind by an earlier version is read by
// `metricsEnabled` and cleared by the next scaffold.
export const CAPTURE_DISABLED_MARKER = 'capture-disabled.json';

/** Where that marker may sit: the operational meta dir, then the project-local `_metrics/`. */
export function captureDisabledMarkerCandidates({ projectDir, operationalMetaDir }) {
  // The same marker left in an older `.core` beside `_core` still disables capture.
  const inState = `${sep}${STATE_DIRNAME}${sep}`;
  const older = operationalMetaDir?.includes(inState)
    ? operationalMetaDir.slice(0, operationalMetaDir.lastIndexOf(inState)) + `${sep}${LEGACY_STATE_DIRNAME}${sep}` + operationalMetaDir.slice(operationalMetaDir.lastIndexOf(inState) + inState.length)
    : null;
  return [
    ...(operationalMetaDir ? [join(operationalMetaDir, CAPTURE_DISABLED_MARKER)] : []),
    ...(older ? [join(older, CAPTURE_DISABLED_MARKER)] : []),
    join(projectDir, '_metrics', CAPTURE_DISABLED_MARKER),
  ];
}

function clearCaptureDisabledMarkers({ projectDir, operationalMetaDir }) {
  // An older `.core` copy is read by the gate but never removed here: that folder is history, and a
  // link in it could point the removal anywhere. Left in place, it keeps capture off, which is safe.
  const inOlder = `${sep}${LEGACY_STATE_DIRNAME}${sep}`;
  for (const path of captureDisabledMarkerCandidates({ projectDir, operationalMetaDir }).filter((p) => !p.includes(inOlder))) {
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
export function initMetrics({ projectDir, home = coreHome(), env = process.env }) {
  if (!projectDir) {
    return { ok: false, reason: 'missing-required-args' };
  }
  if (!existsSync(projectDir)) {
    return { ok: false, reason: 'project-dir-does-not-exist' };
  }

  const detection = detectStoragePath({ projectDir });
  const storagePath = detection.path;

  // Establish the writable project route before creating capture folders or
  // clearing any old marker. Unsupported routes preserve existing history.
  let operationalMetaDir;
  try {
    operationalMetaDir = operationalMetricsDir(projectDir, { home, env });
  } catch (err) {
    if (err.code === 'STATE_NO_PROJECT_PLACE') {
      return { ok: false, status: 'NOT_STORED', written: false,
        reason: err.reason, error_code: err.code, err: err.message };
    }
    return { ok: false, reason: 'cannot-create-operational-meta-dir', err: err.message };
  }

  // The same preparation every capture write uses: a linked `_metrics` is refused before its ignore file is written.
  try {
    prepareStorageDir(projectDir);
  } catch (err) {
    return { ok: false, reason: 'cannot-create-storage-dir', err: err.message };
  }

  // The operational subfolders hooks write to. A missing one is only best-effort (the writer makes it
  // later), but one that is a link is refused here, before the log line or any marker change.
  for (const sub of ['classified', 'detectors', 'evaluations', 'rollups/daily', 'rollups/weekly', 'sessions-active']) {
    try {
      ensureRealFolders(operationalMetaDir, sub);
    } catch (err) {
      if (err.code === 'FOLDER_UNSAFE') return { ok: false, reason: 'operational-folder-unsafe', err: err.message };
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
    appendLeaf(join(operationalMetaDir, 'scaffold.log'), scaffoldLogLine + '\n');
  } catch {
    // Don't fail scaffold on log-write failure; the directories still get created.
  }

  clearCaptureDisabledMarkers({ projectDir, operationalMetaDir });


  return {
    ok: true,
    storagePath,
    operationalMetaDir,
    detection,
    scaffold_log_line: scaffoldLogLine,
  };
}

// Same name as METRICS_EXTERNAL_MARKER in project-state.mjs; kept literal here because this module
// and project-state load in a cycle and a module-level read of its exports would hit a not-yet-set binding.
export const EXTERNAL_MARKER = 'metrics-ever-external.txt';

/** Where storage lives for this project: its own `_metrics/`. */
export function detectStoragePath({ projectDir, platformName = platform() }) {
  return {
    path: join(projectDir, '_metrics'),
    methods: { os: platformName },
    reason: 'project-local',
  };
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
  console.log(JSON.stringify(result, null, 2));
}
