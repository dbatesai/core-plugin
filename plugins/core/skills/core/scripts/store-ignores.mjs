/**
 * CORE's own working files inside a project's memory store stay out of git. Each writer that
 * creates one calls ensureStoreIgnores before its first write there (after creating the folder), so a
 * project gets the rules even if startup never ran.
 *
 * Written only when absent, and never edited: an ignore file the user already has is theirs.
 * Canonical content (units, PROJECT.md, INDEX-*.md, inbox.md) is never matched.
 */
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = '# Written by CORE: its own working files in this folder, never project content.\n';
export const STORE_IGNORES = [
  ['_memories', ['_close.lock*', '._close.lock*', '.*.lock*', '_close-marker.json', '_maintenance-state.json', '_pm-state.json', '_capability-drift-log.md']],
  ['_memories/_lib', ['*']],
];

/** Problems found, as short strings; empty when every rule file is in place. Never throws. */
export function ensureStoreIgnores(projectRoot) {
  // ponytail: best effort so a lock or cache write never fails over an ignore file; the problems
  // are returned for a caller that reports them.
  const problems = [];
  for (const [rel, rules] of STORE_IGNORES) {
    const dir = join(projectRoot, ...rel.split('/'));
    try {
      let st;
      // A folder that doesn't exist yet gets its rules when its own writer creates it.
      try { st = lstatSync(dir); } catch (e) { if (e.code !== 'ENOENT') problems.push(`${rel}: ${e.code}`); break; }
      if (st.isSymbolicLink() || !st.isDirectory()) { problems.push(`${rel} is not a real folder`); break; }
      writeFileSync(join(dir, '.gitignore'), HEADER + rules.join('\n') + '\n', { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') problems.push(`${rel}/.gitignore: ${e.code || e.message}`);
    }
  }
  return problems;
}
