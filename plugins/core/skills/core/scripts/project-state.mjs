/**
 * project-state.mjs — where a project's CORE operational state lives, and whether
 * state found there can be trusted.
 *
 * Layout: <project-root>/.core/<harness>/, with a `*` .gitignore written into
 * .core/ before anything else. ~/.core keeps only cross-project files plus
 * projects.json (the registered roots) and local/ (state that must not sit in the
 * project: synced folders' hot files, read-only roots, another install's project).
 *
 * The project root is the nearest ancestor of the working directory that is
 * registered. The walk stops at any folder carrying its own `.git` (directory or
 * worktree/submodule file) and never considers $HOME or anything inside ~/.core,
 * so a home-directory repo or a nested clone never becomes, or inherits, a root.
 *
 * Trust: a registry entry can only be written by a startup the user ran, so the
 * registry is the auto-close anchor. State inside the project is trusted only when
 * its stamp verifies: an HMAC-SHA256 over (path, harness, install_id) keyed with
 * ~/.core/install-secret. A cloned or downloaded .core/ cannot carry a valid stamp.
 *
 * Ships with the plugin by convention; .mjs (Node.js) only, node:* imports only.
 */

import {
  existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, writeFileSync, accessSync, constants as fsConstants,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { projectPathContainsOneDriveSubstring } from './metrics-init.mjs';
import { requireTrustedHome, containedPath } from './trusted-home.mjs';

export const STATE_DIRNAME = '.core';
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

export function defaultHome(opts) { return requireTrustedHome(opts); }
export function defaultCoreDir(opts) { return join(requireTrustedHome(opts), '.core'); }

/** realpath with native expansion (Windows 8.3 short names); the resolved spelling when absent. */
export function canonical(p) {
  try { return realpathSync.native(resolve(p)); } catch { return resolve(p); }
}

function isInside(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function hasGitMarker(dir) {
  try { lstatSync(join(dir, '.git')); return true; } catch { return false; }
}

function readJsonArray(file) {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * Registered project roots, canonicalized. projects.json is the registry; the
 * legacy index.json is read alongside it while older installs may still register
 * there (pass includeLegacyIndex: false once no unmigrated entry remains).
 */
export function readRegisteredRoots({ coreDir = defaultCoreDir(), includeLegacyIndex = true } = {}) {
  const paths = readJsonArray(join(coreDir, 'projects.json')).map((e) => e && e.path);
  if (includeLegacyIndex) {
    for (const e of readJsonArray(join(coreDir, 'index.json'))) paths.push(e && e.path);
  }
  const home = dirname(coreDir);
  const out = new Set();
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const expanded = p.startsWith('~/') || p === '~' ? join(home, p.slice(1)) : p;
    out.add(canonical(expanded));
  }
  return out;
}

/**
 * The registered project a working directory belongs to, or null.
 * Returns { root, reason }. reason is 'registered' when found, otherwise why the
 * walk stopped: 'git-boundary', 'home', or 'filesystem-root'.
 */
export function resolveProjectRoot(cwd, { home = defaultHome(), coreDir, registered } = {}) {
  const core = canonical(coreDir || join(home, '.core'));
  const homeReal = canonical(home);
  const roots = registered || readRegisteredRoots({ coreDir: core });
  let dir = canonical(cwd);
  for (;;) {
    if (dir === homeReal) return { root: null, reason: 'home' };
    if (!isInside(dir, core) && roots.has(dir)) return { root: dir, reason: 'registered' };
    if (hasGitMarker(dir)) return { root: null, reason: 'git-boundary', boundary: dir };
    const parent = dirname(dir);
    if (parent === dir) return { root: null, reason: 'filesystem-root' };
    dir = parent;
  }
}

/**
 * What `/core` should do with an unregistered directory.
 *   { action: 'registered', root }
 *   { action: 'refuse', reason: 'home' | 'core-dir' | 'contains-registered', contains? }
 *   { action: 'ask', parent }   — inside a registered project, below no .git boundary
 *   { action: 'new', root }
 */
export function classifyRegistration(dir, { home = defaultHome(), coreDir } = {}) {
  const core = canonical(coreDir || join(home, '.core'));
  const homeReal = canonical(home);
  const real = canonical(dir);
  const roots = readRegisteredRoots({ coreDir: core });
  if (real === homeReal) return { action: 'refuse', reason: 'home' };
  if (isInside(real, core)) return { action: 'refuse', reason: 'core-dir' };
  if (roots.has(real)) return { action: 'registered', root: real };

  const contained = [];
  for (const r of roots) {
    if (r === real || !isInside(r, real)) continue;
    let behindBoundary = false;
    for (let d = r; d !== real && isInside(d, real); d = dirname(d)) {
      if (hasGitMarker(d)) { behindBoundary = true; break; }
    }
    if (!behindBoundary) contained.push(r);
  }
  if (contained.length) return { action: 'refuse', reason: 'contains-registered', contains: contained };

  const up = resolveProjectRoot(real, { home, coreDir: core, registered: roots });
  if (up.root) return { action: 'ask', parent: up.root };
  return { action: 'new', root: real };
}

// ---------- where state goes ----------

/** Path under a sync client: OneDrive, iCloud Drive, macOS CloudStorage mounts, Dropbox, Google Drive. */
export function isSyncedPath(p) {
  const norm = String(p).replace(/\\/g, '/');
  if (projectPathContainsOneDriveSubstring(norm)) return true;
  if (norm.includes('/Library/Mobile Documents/') || norm.includes('/Library/CloudStorage/')) return true;
  return norm.split('/').some((c) => c === 'Dropbox' || c.startsWith('Dropbox (') || c === 'Google Drive');
}

function isWritableDir(p) {
  try { accessSync(p, fsConstants.W_OK); return true; } catch { return false; }
}

export function assertHarnessName(harness) {
  if (typeof harness !== 'string' || !HARNESS_RE.test(harness)) {
    throw Object.assign(new Error(`unsafe harness name ${JSON.stringify(harness)}`), { code: 'UNSAFE_HARNESS' });
  }
  return harness;
}

/** ~/.core/local/<root-slug>/<harness>/ — state that must stay on this machine's disk. */
export function localStateDir({ root, harness, coreDir = defaultCoreDir() }) {
  return join(coreDir, 'local', mapProjectPathToSlug(canonical(root)), assertHarnessName(harness));
}

/**
 * The directory a kind of state belongs in. Does not create anything.
 * kind 'durable' (manifest, stamp, drafts) stays in the project unless the root
 * is not writable; kind 'hot' (append logs, metrics, locks) also moves to local/
 * when the root is under a sync client.
 * A root that is not registered (~/.core/projects.json, or the legacy index.json)
 * never gets in-project state: its state lives under ~/.core/local/.
 * Returns { dir, location: 'project' | 'local', reason }.
 */
export function projectStateDir({ root, harness, kind = 'durable', coreDir = defaultCoreDir(), registered }) {
  assertHarnessName(harness);
  if (kind !== 'durable' && kind !== 'hot') throw new Error(`projectStateDir: unknown kind ${kind}`);
  const real = canonical(root);
  const core = canonical(coreDir);
  if (real === dirname(core) || isInside(real, core)) {
    return { dir: localStateDir({ root: real, harness, coreDir }), location: 'local', reason: 'not-a-project-root' };
  }
  // Only a folder the user registered by running /core gets a .core/ inside it; a
  // hook or script working anywhere else keeps its state on this machine.
  let roots = registered;
  if (!roots) { try { roots = readRegisteredRoots({ coreDir: core }); } catch { roots = new Set(); } }
  if (!roots.has(real)) {
    return { dir: localStateDir({ root: real, harness, coreDir }), location: 'local', reason: 'unregistered' };
  }
  if (!isWritableDir(real)) {
    return { dir: localStateDir({ root: real, harness, coreDir }), location: 'local', reason: 'root-not-writable' };
  }
  if (kind === 'hot' && isSyncedPath(real)) {
    return { dir: localStateDir({ root: real, harness, coreDir }), location: 'local', reason: 'synced-folder' };
  }
  return { dir: join(real, STATE_DIRNAME, harness), location: 'project', reason: 'in-project' };
}

/**
 * Containment for in-project state: .core/ and .core/<harness>/ must each be a real
 * directory (not a symlink) directly inside the root. Returns null when they are
 * absent, 'ok' when sound, or the refusal reason.
 */
export function checkStateContainment({ root, harness }) {
  const real = canonical(root);
  const coreDir = join(real, STATE_DIRNAME);
  for (const p of [coreDir, join(coreDir, harness)]) {
    let st;
    try { st = lstatSync(p); } catch { return p === coreDir ? null : 'ok-absent-harness'; }
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isDirectory()) return 'not-directory';
    if (canonical(p) !== p) return 'escapes-root';
  }
  return 'ok';
}

/**
 * Create the state directory for writing. In-project: .core/.gitignore ("*") is
 * written before any other file, and a symlinked or non-directory .core refuses.
 */
export function ensureStateDir(opts) {
  const target = projectStateDir(opts);
  if (target.location === 'project') {
    const dir = join(canonical(opts.root), STATE_DIRNAME, assertHarnessName(opts.harness));
    if (!existsSync(dir)) writeStamp({ root: opts.root, harness: opts.harness, coreDir: opts.coreDir || defaultCoreDir() });
    return { ...target, dir };
  }
  mkdirSync(target.dir, { recursive: true });
  return target;
}

/** Create <root>/.core/ — refusing a symlinked or escaping .core — with .gitignore first. */
function ensureCoreDir(root, harness) {
  const real = canonical(root);
  const containment = checkStateContainment({ root: real, harness });
  if (containment && containment !== 'ok' && containment !== 'ok-absent-harness') {
    throw Object.assign(new Error(`refusing ${join(real, STATE_DIRNAME)}: ${containment}`), { code: 'STATE_CONTAINMENT', reason: containment });
  }
  const coreDir = join(real, STATE_DIRNAME);
  mkdirSync(coreDir, { recursive: true });
  const gitignore = join(coreDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, '*\n');
  return coreDir;
}

// A harness folder never exists without its stamp: it is built beside its final name
// with the stamp inside and renamed into place, so a concurrent reader can't see an
// unstamped folder and set it aside as planted. Losing the rename race is fine.
function createStampedHarnessDir(stateRoot, harness, stampBody) {
  const final = join(stateRoot, harness);
  if (existsSync(final)) return final;
  const tmp = join(stateRoot, `.creating-${harness}-${randomBytes(6).toString('hex')}`);
  mkdirSync(tmp);
  try {
    writeFileSync(join(tmp, 'stamp'), stampBody);
    renameSync(tmp, final);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(final)) throw err;
  }
  return final;
}

// ---------- install identity and the stamp ----------

// Written whole to a temp file, then hard-linked into place: a concurrent reader sees
// either no file or the complete one, never an empty file mid-write.
function createOnce(file, content, mode) {
  if (!existsSync(file)) {
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, content, { mode });
    try { linkSync(tmp, file); } catch (err) { if (err.code !== 'EEXIST') throw err; } finally { rmSync(tmp, { force: true }); }
  }
  return readFileSync(file, 'utf8').trim();
}

/** This install's secret and id, created on first use (the secret mode 0600). */
export function ensureInstallIdentity({ coreDir = defaultCoreDir() } = {}) {
  mkdirSync(coreDir, { recursive: true });
  const secretHex = createOnce(join(coreDir, 'install-secret'), randomBytes(32).toString('hex') + '\n', 0o600);
  const installId = createOnce(join(coreDir, 'install-id'), randomBytes(16).toString('hex') + '\n', 0o644);
  if (!HEX64_RE.test(secretHex)) throw new Error(`install-secret is malformed: ${join(coreDir, 'install-secret')}`);
  return { secret: Buffer.from(secretHex, 'hex'), installId };
}

export function stampHmac(secret, { path, harness, install_id }) {
  return createHmac('sha256', secret).update(JSON.stringify([path, harness, install_id])).digest('hex');
}

/** Write the stamp for a root this install owns. Returns the stamp object. */
export function writeStamp({ root, harness, coreDir = defaultCoreDir() }) {
  const { secret, installId } = ensureInstallIdentity({ coreDir });
  const path = canonical(root);
  const stamp = { path, harness: assertHarnessName(harness), install_id: installId };
  stamp.hmac = stampHmac(secret, stamp);
  const body = JSON.stringify(stamp, null, 2) + '\n';
  const dir = createStampedHarnessDir(ensureCoreDir(path, harness), stamp.harness, body);
  atomicWriteFileSync(join(dir, 'stamp'), body);
  return stamp;
}

function wellFormed(s) {
  return s && typeof s === 'object'
    && typeof s.path === 'string' && s.path
    && typeof s.harness === 'string'
    && typeof s.install_id === 'string' && s.install_id
    && typeof s.hmac === 'string' && HEX64_RE.test(s.hmac);
}

/**
 * Classify the in-project state for (root, harness). Reads only the stamp file,
 * never any other state file.
 *   absent          — no .core/<harness>/ yet
 *   refused         — .core or .core/<harness> is a symlink, not a directory, or escapes the root
 *   verified        — this install's stamp for this path: use the state
 *   planted         — missing/malformed stamp, or this install's id but it does not verify
 *   foreign-install — well-formed stamp from another install: leave it untouched
 *   moved           — verifies, old path gone and its parent still exists
 *   copied          — verifies, old path still exists
 *   ask             — verifies, old path and its parent both gone
 */
export function classifyStamp({ root, harness, coreDir = defaultCoreDir() }) {
  assertHarnessName(harness);
  const real = canonical(root);
  const containment = checkStateContainment({ root: real, harness });
  if (containment === null || containment === 'ok-absent-harness') return { status: 'absent' };
  if (containment !== 'ok') return { status: 'refused', reason: containment };

  const stampFile = join(real, STATE_DIRNAME, harness, 'stamp');
  let stamp = null;
  try {
    const st = lstatSync(stampFile);
    if (st.isFile()) stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
  } catch { stamp = null; }
  if (!wellFormed(stamp)) return { status: 'planted', reason: stamp ? 'malformed-stamp' : 'missing-stamp' };

  const { secret, installId } = ensureInstallIdentity({ coreDir });
  if (stamp.install_id !== installId) return { status: 'foreign-install', stamp };
  const expected = Buffer.from(stampHmac(secret, stamp), 'hex');
  const given = Buffer.from(stamp.hmac, 'hex');
  if (stamp.harness !== harness || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { status: 'planted', reason: 'hmac-mismatch' };
  }
  if (stamp.path === real) return { status: 'verified', stamp };
  if (existsSync(stamp.path)) return { status: 'copied', stamp, oldPath: stamp.path };
  if (existsSync(dirname(stamp.path))) return { status: 'moved', stamp, oldPath: stamp.path };
  return { status: 'ask', stamp, oldPath: stamp.path };
}

/** A path read out of project state must resolve inside that state directory. */
export function containedInState(stateDir, candidate) {
  return containedPath(stateDir, candidate);
}

// ---------- the harness and the root a caller is working in ----------

/**
 * The harness whose subfolder this process reads and writes. CORE_HARNESS wins
 * when it is a safe name; otherwise each harness is detected by its own positive
 * env signal. An unrecognized harness gets 'unknown' rather than borrowing another
 * harness's subfolder, so two harnesses never share one manifest by accident.
 * Canonical signal list: harnesses/<name>.md §detect-harness (env-visible subset).
 */
function harnessFromEnv(env) {
  if (!env) return null;
  const forced = env.CORE_HARNESS;
  if (typeof forced === 'string' && HARNESS_RE.test(forced)) return forced;
  if (env.CODEX_PLUGIN_ROOT || env.CODEX_THREAD_ID || env.CODEX_HARNESS || env.CODEX_SANDBOX) return 'codex';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  return null;
}

// A caller's env object often carries only config flags; with no harness signal in it,
// the process's own env decides, so a partial env never re-files state under 'unknown'.
export function detectStateHarness(env = process.env) {
  return harnessFromEnv(env) ?? (env !== process.env ? harnessFromEnv(process.env) : null) ?? 'unknown';
}

/**
 * The project root a script working on `projectDir` should use: its registered
 * root when it is (or sits inside) a registered project, otherwise the directory
 * itself — a store that has not been registered yet still gets its own state.
 */
export function projectRootFor(projectDir, { home = defaultHome(), coreDir } = {}) {
  const found = resolveProjectRoot(projectDir, { home, coreDir: coreDir || join(home, '.core') });
  return found.root || canonical(projectDir);
}

// ---------- trust-gated state access ----------

function isoStamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Move everything in a harness state dir except superseded/ into superseded/<label>/, unread. */
function setAside(harnessDir, label) {
  const dest = join(harnessDir, 'superseded', label);
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(harnessDir)) {
    if (name === 'superseded') continue;
    renameSync(join(harnessDir, name), join(dest, name));
  }
  return dest;
}

/**
 * The state directory to use for (root, harness, kind), applying the stamp rules.
 *
 * Returns { dir, location, status, trusted } or null when there is nothing
 * trustworthy to read (forWrite false). With forWrite true the directory exists on
 * return and is this install's: an absent state dir is created and stamped; planted
 * or copied state is set aside unread under superseded/ and replaced; another
 * install's state and an unresolved move/copy ('ask') route to ~/.core/local/;
 * a moved project is re-stamped at its new path.
 *
 * Refused containment (a symlinked or escaping .core) throws on write and reads as null.
 */
export function stateDir({ root, harness, kind = 'durable', coreDir = defaultCoreDir(), forWrite = false, onEvent } = {}) {
  assertHarnessName(harness);
  const real = canonical(root);
  const target = projectStateDir({ root: real, harness, kind, coreDir });
  if (target.location === 'local') {
    if (forWrite) mkdirSync(target.dir, { recursive: true });
    else if (!existsSync(target.dir)) return null;
    return { dir: target.dir, location: 'local', status: target.reason, trusted: true };
  }

  const verdict = classifyStamp({ root: real, harness, coreDir });
  const harnessDir = join(real, STATE_DIRNAME, harness);
  const local = () => {
    const dir = localStateDir({ root: real, harness, coreDir });
    if (forWrite) mkdirSync(dir, { recursive: true });
    else if (!existsSync(dir)) return null;
    return { dir, location: 'local', status: verdict.status, trusted: true };
  };
  const note = (event) => { if (typeof onEvent === 'function') onEvent({ ...event, root: real, harness }); };

  switch (verdict.status) {
    case 'verified':
      if (forWrite) mkdirSync(target.dir, { recursive: true });
      return { dir: target.dir, location: 'project', status: 'verified', trusted: true };
    case 'refused':
      if (forWrite) {
        throw Object.assign(new Error(`refusing ${join(real, STATE_DIRNAME)}: ${verdict.reason}`), { code: 'STATE_CONTAINMENT', reason: verdict.reason });
      }
      return null;
    case 'foreign-install':
    case 'ask':
      return local();
    case 'absent':
      if (!forWrite) return null;
      writeStamp({ root: real, harness, coreDir });
      note({ kind: 'state-created' });
      return { dir: target.dir, location: 'project', status: 'created', trusted: true };
    case 'moved':
      if (!forWrite) return { dir: target.dir, location: 'project', status: 'moved', trusted: true };
      writeStamp({ root: real, harness, coreDir });
      note({ kind: 'state-moved', oldPath: verdict.oldPath });
      return { dir: target.dir, location: 'project', status: 'moved', trusted: true, oldPath: verdict.oldPath };
    case 'planted':
    case 'copied': {
      if (!forWrite) return null;
      if (classifyStamp({ root: real, harness, coreDir }).status === 'verified') {
        return { dir: target.dir, location: 'project', status: 'verified', trusted: true };
      }
      const label = `${verdict.status === 'copied' ? 'copied' : 'unverified'}-${isoStamp()}`;
      const aside = setAside(harnessDir, label);
      writeStamp({ root: real, harness, coreDir });
      note({ kind: verdict.status === 'copied' ? 'state-copied' : 'state-unverified', setAside: aside, oldPath: verdict.oldPath });
      return { dir: target.dir, location: 'project', status: verdict.status, trusted: true, setAside: aside };
    }
    default:
      return null;
  }
}

// ---------- the per-harness manifest (workspace.json) ----------

const MANIFEST = 'workspace.json';

/** The manifest for (root, harness), or null when absent or untrusted. */
export function readManifest({ root, harness, coreDir = defaultCoreDir() }) {
  const s = stateDir({ root, harness, kind: 'durable', coreDir });
  if (!s) return null;
  try { return JSON.parse(readFileSync(join(s.dir, MANIFEST), 'utf8')); } catch { return null; }
}

/**
 * Merge `fields` into the manifest. A manifest created here gets a fresh random
 * project_id; a copied project's replacement manifest therefore gets a new one.
 * Throws MANIFEST_UNPARSEABLE rather than overwrite a manifest it cannot read.
 */
export function updateManifest({ root, harness, coreDir = defaultCoreDir(), fields = {}, onEvent }) {
  const s = stateDir({ root, harness, kind: 'durable', coreDir, forWrite: true, onEvent });
  const file = join(s.dir, MANIFEST);
  return withFileLock(`${file}.lock`, () => {
    let current = {};
    if (existsSync(file)) {
      // An unparseable manifest is surfaced, never silently replaced.
      try { current = JSON.parse(readFileSync(file, 'utf8')); } catch (err) {
        throw Object.assign(new Error(`manifest-unparseable: ${file}: ${err.message}`), { code: 'MANIFEST_UNPARSEABLE' });
      }
    }
    const next = { ...current, ...fields };
    if (!next.project_id) next.project_id = randomBytes(16).toString('hex');
    if (!next.harness) next.harness = harness;
    atomicWriteFileSync(file, JSON.stringify(next, null, 2) + '\n');
    return next;
  });
}
