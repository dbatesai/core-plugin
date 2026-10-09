/** Project-local, fail-open lifecycle receipts. No global or OS-temp fallback.
 * Callers supply the selected registered projectRoot; process cwd is never a root selector.
 * CORE_HOOKS_LOG_FILE may name a direct child of _core/_hooks, or /dev/null to mute.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProjectArtifactDir, assertArtifactFile, projectArtifactRoot } from '../scripts/project-artifacts.mjs';
import { STATE_DIRNAME } from '../scripts/state-dirname.mjs';

// Packaged producer identity, read ONCE from the plugin manifest — the same
// seam retrieve-context-hook.mjs uses for its evidence rows — and stamped on
// EVERY receipt this logger writes, so any hook-log row can be bound to the
// exact shipped build that produced it. 'unknown' is honest when the manifest
// is unreadable (packaged layouts vary) or predates the source_sha field
// (a --scope local dev install). source_sha names the commit this release
// PACKAGES (the version-bump commit's own parent), not the tagged release
// commit's own SHA — two different identities; the field name says which.
const PRODUCER_MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch { return {}; }
})();
export const PRODUCER_VERSION = String(PRODUCER_MANIFEST.version || 'unknown');
export const PRODUCER_SHA = String(PRODUCER_MANIFEST.source_sha || 'unknown');

/** Pure lexical selection. Physical and tracked-file checks happen before writing. */
export function resolveHookLogPath(env = process.env, projectRoot = null) {
  if (env?.CORE_HOOKS_LOG_FILE === '/dev/null') return '/dev/null';
  if (!projectRoot) return null;
  const dir = join(resolve(projectRoot), STATE_DIRNAME, '_hooks');
  const override = env?.CORE_HOOKS_LOG_FILE;
  const file = override ? resolve(override) : null;
  return file && dirname(file) === dir && !['.gitignore', '.', '..'].includes(file.slice(dir.length + 1))
    ? file : join(dir, 'hooks-log.jsonl');
}
export function hookLogPath(projectRoot = null) { return resolveHookLogPath(process.env, projectRoot); }

export function logHookEvent(entry = {}) {
  try {
    if (process.env.CORE_HOOKS_LOG_FILE === '/dev/null') return { written: true, muted: true };
    if (!entry.projectRoot) return { written: false, error_code: 'hook-log-project-required' };
    const root = projectArtifactRoot(entry.projectRoot);
    const file = hookLogPath(root);
    const dir = ensureProjectArtifactDir(root, '_hooks');
    assertArtifactFile(dir, file);
    const { projectRoot, ...event } = entry;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event,
      producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA }) + '\n';
    appendFileSync(file, line, { mode: 0o600 });
    return { written: true };
  } catch (error) {
    return { written: false, error_code: typeof error?.code === 'string' ? error.code : 'hook-log-write-failed' };
  }
}
