/**
 * metrics-init.mjs — T1 storage scaffold for the metrics & observability layer
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

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
  // honors what metrics-init.mjs (scaffold-time) chose. Without this, dual-write
  // hardcodes project-local and bypasses the AppData redirect on Windows+OneDrive.
  try {
    writeFileSync(join(operationalMetaDir, 'storage-path.txt'), storagePath);
  } catch {
    // Best-effort; log-event falls back to project-local if absent.
  }

  // Create the storage hierarchy per matrix
  // - traces/  per-session OTel trace JSONL (PM-1, PM-2 immutable + content-addressed)
  //            — written by log-event.mjs; no reader yet (collection stub)
  // - payloads/ content-addressed body files (PM-3 flat <digest-32>.json)
  //            — RESERVED: scaffolded for the spec'd payload store; no writer ships yet
  // - queue/    receiver-down events buffer (RL-2)
  //            — RESERVED: scaffolded for the spec'd push path; no writer ships yet
  for (const sub of ['traces', 'payloads', 'queue']) {
    try {
      mkdirSync(join(storagePath, sub), { recursive: true });
    } catch (err) {
      return { ok: false, reason: `cannot-create-${sub}-dir`, err: err.message, scaffoldLogLine };
    }
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

// CLI entry guard — works under both `node metrics-init.mjs ...` invocation
// and `import('./metrics-init.mjs')` as a library. Canonicalize BOTH sides with
// realpathSync: Node resolves import.meta.url to the real file, but argv[1] keeps
// whatever symlinked/virtualized path the caller used, so comparing them raw makes
// the script silently no-op on a symlinked install (it pins storage-path.txt, and
// startup invokes it with output+exit discarded, so that no-op would be invisible).
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
const isCliEntry = process.argv[1]
  ? _canon(process.argv[1]) === _canon(fileURLToPath(import.meta.url))
  : false;

if (isCliEntry) {
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
