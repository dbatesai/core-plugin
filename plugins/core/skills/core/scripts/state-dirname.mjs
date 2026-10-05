/** The project's CORE state folder name, kept dependency-free so project-only code can use it. */
import { lstatSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { trustedHome } from './trusted-home.mjs';

// Files only the account's own ~/.core holds. A folder carrying any of them is never renamed.
const ACCOUNT_MARKERS = ['install-secret', 'install-id', 'projects.json', 'index.json'];
const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); } };

export const STATE_DIRNAME = '_core';
export const LEGACY_STATE_DIRNAME = '.core';

/**
 * The project's state folder was named `.core` before it was made visible as `_core`. Whatever first
 * resolves a project's state renames it once. A rename is atomic, so a concurrent caller either does it
 * or finds it done, and nothing inside changes (stamps bind the project root, MACs bind file names).
 * When both exist, `_core` is used and the older folder is left for the user. The account's own
 * ~/.core (the home folder's, the one passed as `coreDir`, or any folder holding the install keys or
 * registry) is never renamed. Returns what it found.
 */
/** True when only the older `.core` is there, as a real folder: a rename is still to come. Reads only. */
export function folderNeedsRename(root) {
  try { const st = lstatSync(join(root, LEGACY_STATE_DIRNAME)); if (!st.isDirectory() || st.isSymbolicLink()) return false; }
  catch { return false; }
  try { lstatSync(join(root, STATE_DIRNAME)); return false; } catch { return true; }
}

export function settleStateFolderName(root, { coreDir } = {}) {
  const from = join(root, LEGACY_STATE_DIRNAME), to = join(root, STATE_DIRNAME);
  let st;
  try { st = lstatSync(from); } catch { return null; }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'legacy-not-a-folder';
  const home = trustedHome();
  if ((home && same(root, home)) || (coreDir && same(from, coreDir)) || ACCOUNT_MARKERS.some((n) => existsSync(join(from, n)))) return 'account-folder';
  try { lstatSync(to); return 'both'; } catch { /* only the older folder: rename it */ }
  try { renameSync(from, to); return 'renamed'; }
  catch (e) { return existsSync(to) ? 'both' : `not-renamed:${e.code}`; }
}
