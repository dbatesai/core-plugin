/**
 * metrics-init.mjs — storage scaffold for the metrics & observability layer
 *
 * What it does:
 *   - Default storage: `<project>/_metrics/` on Mac, Linux, Windows-no-OneDrive.
 *   - Windows-with-OneDrive: redirect to `~/AppData/Local/core-metrics/<workspace-id>/`.
 *   - Detection: methods (a) path-substring + (c) OneDrive .ini-settings-parse.
 *   - Per-scaffold forensic log line written to operational meta.
 *   - Stub README left at project location when storage is redirected.
 *   - Idempotent: re-runs leave existing content alone, just ensure structure.
 *
 * Library usage:
 *   import { initMetrics } from './metrics-init.mjs';
 *   const result = initMetrics({ projectDir: '/path/to/project', workspaceId: 'core-framework' });
 *
 * CLI usage:
 *   node metrics-init.mjs <project-dir> <workspace-id>
 *
 * Failure mode discipline: never throws. Returns a result object with `ok: false`
 * and a `reason` when scaffolding can't proceed. Hosts treat scaffold failure as
 * non-fatal — metrics capture degrades, the session continues.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isCliEntry } from './cli-entry.mjs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { atomicWriteFileSync } from './fs-atomic.mjs';

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
    join(operationalMetaDir, CAPTURE_DISABLED_MARKER),
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
 * @param {string} args.workspaceId - Workspace identifier (kebab-case).
 * @returns {object} - { ok, storagePath, detection, scaffold_log_line }
 */
export function initMetrics({ projectDir, workspaceId }) {
  if (!projectDir || !workspaceId) {
    return { ok: false, reason: 'missing-required-args' };
  }
  if (!existsSync(projectDir)) {
    return { ok: false, reason: 'project-dir-does-not-exist' };
  }

  const detection = detectStoragePath({ projectDir, workspaceId });
  const storagePath = detection.path;

  // Write the forensic line BEFORE any other work so a partial failure
  // still leaves a debug trail.
  const operationalMetaDir = join(homedir(), '.core', 'workspaces', workspaceId, 'metrics');
  try {
    mkdirSync(operationalMetaDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: 'cannot-create-operational-meta-dir', err: err.message };
  }

  const scaffoldLogLine = formatScaffoldLog({
    timestamp: new Date().toISOString(),
    workspace_id: workspaceId,
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
    atomicWriteFileSync(join(operationalMetaDir, 'storage-path.txt'), storagePath);
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
      + `(${err && (err.code || err.message)}); metrics capture is DISABLED for workspace ${workspaceId} `
      + `(marker: ${markerPath || 'unwritable — both marker locations failed'}). `
      + 'Capture never falls back silently into the synced project folder. '
      + 'Fix the permissions on the workspace metrics dir and re-run metrics-init to re-enable.\n',
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
    storagePath,
    operationalMetaDir,
    detection,
    scaffold_log_line: scaffoldLogLine,
  };
}

/**
 * Decide where storage lives for this project. Honors CORE_METRICS_FORCE_PROJECT_LOCAL=1
 * as a user escape hatch.
 */
export function detectStoragePath({ projectDir, workspaceId }) {
  if (process.env.CORE_METRICS_FORCE_PROJECT_LOCAL === '1') {
    return {
      path: join(projectDir, '_metrics'),
      methods: { forced: 'project-local' },
      reason: 'forced-project-local-via-env',
    };
  }

  if (process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK === '1') {
    return {
      path: join(homedir(), 'AppData', 'Local', 'core-metrics', workspaceId),
      methods: { forced: 'appdata-fallback' },
      reason: 'forced-appdata-fallback-via-env',
    };
  }

  // Non-Windows is always project-local
  if (platform() !== 'win32') {
    return {
      path: join(projectDir, '_metrics'),
      methods: { os: 'non-windows' },
      reason: 'non-windows-default-project-local',
    };
  }

  // Windows checks methods (a) and (c) only; method (b) is not implemented.
  const methodA = projectPathContainsOneDriveSubstring(projectDir);
  const methodC = projectInOneDriveSyncSettings(projectDir);

  if (methodA || methodC) {
    return {
      path: join(homedir(), 'AppData', 'Local', 'core-metrics', workspaceId),
      methods: { a: methodA, c: methodC, b: 'not-implemented' },
      reason: 'windows-onedrive-detected-redirect-appdata',
    };
  }

  return {
    path: join(projectDir, '_metrics'),
    methods: { a: methodA, c: methodC, b: 'dropped-per-rm-turn-12' },
    reason: 'windows-no-onedrive-project-local',
  };
}

/**
 * Method (a): project root path components contain `OneDrive` or `OneDrive - <Org>`.
 * Cheap; catches the common 95% of OneDrive Documents-redirection setups.
 */
export function projectPathContainsOneDriveSubstring(projectDir) {
  const components = projectDir.split(/[\\/]/);
  return components.some((c) => c === 'OneDrive' || c.startsWith('OneDrive - '));
}

/**
 * Method (c): scan OneDrive settings files for the OneDrive root presence.
 *
 * OneDrive account metadata on Windows 11 (build 10.0.26200 and compatible):
 *   - The settings files use the `.ini` extension, NOT `.dat`.
 *   - The hex-prefixed `<account-id>.ini` file contains the OneDrive root path
 *     (e.g., `C:\Users\<user>\OneDrive`) in its `libraryScope` line.
 *   - File content is UTF-16LE with no BOM (Windows convention for these binary blobs);
 *     reading as UTF-8 produces null-byte-interleaved garbage and substring search fails.
 *   - OneDrive Business accounts live in sibling `Business1`, `Business2`, ... directories
 *     under `~/AppData/Local/Microsoft/OneDrive/settings/` with the same naming convention.
 *
 * What this method detects: "this user has OneDrive configured" — combined with method (a)
 * (project path string contains `OneDrive`), the two-method check is more robust than
 * either signal alone.
 */
export function projectInOneDriveSyncSettings(projectDir, _settingsRootOverride = null) {
  const oneDriveSettingsRoot = _settingsRootOverride
    || join(homedir(), 'AppData', 'Local', 'Microsoft', 'OneDrive', 'settings');
  if (!existsSync(oneDriveSettingsRoot)) return false;

  // Scan Personal + any Business<N> account directories
  let accountDirs = [];
  try {
    accountDirs = readdirSync(oneDriveSettingsRoot)
      .filter((d) => d === 'Personal' || /^Business\d+$/.test(d))
      .map((d) => join(oneDriveSettingsRoot, d));
  } catch {
    return false;
  }

  for (const accountDir of accountDirs) {
    let iniFiles = [];
    try {
      // .ini files, not .dat
      iniFiles = readdirSync(accountDir).filter((f) => f.endsWith('.ini'));
    } catch {
      continue;
    }

    for (const f of iniFiles) {
      let content;
      try {
        content = readFileSync(join(accountDir, f));
      } catch {
        continue;
      }
      // UTF-16LE (Windows convention, no BOM on these files)
      const text16 = content.toString('utf16le');

      // Exact match: the .ini happens to name the project path verbatim
      if (text16.includes(projectDir)) return true;

      // Root-prefix match: the .ini names the OneDrive root (libraryScope case);
      // project lives under that root. Extract Windows OneDrive paths from the
      // file content and check if any is a prefix of projectDir.
      //
      // Matches `C:\Users\<user>\OneDrive` and `C:\Users\<user>\OneDrive - <Org>`
      // (org name can contain spaces, letters, digits, hyphens).
      //
      // The trailing-terminator lookahead requires the match to end at a path
      // separator, quote, whitespace, or end-of-string. Rejects false-positives
      // like `OneDrive-backup-archive`.
      const oneDrivePathRe = /[A-Za-z]:\\Users\\[^\\"]+\\OneDrive(?: - [^\\"]+)?(?=[\\"/\s]|$)/g;
      const matches = text16.match(oneDrivePathRe) || [];
      for (const root of matches) {
        if (projectDir === root || projectDir.startsWith(root + '\\') || projectDir.startsWith(root + '/')) {
          return true;
        }
      }
    }
  }
  return false;
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
    '    ~/.core/workspaces/<workspace-id>/metrics/scaffold.log',
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
  workspace_id,
  project_dir,
  detection_methods,
  chosen_storage,
  chosen_reason,
}) {
  const methodSummary = Object.entries(detection_methods)
    .map(([k, v]) => `(${k})=${v}`)
    .join(' ');
  return `${timestamp} metrics-init workspace=${workspace_id} project=${project_dir} methods: ${methodSummary} → ${chosen_storage} (${chosen_reason})`;
}

if (isCliEntry(import.meta.url)) {
  const [projectDir, workspaceId] = process.argv.slice(2);
  if (!projectDir || !workspaceId) {
    console.error('usage: node metrics-init.mjs <project-dir> <workspace-id>');
    process.exit(1);
  }
  const result = initMetrics({ projectDir, workspaceId });
  if (!result.ok) {
    console.error('metrics-init failed:', result.reason, result.err || '');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}
