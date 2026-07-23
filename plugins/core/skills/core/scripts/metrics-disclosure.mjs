/**
 * metrics-disclosure.mjs — one-time first-run metrics disclosure.
 *
 * dc-107 made local metrics capture default-on for every install: from a user's
 * first `/core` invocation, turns get classified into `_metrics`/workspace metrics
 * dirs, including a `user_text` field with real excerpts of what they typed. That
 * call was reasoned about for a small set of known, controlled installs; the
 * plugin has since gone public on the marketplace with no user-facing disclosure
 * that any of this happens.
 *
 * This script is the structural fix, not a prose reminder. It fires once, ever,
 * per workspace, the first time a workspace is scaffolded — mirroring the
 * fork-check pattern in `protocols/startup.md` (ship the mechanism as a script the
 * agent runs and echoes verbatim; don't rely on the agent remembering to say it).
 *
 * "Have we shown this before" lives in the workspace manifest
 * (`~/.core/workspaces/<id>/workspace.json`, field `metrics_disclosure_shown`) —
 * the flag travels with the workspace, not the session, so it's safe to call this
 * check on every bootstrap: shown once, silent every time after.
 *
 * CLI usage:
 *   node metrics-disclosure.mjs check <workspace-id>
 *   → first call for a workspace id: prints the notice text and marks it shown.
 *   → every call after: prints ALREADY-SHOWN and writes nothing.
 *
 * Library usage:
 *   import { checkMetricsDisclosure, NOTICE_TEXT } from './metrics-disclosure.mjs';
 *
 * Failure mode discipline: never throws. A manifest that can't be read or written
 * fails open toward showing the notice (never toward silently skipping disclosure)
 * and reports the reason rather than crashing the bootstrap.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const NOTICE_TEXT = [
  "One thing worth knowing since this is a brand-new project: CORE keeps a local, on-this-machine log of how well it's answering you, turn by turn, so it can get better at working with you over time. That happens automatically, it stays on this machine, and none of it goes anywhere else.",
  "If you'd rather it not run, set `CORE_METRICS_ENABLED=0` in your environment, or add `metrics_enabled: false` to this project's `workspace.json`.",
  "There's also an optional, more detailed capture you can turn ON if you ever want to debug why a retrieval went wrong — it saves the literal text of your query and the context CORE delivered, locally, for that turn. It is OFF by default and only turns on if you add `rich_context_capture: true` to this project's `workspace.json`; it's kept for 30 days and you can purge it at any time.",
].join('\n\n');

/**
 * Check-and-mark. Idempotent and safe to call on every bootstrap — only the
 * first call for a given workspace id (ever) returns the notice text.
 *
 * @param {object} args
 * @param {string} args.workspaceId
 * @returns {{ ok: boolean, shown: boolean, alreadyShown: boolean, noticeText: string|null, reason?: string }}
 */
export function checkMetricsDisclosure({ workspaceId }) {
  if (!workspaceId) {
    return { ok: false, shown: false, alreadyShown: false, noticeText: null, reason: 'missing-workspace-id' };
  }

  const manifestDir = join(homedir(), '.core', 'workspaces', workspaceId);
  const manifestPath = join(manifestDir, 'workspace.json');

  let manifest = {};
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      // Unparseable manifest: don't silently skip disclosure over an unrelated
      // corruption issue, but don't pretend we can safely merge-write either.
      return { ok: false, shown: false, alreadyShown: false, noticeText: null, reason: `manifest-unparseable: ${err.message}` };
    }
  }

  if (manifest.metrics_disclosure_shown === true) {
    return { ok: true, shown: false, alreadyShown: true, noticeText: null };
  }

  manifest.metrics_disclosure_shown = true;

  try {
    mkdirSync(manifestDir, { recursive: true });
    atomicWriteFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    // Fail toward showing the notice this session even though we couldn't persist
    // the flag — a repeated notice (rare write failure) is a far smaller defect
    // than a disclosure that silently never happens.
    return { ok: false, shown: true, alreadyShown: false, noticeText: NOTICE_TEXT, reason: `manifest-write-failed: ${err.message}` };
  }

  return { ok: true, shown: true, alreadyShown: false, noticeText: NOTICE_TEXT };
}

// CLI entry guard — mirrors metrics-init.mjs's realpath-canonicalized check so a
// symlinked/virtualized invocation path doesn't cause a silent no-op.
const _canon = (p) => { try { return fileURLToPath(pathToFileURL(p).href); } catch { return p; } };
const isCliEntry = process.argv[1]
  ? _canon(process.argv[1]) === _canon(fileURLToPath(import.meta.url))
  : false;

if (isCliEntry) {
  const [subcommand, workspaceId] = process.argv.slice(2);
  if (subcommand !== 'check' || !workspaceId) {
    console.error('usage: node metrics-disclosure.mjs check <workspace-id>');
    process.exit(1);
  }
  const result = checkMetricsDisclosure({ workspaceId });
  if (result.alreadyShown) {
    console.log('ALREADY-SHOWN');
  } else if (result.noticeText) {
    console.log(result.noticeText);
    if (!result.ok) {
      console.error(`metrics-disclosure: notice shown but flag not persisted (${result.reason}) — may repeat next session`);
    }
  } else {
    console.error('metrics-disclosure failed:', result.reason || 'unknown');
    process.exit(2);
  }
}
