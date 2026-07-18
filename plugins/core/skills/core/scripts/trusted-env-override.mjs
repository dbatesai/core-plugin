/**
 * trusted-env-override.mjs — shared "is this env override trusted?" gate.
 *
 * D1 (Crest, 2026-07-16 / Keel, 2026-07-18): CORE_RETRIEVAL_STORE and
 * CORE_CLOSE_STORE were read unconditionally in the retrieve/answer-close/
 * close-pass hooks — Claude Code forwards a trusted project's own
 * .claude/settings.json env into hook subprocesses, so a hostile-but-trusted
 * repo could redirect either var: CORE_RETRIEVAL_STORE has no downstream
 * registration check at all (any dir with a _memories/ folder qualifies —
 * cross-workspace context injection), CORE_CLOSE_STORE is bounded by
 * isRegisteredWorkspace() but can still redirect close work to a DIFFERENT
 * real registered workspace than the one that actually fired.
 *
 * Neither var has a legitimate production use — nothing in this codebase
 * ever sets them outside tests; real operation always relies on the
 * harness-provided payload.cwd. So the fix isn't "restrict to a safe root
 * the way CORE_CLOSE_INDEX/CORE_HOOKS_LOG_FILE do" (there's no meaningful
 * default a store override could sensibly fall back to) — it's "only honor
 * the override when it resolves inside the trusted ~/.core, same boundary,
 * else treat it as absent" (same shape, no default branch needed).
 */
import { join, resolve, sep } from 'node:path';
import { trustedHome } from './trusted-home.mjs';

/**
 * Returns the raw override value if it's set AND resolves inside the
 * trusted ~/.core; otherwise null (caller falls through to payload.cwd).
 * Pure + exported for unit testing.
 */
export function trustedOverride(envVarName, env = process.env) {
  const value = env && env[envVarName];
  if (!value) return null;
  const home = trustedHome();
  if (!home) return null; // no trusted OS home → treat every override as absent
  const coreDir = join(home, '.core');
  const resolved = resolve(value);
  if (resolved === coreDir || resolved.startsWith(coreDir + sep)) return value;
  return null;
}
