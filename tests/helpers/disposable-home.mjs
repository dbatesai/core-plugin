// True only for the folder run-suite-isolated.mjs itself creates: <realpath of the system temp folder>/core-suite-home-XXXXXX,
// a real directory (not a link) owned by the current user. A matching name alone is not enough to mutate or remove anything.
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export function isRunnerHome(path) {
  try {
    if (typeof path !== 'string' || !/^core-suite-home-[A-Za-z0-9]{6}$/.test(basename(path))) return false;
    if (realpathSync(dirname(path)) !== realpathSync(tmpdir())) return false;
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && (process.getuid === undefined || st.uid === process.getuid());
  } catch { return false; }
}
