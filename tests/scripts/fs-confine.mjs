/**
 * fs-confine.mjs — the attempted-access gate for one-folder tests.
 *
 * Imported first in a child process (`node --import ./fs-confine.mjs …`), it wraps node:fs so any
 * path outside FS_CONFINE_ROOTS (path-delimiter separated) is recorded and refused with EACCES,
 * and the list is printed to stderr as `FS_CONFINE_VIOLATIONS <json>` at exit. Refused and
 * recorded both, because best-effort code that swallows the error would otherwise hide the access.
 * Named ESM imports see the wrappers too (synced after wrapping). Covers the sync, callback and promise forms of the path-taking calls CORE uses; it is a test
 * seam, not a sandbox (a native addon or child process is outside it).
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { delimiter, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = (process.env.FS_CONFINE_ROOTS || '').split(delimiter).filter(Boolean).map(r => resolve(r));
const violations = [];
const inside = (p) => {
  if (typeof p !== 'string' && !(p instanceof URL)) return true;   // fds and buffers pass through
  const abs = resolve(p instanceof URL ? fileURLToPath(p) : p);
  return roots.some(r => abs === r || abs.startsWith(r + sep));
};
const refuse = (call, p) => {
  violations.push({ call, path: String(p) });
  return Object.assign(new Error(`fs-confine: ${call} ${p}`), { code: 'EACCES' });
};
const TWO = new Set(['rename', 'link', 'symlink', 'copyFile', 'cp']);
const NAMES = ['access', 'appendFile', 'chmod', 'copyFile', 'cp', 'link', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir',
  'readdir', 'readFile', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes', 'writeFile'];
const paths = (name, args) => (TWO.has(name) ? [args[0], args[1]] : [args[0]]);

for (const name of NAMES) {
  for (const [obj, key] of [[fs, `${name}Sync`], [fs, name], [fs.promises, name]]) {
    const orig = obj[key];
    if (typeof orig !== 'function') continue;
    const wrapped = function confined(...args) {
      const bad = paths(name, args).find(p => !inside(p));
      if (bad === undefined) return orig.apply(this, args);
      const err = refuse(key, bad);
      if (obj === fs.promises) return Promise.reject(err);
      if (key.endsWith('Sync')) throw err;
      const cb = args.find(a => typeof a === 'function');
      if (cb) return process.nextTick(cb, err);
      throw err;
    };
    // realpathSync.native / realpath.native ride on the function object: wrap and keep them.
    if (typeof orig.native === 'function') {
      const nat = orig.native;
      wrapped.native = function confinedNative(...args) {
        if (inside(args[0])) return nat.apply(this, args);
        const err = refuse(`${key}.native`, args[0]);
        if (key.endsWith('Sync')) throw err;
        const cb = args.find(a => typeof a === 'function');
        if (cb) return process.nextTick(cb, err);
        throw err;
      };
    }
    obj[key] = wrapped;
  }
}
const origExists = fs.existsSync;
fs.existsSync = (p) => { if (!inside(p)) { refuse('existsSync', p); return false; } return origExists(p); };
// CORE imports fs functions by name; without this, named imports keep the unwrapped originals.
syncBuiltinESMExports();
process.on('exit', () => { process.stderr.write(`FS_CONFINE_VIOLATIONS ${JSON.stringify(violations)}\n`); });
