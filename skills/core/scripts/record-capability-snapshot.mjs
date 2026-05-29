/**
 * record-capability-snapshot.mjs — v2.7.0 capability-history append path.
 *
 * The missing wire between the producer and the store: startup runs the
 * capability probe and writes capability-state.json, but nothing appended the
 * rows to the per-workspace history, so drift/regression analysis had nothing
 * to read across sessions. This script runs runStartup() and appends the rows
 * to ~/.core/workspaces/<id>/capability-history.jsonl via appendRows().
 *
 * Used by protocols/startup.md (once per session, fail-open) so each session
 * leaves a capability snapshot; analyze-capability-drift.mjs then reads the
 * accumulated history in /finalize and /process-memory.
 *
 * CLI: node record-capability-snapshot.mjs --workspace-id <id>
 *      [--harness <h>] [--cwd <path>] [--session-id <sid>]
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runStartup, SCHEMA_VERSION } from './capability-probe.mjs';
import { appendRows } from './capability-history.mjs';

/**
 * Probe the current session's capabilities and append them to the workspace
 * history. Returns a small summary. opts.home is a test seam (defaults to $HOME).
 */
export async function recordSnapshot(opts = {}) {
  const { workspaceId, harness, cwd, sessionId } = opts;
  if (!workspaceId) throw new Error('record-capability-snapshot: workspaceId is required');

  const startup = await runStartup({ harness, cwd });
  const rows = startup.rows || [];

  const appendOpts = {};
  if (opts.home) appendOpts.home = opts.home;
  if (opts.lockOpts) appendOpts.lockOpts = opts.lockOpts;

  appendRows(
    workspaceId,
    rows,
    { schema_version: SCHEMA_VERSION, runner_version: SCHEMA_VERSION, session_id: sessionId ?? null },
    appendOpts,
  );

  return {
    workspace_id: workspaceId,
    harness: startup.harness,
    appended: rows.length,
    summary: startup.summary,
  };
}

export async function main(argv) {
  let workspaceId = null, harness = null, cwd = null, sessionId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--harness') harness = argv[++i];
    else if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--session-id') sessionId = argv[++i];
  }
  if (!workspaceId) {
    process.stderr.write('usage: record-capability-snapshot.mjs --workspace-id <id> [--harness <h>] [--cwd <path>] [--session-id <sid>]\n');
    return 2;
  }
  try {
    const r = await recordSnapshot({ workspaceId, harness, cwd, sessionId });
    console.log(JSON.stringify(r));
    return 0;
  } catch (e) {
    process.stderr.write(`record-capability-snapshot error: ${e.message}\n`);
    return 1;
  }
}

const _c = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
