/**
 * CORE's own working files inside a project's memory store stay out of git. Each writer that
 * creates one calls ensureStoreIgnores before its first write there (after creating the folder), so a
 * project gets the rules even if startup never ran.
 *
 * Written only when absent, and never edited: an ignore file the user already has is theirs. When that
 * file (with the rest of the repository's rules) leaves some of CORE's working files visible to git, the
 * names are returned as a problem, so the gap is reported rather than hidden.
 * Canonical content (units, PROJECT.md, INDEX-*.md, inbox.md, curated gold sets) is never matched.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HEADER = '# Written by CORE: its own working files in this folder, never project content.\n';
export const STORE_IGNORES = [
  ['_memories', ['_close.lock*', '._close.lock*', '.*.lock*', '.*.tmp-*', '_close-marker.json', '_maintenance-state.json', '_pm-state.json', '_capability-drift-log.md']],
  // Generated test rounds hold answer keys and run state: local evaluation, not project content.
  ['_tests/self-test', ['round-*/', 'auto-author-state.json']],
];

/** 'real' when every folder on the path is a real folder, 'absent' when one doesn't exist, otherwise why not. */
export function folderChain(root, rel) {
  let path = root;
  for (const part of rel.split('/')) {
    path = join(path, part);
    let st;
    try { st = lstatSync(path); } catch (e) { return e.code === 'ENOENT' ? 'absent' : `${part} could not be examined (${e.code})`; }
    if (st.isSymbolicLink() || !st.isDirectory()) return `${part} is not a real folder`;
  }
  return 'real';
}

const refuse = (code, why) => { throw Object.assign(new Error(`cache folder refused: ${why}`), { code }); };
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });

/**
 * The cache folder `_memories/_lib`, ready for a first write, judged from inside the project folder only.
 * It must be a real folder whose ignore file is a single-named regular file ending in `*` with nothing
 * re-included (CORE writes one if absent). When the project's own `.git` sits at its root, git is asked
 * (and told not to look above the project) whether anything in the folder is tracked. Anything else
 * throws before any lock, temp or payload write. A repository above the project isn't consulted, since
 * that would read outside the folder.
 */
export function ensureLibDir(projectRoot) {
  const store = folderChain(projectRoot, '_memories');
  if (store === 'absent') mkdirSync(join(projectRoot, '_memories'));
  else if (store !== 'real') refuse('cache-folder-unsafe', store);
  ensureStoreIgnores(projectRoot);
  const lib = join(projectRoot, '_memories', '_lib');
  const state = folderChain(projectRoot, '_memories/_lib');
  if (state === 'absent') mkdirSync(lib, { mode: 0o700 });
  else if (state !== 'real') refuse('cache-folder-unsafe', state);
  const ignore = join(lib, '.gitignore');
  let st = null;
  try { st = lstatSync(ignore); } catch (e) { if (e.code !== 'ENOENT') refuse('cache-ignore-unsafe', `ignore file could not be examined (${e.code})`); }
  if (!st) writeFileSync(ignore, HEADER + '*\n', { flag: 'wx', mode: 0o600 });
  else {
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) refuse('cache-ignore-unsafe', 'its ignore file is a link, a second name or not a file');
    const rules = readFileSync(ignore, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (rules.at(-1) !== '*' || rules.some((r) => r.startsWith('!'))) refuse('cache-ignore-unsafe', 'its ignore file does not end in * or re-includes a file');
  }
  let dotGit = null;
  try { dotGit = lstatSync(join(projectRoot, '.git')); } catch { /* no repository of its own at the root */ }
  if (dotGit) {
    const r = spawnSync('git', ['-C', projectRoot, 'ls-files', '-z', '--', '_memories/_lib/'], { encoding: 'utf8', timeout: 3000, env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: dirname(projectRoot) } });
    if (r.status !== 0) refuse('cache-tracking-unknown', 'git could not say whether it is tracked');
    if (r.stdout.split('\0').some((n) => n && n !== '_memories/_lib/.gitignore')) refuse('cache-tracked', 'git tracks files in it');
  }
  return lib;
}

/** The rules whose files git would still show, judged by git itself with every rule in the repository.
 *  Outside a repository, or when git can't answer, nothing is reported. */
function visibleToGit(root, rel, dir, rules) {
  try { if (readFileSync(join(dir, '.gitignore'), 'utf8').startsWith(HEADER)) return []; } catch { return []; }
  const env = gitEnv();
  const visible = [];
  for (const rule of rules) {
    const sample = `${rel}/${rule.replace(/\*/g, 'x').replace(/\/$/, '/x')}`;
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', sample], { env, timeout: 3000 });
    if (r.status === 1) visible.push(rule);
  }
  return visible;
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
      if (e.code !== 'EEXIST') { problems.push(`${rel}/.gitignore: ${e.code || e.message}`); continue; }
      const visible = visibleToGit(projectRoot, rel, dir, rules);
      if (visible.length) problems.push(`${rel}/.gitignore is not CORE's and leaves ${visible.join(', ')} visible to git`);
    }
  }
  return problems;
}
