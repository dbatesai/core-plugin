/**
 * trusted-test-tmp.mjs — shared root for hostile-env-var isolation tests.
 *
 * Once CORE_HOOKS_LOG_FILE/CORE_RETRIEVAL_STORE/CORE_CLOSE_STORE only honor
 * overrides that resolve inside the trusted ~/.core (mirroring
 * resolveIndexPath's CORE_CLOSE_INDEX gate), test fixtures that redirect any
 * of them for isolation have to live there too — os.tmpdir() no longer
 * qualifies. Not auto-cleaned by the OS the way os.tmpdir() is, so callers
 * that create paths here MUST register an after() cleanup (see
 * isolatedHooksLog() call sites for the pattern).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { localStateDir } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { tmpdir } from 'node:os';
import { trustedHome } from '../../plugins/core/skills/core/scripts/trusted-home.mjs';
import { randomUUID } from 'node:crypto';

/**
 * Windows without Developer Mode or admin lacks SeCreateSymbolicLinkPrivilege,
 * so fs.symlinkSync throws EPERM for a normal process — symlink-fixture tests
 * then hard-fail in SETUP without exercising the product logic at all
 * (a Windows full-suite finding). Probe once per process;
 * symlink-dependent tests call this and skip cleanly when it's false.
 * GitHub's windows-latest runners have the privilege, so CI still exercises
 * the real assertions everywhere they can run.
 */
let _tarWritesZip = null;
/** Whether the local `tar` writes a real zip for `-a -c -f x.zip` (bsdtar does; GNU tar writes a plain tar under that name). */
export function tarWritesZip() {
  if (_tarWritesZip !== null) return _tarWritesZip;
  const dir = mkdtempSync(join(tmpdir(), 'tar-zip-probe-'));
  try {
    mkdirSync(join(dir, 'in'));
    writeFileSync(join(dir, 'in', 'f.txt'), 'x');
    const r = spawnSync('tar', ['-a', '-c', '-f', 'p.zip', '-C', 'in', '.'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    _tarWritesZip = r.status === 0 && readFileSync(join(dir, 'p.zip')).subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  } catch {
    _tarWritesZip = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return _tarWritesZip;
}

let _symlinkCapable = null;
export function symlinkCapable() {
  if (_symlinkCapable !== null) return _symlinkCapable;
  const dir = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try {
    symlinkSync(dir, join(dir, 'probe-link'), 'dir');
    _symlinkCapable = true;
  } catch {
    _symlinkCapable = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return _symlinkCapable;
}

/**
 * CORE keeps an unregistered project's state under the real ~/.core/local/<key>/ (the state home
 * reads the OS account, never $HOME), so every temp test project that reaches state leaves a
 * folder there. Call when the project is created; its local folder is removed when the process exits.
 */
const localLeftovers = new Set();
export function removeLocalStateOnExit(project) {
  if (!localLeftovers.size) process.on('exit', () => { for (const d of localLeftovers) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
  localLeftovers.add(dirname(localStateDir({ root: realpathSync(project), harness: 'claude-code' })));
  return project;
}

export function trustedTestTmpRoot() {
  // Under the isolated runner, its disposable account (CORE_TEST_ACCOUNT_HOME) even in a child that dropped the
  // preload: such a child would otherwise read the real account record and create .test-tmp in the real ~/.core.
  const dir = join(process.env.CORE_TEST_ACCOUNT_HOME || trustedHome(), '.core', '.test-tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Symlinks a committed, read-only fixture directory into the trusted root so
 * CORE_RETRIEVAL_STORE/CORE_CLOSE_STORE can legitimately point at it —
 * path.resolve() doesn't dereference symlinks, so the link itself (inside
 * ~/.core) is what the trust check sees, while fs reads through it transparently
 * reach the real fixture. Cheap: no copying a potentially large fixture tree.
 * Caller must rmSync the returned link path (force: true — it's a symlink, not
 * a directory to recurse into) in its own cleanup/after().
 */
export function linkFixtureUnderTrustedRoot(fixturePath) {
  const link = join(trustedTestTmpRoot(), `fixt-${randomUUID()}`);
  symlinkSync(fixturePath, link, 'dir');
  return link;
}

/**
 * Registers `projectPath` in a throwaway registry under the trusted root and returns the env
 * entry that points a hook subprocess at it (CORE_CLOSE_INDEX is honored only inside ~/.core).
 * The per-turn retrieval hook injects memory only for a registered project, so a hook test
 * that wants retrieval must register its store this way. The registry dir is removed when
 * the test process exits.
 */
const _registryDirs = [];
process.on('exit', () => { for (const d of _registryDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
export function registryEnvFor(...projectPaths) {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'registry-'));
  _registryDirs.push(dir);
  const file = join(dir, 'projects.json');
  writeFileSync(file, JSON.stringify(projectPaths.map((path) => ({ path }))));
  return { CORE_CLOSE_INDEX: file };
}
