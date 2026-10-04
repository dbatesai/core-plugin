/**
 * project-state.mjs — where a project's CORE operational state lives, and whether
 * state found there can be trusted.
 *
 * Layout: <project-root>/.core/<harness>/, with a `*` .gitignore written into
 * .core/ before anything else. ~/.core keeps only cross-project files plus
 * projects.json (the registered roots) and local/ (state that must not sit in the
 * project: read-only roots, another install's project).
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
  appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync, accessSync, constants as fsConstants,
} from 'node:fs';
import { dirname, join, resolve, sep, isAbsolute } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock } from './file-lock.mjs';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { requireTrustedHome, containedPath } from './trusted-home.mjs';
import { registerProject } from './index-registry.mjs';

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
/**
 * The folder a registry entry names. Older registrations spell the field `project_path`
 * (schema v2, forward slashes); newer ones spell it `path`. Every reader of the legacy
 * registry goes through this so the two spellings cannot drift apart again.
 */
export function registryEntryPath(entry) {
  return (entry && (entry.path || entry.project_path)) || null;
}

/**
 * Why the registry cannot be trusted as a complete list, or null when it can: a file that is not a
 * JSON array, or an entry without a usable path. readRegisteredRoots skips such entries for
 * everyday lookups; a caller that must know it saw every project uses this.
 */
export function registryShapeProblem({ coreDir = defaultCoreDir() } = {}) {
  for (const name of ['projects.json', 'index.json']) {
    const file = join(coreDir, name);
    if (!existsSync(file)) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return `${name} cannot be read (${e.code || 'not JSON'})`; }
    if (!Array.isArray(parsed)) return `${name} is not a list`;
    const bad = parsed.findIndex((e) => !e || typeof (name === 'projects.json' ? e.path : registryEntryPath(e)) !== 'string' || !(name === 'projects.json' ? e.path : registryEntryPath(e)));
    if (bad !== -1) return `${name} entry ${bad} has no usable path`;
  }
  return null;
}

export function readRegisteredRoots({ coreDir = defaultCoreDir(), includeLegacyIndex = true } = {}) {
  const paths = readJsonArray(join(coreDir, 'projects.json')).map((e) => e && e.path);
  if (includeLegacyIndex) {
    // An entry the migration marked migrated is history: its project is registered in
    // projects.json at wherever it lives now, and its old path must not authorize
    // whatever folder later appears there.
    for (const e of readJsonArray(join(coreDir, 'index.json'))) if (e && e.migrated !== true) paths.push(registryEntryPath(e));
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

function isWritableDir(p) {
  try { accessSync(p, fsConstants.W_OK); return true; } catch { return false; }
}

export function assertHarnessName(harness) {
  if (typeof harness !== 'string' || !HARNESS_RE.test(harness)) {
    throw Object.assign(new Error(`unsafe harness name ${JSON.stringify(harness)}`), { code: 'UNSAFE_HARNESS' });
  }
  return harness;
}

/**
 * ~/.core/local/<root-slug>-<hash>/<harness>/ — state that must stay on this machine's disk.
 * The slug is for people reading the folder; the hash of the canonical root is what keeps
 * the key one-to-one, because the slug maps `.`, `-`, `/` and `:` all to `-` and two
 * different projects (`a.b`, `a-b`) would otherwise share one folder and one metrics pin.
 */
export function localRootKey(root) {
  const real = canonical(root);
  return `${mapProjectPathToSlug(real)}-${createHash('sha256').update(real).digest('hex').slice(0, 12)}`;
}

export function localStateDir({ root, harness, coreDir = defaultCoreDir() }) {
  return join(coreDir, 'local', localRootKey(root), assertHarnessName(harness));
}

/**
 * The directory a kind of state belongs in. Does not create anything.
 * Both kinds, 'durable' (manifest, stamp, drafts) and 'hot' (append logs, metrics,
 * locks), stay in the project, synced folder or not, unless the root is not writable.
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
    const dir = join(ensureCoreDir(opts.root, opts.harness), assertHarnessName(opts.harness));
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

// A migration writes into the project's state before it is whole. While its marker is
// present, everything except the migration itself is kept out of that state: reads see
// nothing, and writes go to this machine's local state instead, so no reader or writer
// consumes half a copy.
export const MIGRATING_MARKER = '.migrating';
let migrationDepth = 0;
export function duringMigration(fn) {
  migrationDepth++;
  try { return fn(); } finally { migrationDepth--; }
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
      if (!migrationDepth && existsSync(join(harnessDir, MIGRATING_MARKER))) {
        const held = local();
        return held && { ...held, status: 'migrating' };
      }
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

// ---------- signed control files ----------

// A stamp proves where state belongs, not that its files are unchanged. Files whose
// values can suppress a safety action (the manifest's disclosure and metrics flags,
// the bootstrap dedup record) carry a MAC sidecar; a missing or wrong MAC, or a copy
// git tracks (a force-added file a pull could overwrite), reads as absent.

const MAC_SUFFIX = '.mac';

export function contentMac(secret, rel, bytes) {
  return createHmac('sha256', secret).update(JSON.stringify([rel, Buffer.from(bytes).toString('base64')])).digest('hex');
}

/** Names under .core/<harness>/ that git tracks at `root`; empty outside a repo or without git. */
/** The git index file for the repo containing `root` (worktrees and submodules included), or null. */
function gitIndexFile(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    try {
      const st = lstatSync(dotGit);
      if (st.isDirectory()) return join(dotGit, 'index');
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
      return m ? join(resolve(dir, m[1]), 'index') : null;
    } catch { /* no .git here; keep walking */ }
    if (dirname(dir) === dir) return null;
  }
}

// Paths sit in a v2/v3 index as plain bytes, so a file that never mentions the state
// prefix can't be tracking anything under it; that skips spawning git on every read.
// A v4 (prefix-compressed) or split index can hide the bytes, so those always ask git.
function indexMightTrack(root, prefix) {
  const idx = gitIndexFile(root);
  if (!idx) return false;
  let buf;
  try { buf = readFileSync(idx); } catch { return true; }
  const version = buf.length >= 8 ? buf.readUInt32BE(4) : 0;
  if (version >= 4) return true;
  try { if (readdirSync(dirname(idx)).some((n) => n.startsWith('sharedindex.'))) return true; } catch { return true; }
  return buf.includes(prefix);
}

// Returned when git ls-files errors or times out while the index says the prefix
// MIGHT be tracked: we can no longer tell which names are tracked, so every name
// must read as tracked (untrusted) rather than falling back to "nothing tracked".
// Fail-closed duck-types the real Set's only call-site contract, `.has(name)`.
const UNKNOWN_TRACKED = { has: () => true };

export function trackedStateFiles(root, harness) {
  const prefix = `${STATE_DIRNAME}/${harness}/`;
  if (!indexMightTrack(root, prefix)) return new Set();
  try {
    // Without --full-name, ls-files prints paths relative to -C, so a project nested
    // inside a larger repo still lists as `.core/<harness>/<name>`.
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', prefix], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
    });
    return new Set(out.split('\0').filter(Boolean).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)));
  } catch {
    return UNKNOWN_TRACKED;
  }
}

/** Write `name` in the state dir with its MAC sidecar. Callers hold the file's lock. */
export function writeSignedFile({ dir, name, body, coreDir = defaultCoreDir(), mode }) {
  const { secret } = ensureInstallIdentity({ coreDir });
  const file = join(dir, name);
  atomicWriteFileSync(file, body);
  if (mode) { try { chmodSync(file, mode); } catch { /* Windows: mode is advisory */ } }
  atomicWriteFileSync(`${file}${MAC_SUFFIX}`, contentMac(secret, name, body) + '\n');
  return file;
}

/**
 * The verified bytes of `name` in the state for (root, harness), as a string, or null
 * when the state is absent or untrusted, git tracks the file, or its MAC doesn't match.
 * A writer sits between the file and its sidecar for a moment, so one re-read is taken
 * before calling a mismatch.
 */
export function readSignedFile({ root, harness, name, coreDir = defaultCoreDir() }) {
  const s = stateDir({ root, harness, kind: 'durable', coreDir });
  if (!s) return null;
  if (s.location === 'project' && trackedStateFiles(canonical(root), harness).has(name)) return null;
  let secret;
  try { ({ secret } = ensureInstallIdentity({ coreDir })); } catch { return null; }
  const file = join(s.dir, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    let bytes, mac;
    try {
      bytes = readFileSync(file);
      mac = readFileSync(`${file}${MAC_SUFFIX}`, 'utf8').trim();
    } catch { return null; }
    const want = Buffer.from(contentMac(secret, name, bytes), 'hex');
    const got = /^[0-9a-f]{64}$/.test(mac) ? Buffer.from(mac, 'hex') : null;
    if (got && timingSafeEqual(want, got)) return bytes.toString('utf8');
    if (attempt === 0) sleepMs(25);
  }
  return null;
}

/**
 * The verified bytes of `name` in `dir` (any directory of this install's state, such as the
 * metrics folder), or null when the file or its MAC sidecar is missing or the MAC does not
 * match this install's secret. A file written by anything but writeSignedFile reads as absent.
 */
export function readSignedFileAt({ dir, name, coreDir = defaultCoreDir() }) {
  let secret;
  try { ({ secret } = ensureInstallIdentity({ coreDir })); } catch { return null; }
  const file = join(dir, name);
  for (let attempt = 0; attempt < 2; attempt++) {
    let bytes, mac;
    try {
      bytes = readFileSync(file);
      mac = readFileSync(`${file}${MAC_SUFFIX}`, 'utf8').trim();
    } catch { return null; }
    const want = Buffer.from(contentMac(secret, name, bytes), 'hex');
    const got = /^[0-9a-f]{64}$/.test(mac) ? Buffer.from(mac, 'hex') : null;
    if (got && timingSafeEqual(want, got)) return bytes.toString('utf8');
    if (attempt === 0) sleepMs(25);
  }
  return null;
}

/**
 * The metrics storage pin is signed together with the project root it belongs to, so a pin
 * file and its MAC copied into another project's state verify as a signature but name the
 * wrong project and are refused.
 */
export function writePinSigned({ dir, path, root, coreDir = defaultCoreDir() }) {
  writeSignedFile({ dir, name: 'storage-path.txt', body: JSON.stringify({ path, root: canonical(root) }), coreDir });
}

/** The pinned folder in `dir`, when it is signed by this install and was written for `root`; otherwise null. */
export function readPinSigned({ dir, root, coreDir = defaultCoreDir() }) {
  const raw = readSignedFileAt({ dir, name: 'storage-path.txt', coreDir });
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.path === 'string' && typeof j.root === 'string' && canonical(j.root) === canonical(root)) return j.path.trim() || null;
  } catch { /* not a pin this code wrote */ }
  return null;
}

/**
 * Where a project's metrics may be stored: its own `_metrics/`, or the Windows AppData
 * folder the OneDrive redirect uses. A pin naming anywhere else is refused, so a pin can
 * never send prompt and context evidence to an arbitrary directory or a mounted share. An
 * AppData folder some other project claimed (`.project-root`) is refused too.
 */
export function metricsStorageAllowed(pinned, { projectDir, home }) {
  if (typeof pinned !== 'string' || !isAbsolute(pinned)) return false;
  if (containedPath(join(projectDir, '_metrics'), pinned)) return true;
  // An older Windows OneDrive redirect left some projects' metrics in AppData; their pins stay valid.
  if (!containedPath(join(home, 'AppData', 'Local', 'core-metrics'), pinned)) return false;
  try {
    const owner = readFileSync(join(pinned, METRICS_OWNER_FILE), 'utf8').trim();
    if (owner && canonical(owner) !== canonical(projectDir)) return false;
  } catch { /* unclaimed: whether this project may have it is decided where pins are compared */ }
  return true;
}

/** Record, signed, that this project was held off an ambiguously named legacy metrics folder. */
export function writeHeldSigned({ dir, folder, alsoNamedBy = [], coreDir = defaultCoreDir() }) {
  writeSignedFile({ dir, name: 'held-legacy-folder.txt', body: JSON.stringify({ folder, also_named_by: alsoNamedBy }), coreDir });
}

/** The signed hold record in `dir` as { folder, also_named_by }, or null. Reads the older plain-folder body too. */
export function readHeldSigned({ dir, coreDir = defaultCoreDir() }) {
  const raw = readSignedFileAt({ dir, name: 'held-legacy-folder.txt', coreDir });
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.folder === 'string') return { folder: j.folder, also_named_by: Array.isArray(j.also_named_by) ? j.also_named_by : [] };
  } catch { /* an older record: the body is the folder */ }
  return raw.trim() ? { folder: raw.trim(), also_named_by: [] } : null;
}

export const METRICS_OWNER_FILE = '.project-root';
export const METRICS_EXTERNAL_MARKER = 'metrics-ever-external.txt';

/**
 * Record, durably and outside the metrics dir the pin itself lives in, that a project's metrics
 * were ever redirected externally. The producer of an external pin (the migration
 * that carries one over) calls this; `metricsHistoryFolders` reads it back to name the folder. Throws
 * on failure — the caller decides whether that failure is fatal to the operation writing the pin.
 */
export function markMetricsEverExternal({ projectDir, harness, home, coreDir = defaultCoreDir(), folder }) {
  const durable = stateDir({ root: projectRootFor(projectDir, { home, coreDir }), harness, coreDir, forWrite: true });
  if (!durable) throw new Error('no durable state for this project');
  writeSignedFile({ dir: durable.dir, name: METRICS_EXTERNAL_MARKER, body: JSON.stringify({ folder }), coreDir });
}



/**
 * The harnesses with state for this project, in the project's `.core/` and its machine-local
 * fallback folder: the names found in every folder that could be listed, plus each folder that
 * couldn't. A missing folder has no harnesses; one that can't be read is a problem, not an
 * absence, and the names seen in the other one are still returned.
 * @returns {{harnesses: string[], problems: {what: string, code: string}[]}}
 */
export function stateHarnessesPartial({ root, coreDir = defaultCoreDir(), include = [] }) {
  const names = new Set(include);
  const problems = [];
  const real = canonical(root);
  for (const dir of [join(real, STATE_DIRNAME), join(coreDir, 'local', localRootKey(real))]) {
    let entries = [];
    try { entries = readdirSync(dir); }
    catch (e) {
      if (!(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'))) problems.push({ what: dir, code: (e && e.code) || 'error' });
      continue;
    }
    // Every harness-shaped entry counts, a link or a file included: classifying it (refused, for a
    // link) is how its state gets reported, and skipping it would read as no state at all.
    for (const name of entries) if (HARNESS_RE.test(name)) names.add(name);
  }
  return { harnesses: [...names], problems };
}

/**
 * Every place this project's state for one harness can be, whichever one routing picks today: the
 * project folder (`<root>/.core/<harness>`) and the machine-local fallback
 * (`~/.core/local/<project>/<harness>`). Registration and root writability move routing between
 * them, and the one not chosen can still hold records and rows. Read-only: nothing is created,
 * adopted or set aside. A place that exists but can't be trusted as this project's is a problem,
 * not an absence: project state whose stamp doesn't verify, or a fallback folder that is a link
 * or resolves somewhere other than its own spot under `~/.core/local`.
 *
 * @returns {{ locations: {kind: 'project'|'local', dir: string, keyDir?: string}[], problems: {what: string, reason: string}[] }}
 */
export function stateLocations({ root, harness, coreDir = defaultCoreDir() }) {
  assertHarnessName(harness);
  const real = canonical(root);
  const locations = [];
  const problems = [];
  const projectDir = join(real, STATE_DIRNAME, harness);
  const unreadable = (what) => {
    const p = pathPresence(what);
    if (p.state === 'unknown') problems.push({ what, reason: `this project's ${harness} state could not be looked at (${p.code})` });
    return p.state === 'unknown';
  };
  if (unreadable(projectDir)) { /* reported */ }
  else if (existsSync(projectDir) || isSymlink(projectDir)) {
    const { status } = classifyStamp({ root: real, harness, coreDir });
    if (existsSync(join(projectDir, MIGRATING_MARKER))) problems.push({ what: projectDir, reason: `this project's ${harness} state cannot be read as its own (migration in progress)` });
    else if (status === 'verified' || status === 'moved') locations.push({ kind: 'project', dir: projectDir });
    else if (status !== 'absent') problems.push({ what: projectDir, reason: `this project's ${harness} state cannot be read as its own (${status})` });
  }
  const localRoot = join(coreDir, 'local');
  const keyDir = join(localRoot, localRootKey(real));
  const localDir = join(keyDir, harness);
  if (unreadable(keyDir)) { /* reported */ }
  else if (existsSync(keyDir) || isSymlink(keyDir)) {
    let expected = null;
    try { expected = join(realpathSync.native(localRoot), localRootKey(real)); } catch { /* no local root */ }
    let actual = null;
    try { actual = realpathSync.native(keyDir); } catch { /* dangling */ }
    if (isSymlink(keyDir) || !expected || actual !== expected) {
      problems.push({ what: keyDir, reason: "this project's machine-local state folder is a link or resolves outside its own place, so it cannot be read as this project's" });
    } else if (isSymlink(localDir)) {
      problems.push({ what: localDir, reason: `this project's machine-local ${harness} state is a link, so it cannot be read as this project's` });
    } else if (unreadable(localDir)) { /* reported */ }
    else if (existsSync(localDir)) {
      locations.push({ kind: 'local', dir: localDir, keyDir });
    }
  }
  return { locations, problems };
}

/**
 * Whether a path is there, for callers that must not read "could not look" as "absent": only a
 * missing path (ENOENT, ENOTDIR) is absent; any other failure (EACCES, EPERM) is unknown.
 * @returns {{state: 'present'|'absent'|'unknown', code?: string}}
 */
export function pathPresence(p) {
  try { statSync(p); return { state: 'present' }; }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { state: 'absent' };
    return { state: 'unknown', code: (e && e.code) || 'error' };
  }
}

function isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/**
 * The external folders a project's records name for one harness, read from every place its state
 * can be (`stateLocations`): the signed storage pin and held record under `metrics/`, and the
 * signed ever-external marker. Records that do not verify name nothing here; `metricsHistoryHeld`
 * reports them.
 *
 * @returns {{folder: string, ambiguous: boolean}[]}
 */
export function historyRecordFolders({ root, harness, coreDir = defaultCoreDir() }) {
  const out = [];
  for (const { dir } of stateLocations({ root, harness, coreDir }).locations) {
    const meta = join(dir, 'metrics');
    const pin = readPinSigned({ dir: meta, root, coreDir });
    if (pin) out.push({ folder: pin, ambiguous: false });
    const held = readHeldSigned({ dir: meta, coreDir });
    if (held) out.push({ folder: held.folder, ambiguous: true });
    const raw = readSignedFileAt({ dir, name: METRICS_EXTERNAL_MARKER, coreDir });
    if (raw !== null) {
      try { const f = JSON.parse(raw).folder; if (typeof f === 'string') out.push({ folder: f, ambiguous: false }); } catch { /* not a marker this code wrote */ }
    }
  }
  return out;
}

/**
 * The other registered projects, on this machine and readable by this install, whose signed
 * pin (or signed hold record) names `folder`. A hold record keeps the answer the same whichever
 * project scaffolds first. Advisory: the migration uses it to avoid signing a shared folder for
 * either project. Nothing destructive relies on it, because an unreadable project is skipped.
 */
export function otherProjectsNamingFolder(folder, { projectDir, home, env }) {
  const coreDir = join(home, '.core');
  const harness = detectStateHarness(env);
  const out = [];
  const self = canonical(projectDir);
  let roots;
  try { roots = readRegisteredRoots({ coreDir }); } catch { return out; }
  for (const root of roots) {
    if (root === self) continue;
    try {
      const s = stateDir({ root, harness, kind: 'hot', coreDir });
      if (!s) continue;
      const metricsDir = join(s.dir, 'metrics');
      const named = readPinSigned({ dir: metricsDir, root, coreDir }) === folder
        || readHeldSigned({ dir: metricsDir, coreDir })?.folder === folder;
      if (named) out.push(root);
    } catch { /* an unreadable project cannot vouch for a claim */ }
  }
  return out;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- the per-harness manifest (workspace.json) ----------

const MANIFEST = 'workspace.json';

/** The manifest for (root, harness), or null when absent, untrusted, tracked, or its MAC fails. */
export function readManifest({ root, harness, coreDir = defaultCoreDir() }) {
  const text = readSignedFile({ root, harness, name: MANIFEST, coreDir });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Merge `fields` into the manifest. A manifest created here gets a fresh random
 * project_id; a copied project's replacement manifest therefore gets a new one.
 * A manifest whose MAC doesn't verify is set aside unread (never deleted) and the
 * merge starts from empty. Throws MANIFEST_UNPARSEABLE rather than overwrite a
 * verified manifest it cannot parse.
 */
export function updateManifest({ root, harness, coreDir = defaultCoreDir(), fields = {}, onEvent }) {
  const s = stateDir({ root, harness, kind: 'durable', coreDir, forWrite: true, onEvent });
  const file = join(s.dir, MANIFEST);
  return withFileLock(`${file}.lock`, () => {
    let current = {};
    if (existsSync(file)) {
      const text = readSignedFile({ root, harness, name: MANIFEST, coreDir });
      if (text === null) {
        // An untrusted manifest can only make capture safer: its opt-out survives the set-aside.
        current = untrustedOptOuts(file);
        renameSync(file, `${file}.unverified-${isoStamp()}`);
      } else {
        // An unparseable manifest is surfaced, never silently replaced.
        try { current = JSON.parse(text); } catch (err) {
          throw Object.assign(new Error(`manifest-unparseable: ${file}: ${err.message}`), { code: 'MANIFEST_UNPARSEABLE' });
        }
      }
    }
    const next = { ...current, ...fields };
    if (!next.project_id) next.project_id = randomBytes(16).toString('hex');
    if (!next.harness) next.harness = harness;
    writeSignedFile({ dir: s.dir, name: MANIFEST, body: JSON.stringify(next, null, 2) + '\n', coreDir });
    return next;
  });
}

// Which capture switches an unverified manifest turns off. Untrusted content may only ever
// make capture safer, so each opt-out it carries survives the set-aside.
function untrustedOptOuts(file) {
  const out = {};
  try {
    const m = JSON.parse(readFileSync(file, 'utf8'));
    if (m.metrics_enabled === false) out.metrics_enabled = false;
    if (m.turn_capture === false) out.turn_capture = false;
  } catch { /* unreadable: no opt-out to carry */ }
  return out;
}
function untrustedOptOut(file) { return untrustedOptOuts(file).metrics_enabled === false; }

/**
 * True when this harness's manifest says metrics_enabled:false but doesn't verify.
 * Untrusted content may switch capture off, never on.
 */
export function manifestOptsOutUnverified({ root, harness }) {
  return untrustedOptOut(join(canonical(root), STATE_DIRNAME, harness, MANIFEST));
}

/** Same rule for the turn-capture switch: an unverified manifest may switch it off, never on. */
export function manifestTurnCaptureOptsOutUnverified({ root, harness }) {
  return untrustedOptOuts(join(canonical(root), STATE_DIRNAME, harness, MANIFEST)).turn_capture === false;
}

// ---------- the bootstrap record (last-bootstrap.json) ----------

const BOOTSTRAP = 'last-bootstrap.json';

/** Record that bootstrap ran; signed, owner-only, written under its own lock. */
export function writeBootstrap({ root, harness, coreDir = defaultCoreDir(), record }) {
  const s = stateDir({ root, harness, kind: 'durable', coreDir, forWrite: true });
  const file = join(s.dir, BOOTSTRAP);
  withFileLock(`${file}.lock`, () => {
    writeSignedFile({ dir: s.dir, name: BOOTSTRAP, body: JSON.stringify(record, null, 2) + '\n', coreDir, mode: 0o600 });
  });
  return file;
}

/** The verified bootstrap record, or null (absent, untrusted, tracked, or MAC fails). */
export function readBootstrap({ root, harness, coreDir = defaultCoreDir() }) {
  const text = readSignedFile({ root, harness, name: BOOTSTRAP, coreDir });
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------- adopting another install's state (a restore) ----------

const DECLINED_ADOPT = 'declined-adopt';
const ADOPTED_INSTALLS = 'adopted-sibling-stamps';

function declinedAdoptFile({ root, coreDir }) {
  return join(coreDir, 'local', localRootKey(root), DECLINED_ADOPT);
}

function declinedStamps({ root, coreDir }) {
  try {
    return new Set(readFileSync(declinedAdoptFile({ root, coreDir }), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }
}

function pendingAdoptFile({ root, harness, coreDir }) {
  return join(coreDir, 'local', localRootKey(root), `pending-adopt-${harness}.json`);
}

/** An adoption this machine started for (root, harness) and didn't finish, with a sound archive. */
function pendingAdoption({ root, harness, coreDir }) {
  try {
    const plan = JSON.parse(readFileSync(pendingAdoptFile({ root, harness, coreDir }), 'utf8'));
    const superseded = join(root, STATE_DIRNAME, harness, 'superseded');
    if (!plan || typeof plan.archive !== 'string' || dirname(plan.archive) !== superseded) return null;
    if (!lstatSync(superseded).isDirectory() || !lstatSync(plan.archive).isDirectory()) return null;
    return plan;
  } catch { return null; }
}

function adoptedInstallsFile({ root, coreDir }) {
  return join(coreDir, 'local', localRootKey(root), ADOPTED_INSTALLS);
}

/**
 * Stamps of the restore's other harnesses, recorded when its first harness was adopted: the
 * sha256 of each sibling .core/<harness>/stamp exactly as it arrived. An install id inside a
 * foreign stamp is self-asserted and copyable, so the second-harness offer is bound to these
 * bytes instead: state planted after the first adoption never matches.
 */
function adoptedInstalls({ root, coreDir }) {
  try {
    return new Set(readFileSync(adoptedInstallsFile({ root, coreDir }), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  } catch { return new Set(); }
}

// Persistent descriptive data a restore carries, each with the only shape it may have. These
// are data, not controls: the control allowlist below is unchanged. A wrong-typed value is not
// coerced; it stays in the inert archive and is named in the adoption result.
const plainText = (max, multiline) => (v) => typeof v === 'string' && v.length > 0 && v.length <= max
  && !(multiline ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(v);
const ADOPTED_DATA_FIELDS = {
  name: plainText(200, false),
  agent_notes: plainText(20000, true),
  created: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]{0,30})?$/.test(v),
  session_log_refs: (v) => Array.isArray(v) && v.length <= 500 && v.every(plainText(1000, false)),
};

function lastWrittenAt(dir) {
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (name === 'superseded') continue;
      try { newest = Math.max(newest, lstatSync(join(dir, name)).mtimeMs); } catch { /* vanished */ }
    }
  } catch { return null; }
  return newest ? new Date(newest).toISOString() : null;
}

/**
 * The adoption question for (root, harness), or null when there's nothing to offer.
 * Offered only for a folder not registered here whose .core/<harness>/ is a real
 * directory holding a well-formed stamp from another install, for this harness,
 * that git doesn't track and the user hasn't declined. Reads the stamp and file
 * times only, never any other state file.
 * Returns { root, harness, oldPath, lastWritten, stampHmac }.
 */
export function adoptionCandidate({ root, harness, coreDir = defaultCoreDir() }) {
  assertHarnessName(harness);
  const real = canonical(root);
  const core = canonical(coreDir);
  const registered = readRegisteredRoots({ coreDir: core }).has(real);
  if (!registered && classifyRegistration(real, { home: dirname(core), coreDir: core }).action === 'refuse') return null;
  if (checkStateContainment({ root: real, harness }) !== 'ok') return null;
  const harnessDir = join(real, STATE_DIRNAME, harness);
  // an adoption this machine started here and didn't finish is resumed, whatever the stamp now says
  const resume = pendingAdoption({ root: real, harness, coreDir });
  if (resume) return { root: real, harness, oldPath: resume.oldPath, lastWritten: lastWrittenAt(harnessDir), stampHmac: null, resume };
  let stamp = null;
  try {
    const st = lstatSync(join(harnessDir, 'stamp'));
    if (st.isFile()) stamp = JSON.parse(readFileSync(join(harnessDir, 'stamp'), 'utf8'));
  } catch { return null; }
  if (!wellFormed(stamp) || stamp.harness !== harness) return null;
  if (stamp.install_id === ensureInstallIdentity({ coreDir }).installId) return null;
  if (trackedStateFiles(real, harness).has('stamp')) return null;
  if (declinedStamps({ root: real, coreDir }).has(stamp.hmac)) return null;
  // A registered root is offered only for another harness of an install this machine already
  // adopted here — the rest of the same restore. Any other foreign state on a registered root
  // (a synced folder another machine is writing) stays not-a-candidate.
  const stampHash = createHash('sha256').update(readFileSync(join(harnessDir, 'stamp'))).digest('hex');
  if (registered && !adoptedInstalls({ root: real, coreDir }).has(stampHash)) return null;
  return { root: real, harness, oldPath: stamp.path, lastWritten: lastWrittenAt(harnessDir), stampHmac: stamp.hmac };
}

function setAsideUnparseable(file) {
  const tag = `unparseable-${isoStamp()}`;
  renameSync(file, `${file}.${tag}`);
  if (existsSync(`${file}${MAC_SUFFIX}`)) renameSync(`${file}${MAC_SUFFIX}`, `${file}${MAC_SUFFIX}.${tag}`);
}

/**
 * Act on the user's answer to the adoption question. Only an interactive /core
 * startup calls this, after asking.
 *   'no'  — remember the refusal for this stamp; the foreign state is left untouched.
 *   'yes' — make the state this install's: keep the original manifest and stamp byte for
 *           byte in superseded/adopted-<time>/, re-stamp, re-sign the manifest (an
 *           unparseable one is set aside, not adopted), then register the folder.
 *           project_id and agent_name carry over, plus the typed descriptive data in
 *           ADOPTED_DATA_FIELDS (a wrong-typed field is named in not_imported); the install
 *           is recorded so the same restore's other harness can be adopted next. Adoption never
 *           switches capture on: an explicit metrics_enabled:true is dropped, an
 *           opt-out (the adopted one or this machine's own) is kept, and the metrics
 *           notice shows again on this machine.
 * Returns { status: 'adopted' | 'declined' | 'not-a-candidate', ... }.
 */
export function adoptForeignState({ root, harness, coreDir = defaultCoreDir(), decision }) {
  if (decision !== 'yes' && decision !== 'no') throw new Error(`adoptForeignState: decision must be 'yes' or 'no', got ${JSON.stringify(decision)}`);
  const cand = adoptionCandidate({ root, harness, coreDir });
  if (!cand) return { status: 'not-a-candidate' };
  const real = cand.root;

  if (decision === 'no' && cand.resume) {
    // declining an interrupted adoption ends it: the plan goes, the archive and state stay as they are
    rmSync(pendingAdoptFile({ root: real, harness, coreDir }), { force: true });
    return { status: 'declined', oldPath: cand.oldPath, resumed: true };
  }
  if (decision === 'no') {
    const file = declinedAdoptFile({ root: real, coreDir });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, cand.stampHmac + '\n');
    return { status: 'declined', oldPath: cand.oldPath };
  }

  const localManifest = readManifest({ root: real, harness, coreDir });
  const localOptOut = localManifest?.metrics_enabled === false;
  const localTurnOptOut = localManifest?.turn_capture === false;
  const harnessDir = join(real, STATE_DIRNAME, harness);
  const manifestFile = join(harnessDir, MANIFEST);
  const supersededDir = join(harnessDir, 'superseded');
  const pendingFile = pendingAdoptFile({ root: real, harness, coreDir });

  // A plan recorded before anything is committed makes the adoption resumable: if a later write
  // fails (the stamp is already local, the manifest or registration isn't), a retry finishes from
  // the archived original instead of finding nothing to adopt.
  let plan = cand.resume || null;
  let manifest = null;
  const readJsonFile = (f) => {
    try { if (!lstatSync(f).isFile()) return null; } catch { return null; }   // never through a link
    try { const m = JSON.parse(readFileSync(f, 'utf8')); return m && typeof m === 'object' && !Array.isArray(m) ? m : null; } catch { return null; }
  };

  if (!plan) {
    let manifestIsFile = false;
    try { manifestIsFile = lstatSync(manifestFile).isFile(); } catch { /* absent */ }
    // Only a regular file is read: a planted symlink must not pull another file's contents into
    // the signed manifest. A non-file manifest is left untouched and named in not_archived.
    if (manifestIsFile) {
      manifest = readJsonFile(manifestFile);
      if (!manifest) setAsideUnparseable(manifestFile);
    }
    // The bootstrap record is completion evidence, and another install's record proves nothing
    // about this one: it is never carried or re-signed. Left unsigned where it is, it reads as
    // absent, so the first session here runs startup in full.

    const wasRegistered = readRegisteredRoots({ coreDir: canonical(coreDir) }).has(real);
    const siblingStamps = [];
    for (const other of (() => { try { return readdirSync(join(real, STATE_DIRNAME)); } catch { return []; } })()) {
      if (other === harness || !HARNESS_RE.test(other)) continue;
      const f = join(real, STATE_DIRNAME, other, 'stamp');
      try { if (lstatSync(join(real, STATE_DIRNAME, other)).isDirectory() && lstatSync(f).isFile()) siblingStamps.push(createHash('sha256').update(readFileSync(f)).digest('hex')); } catch { /* absent */ }
    }

    // Keep the originals byte for byte, inert, before anything is re-signed. The archive folder is
    // created fresh and exclusively (a non-recursive mkdir fails on anything already there,
    // including a link), under a superseded/ that must be a real directory, and only regular
    // files are copied, so a planted link can neither pull bytes in nor redirect the write.
    try { mkdirSync(supersededDir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { if (!lstatSync(supersededDir).isDirectory()) return { status: 'held', reason: 'superseded-not-a-directory', oldPath: cand.oldPath }; }
    catch { return { status: 'held', reason: 'superseded-unreadable', oldPath: cand.oldPath }; }
    const archive = join(supersededDir, `adopted-${isoStamp()}-${randomBytes(4).toString('hex')}`);
    try { mkdirSync(archive); } catch (e) { if (e.code === 'EEXIST') return { status: 'held', reason: 'archive-name-taken', oldPath: cand.oldPath }; throw e; }
    if (!lstatSync(archive).isDirectory()) return { status: 'held', reason: 'archive-not-a-directory', oldPath: cand.oldPath };
    const notArchived = [];
    for (const name of [MANIFEST, 'stamp']) {
      const f = join(harnessDir, name);
      let st = null;
      try { st = lstatSync(f); } catch { continue; }
      if (!st.isFile()) { notArchived.push(name); continue; }
      writeFileSync(join(archive, name), readFileSync(f), { flag: 'wx' });
    }

    // The sibling stamps are remembered before the commit (harmless while the root is
    // unregistered), so no later failure can strand the restore's other harness.
    if (!wasRegistered) {
      const known = adoptedInstalls({ root: real, coreDir });
      const fresh = siblingStamps.filter((h) => !known.has(h));
      if (fresh.length) {
        const file = adoptedInstallsFile({ root: real, coreDir });
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, fresh.map((h) => h + '\n').join(''));
      }
    }
    plan = { archive, notArchived, oldPath: cand.oldPath, manifestArchived: !notArchived.includes(MANIFEST) && existsSync(join(archive, MANIFEST)) };
    mkdirSync(dirname(pendingFile), { recursive: true });
    const tmp = `${pendingFile}.tmp-${process.pid}-${randomBytes(2).toString('hex')}`;
    writeFileSync(tmp, JSON.stringify(plan) + '\n');
    renameSync(tmp, pendingFile);
  } else if (plan.manifestArchived) {
    manifest = readJsonFile(join(plan.archive, MANIFEST));      // resume: the original, from the archive
  }

  const notImported = [];
  writeStamp({ root: real, harness, coreDir });
  if (manifest) {
    // Allowlist, not spread: the stated carry-over contract is project identity/name
    // and explicit opt-outs only. A hostile manifest can plant arbitrary extra keys
    // (project-state.mjs's own trust model never verifies a foreign install), so any
    // key outside this list must not survive into the newly-signed local manifest.
    const next = { harness };
    if (typeof manifest.project_id === 'string' && manifest.project_id) next.project_id = manifest.project_id;
    if (typeof manifest.agent_name === 'string' && manifest.agent_name) next.agent_name = manifest.agent_name;
    if (manifest.metrics_enabled === false || localOptOut) next.metrics_enabled = false;
    if (manifest.turn_capture === false || localTurnOptOut) next.turn_capture = false;
    for (const [field, ok] of Object.entries(ADOPTED_DATA_FIELDS)) {
      if (!(field in manifest)) continue;
      if (ok(manifest[field])) next[field] = manifest[field]; else notImported.push(field);
    }
    withFileLock(`${manifestFile}.lock`, () => {
      writeSignedFile({ dir: harnessDir, name: MANIFEST, body: JSON.stringify(next, null, 2) + '\n', coreDir });
    });
  } else if (localOptOut || localTurnOptOut) {
    withFileLock(`${manifestFile}.lock`, () => {
      writeSignedFile({ dir: harnessDir, name: MANIFEST, body: JSON.stringify({ ...(localOptOut ? { metrics_enabled: false } : {}), ...(localTurnOptOut ? { turn_capture: false } : {}), harness }, null, 2) + '\n', coreDir });
    });
  }
  const registered = registerProject(coreDir, real, { home: dirname(canonical(coreDir)), confirmNew: true });
  rmSync(pendingFile, { force: true });                         // the adoption is complete
  return {
    status: 'adopted', oldPath: plan.oldPath, registration: registered, resumed: Boolean(cand.resume),
    project_id: manifest?.project_id ?? null, agent_name: manifest?.agent_name ?? null,
    archived: plan.archive, not_archived: plan.notArchived, not_imported: notImported,
  };
}
