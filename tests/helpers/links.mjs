// Links for the store-boundary fixtures. A folder link is a symbolic link where this account may
// make one, and on Windows otherwise a directory junction: a junction needs no admin rights or
// developer mode, and lstat and directory listings report it as a link (libuv marks every reparse
// point as one). A file has no junction form, so where a symbolic link can't be made the file-link
// cases skip with FILE_LINK_SKIP.
//
// CORE_TEST_LINKS=junction takes the no-symlink branch on any platform, so a POSIX run shows which
// cases a Windows runner without symlink rights skips (the 'junction' type is ignored off Windows).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function symlinksAllowed() {
  if (process.env.CORE_TEST_LINKS === 'junction') return false;
  if (process.platform !== 'win32') return true;
  const dir = mkdtempSync(join(tmpdir(), 'core-link-probe-'));
  try {
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'dir');
    return true;
  } catch { return false; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export const CAN_SYMLINK = symlinksAllowed();
export const FILE_LINK_SKIP = CAN_SYMLINK ? false : 'file links need symlink rights; a junction links folders only';

/** A link at `path` to the folder `target`: a symbolic link, or a junction when only that is allowed. */
export function linkFolder(target, path) {
  symlinkSync(target, path, CAN_SYMLINK ? 'dir' : 'junction');
}

/** A symbolic link at `path` to the file `target`. Callers skip with FILE_LINK_SKIP when it can't be made. */
export function linkFile(target, path) {
  if (!CAN_SYMLINK) throw new Error(`linkFile called where file links can't be made; skip with FILE_LINK_SKIP (${path})`);
  symlinkSync(target, path, 'file');
}
