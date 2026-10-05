/**
 * CORE's own working files inside a project's memory store stay out of git. Each writer that
 * creates one calls ensureStoreIgnores before its first write there (after creating the folder), so a
 * project gets the rules even if startup never ran.
 *
 * Written only when absent, and never edited: an ignore file the user already has is theirs.
 * Canonical content (units, PROJECT.md, INDEX-*.md, inbox.md, curated gold sets) is never matched.
 */
import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = '# Written by CORE: its own working files in this folder, never project content.\n';
export const STORE_IGNORES = [
  ['_memories', ['_close.lock*', '._close.lock*', '.*.lock*', '_close-marker.json', '_maintenance-state.json', '_pm-state.json', '_capability-drift-log.md']],
  ['_memories/_lib', ['*']],
  // Generated test rounds hold answer keys and run state: local evaluation, not project content.
  ['_tests/self-test', ['round-*/', 'auto-author-state.json']],
];

/** 'real' when every folder on the path is a real folder, 'absent' when one doesn't exist, otherwise why not. */
function folderChain(root, rel) {
  let path = root;
  for (const part of rel.split('/')) {
    path = join(path, part);
    let st;
    try { st = lstatSync(path); } catch (e) { return e.code === 'ENOENT' ? 'absent' : `${part} could not be examined (${e.code})`; }
    if (st.isSymbolicLink() || !st.isDirectory()) return `${part} is not a real folder`;
  }
  return 'real';
}

/** Problems found, as short strings; empty when every rule file is in place. Never throws. */
export function ensureStoreIgnores(projectRoot) {
  // ponytail: best effort so a lock or cache write never fails over an ignore file; the problems
  // are returned for a caller that reports them.
  const problems = [];
  for (const [rel, rules] of STORE_IGNORES) {
    const dir = join(projectRoot, ...rel.split('/'));
    try {
      // Every folder from the project root down is checked, so a linked parent never leads the write
      // elsewhere. A folder that doesn't exist yet gets its rules when its own writer creates it.
      const state = folderChain(projectRoot, rel);
      if (state === 'absent') continue;
      if (state !== 'real') { problems.push(`${rel}: ${state}`); continue; }
      writeFileSync(join(dir, '.gitignore'), HEADER + rules.join('\n') + '\n', { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') problems.push(`${rel}/.gitignore: ${e.code || e.message}`);
    }
  }
  return problems;
}
