/**
 * record-capability-snapshot.mjs — the capability-history append path.
 *
 * The wire between the producer and the store: startup runs the capability probe
 * and writes capability-state.json; this script runs runStartup() and appends the
 * rows to the project's `_core/<harness>/capability-history.jsonl` via appendRows(), which
 * is what gives drift/regression analysis something to read across sessions.
 *
 * Used by protocols/startup.md (once per session, fail-open) so each session
 * leaves a capability snapshot; analyze-capability-drift.mjs then reads the
 * accumulated history in /finalize and /process-memory.
 *
 * CLI: node record-capability-snapshot.mjs [--cwd <path>] [--harness <h>]
 *      [--harness <h>] [--cwd <path>] [--project <path>] [--session-id <sid>] [--from <probe json>]
 *
 * The script ships with the plugin by design. The plugin ships .mjs only, zero dependencies.
 */

import { statSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runStartup, SCHEMA_VERSION } from './capability-probe.mjs';
import { appendRows } from './capability-history.mjs';
import { projectRootFor, detectStateHarness } from './project-state.mjs';
import { isCliEntry } from './cli-entry.mjs';

/**
 * Resolve a NON-NULL session id so per-session history buckets never collapse
 * Order: explicit id → harness session env var → a
 * per-invocation fallback (timestamp + random) that is distinct across sessions.
 * A null session id would land every session in one bucket and break
 * regression detection, which delimits sessions by session_id.
 */
export function resolveSessionId(opts = {}) {
  if (opts.sessionId) return opts.sessionId;
  const env = opts.env || process.env;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  if (env.CODEX_THREAD_ID) return env.CODEX_THREAD_ID;
  return `session-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function isStoreUnavailable(err) {
  // EEXIST: ~/.core (which holds the install secret the state stamp needs) is a file, not a directory.
  return ['EPERM', 'EACCES', 'EROFS', 'ENOTDIR', 'EEXIST'].includes(err?.code);
}

// The project-local fallback store: an explicit --project, else the resolved
// project root when it is a real folder.
function resolveFallbackProject(opts = {}, root = null) {
  for (const candidate of [opts.project, root].filter(Boolean)) {
    try {
      if (statSync(candidate).isDirectory()) return candidate;
    } catch { /* ignore invalid candidate */ }
  }
  return null;
}

/**
 * Probe the current session's capabilities and append them to the workspace
 * history. Returns a small summary. opts.home is a test seam (defaults to $HOME).
 */
export async function recordSnapshot(opts = {}) {
  const { harness, cwd } = opts;
  const where = cwd || process.cwd();
  const root = opts.root || projectRootFor(where, opts.home ? { home: opts.home } : {});
  const target = { root, harness: opts.stateHarness || harness || detectStateHarness(opts.env || process.env) };
  const sessionId = resolveSessionId(opts);

  // The startup probe already ran this session: its saved result is recorded, not a second probe.
  const startup = opts.from ? JSON.parse(readFileSync(opts.from, 'utf8')) : await runStartup({ harness, cwd });
  if (!Array.isArray(startup?.rows)) throw new Error(`no probe rows in ${opts.from}`);
  const rows = startup.rows || [];

  const appendOpts = {};
  if (opts.home) appendOpts.home = opts.home;
  if (opts.lockOpts) appendOpts.lockOpts = opts.lockOpts;

  let appendResult;
  let storage = 'state';
  let primaryError = null;
  try {
    appendResult = appendRows(
      target,
      rows,
      { schema_version: SCHEMA_VERSION, runner_version: SCHEMA_VERSION, session_id: sessionId },
      appendOpts,
    );
  } catch (err) {
    if (err.code === 'STATE_NO_PROJECT_PLACE') {
      return { root, harness: startup.harness, session_id: sessionId,
        complete: startup.complete === true, appended: 0, path: null, storage: 'none',
        status: 'NOT_STORED', reason: err.reason, error_code: err.code, summary: startup.summary };
    }
    const project = resolveFallbackProject(opts, root);
    if (!project || !isStoreUnavailable(err)) throw err;
    primaryError = err.message;
    storage = 'project-fallback';
    appendResult = appendRows(
      target,
      rows,
      { schema_version: SCHEMA_VERSION, runner_version: SCHEMA_VERSION, session_id: sessionId },
      { ...appendOpts, project },
    );
  }

  return {
    root,
    harness: startup.harness,
    session_id: sessionId,
    // Carried through from the probe run: an appended count says how much was written,
    // never whether the harness's declared capability set was actually covered.
    complete: startup.complete === true,
    appended: rows.length,
    path: appendResult.path,
    storage,
    ...(primaryError ? { primary_error: primaryError } : {}),
    summary: startup.summary,
  };
}

export async function main(argv) {
  let harness = null, cwd = null, sessionId = null, project = null, from = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--harness') harness = argv[++i];
    else if (argv[i] === '--cwd') cwd = argv[++i];
    else if (argv[i] === '--session-id') sessionId = argv[++i];
    else if (argv[i] === '--project') project = argv[++i];
    else if (argv[i] === '--from') from = argv[++i];
  }
  try {
    const r = await recordSnapshot({ harness, cwd, sessionId, project, from });
    console.log(JSON.stringify(r));
    return 0;
  } catch (e) {
    process.stderr.write(`record-capability-snapshot error: ${e.message}\n`);
    return 1;
  }
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code ?? 0));
}
