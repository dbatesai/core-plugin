/**
 * fs-confine.mjs — the attempted-access gate for one-folder tests.
 *
 * Imported first in a child process (`node --import ./fs-confine.mjs …`), it wraps node:fs so any
 * path outside FS_CONFINE_ROOTS (path-delimiter separated) is recorded and refused with EACCES,
 * and the list is printed to stderr as `FS_CONFINE_VIOLATIONS <json>` at exit. Refused and
 * recorded both, because best-effort code that swallows the error would otherwise hide the access.
 * Named ESM imports see the wrappers too (synced after wrapping). Covers the sync, callback and promise forms of the path-taking calls CORE uses; it is a test
 * seam, not a sandbox (a native addon or child process is outside it). FS_CONFINE_ERRNO=ENOENT answers
 * every outside path as absent instead of unreadable (EACCES, the default); FS_CONFINE_LOG=<file> appends one
 * JSON line per path-taking call, allowed or refused, written with the unwrapped originals. Paths are judged
 * physically (links resolved), so a link out of a root is caught; a link swapped in between the
 * check and the call is not.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Physical, not lexical: a path is judged by where it actually leads. The deepest existing
// ancestor is resolved (links followed) and the rest appended, so a link inside a root that
// points elsewhere counts as outside. The originals are captured before anything is wrapped.
const realNative = fs.realpathSync.native.bind(fs);
const physical = (abs) => {
  let head = abs, tail = '';
  for (;;) {
    try { return tail ? join(realNative(head), tail) : realNative(head); }
    catch { const parent = dirname(head); if (parent === head) return abs; tail = tail ? join(basename(head), tail) : basename(head); head = parent; }
  }
};
const roots = (process.env.FS_CONFINE_ROOTS || '').split(delimiter).filter(Boolean).map(r => physical(resolve(r)));
const violations = [];
const ERRNO = process.env.FS_CONFINE_ERRNO === 'ENOENT' ? 'ENOENT' : 'EACCES';
const LOG = process.env.FS_CONFINE_LOG || '';
const rawAppend = fs.appendFileSync.bind(fs);
const record = (call, path, verdict) => { if (LOG) { try { rawAppend(LOG, JSON.stringify({ call, path: String(path), verdict }) + '\n'); } catch { /* the log is evidence, never a dependency */ } } };
// Calls that act on a link itself (lstat, readlink, unlink, rm, rename) are judged by where the
// link sits: its parent resolved physically, plus its own name.
const ON_LINK = new Set(['lstat', 'readlink', 'unlink', 'rm', 'rmdir', 'rename']);
const inside = (p, name = '') => {
  if (typeof p !== 'string' && !(p instanceof URL)) return true;   // fds and buffers pass through
  const lex = resolve(p instanceof URL ? fileURLToPath(p) : p);
  const abs = ON_LINK.has(name) ? join(physical(dirname(lex)), basename(lex)) : physical(lex);
  return roots.some(r => abs === r || abs.startsWith(r + sep));
};
const refuse = (call, p) => {
  violations.push({ call, path: String(p) });
  record(call, p, `refused-${ERRNO}`);
  return Object.assign(new Error(`fs-confine: ${call} ${p}`), { code: ERRNO });
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
      const bad = paths(name, args).find(p => !inside(p, name));
      if (bad === undefined) { if (LOG) record(key, paths(name, args)[0], 'allowed'); return orig.apply(this, args); }
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
        if (inside(args[0])) { record(`${key}.native`, args[0], 'allowed'); return nat.apply(this, args); }
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
fs.existsSync = (p) => { if (!inside(p)) { refuse('existsSync', p); return false; } record('existsSync', p, 'allowed'); return origExists(p); };
// CORE imports fs functions by name; without this, named imports keep the unwrapped originals.
syncBuiltinESMExports();
process.on('exit', () => { process.stderr.write(`FS_CONFINE_VIOLATIONS ${JSON.stringify(violations)}\n`); });
