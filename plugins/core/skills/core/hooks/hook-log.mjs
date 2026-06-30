/**
 * hook-log.mjs — shared, fail-open forensic logger for the lifecycle hooks.
 *
 * Each SessionStart / SessionEnd fire appends one JSONL line recording the decision it made
 * (injected / spawned / skipped-and-why). It's the validation surface: after a real session,
 * `cat ~/.core/hooks-log.jsonl` shows exactly whether the hooks ran and what they did — no
 * guessing from behavior. Cheap (one line per session-start, one per session-end).
 *
 * Path: ~/.core/hooks-log.jsonl, overridable with CORE_HOOKS_LOG_FILE (tests point it at a
 * temp file; set it to /dev/null to silence). Logging must NEVER break a hook, so every
 * failure is swallowed.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function hookLogPath() {
  return process.env.CORE_HOOKS_LOG_FILE || join(homedir(), '.core', 'hooks-log.jsonl');
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
  } catch { /* a logger must never break the hook it instruments */ }
}
