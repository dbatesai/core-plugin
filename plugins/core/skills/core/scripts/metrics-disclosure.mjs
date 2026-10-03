/**
 * metrics-disclosure.mjs — one-time first-run metrics disclosure.
 *
 * Local metrics capture is default-on by design for every install: from a user's
 * first `/core` invocation, turns get classified into `_metrics`/workspace metrics
 * dirs, including a `user_text` field with real excerpts of what they typed. That
 * call was reasoned about for a small set of known, controlled installs; the
 * plugin has since gone public on the marketplace with no user-facing disclosure
 * that any of this happens.
 *
 * This script is the structural fix, not a prose reminder. It fires once, ever,
 * per project and harness, the first time the project is scaffolded (ship the
 * mechanism as a script the agent runs and echoes verbatim; don't rely on the
 * agent remembering to say it).
 *
 * "Have we shown this before" lives in the project's per-harness manifest
 * (`<project>/.core/<harness>/workspace.json`, field `metrics_disclosure_shown`).
 * The manifest is read only when its stamp verifies, so a flag planted by a cloned
 * repo never suppresses the notice. It's safe to call this check on every
 * bootstrap: shown once, silent every time after.
 *
 * CLI usage:
 *   node metrics-disclosure.mjs check [<project-dir>]
 *   → first call for a project: prints the notice text and marks it shown.
 *   → every call after: prints ALREADY-SHOWN and writes nothing.
 *
 * Library usage:
 *   import { checkMetricsDisclosure, NOTICE_TEXT } from './metrics-disclosure.mjs';
 *
 * Failure mode discipline: never throws. A manifest that can't be read or written
 * fails open toward showing the notice (never toward silently skipping disclosure)
 * and reports the reason rather than crashing the bootstrap.
 */

import { isCliEntry } from './cli-entry.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectRootFor, detectStateHarness, readManifest, updateManifest } from './project-state.mjs';
import { metricsHistoryFolders } from './log-event.mjs';

/**
 * Bump whenever the notice describes something materially new being stored.
 * Workspaces stamped below this see the notice again; a wording polish that
 * changes nothing about what is captured does not earn a bump.
 */
export const NOTICE_VERSION = 6;
// A project with earlier rows outside its folder is shown the notice again once, naming them: the
// version 6 text told it the log was kept there.
export const HISTORY_NOTICE_VERSION = 7;

export const NOTICE_TEXT = [
  "One thing worth knowing about this project: CORE keeps a log of how well it's answering you, turn by turn, so it can get better at working with you over time. That happens automatically and the log lives in this project's folder. CORE never sends it anywhere, but if the folder syncs to a cloud service such as OneDrive, iCloud Drive or Dropbox, the log syncs with it.",
  "If you'd rather it not run, set `CORE_METRICS_ENABLED=0` in your environment, or add `metrics_enabled: false` to this project's `.core/<harness>/workspace.json`.",
  "Part of that log is a local evidence record: each turn's prompt and the memory context CORE delivered are saved with the project (CORE never exports them, and they are kept until you purge them) so retrieval quality can be graded honestly after the fact — the classified turn log the recognition classifier writes is kept the same way. Turn the evidence record off with `CORE_TURN_CAPTURE=0`, or `turn_capture: false` in this project's `.core/<harness>/workspace.json`; you can also purge everything it has saved at any time.",
].join('\n\n');

/**
 * Check-and-mark. Idempotent and safe to call on every bootstrap — only the
 * first call for a given project and harness (ever) returns the notice text.
 *
 * @param {object} args
 * @param {string} args.projectDir
 * @param {string} [args.home] test seam; defaults to the OS home
 * @param {object} [args.env]
 * @returns {{ ok: boolean, shown: boolean, alreadyShown: boolean, noticeText: string|null, reason?: string }}
 */
/**
 * The notice says the log lives in the project's folder, and it is always true: new rows are only
 * written there. A project whose records name an older external folder (an earlier Windows
 * OneDrive redirect to AppData) gets a line saying where the earlier rows are kept.
 */
export function noticeTextFor(projectDir, { home = homedir(), env = process.env } = {}) {
  let history = [];
  try { history = metricsHistoryFolders(projectDir, { home, env }); } catch { /* unknown: base text */ }
  if (!history.length) return NOTICE_TEXT;
  const where = history.map((h) => `\`${h.folder}\``).join(' and ');
  return `${NOTICE_TEXT}\n\nEarlier rows from before this version are kept outside the project folder, at ${where}. Nothing new is written there, and CORE never deletes or moves it on its own. An explicit purge removes it only when it is provably this project's; if it can't be proven, the purge leaves it and says so.`;
}

export function checkMetricsDisclosure({ projectDir, home = homedir(), env = process.env } = {}) {
  if (!projectDir) {
    return { ok: false, shown: false, alreadyShown: false, noticeText: null, reason: 'missing-project-dir' };
  }
  const coreDir = join(home, '.core');
  let root, harness;
  try {
    root = projectRootFor(projectDir, { home, coreDir });
    harness = detectStateHarness(env);
  } catch (err) {
    return { ok: false, shown: true, alreadyShown: false, noticeText: noticeTextFor(projectDir, { home, env }), reason: `project-unresolved: ${err.message}` };
  }

  // Untrusted or absent state reads as null: the notice shows.
  const manifest = readManifest({ root, harness, coreDir }) || {};
  let hasHistory = false;
  try { hasHistory = metricsHistoryFolders(projectDir, { home, env }).length > 0; } catch { /* no history known */ }
  const version = hasHistory ? HISTORY_NOTICE_VERSION : NOTICE_VERSION;

  // Versioned: a project that saw an older notice is shown the current one
  // when the wording changes materially. A bare boolean would strand everyone
  // who was told about a narrower version of what gets stored.
  if (manifest.metrics_disclosure_shown === true
      && Number(manifest.metrics_disclosure_version || 1) >= version) {
    return { ok: true, shown: false, alreadyShown: true, noticeText: null };
  }

  try {
    updateManifest({ root, harness, coreDir, fields: { metrics_disclosure_shown: true, metrics_disclosure_version: version } });
  } catch (err) {
    // Fail toward showing the notice this session even though we couldn't persist
    // the flag — a repeated notice (rare write failure) is a far smaller defect
    // than a disclosure that silently never happens.
    return { ok: false, shown: true, alreadyShown: false, noticeText: noticeTextFor(projectDir, { home, env }), reason: `manifest-write-failed: ${err.message}` };
  }

  return { ok: true, shown: true, alreadyShown: false, noticeText: noticeTextFor(projectDir, { home, env }) };
}

// Shared spelling-robust entry guard (cli-entry.mjs) — the previous local
// canonicalizer never resolved symlinks, so a symlinked invocation was a
// silent no-op. exitCode + natural exit so piped output always flushes.
if (isCliEntry(import.meta.url)) {
  const [subcommand, projectArg] = process.argv.slice(2);
  if (subcommand !== 'check') {
    console.error('usage: node metrics-disclosure.mjs check [<project-dir>]');
    process.exitCode = 1;
  } else {
    const result = checkMetricsDisclosure({ projectDir: projectArg || process.cwd() });
    if (result.alreadyShown) {
      console.log('ALREADY-SHOWN');
    } else if (result.noticeText) {
      console.log(result.noticeText);
      if (!result.ok) {
        console.error(`metrics-disclosure: notice shown but flag not persisted (${result.reason}) — may repeat next session`);
      }
    } else {
      console.error('metrics-disclosure failed:', result.reason || 'unknown');
      process.exitCode = 2;
    }
  }
}
