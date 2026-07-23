/**
 * artifact-provenance.mjs — truthful producer identity for every artifact-page
 * generator (extracted from render-browse-artifact.mjs, 2026-07-22, when the
 * metrics artifact generator became its second consumer — extraction over
 * duplication, matching the state-cache.mjs precedent).
 *
 * The rule this module enforces (Hale condition 6, 2026-07-22 HOLD
 * correction 1): a page rendered for publish must carry REAL provenance.
 *
 *   - In a source Git checkout: the real `git rev-parse HEAD` of the plugin
 *     source tree this module actually runs from — never a stale release
 *     stamp. Resolution starts from the executing module's realpath (the same
 *     realpath-from-module discipline resolve-plugin-root.mjs documents; cwd
 *     is never consulted). The SHA is only accepted if THIS module file is
 *     tracked in that repo — which guards against an installed copy that
 *     happens to sit inside an unrelated Git repo inheriting that repo's SHA
 *     as false provenance. (All generators are co-located in this scripts/
 *     directory, so "this module is tracked" and "the calling generator is
 *     tracked" stand or fall together.)
 *   - In an installed/package tree (no git checkout): the stamped manifest
 *     identity from plugin.json, honestly labeled as such.
 *   - Neither: `source_sha` stays null and `source_sha_from` stays null —
 *     callers fail closed rather than render an unknown-provenance page.
 *
 * `source_sha_from` says which source won: 'git' | 'manifest' | null.
 */
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { producerIdentity as manifestIdentity } from './metrics-check.mjs';

const _moduleDir = dirname(fileURLToPath(import.meta.url));
const _moduleFile = 'artifact-provenance.mjs';

/**
 * Truthful producer identity for the named generator script.
 * @param {string} scriptName — the generator's own filename, recorded as
 *   `identity.script` so a receipt or page banner names who produced it.
 */
export function truthfulProducerIdentity(scriptName) {
  const identity = { ...manifestIdentity(), script: scriptName, source_sha_from: null };
  let realDir;
  try { realDir = realpathSync(_moduleDir); } catch { realDir = _moduleDir; }
  try {
    const head = execFileSync('git', ['-C', realDir, 'rev-parse', 'HEAD'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    // Provenance guard: the HEAD SHA describes this tree only if this module
    // is tracked in that repo.
    execFileSync('git', ['-C', realDir, 'ls-files', '--error-unmatch', join(realDir, _moduleFile)],
      { stdio: 'ignore' });
    if (/^[0-9a-f]{40}$/.test(head)) {
      identity.source_sha = head;
      identity.source_sha_from = 'git';
      return identity;
    }
  } catch { /* not a source checkout (or no git binary) — fall through to the stamped manifest */ }
  identity.source_sha_from = identity.source_sha ? 'manifest' : null;
  return identity;
}
