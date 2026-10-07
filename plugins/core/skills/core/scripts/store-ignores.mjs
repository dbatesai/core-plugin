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
import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATE_DIRNAME } from './state-dirname.mjs';
import { renameWithRetrySync } from './fs-atomic.mjs';

const HEADER = '# Written by CORE: its own working files in this folder, never project content.\n';
// The names CORE actually writes for each rule: git is asked about these, so an exact exception a
// user wrote for one of them is seen.
const SAMPLES = {
  '_close.lock*': ['_close.lock', '_close.lock.g1', '_close.lock.g1.done'], '._close.lock*': ['._close.lock.new-0'],
  '.*.lock*': ['.decorate-graph.lock.g1.done', '.project-md-writer.lock.g1.done', '._close.lock.g1.new-0'],
  '.*.tmp-*': ['._close-marker.json.tmp-1-1', '._maintenance-state.json.tmp-1-1'],
  'round-*/': ['round-1/results-1.json', 'round-1/goldset.json'],
  '_metrics:*': ['turn-capture-health.json', 'judgment-log.jsonl', 'scorecard-log.jsonl', '.turn-capture.lock', '.judgment.lock', '.scorecard.lock', 'turn-capture/2026-01-01.jsonl'],
  [`${STATE_DIRNAME}:*`]: ['claude-code/workspace.json', '_agent/agent-profile.md', '_project-only/claude-code/bootstrap.json', '_hooks/hooks-log.jsonl'],
};
const samplesFor = (rel, rule) => SAMPLES[`${rel}:${rule}`] || SAMPLES[rule] || [rule.replace(/^\*\//, '2026-01-01/')];

export const STORE_IGNORES = [
  ['_memories', ['_close.lock*', '._close.lock*', '.*.lock*', '.*.tmp-*', '_close-marker.json', '_maintenance-state.json', '_pm-state.json', '_capability-drift-log.md']],
  // Generated test rounds hold answer keys and run state: local evaluation, not project content.
  ['_tests/self-test', ['round-*/', 'auto-author-state.json']],
];

// The rest of what CORE writes in the project. Hot writers only make sure the file is there
// (verify: false); maintenance checks these with git, tracked files included.
export const METRICS_IGNORE = ['_metrics', ['*', '!.gitignore', '!README.md']];
// Machine telemetry only: the rest of `_sessions/` holds notes people write and stays visible.
export const SESSIONS_IGNORE = ['_sessions', ['*/retrieval-log.jsonl', '*/hygiene-log.jsonl', '*/outcome-log.jsonl', '*/self-test-log.jsonl', '*/priority-log.jsonl']];
export const STATE_IGNORE = [STATE_DIRNAME, ['*']];
export const PROJECT_IGNORES = [METRICS_IGNORE, SESSIONS_IGNORE, STATE_IGNORE];

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
// Another process may create the folder between the check and the mkdir: the loser looks again
// and accepts it only if it is now a real folder.
export function makeRealDir(projectRoot, rel, options) {
  try { mkdirSync(join(projectRoot, ...rel.split('/')), options); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const now = folderChain(projectRoot, rel);
    if (now !== 'real') refuse('cache-folder-unsafe', now);
  }
}

// Puts a fully written temp file in place by rename (with the bounded Windows retry). When the rename still fails
// but something is already at the destination, another writer got there first: the temp file is dropped and the caller
// judges what is there. With nothing there, the failure stands.
export function publishWhole(tmp, dest, rename = renameWithRetrySync) {
  try { rename(tmp, dest); }
  catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    try { lstatSync(dest); } catch { throw e; }
  }
}

export function ensureLibDir(projectRoot) {
  const store = folderChain(projectRoot, '_memories');
  if (store === 'absent') makeRealDir(projectRoot, '_memories');
  else if (store !== 'real') refuse('cache-folder-unsafe', store);
  ensureStoreIgnores(projectRoot);
  const lib = join(projectRoot, '_memories', '_lib');
  const state = folderChain(projectRoot, '_memories/_lib');
  if (state === 'absent') makeRealDir(projectRoot, '_memories/_lib', { mode: 0o700 });
  else if (state !== 'real') refuse('cache-folder-unsafe', state);
  const ignore = join(lib, '.gitignore');
  let st = null;
  try { st = lstatSync(ignore); } catch (e) { if (e.code !== 'ENOENT') refuse('cache-ignore-unsafe', `ignore file could not be examined (${e.code})`); }
  if (!st) {
    // Written whole under a name _memories already ignores, then renamed into place: a concurrent process never finds the
    // ignore file half-written, and nothing is ever written into _lib before its ignore file exists. Racing writers put down
    // identical bytes, and a rename replaces a link instead of following it.
    const tmp = join(projectRoot, '_memories', `.lib-ignore.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, HEADER + '*\n', { flag: 'wx', mode: 0o600 });
    publishWhole(tmp, ignore);
    st = lstatSync(ignore);
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) refuse('cache-ignore-unsafe', 'its ignore file is a link, a second name or not a file');
    const rules = readFileSync(ignore, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (rules.at(-1) !== '*' || rules.some((r) => r.startsWith('!'))) refuse('cache-ignore-unsafe', 'its ignore file does not end in * or re-includes a file');
  }
  const repo = ownRepository(projectRoot);
  if (repo === 'unknown') refuse('cache-tracking-unknown', 'the project\'s .git could not be examined');
  // A .git that is a link or a pointer file keeps its repository outside the project: not consulted (stated limit).
  if (repo === 'yes') {
    const r = spawnSync('git', ['-C', projectRoot, 'ls-files', '-z', '--', '_memories/_lib/'], { encoding: 'utf8', timeout: 3000, env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: dirname(projectRoot) } });
    if (r.status !== 0) refuse('cache-tracking-unknown', 'git could not say whether it is tracked');
    if (r.stdout.split('\0').some((n) => n && n !== '_memories/_lib/.gitignore')) refuse('cache-tracked', 'git tracks files in it');
  }
  return lib;
}

/**
 * 'yes' when the project's repository is a real `.git` folder at its root; 'no' when there is none;
 * 'elsewhere' when `.git` is a link or a pointer file (a worktree or submodule), whose repository lives
 * outside the project and is not consulted; 'unknown' when `.git` can't be examined.
 */
function ownRepository(root) {
  let st;
  try { st = lstatSync(join(root, '.git')); } catch (e) { return e.code === 'ENOENT' ? 'no' : 'unknown'; }
  return st.isDirectory() && !st.isSymbolicLink() ? 'yes' : 'elsewhere';
}

// A rule as a name test, so the CORE files actually present are checked too.
const ruleRe = (rule) => new RegExp('^' + rule.replace(/\/$/, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');

/**
 * The rules whose files git would still show, asked of the project's own repository only (git is kept
 * from looking above the project). Without a repository at the project root nothing is checked: a
 * repository above the project is not consulted, which is a stated limit, not a finding of "ignored".
 * The ignore file is examined before it is read, and a failure to check is reported, never read as clean.
 */
function visibleToGit(root, rel, dir, rules) {
  const repo = ownRepository(root);
  if (repo === 'no') return [];
  if (repo === 'unknown') return ['(could not check: the project\'s .git could not be examined)'];
  let text;
  try {
    const st = lstatSync(join(dir, '.gitignore'));
    if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) return ['(its .gitignore is a link, a second name or not a file, so git does not use it as written)'];
    text = readFileSync(join(dir, '.gitignore'), 'utf8');   // the one read; everything below uses it
  } catch (e) { return [`(could not check: ${e.code})`]; }
  // Exactly the file CORE writes: a folder's own rules decide for its files, so nothing above can undo them.
  if (text === HEADER + rules.join('\n') + '\n') return [];
  if (repo === 'elsewhere') return ['(was not checked: the project\'s .git is a link or pointer file, and the repository it names is not consulted)'];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const positives = rules.filter((r) => !r.startsWith('!'));
  const keep = new Set(['.gitignore', ...rules.filter((r) => r.startsWith('!')).map((r) => r.slice(1))]);
  const samples = positives.flatMap((rule) => samplesFor(rel, rule).map((n) => [rule, `${rel}/${n}`]));
  // The CORE files already here, whatever their generation or round number.
  const notes = [];
  let present = [];
  try { present = readdirSync(dir); } catch (e) { notes.push(`(could not list the folder (${e.code}), so the CORE files in it were not all checked)`); }
  for (const name of present) if (!keep.has(name)) for (const rule of positives) if (ruleRe(rule).test(name)) samples.push([rule, `${rel}/${name}${rule.endsWith('/') ? '/x' : ''}`]);
  // Future names in a numbered family (lock generations, rounds) count as covered only when this file
  // has CORE's own wildcard rule and re-includes nothing; anything else is said, not assumed.
  const reincludes = lines.some((l) => l.startsWith('!') && !rules.includes(l));
  const unproven = positives.filter((rule) => rule.includes('*') && (reincludes || !lines.includes(rule)));
  const r = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
    input: samples.map(([, p]) => p).join('\0') + '\0', encoding: 'utf8', timeout: 3000,
    env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: dirname(root) },
  });
  if (r.status !== 0 && r.status !== 1) return [...notes, `(could not check: git ${r.status ?? r.error?.code ?? 'failed'})`];
  const ignored = new Set(r.stdout.split('\0').filter(Boolean));
  const visible = [...new Set(samples.filter(([, p]) => !ignored.has(p)).map(([rule]) => rule))];
  const future = unproven.filter((rule) => !visible.includes(rule));
  if (future.length) notes.push(`(does not prove later names are covered for ${future.join(', ')}: it lacks CORE's rule or re-includes names)`);
  return [...visible, ...notes];
}

/** Problems found, as short strings; empty when every rule file is in place. Never throws. */
export function ensureStoreIgnores(projectRoot, { families = STORE_IGNORES, verify = true } = {}) {
  // ponytail: best effort so a lock or cache write never fails over an ignore file; the problems
  // are returned for a caller that reports them.
  const problems = [];
  for (const [rel, rules] of families) {
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
      if (!verify) continue;
      const found = visibleToGit(projectRoot, rel, dir, rules);
      const visible = found.filter((f) => !f.startsWith('(')), notes = found.filter((f) => f.startsWith('('));
      if (visible.length) problems.push(`${rel}/.gitignore is not CORE's and leaves ${visible.join(', ')} visible to git`);
      for (const note of notes) problems.push(`${rel}/.gitignore ${note.slice(1, -1)}`);
    }
  }
  return problems;
}

/**
 * CORE files in these families that git already tracks: an ignore rule doesn't apply to a tracked
 * file, so each is reported (the user decides whether to untrack it). Asked of the project's own
 * repository only; nothing when there is none, and a note when it can't be asked.
 */
export function trackedGenerated(projectRoot, families = [...STORE_IGNORES, ...PROJECT_IGNORES]) {
  const repo = ownRepository(projectRoot);
  if (repo === 'no') return [];
  if (repo !== 'yes') return [`tracked files were not checked: the project's .git ${repo === 'elsewhere' ? 'is a link or pointer file' : 'could not be examined'}`];
  const r = spawnSync('git', ['-C', projectRoot, 'ls-files', '-z', '--', ...families.map(([rel]) => `${rel}/`)], { encoding: 'utf8', timeout: 3000, env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: dirname(projectRoot) } });
  if (r.status !== 0) return [`tracked files were not checked: git ${r.status ?? r.error?.code ?? 'failed'}`];
  const out = [];
  for (const path of r.stdout.split('\0').filter(Boolean)) {
    const fam = families.find(([rel]) => path.startsWith(rel + '/'));
    if (!fam) continue;
    const [rel, rules] = fam;
    const sub = path.slice(rel.length + 1);
    if (sub === '.gitignore' || rules.includes('!' + sub)) continue;
    const parts = sub.split('/');
    const hit = rules.some((rule) => !rule.startsWith('!') && (rule.startsWith('*/')
      ? parts.length === 2 && ruleRe(rule.slice(2)).test(parts[1])
      : ruleRe(rule).test(parts[0])));
    if (hit) out.push(`${path} is tracked by git, so its ignore rule does not apply to it`);
  }
  return out;
}
