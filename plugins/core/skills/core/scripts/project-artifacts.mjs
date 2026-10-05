/** Reserved local hook/scratch/cache artifacts. This creates no enrollment or identity state. */
import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { trackedProjectFiles, trackedStateFiles, STATE_DIRNAME, settleStateFolderName } from './project-state.mjs';

function refuse() { throw Object.assign(new Error('Project artifact target is not safe'), { code: 'project-artifact-unsafe-target' }); }
function statOrMissing(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function physicalDirectory(path) {
  const st = statOrMissing(path);
  if (st && (!st.isDirectory() || st.isSymbolicLink())) refuse();
  return st;
}
export function assertArtifactFile(dir, file) {
  if (dirname(file) !== dir) refuse();
  const st = statOrMissing(file);
  if (st && (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1)) refuse();
}
export function projectArtifactRoot(projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) refuse();
  const path = resolve(projectRoot);
  if (!physicalDirectory(path)) refuse();
  // OS aliases in ancestors (e.g. macOS /var -> /private/var) are canonicalized.
  // The supplied root itself must be a physical directory, not a linked root.
  return realpathSync(path);
}
export function ensureProjectArtifactDir(projectRoot, kind) {
  if (!['_hooks', '_scratch', '_package', '_agent'].includes(kind)) refuse();
  return ensureGeneratedDir(projectRoot, [STATE_DIRNAME, kind]);
}

/** Generated attribution cache uses the same policy-before-writer guard as hook/scratch files. */
export function ensureProjectCacheDir(projectRoot) {
  return ensureGeneratedDir(projectRoot, ['_memories', '_lib']);
}

/** Local-only receipt checks must validate policy without creating or rewriting any artifact. */
export function assertProjectCacheDir(projectRoot) {
  return ensureGeneratedDir(projectRoot, ['_memories', '_lib'], false);
}

function ensureGeneratedDir(projectRoot, segments, create = true) {
  const root = projectArtifactRoot(projectRoot);
  if (segments[0] === STATE_DIRNAME) settleStateFolderName(root);
  const parent = join(root, segments[0]), dir = join(parent, segments[1]);
  const parentStat = physicalDirectory(parent);
  if (parentStat) physicalDirectory(dir);
  const tracked = segments[0] === STATE_DIRNAME ? trackedStateFiles(root, segments[1]) : trackedProjectFiles(root, segments.join('/') + '/');
  if (tracked.size || tracked.has('.gitignore')) refuse();
  if (!parentStat) { if (!create) refuse(); mkdirSync(parent, { mode: 0o700 }); }
  if (!physicalDirectory(dir)) { if (!create) refuse(); mkdirSync(dir, { mode: 0o700 }); }
  const ignore = join(dir, '.gitignore');
  assertArtifactFile(dir, ignore);
  if (!statOrMissing(ignore)) { if (!create) refuse(); writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
  // Preserve custom files. Only an existing policy excluding every artifact is accepted.
  const rules = readFileSync(ignore, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (rules.at(-1) !== '*') refuse();
  return dir;
}
