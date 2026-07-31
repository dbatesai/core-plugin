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
import { isCliEntry } from './cli-entry.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

/**
 * Bump whenever the notice describes something materially new being stored.
 * Workspaces stamped below this see the notice again; a wording polish that
 * changes nothing about what is captured does not earn a bump.
 */
export const NOTICE_VERSION = 3;

export const NOTICE_TEXT = [
  "One thing worth knowing since this is a brand-new project: CORE keeps a local, on-this-machine log of how well it's answering you, turn by turn, so it can get better at working with you over time. That happens automatically, it stays on this machine, and none of it goes anywhere else.",
  "If you'd rather it not run, set `CORE_METRICS_ENABLED=0` in your environment, or add `metrics_enabled: false` to this project's `workspace.json`.",
  "Part of that log is a local evidence record: each turn's prompt and the memory context CORE delivered are saved on this machine (never exported, auto-deleted after 30 days) so retrieval quality can be graded honestly after the fact — the same 30-day deletion covers the classified turn log the recognition classifier writes. Turn the evidence record off with `CORE_TURN_CAPTURE=0`, or `turn_capture: false` in this project's `workspace.json`; you can also purge everything it has saved at any time.",
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

  // Versioned: a workspace that saw an older notice is shown the current one
  // when the wording changes materially. A bare boolean would strand everyone
  // who was told about a narrower version of what gets stored.
  if (manifest.metrics_disclosure_shown === true
      && Number(manifest.metrics_disclosure_version || 1) >= NOTICE_VERSION) {
    return { ok: true, shown: false, alreadyShown: true, noticeText: null };
  }

  manifest.metrics_disclosure_shown = true;
  manifest.metrics_disclosure_version = NOTICE_VERSION;

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

// Shared spelling-robust entry guard (cli-entry.mjs) — the previous local
// canonicalizer never resolved symlinks, so a symlinked invocation was a
// silent no-op. exitCode + natural exit so piped output always flushes.
if (isCliEntry(import.meta.url)) {
  const [subcommand, workspaceId] = process.argv.slice(2);
  if (subcommand !== 'check' || !workspaceId) {
    console.error('usage: node metrics-disclosure.mjs check <workspace-id>');
    process.exitCode = 1;
  } else {
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
      process.exitCode = 2;
    }
  }
}
