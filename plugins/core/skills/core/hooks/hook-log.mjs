/**
 * hook-log.mjs — shared, fail-open forensic logger for the lifecycle hooks.
 *
 * Each SessionStart / SessionEnd fire appends one JSONL line recording the decision it made
 * (injected / spawned / skipped-and-why). It's the validation surface: after a real session,
 * `cat ~/.core/hooks-log.jsonl` shows exactly whether the hooks ran and what they did — no
 * guessing from behavior. Cheap (one line per session-start, one per session-end).
 *
 * Path: ~/.core/hooks-log.jsonl, overridable with CORE_HOOKS_LOG_FILE (tests point it at a
 * trusted temp file under ~/.core; set it to /dev/null to silence). Logging must NEVER break
 * a hook, so every failure is swallowed.
 *
 * D1 (Crest, 2026-07-16 / Keel verification 2026-07-18): CORE_HOOKS_LOG_FILE was previously
 * read unconditionally, an arbitrary-file-append primitive — Claude Code forwards a trusted
 * project's .claude/settings.json env into hook subprocesses, so a hostile-but-trusted repo
 * could redirect it. Same fix shape as CORE_CLOSE_INDEX's resolveIndexPath(): only honor the
 * override when it resolves inside the trusted ~/.core (via trustedHome(), not the spoofable
 * os.homedir()), otherwise ignore it and use the real default.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { trustedHome } from '../scripts/trusted-home.mjs';

/** Pure + exported for unit testing, same shape as close-pass.mjs's resolveIndexPath(). */
export function resolveHookLogPath(env = process.env) {
  const override = env && env.CORE_HOOKS_LOG_FILE;
  // /dev/null is a universal, safe sink (the documented "silence logging"
  // affordance, exercised by the smoke tests and session-start-hook.test.mjs)
  // — always honored, it can never leak or corrupt anything by design.
  if (override === '/dev/null') return override;
  const home = trustedHome();
  if (!home) return null; // no trusted OS home — hookLogPath() falls back to tmpdir
  const coreDir = join(home, '.core');
  const dflt = join(coreDir, 'hooks-log.jsonl');
  if (!override) return dflt;
  const resolved = resolve(override);
  // Honor the override ONLY inside the trusted ~/.core — a project-forwarded
  // path (the shape Claude Code forwards from a project settings.json) is ignored.
  if (resolved === coreDir || resolved.startsWith(coreDir + sep)) return override;
  return dflt;
}

export function hookLogPath() {
  // Logging is low-stakes (unlike the workspace-registry trust gate) — an
  // unresolvable OS home falls back to tmpdir rather than losing the log
  // entirely; appendFileSync failures are already caught by the caller below.
  return resolveHookLogPath() || join(tmpdir(), '.core', 'hooks-log.jsonl');
}

/**
 * Append one JSONL event. Entry should carry at least { hook, action }; reason/cwd optional.
 * @param {{hook: string, action: string, reason?: string, cwd?: string}} entry
 */
export function logHookEvent(entry) {
  try {
    const file = hookLogPath();
    try { mkdirSync(dirname(file), { recursive: true }); } catch { /* dir exists or unwritable */ }
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
    return { written: true };
  } catch (error) {
    // Fail-open for the hook, but never lie that the authoritative receipt
    // exists. Only a closed error code crosses this boundary; messages can
    // contain local paths.
    return { written: false, error_code: typeof error?.code === 'string' ? error.code : 'hook-log-write-failed' };
  }
}
