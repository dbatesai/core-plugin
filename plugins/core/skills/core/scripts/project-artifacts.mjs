/** Reserved local hook/scratch artifacts. This creates no enrollment or identity state. */
import { lstatSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve, join, dirname } from 'node:path';
import { trackedStateFiles } from './project-state.mjs';

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
  if (!['_hooks', '_scratch'].includes(kind)) refuse();
  const root = projectArtifactRoot(projectRoot);
  const core = join(root, '.core'), dir = join(core, kind);
  physicalDirectory(core);
  // Check each component before descending, including an already present .core link.
  const coreStat = statOrMissing(core);
  if (coreStat) physicalDirectory(dir);
  const tracked = trackedStateFiles(root, kind);
  if (tracked.size || tracked.has('.gitignore')) refuse();
  if (!coreStat) mkdirSync(core, { mode: 0o700 });
  if (!physicalDirectory(dir)) mkdirSync(dir, { mode: 0o700 });
  const ignore = join(dir, '.gitignore');
  assertArtifactFile(dir, ignore);
  if (!statOrMissing(ignore)) writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
  // Preserve custom files. Only an existing policy excluding every artifact is accepted.
  const rules = readFileSync(ignore, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  if (rules.at(-1) !== '*') refuse();
  return dir;
}
