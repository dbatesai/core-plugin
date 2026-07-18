/**
 * trusted-test-tmp.mjs — shared root for hostile-env-var isolation tests.
 *
 * Once CORE_HOOKS_LOG_FILE only honors overrides that resolve inside the trusted
 * ~/.core (mirroring resolveIndexPath's CORE_CLOSE_INDEX gate), test fixtures that
 * redirect the hook log for isolation have to live there too — os.tmpdir() no
 * longer qualifies. Not auto-cleaned by the OS the way os.tmpdir() is, so callers
 * that create paths here MUST register an after() cleanup (see isolatedHooksLog()
 * call sites for the pattern).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function trustedTestTmpRoot() {
  const dir = join(homedir(), '.core', '.test-tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}
