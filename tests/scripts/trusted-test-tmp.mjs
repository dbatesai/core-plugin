/**
 * trusted-test-tmp.mjs — shared root for hostile-env-var isolation tests.
 *
 * Once CORE_HOOKS_LOG_FILE/CORE_RETRIEVAL_STORE/CORE_CLOSE_STORE only honor
 * overrides that resolve inside the trusted ~/.core (D1 fix, mirroring
 * resolveIndexPath's CORE_CLOSE_INDEX gate), test fixtures that redirect any
 * of them for isolation have to live there too — os.tmpdir() no longer
 * qualifies. Not auto-cleaned by the OS the way os.tmpdir() is, so callers
 * that create paths here MUST register an after() cleanup (see
 * isolatedHooksLog() call sites for the pattern).
 */
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function trustedTestTmpRoot() {
  const dir = join(homedir(), '.core', '.test-tmp');
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
