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
 *     tracked" stand or fall together.) The SHA is ALSO refused when the
 *     plugin source tree is DIRTY — any tracked, staged, or untracked change
 *     under the plugin root: HEAD names the committed
 *     bytes, and the executing bytes no longer match them, so stamping HEAD
 *     would be a lie. A dirty tree fails closed exactly like no-checkout —
 *     source_sha stays null and callers refuse to render for publish.
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
// The plugin root (dir carrying .claude-plugin/plugin.json) relative to this
// scripts/ dir — scripts → core skill → skills → plugin root. The dirty check
// is scoped here so a change to ANY shipped plugin file (not just this scripts/
// dir) refuses a clean HEAD stamp.
const _pluginRootFromModule = (dir) => join(dir, '..', '..', '..');

/**
 * True when the plugin source tree under `pluginRoot` has ANY tracked, staged,
 * or untracked change (i.e. `git status --porcelain` on it is non-empty).
 * `git -C dir` runs in the module's real checkout; the pathspec scopes the
 * status to the plugin root. Exported for direct testing against controlled
 * git fixtures. Throws only for the caller to treat as "cannot determine" —
 * truthfulProducerIdentity converts any failure into fail-closed.
 */
export function pluginTreeDirty(dir, pluginRoot) {
  const out = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--', pluginRoot],
    { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
  return out.trim().length > 0;
}

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
    // Dirty-tree guard: HEAD names the committed bytes; if the
    // plugin tree has any relevant modification the executing bytes differ, so
    // fail closed rather than stamp a commit the bytes don't match.
    const pluginRoot = _pluginRootFromModule(realDir);
    if (pluginTreeDirty(realDir, pluginRoot)) {
      // Dirty source checkout: fail closed. We are demonstrably IN a git
      // checkout (git ran, this module is tracked), so the manifest stamp is
      // NOT a valid fallback — the executing bytes match neither HEAD nor the
      // release stamp. Force source_sha null so callers refuse to publish.
      identity.source_sha = null;
      identity.source_sha_from = null;
      return identity;
    }
    if (/^[0-9a-f]{40}$/.test(head)) {
      identity.source_sha = head;
      identity.source_sha_from = 'git';
      return identity;
    }
  } catch { /* not a source checkout (or no git binary) — fall through to the stamped manifest */ }
  identity.source_sha_from = identity.source_sha ? 'manifest' : null;
  return identity;
}
