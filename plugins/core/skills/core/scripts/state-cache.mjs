/**
 * state-cache.mjs — shared file-write-attribution primitives for the
 * edit-detection state cache.
 *
 * When a script rewrites a file on the user's behalf, edit-detection must not
 * misread that write as a user edit on the next session — so the write gets
 * stamped `last_written_by` in the state cache. This module is the one
 * shared lock-and-write primitive for that stamp: `hot-section.mjs`'s
 * `recordProjectMdWrite` and `decorate-graph.mjs` both call into it rather
 * than owning copies of the lock/prune logic that could drift.
 *
 * Cache of record: per-project at `<project>/_memories/_lib/state-cache.json`
 * — single-owner ACROSS PROJECTS (two projects closing at once can't clobber
 * each other's hashes, since each writes its own file), but NOT single-owner
 * WITHIN a project: `decorate-graph.mjs`, `hot-section.mjs`, and
 * `maintenance-run.mjs` can all stamp the same project-local cache file in
 * the same window (concurrent hooks/agents/CLI invocations), and the write
 * itself is a read-modify-write over the whole JSON file — an unlocked
 * read-modify-write loses stamps to the race. So the write below is
 * serialized under a project-local lock
 * (`<project>/_memories/_lib/.state-cache.lock`, same `withFileLock`
 * primitive every other lock in this codebase uses — no new mechanism). A
 * stamp never touches the older global `~/.core/state-cache.json` or a lock
 * beside it: readers take the per-project entry whenever one exists
 * (`data-storage.md` §"Edit detection"), so a stale global entry can't shadow
 * it and no shared lock is needed. (The lock helper still reads
 * `~/.core/install-id` for lock ownership.)
 *
 * What this module deliberately does NOT own: any domain-specific "what
 * counts as CORE's own write vs a real user edit" classification (e.g.
 * hashing outside a marker-delimited block). That logic differs per file
 * shape (PROJECT.md's hot block vs a unit's edges block) and stays next to
 * the code that defines the block markers — see `hot-section.mjs`'s
 * `hashOutsideHotBlock`/`classifyProjectMdChange` and `decorate-graph.mjs`'s
 * `hashOutsideEdgesBlock`/`classifyUnitChange`. This module only provides the
 * generic hash primitive and the locked stamp plumbing both of those
 * build on.
 */

import { readFileSync, mkdirSync, renameSync, existsSync, lstatSync, realpathSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { withFileLock, foreignLockArtifact } from './file-lock.mjs';
import { trustedHome } from './trusted-home.mjs';
import { ensureProjectCacheDir, assertProjectCacheDir } from './project-artifacts.mjs';
import { trackedProjectFiles } from './project-state.mjs';

export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** Generic content hash — sha256, truncated to 16 hex chars (matches the
 * convention `hot-section.mjs` established: enough to detect a mismatch,
 * short enough to keep the cache file readable). */
export function hashText(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}

export function projectCachePath(projectDir) {
  return join(resolve(projectDir), '_memories', '_lib', 'state-cache.json');
}

/** Three distinct answers, because rebuilding damage as absence destroys evidence. */
export const CACHE_CLEAN = 'clean';
export const CACHE_ABSENT = 'absent';
export const CACHE_CORRUPT = 'corrupt';
export const CACHE_UNREADABLE = 'unreadable';

/**
 * Why the cache can't be used here, or null. The cache is CORE's own generated file and must
 * physically be this project's: `_memories` and `_memories/_lib` real directories under the real
 * project root. Data must be an ordinary single-name file; mutex custody uses the shared helper,
 * which permits the owned two-name atomic publication transition and refuses foreign names.
 * Legacy-source and candidate selection use the same strict directory/data guard. A linked parent
 * or shared data leaf can inherit foreign evidence. Checks precede ordinary selection; no kernel
 * race guarantee is claimed. The project itself may be reached by an alias.
 */
export function cacheFileCustodyProblem(rootDir, file, { lockPath = null, ordinaryUnreadable = false } = {}) {
  const lexical = resolve(rootDir), path = resolve(file);
  const rel = (p) => relative(lexical, p) || '.';
  const kind = (p) => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  try {
    const root = realpathSync.native(lexical);
    if (!lstatSync(root).isDirectory()) return 'selected root is not an ordinary directory';
    const target = relative(lexical, path);
    if (!target || isAbsolute(target) || target === '..' || target.startsWith('..' + sep) || resolve(lexical, target) !== path) return 'cache path is outside its selected root';
    let d = lexical;
    for (const segment of target.split(sep).slice(0, -1)) {
      d = join(d, segment);
      const st = kind(d);
      if (!st) return null; // absent under a checked parent; do not descend farther
      if (st.isSymbolicLink()) return `${rel(d)} is a link`;
      if (!st.isDirectory()) return ordinaryUnreadable ? null : `${rel(d)} is not an ordinary directory`;
      const real = realpathSync.native(d);
      const inside = relative(root, real);
      if (inside === '..' || inside.startsWith('..' + sep)) return `${rel(d)} is outside the selected root`;
    }
    const st = kind(path);
    if (st && (st.isSymbolicLink() || (st.isFile() && st.nlink !== 1))) return `${rel(path)} is a link or has another name`;
    // Preserve E05's pre-read FIFO/socket/device refusal and ordinary unreadable cache directories.
    // Explicit legacy-source selection additionally requires a regular file.
    if (st && !st.isFile() && !(ordinaryUnreadable && st.isDirectory())) return `${rel(path)} is not a regular file`;
    if (lockPath !== null) {
      if (dirname(resolve(lockPath)) !== dirname(path)) return 'cache mutex is outside the selected folder';
      const lock = foreignLockArtifact(lockPath);
      if (lock) return `${rel(join(dirname(path), lock))} is a link or has a name outside this folder`;
    }
  } catch (e) { return `the cache location could not be checked (${e.code || e.message})`; }
  return null;
}

export function cacheCustodyProblem(projectDir) {
  const path = projectCachePath(projectDir);
  return cacheFileCustodyProblem(projectDir, path, { lockPath: join(dirname(path), '.state-cache.lock'), ordinaryUnreadable: true });
}

/**
 * Read the project-local cache. The returned `status` separates a store that has
 * never been stamped (`absent`) from one whose baseline is unreadable
 * (`corrupt`) — both yield an empty `files` map, but only the first means "no
 * prior attribution existed". A caller that cannot tell them apart converts
 * damage into a plausible fresh start and overwrites the evidence.
 */
export function readProjectCache(projectDir) {
  const path = projectCachePath(projectDir);
  // Bytes that aren't physically this project's are not its baseline: unknown, evidence untouched.
  const custody = cacheCustodyProblem(projectDir);
  if (custody) return { files: {}, status: CACHE_UNREADABLE, error: `cache-custody: ${custody}`, baseline_trustworthy_hint: false };
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    // Absence is ONLY a missing file. Permission, directory-in-the-way, and
    // every other read failure is unreadable UNKNOWN with the evidence kept —
    // mapping those to absent would let a rebuild replace attribution that
    // still exists on disk but couldn't be read this run.
    if (e && e.code === 'ENOENT') return { files: {}, status: CACHE_ABSENT };
    return {
      files: {}, status: CACHE_UNREADABLE,
      error: `${e && e.code ? e.code + ': ' : ''}${String(e && e.message || e).slice(0, 160)}`,
      baseline_trustworthy_hint: false,
    };
  }
  try {
    const cache = JSON.parse(raw);
    if (cache && typeof cache === 'object' && cache.files
      && typeof cache.files === 'object' && !Array.isArray(cache.files)) {
      return { ...cache, status: CACHE_CLEAN };
    }
  } catch { /* unparseable — corrupt, handled below */ }
  return { files: {}, status: CACHE_CORRUPT };
}

// Explicit old-evidence transfer. No ordinary reader invokes this door.
const IMPORT_RECEIPT = 'legacy_baseline_import';
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function stampValid(stamp) {
  return object(stamp) && /^[a-f0-9]{16}$/i.test(stamp.last_hash || '')
    && typeof stamp.last_hash === 'string' && typeof stamp.last_written === 'string'
    && Number.isFinite(Date.parse(stamp.last_written)) && typeof stamp.last_written_by === 'string'
    && (!own(stamp, 'outside_hash') || (typeof stamp.outside_hash === 'string' && /^[a-f0-9]{16}$/i.test(stamp.outside_hash)))
    && (!own(stamp, 'last_section_written') || typeof stamp.last_section_written === 'string');
}
function supportedImportKey(root, key) {
  if (typeof key !== 'string' || !isAbsolute(key) || resolve(key) !== key) return false;
  const rel = relative(root, key);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) return false;
  const parts = rel.split(sep);
  if (rel === 'PROJECT.md') return true;
  if (['_memories/INDEX-decisions.md', '_memories/INDEX-risks.md', '_memories/_lib/unit-summaries.json'].includes(parts.join('/'))) return true;
  return parts[0] === '_memories' && parts.length > 1 && parts.at(-1).endsWith('.md')
    && !parts.at(-1).startsWith('INDEX-') && parts.slice(1, -1).every(p => p !== 'archive' && !p.startsWith('_') && !p.startsWith('.'));
}
function importError(reason, fields = {}) {
  return { status: 'held', imported_count: 0, recovery: 'recovery-required', reason, ...fields };
}
function localImportImage(root) {
  const read = readProjectCache(root);
  if (read.status === CACHE_ABSENT) return { data: { files: {} }, raw: null };
  if (read.status !== CACHE_CLEAN) throw Object.assign(new Error(read.error || read.status), { code: 'LOCAL_BASELINE_UNAVAILABLE' });
  const problem = cacheCustodyProblem(root);
  if (problem) throw Object.assign(new Error(problem), { code: 'LOCAL_CUSTODY_REFUSED' });
  const raw = readFileSync(projectCachePath(root));
  const data = JSON.parse(raw);
  if (!object(data) || !object(data.files)) throw Object.assign(new Error('invalid local baseline envelope'), { code: 'LOCAL_BASELINE_INVALID' });
  return { data, raw };
}
function legacyImportSnapshot(home, path) {
  const problem = cacheFileCustodyProblem(home, path);
  if (problem) throw Object.assign(new Error(problem), { code: 'LEGACY_CUSTODY_REFUSED' });
  let before;
  try { before = lstatSync(path, { bigint: true }); }
  catch (e) { if (e.code === 'ENOENT') return { status: 'absent', path, bytes: 0, sha256: null, files: {} }; throw e; }
  const raw = readFileSync(path); // once presence was observed, a later disappearance is not verified absence
  const after = lstatSync(path, { bigint: true });
  const identity = (st) => [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':');
  if (identity(before) !== identity(after)) throw Object.assign(new Error('legacy source changed during snapshot'), { code: 'LEGACY_SOURCE_CHANGED' });
  const parsed = JSON.parse(raw);
  if (!object(parsed) || !object(parsed.files)) throw Object.assign(new Error('invalid legacy baseline envelope'), { code: 'LEGACY_BASELINE_INVALID' });
  return { status: 'clean', path, bytes: raw.length, sha256: digest(raw), identity: identity(after), files: parsed.files };
}
function sealImportReceipt(receipt) {
  const { checksum, ...body } = receipt;
  return { ...body, checksum: digest(stableJson(body)) };
}
function receiptValid(receipt, root) {
  const hash64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (!object(receipt) || receipt.schema !== 1 || receipt.root !== root
    || typeof receipt.key_root !== 'string' || !isAbsolute(receipt.key_root) || resolve(receipt.key_root) !== receipt.key_root
    || receipt.key_scope !== 'exact-lexical-keys'
    || typeof receipt.import_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(receipt.import_id)
    || !['applied-unverified', 'verified'].includes(receipt.phase) || !['complete', 'held'].includes(receipt.coverage)
    || !object(receipt.source) || !['clean', 'absent'].includes(receipt.source.status)
    || typeof receipt.source.path !== 'string' || !isAbsolute(receipt.source.path)
    || !Number.isSafeInteger(receipt.source.bytes) || receipt.source.bytes < 0
    || (receipt.source.status === 'clean' && !/^[a-f0-9]{64}$/.test(receipt.source.sha256 || ''))
    || (receipt.source.status === 'absent' && (receipt.source.sha256 !== null || receipt.source.bytes !== 0))
    || !date(receipt.imported_at) || (receipt.prior_sha256 !== null && !hash64(receipt.prior_sha256))
    || !object(receipt.tool) || receipt.tool.protocol !== 1 || !hash64(receipt.tool.script_sha256)
    || !Array.isArray(receipt.imports) || !Array.isArray(receipt.held) || !Array.isArray(receipt.retained)) return false;
  if (receipt.source.status === 'clean' && (typeof receipt.source.identity !== 'string'
    || !/^\d+:\d+:\d+:-?\d+:-?\d+$/.test(receipt.source.identity)
    || receipt.source.identity.split(':')[2] !== String(receipt.source.bytes))) return false;
  if (receipt.source.status === 'absent' && (own(receipt.source, 'identity') || receipt.imports.length !== 0)) return false;
  const imports = new Set(), retained = new Set();
  if (!receipt.imports.every(x => {
    if (!object(x) || !supportedImportKey(receipt.key_root, x.path) || !hash64(x.stamp_sha256)
      || !date(x.last_written) || typeof x.last_written_by !== 'string' || imports.has(x.path)) return false;
    imports.add(x.path); return true;
  }) || !receipt.retained.every(x => {
    if (!object(x) || !supportedImportKey(receipt.key_root, x.path) || x.disposition !== 'local-wins'
      || imports.has(x.path) || retained.has(x.path)) return false;
    retained.add(x.path); return true;
  }) || !receipt.held.every(x => object(x) && typeof x.path === 'string' && isAbsolute(x.path) && typeof x.reason === 'string' && x.reason.length > 0)
    || (receipt.coverage === 'complete') !== (receipt.held.length === 0)) return false;
  return receipt.checksum === sealImportReceipt(receipt).checksum;
}
function importReceiptResult(receipt, { noop = false } = {}) {
  const verified = receipt.phase === 'verified';
  return { status: !verified || receipt.coverage === 'held' ? 'held' : receipt.source.status === 'absent' ? 'source-absent' : 'verified',
    noop, phase: receipt.phase, coverage: receipt.coverage, coverage_scope: receipt.key_scope, key_root: receipt.key_root,
    physical_project_coverage: 'not-evaluated', imported_count: noop ? 0 : receipt.imports.length,
    transferred_count: receipt.imports.length, verified_count: verified ? receipt.imports.length : 0,
    held: receipt.held, retained: receipt.retained, source: receipt.source,
    ...(verified ? {} : { recovery: 'recovery-required', reason: 'import-transfer-unverified' }) };
}

function unresolvedImportedKeys(data, receipt) {
  return receipt.imports.filter(x => !own(data.files, x.path) || digest(stableJson(data.files[x.path])) !== x.stamp_sha256);
}

function sourceReceiptMismatch(source, receipt) {
  const contradicting = receipt.imports.filter(x => {
    const stamp = source.files[x.path];
    return !own(source.files, x.path) || !stampValid(stamp)
      || digest(stableJson(stamp)) !== x.stamp_sha256
      || stamp.last_written !== x.last_written || stamp.last_written_by !== x.last_written_by;
  });
  return contradicting.length ? importError('recorded-source-key-mismatch', {
    phase: receipt.phase,
    held: contradicting.map(x => ({ path: x.path, reason: 'preserved-source-contradicts-receipt' })),
  }) : null;
}

function localReceiptResult(root, receipt) {
  assertProjectCacheDir(realpathSync.native(root));
  const result = importReceiptResult(receipt, { noop: true });
  // A transfer receipt does not certify later mutex cleanup. Inspect names locally, without
  // reading ownership/global identity, stealing a lock, or treating directory I/O as absence.
  const names = readdirSync(dirname(projectCachePath(root)));
  const live = names.filter(name => name === '.state-cache.lock' || /^\.state-cache\.lock\.g\d+$/.test(name));
  return live.length ? { ...result, status: 'held', reason: 'local-cache-mutex-unsettled', recovery: 'recovery-required', mutex_artifacts: live } : result;
}

function nestedImportBoundaryProblem(root, file) {
  for (let dir = dirname(file); dir !== root; dir = dirname(dir)) {
    for (const name of ['PROJECT.md', '.git', '.core', '_memories']) {
      try { lstatSync(join(dir, name)); return 'nested-project-boundary'; }
      catch (e) { if (e.code !== 'ENOENT') return `nested-boundary-unreadable: ${e.code || e.message}`; }
    }
  }
  return null;
}

/** Dry-run by default; preserve accepted OLD stamps, never adopt current file bytes. */
export function importLegacyProjectCache(projectDir, { apply = false, recover = false, now = nowIso() } = {}) {
  const root = resolve(projectDir), path = projectCachePath(root);
  let material = null, writeAttempted = false, expectedReceiptChecksum = null;
  try {
    const physicalRoot = realpathSync.native(root);
    const custody = cacheCustodyProblem(root);
    if (custody) return importError('local-custody-refused', { error: custody });
    const tracked = trackedProjectFiles(physicalRoot, '_memories/_lib/');
    if (tracked.size || tracked.has('.gitignore')) return importError('generated-cache-tracked-or-unknown');
    const initial = localImportImage(root);
    const present = initial.data[IMPORT_RECEIPT];
    if (own(initial.data, IMPORT_RECEIPT)) {
      if (!receiptValid(present, physicalRoot)) return importError('import-receipt-invalid');
      if (present.key_root !== root) return importError('import-key-scope-mismatch', { key_root: present.key_root, invoked_root: root });
      if (present.phase === 'verified' || !recover) return localReceiptResult(root, present);
    }
    if (recover && !present) return importError('no-import-to-recover');
    const home = trustedHome();
    if (!home) return importError('legacy-home-unavailable');
    const legacyPath = join(home, '.core', 'state-cache.json');
    const source = legacyImportSnapshot(home, legacyPath);
    if (present && (present.source.path !== source.path || present.source.sha256 !== source.sha256 || present.source.bytes !== source.bytes || present.source.status !== source.status || present.source.identity !== source.identity)) return importError('recorded-legacy-snapshot-changed');
    if (present) { const mismatch = sourceReceiptMismatch(source, present); if (mismatch) return mismatch; }
    const plan = (local) => {
      const entries = [], held = [], retained = [];
      let selected = 0;
      const normalizedLocalKeys = new Set(Object.keys(local.files).map(key => resolve(key)));
      const unresolvedLocalScope = Object.keys(local.files).some(key => !key.startsWith(root + sep));
      for (const [key, stamp] of Object.entries(local.files)) {
        if (!supportedImportKey(root, key) || !stampValid(stamp)) held.push({ path: key, reason: 'local-evidence-held' });
      }
      for (const [key, stamp] of Object.entries(source.files)) {
        if (!key.startsWith(root + sep)) {
          if (root !== physicalRoot && key.startsWith(physicalRoot + sep)) held.push({ path: key, reason: 'different-lexical-key-scope' });
          continue; // no guessed or other-project paths are probed
        }
        selected++;
        if (!supportedImportKey(root, key)) { held.push({ path: key, reason: 'unsupported-legacy-key' }); continue; }
        if (own(local.files, key)) { retained.push({ path: key, disposition: 'local-wins' }); continue; }
        if (normalizedLocalKeys.has(resolve(key))) { held.push({ path: key, reason: 'equivalent-local-key-retained' }); continue; }
        if (unresolvedLocalScope) { held.push({ path: key, reason: 'unresolved-local-key-scope' }); continue; }
        const physicalKey = join(physicalRoot, relative(root, key));
        if (physicalKey !== key && own(local.files, physicalKey)) { held.push({ path: key, reason: 'equivalent-local-key-retained' }); continue; }
        if (!stampValid(stamp)) { held.push({ path: key, reason: 'invalid-legacy-stamp' }); continue; }
        const problem = cacheFileCustodyProblem(root, key);
        if (problem) { held.push({ path: key, reason: `target-custody: ${problem}` }); continue; }
        const boundary = nestedImportBoundaryProblem(root, key);
        if (boundary) { held.push({ path: key, reason: boundary }); continue; }
        let exists;
        try { exists = lstatSync(key).isFile(); } catch (e) { if (e.code !== 'ENOENT') { held.push({ path: key, reason: `target-unreadable: ${e.code || e.message}` }); continue; } }
        if (!exists) { held.push({ path: key, reason: 'target-missing' }); continue; }
        entries.push({ path: key, stamp });
      }
      if (source.status === 'clean' && selected === 0 && held.length === 0) held.push({ path: root, reason: 'no-matching-legacy-keys' });
      return { entries, held, retained };
    };
    const proposed = plan(initial.data);
    if (present && !apply) {
      const unresolved = unresolvedImportedKeys(initial.data, present);
      if (unresolved.length) return importError('superseded-before-verification', { phase: present.phase, held: unresolved.map(x => ({ path: x.path, reason: 'transfer-unverified-local-key-retained' })) });
      return { ...importReceiptResult(present, { noop: true }), reason: 'recovery-preview', recoverable_count: present.imports.length, applied: false };
    }
    if (!apply) return { status: proposed.held.length ? 'held' : source.status === 'absent' ? 'source-absent' : 'planned',
      imported_count: 0, eligible_count: proposed.entries.length, held: proposed.held, retained: proposed.retained,
      coverage_scope: 'exact-lexical-keys', key_root: root, physical_project_coverage: 'not-evaluated', applied: false };
    if (!present && proposed.entries.length === 0 && proposed.held.length) return importError('selected-evidence-held', proposed);
    // New receipt metadata must satisfy the same contract as later receipt reads.
    // Existing receipts and recovery retain their original time; dry-run writes none.
    if (!present && (typeof now !== 'string' || !Number.isFinite(Date.parse(now)))) return importError('invalid-import-timestamp');
    const problem = cacheCustodyProblem(root);
    if (problem) return importError('local-custody-refused', { error: problem });
    ensureProjectCacheDir(physicalRoot);
    return withFileLock(join(dirname(path), '.state-cache.lock'), () => {
      const current = localImportImage(root);
      const existing = current.data[IMPORT_RECEIPT];
      if (recover && !own(current.data, IMPORT_RECEIPT)) return importError('no-import-to-recover');
      if (own(current.data, IMPORT_RECEIPT)) {
        if (!receiptValid(existing, physicalRoot)) return importError('import-receipt-invalid');
        if (existing.key_root !== root) return importError('import-key-scope-mismatch', { key_root: existing.key_root, invoked_root: root });
        if (existing.phase === 'verified' || !recover) return importReceiptResult(existing, { noop: true });
      }
      let receipt, merged = current.data;
      if (existing) {
        const mismatch = sourceReceiptMismatch(source, existing); if (mismatch) return mismatch;
        const unresolved = unresolvedImportedKeys(current.data, existing);
        if (unresolved.length) return importError('superseded-before-verification', { phase: existing.phase, held: unresolved.map(x => ({ path: x.path, reason: 'transfer-unverified-local-key-retained' })) });
        receipt = existing;
      } else {
        const chosen = plan(current.data);
        if (!chosen.entries.length && chosen.held.length) return importError('selected-evidence-held', chosen);
        const { files, ...meta } = source;
        receipt = sealImportReceipt({ schema: 1, import_id: randomUUID(), root: physicalRoot, key_root: root, key_scope: 'exact-lexical-keys', source: meta, phase: 'applied-unverified', coverage: chosen.held.length ? 'held' : 'complete',
          imports: chosen.entries.map(x => ({ path: x.path, stamp_sha256: digest(stableJson(x.stamp)), last_written: x.stamp.last_written, last_written_by: x.stamp.last_written_by })),
          held: chosen.held, retained: chosen.retained, prior_sha256: current.raw === null ? null : digest(current.raw), imported_at: now,
          tool: { protocol: 1, script_sha256: digest(readFileSync(fileURLToPath(import.meta.url))) } });
        merged = { ...current.data, files: { ...current.data.files } };
        for (const x of chosen.entries) merged.files[x.path] = x.stamp;
      }
      const verifySource = () => {
        const again = legacyImportSnapshot(home, legacyPath);
        if (again.path !== receipt.source.path || again.status !== receipt.source.status || again.sha256 !== receipt.source.sha256 || again.bytes !== receipt.source.bytes || again.identity !== receipt.source.identity) throw Object.assign(new Error('accepted legacy snapshot changed'), { code: 'LEGACY_SOURCE_CHANGED' });
      };
      verifySource();
      if (!existing) {
        const output = JSON.stringify({ ...merged, [IMPORT_RECEIPT]: receipt }, null, 2) + '\n';
        const custody = cacheCustodyProblem(root); if (custody) throw Object.assign(new Error(custody), { code: 'LOCAL_CUSTODY_REFUSED' });
        expectedReceiptChecksum = receipt.checksum; writeAttempted = true;
        atomicWriteFileSync(path, output);
        material = importReceiptResult(receipt);
        const readback = localImportImage(root);
        if (digest(readback.raw) !== digest(output)) throw Object.assign(new Error('import output readback differs'), { code: 'IMPORT_READBACK_CHANGED' });
        merged = readback.data;
      }
      verifySource();
      const verified = sealImportReceipt({ ...receipt, phase: 'verified' });
      const final = JSON.stringify({ ...merged, [IMPORT_RECEIPT]: verified }, null, 2) + '\n';
      const custody = cacheCustodyProblem(root); if (custody) throw Object.assign(new Error(custody), { code: 'LOCAL_CUSTODY_REFUSED' });
      expectedReceiptChecksum = verified.checksum; writeAttempted = true;
      atomicWriteFileSync(path, final);
      material = importReceiptResult(verified);
      if (digest(localImportImage(root).raw) !== digest(final)) throw Object.assign(new Error('verified receipt readback differs'), { code: 'IMPORT_READBACK_CHANGED' });
      return material;
    }, { machine: null, retries: 20, retryDelayMs: 50 });
  } catch (e) {
    let outcome = e.operationResult || material;
    if (!e.operationResult && writeAttempted) {
      // A rename may land and still report failure. Settle by guarded local readback of THIS
      // uniquely identified import image; never replay or attribute an unrelated receipt to it.
      try {
        const image = localImportImage(root);
        const observed = image.data[IMPORT_RECEIPT];
        if (image.raw === null && !outcome) outcome = { imported_count: 0, landed: false };
        if (receiptValid(observed, realpathSync.native(root)) && observed.key_root === root && observed.checksum === expectedReceiptChecksum) outcome = importReceiptResult(observed);
      } catch { /* keep the known material outcome, or explicitly unknown below */ }
    }
    const lockReleaseFailures = e.lockReleaseFailures || (e.releaseResult ? [{ lockPath: e.lockPath, releaseResult: e.releaseResult }] : []);
    return { ...(outcome || { imported_count: writeAttempted ? null : 0, landed: writeAttempted ? 'unknown' : false }), status: 'held', recovery: 'recovery-required', reason: e.code || 'legacy-import-failed',
      primaryError: { code: e.code || null, message: String(e.message || e) },
      ...(e.operationResult !== undefined ? { operationResult: e.operationResult } : {}),
      ...(lockReleaseFailures.length ? { lockReleaseFailures, lockRecovery: e.recovery } : {}) };
  }
}

/**
 * Move a damaged cache aside, bytes intact, so the rebuild cannot destroy it.
 * Returns the quarantine path, or null when nothing could be preserved.
 */
export function quarantineCache(path, now = nowIso()) {
  if (!existsSync(path)) return null;
  const stamp = String(now).replace(/[:.]/g, '-');
  const dest = `${path}.corrupt-${stamp}`;
  try { renameSync(path, dest); return dest; } catch { return null; }
}

/**
 * stampFiles — record one or more file writes as CORE's own authorship, in
 * the project-local cache. It never prunes or locks a residual global cache.
 * The cache write must never THROW —
 * the caller's real content write has already landed by the time this runs,
 * so a failure here must not blow up the caller — but it must NOT be swallowed
 * silently either: a content write that succeeds
 * while the baseline stamp fails means the file's on-disk bytes and its
 * recorded authorship have diverged. Reported, not hidden.
 *
 * Returns a truthful outcome:
 *   { stamped: true }
 *       The baseline landed. Attribution is correct.
 *   { stamped: false, outcome: 'attribution-unknown', recovery: 'recovery-required', reason }
 *       The content write already happened but the stamp did NOT land (lock
 *       timeout, disk error, EPERM under sync/AV). The file's authorship is now
 *       unknown: next lifecycle pass will see its content hash disagree with
 *       the (stale or absent) baseline and correctly treat it as unreconciled —
 *       i.e. it fails CLOSED on its own, which is the safe direction. The caller
 *       surfaces this so a human knows a re-stamp/reconcile is owed. No
 *       cross-file transaction is claimed or needed.
 *
 * @param {string} projectDir
 * @param {Array<{path: string, hash: string, lastWrittenBy: string, extra?: object}>} entries
 *   `path` absolute; `hash` the caller's own content hash for THIS stamp
 *   (whole-file or domain-specific, caller's choice) recorded as
 *   `last_hash`; `extra` merges additional fields into the stamp (e.g.
 *   `outside_hash` for a marker-delimited-block classifier).
 * @param {{now?: string}} [opts]
 * @returns {{stamped: boolean, outcome?: string, recovery?: string, reason?: string,
 *   primaryError?: object, lockReleaseFailures?: object[], lockRecovery?: object}}
 */
export function stampFiles(projectDir, entries, { now } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return { stamped: true };
  const ts = now || nowIso();
  const cachePath = projectCachePath(projectDir);

  // The read-modify-write over the whole project-local cache file must be
  // serialized: any caller of stampFiles/stampFile races every OTHER caller
  // (decorate-graph, hot-section, maintenance-run, and any future writer),
  // not just other instances of itself. Reuses the same withFileLock
  // primitive every other lock in this codebase uses. A lock-acquire or
  // cache-write failure never THROWS into the
  // caller (the underlying content write already happened), but it IS
  // reported truthfully instead of silently swallowed.
  let stampOutcome = { stamped: true };
  // Refused before the folder is created or the lock is taken: nothing is made or read elsewhere.
  const custody = cacheCustodyProblem(projectDir);
  if (custody) return { stamped: false, outcome: 'refused', recovery: 'recovery-required', reason: `cache-custody: ${custody}` };
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    const lockResult = withFileLock(join(dirname(cachePath), '.state-cache.lock'), () => {
      const cache = readProjectCache(projectDir);
      // A damaged baseline is preserved, never overwritten: the rebuild below
      // would otherwise turn unreadable prior attribution into a plausible
      // partial cache, and every file it used to describe would silently
      // reclassify. The new stamp still lands; what the old bytes said is
      // reported as unknown, with the file kept for recovery.
      if (cache.status === CACHE_CORRUPT) {
        const quarantined = quarantineCache(cachePath, ts);
        // Nothing preserved the damaged bytes: writing over them would destroy the only
        // record of prior attribution, so refuse the stamp like an unreadable cache.
        if (quarantined === null) {
          return {
            stamped: false,
            outcome: 'refused',
            recovery: 'recovery-required',
            reason: 'corrupt-cache-not-preserved',
          };
        }
        stampOutcome = {
          stamped: true,
          outcome: 'prior-attribution-unknown',
          recovery: 'recovery-required',
          reason: 'corrupt-cache-quarantined',
          quarantined,
        };
      } else if (cache.status === CACHE_UNREADABLE) {
        // The bytes may be intact — the read failed (permissions, a directory
        // in the way). Writing a rebuilt cache over them would destroy
        // attribution we never even saw. Refuse the stamp entirely.
        return {
          stamped: false,
          outcome: 'refused',
          recovery: 'recovery-required',
          reason: `cache-unreadable: ${cache.error || 'unknown read failure'}`,
        };
      }
      for (const e of entries) {
        cache.files[e.path] = {
          last_hash: e.hash,
          last_written: ts,
          last_written_by: e.lastWrittenBy,
          ...(e.extra || {}),
        };
      }
      atomicWriteFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n');
      // The checked-release helper must receive the actual stamp outcome so
      // cleanup failure cannot turn a completed stamp into a failed stamp.
      return stampOutcome;
    }, { retries: 20, retryDelayMs: 50 });
    // The callback's refusal is the stamp's outcome, not a success.
    if (lockResult && lockResult.stamped === false) stampOutcome = lockResult;
  } catch (e) {
    const releaseFailures = e?.lockReleaseFailures || (e?.releaseResult
      ? [{ lockPath: e.lockPath, releaseResult: e.releaseResult }] : []);
    // operationResult exists only when the callback returned. Never infer a
    // successful stamp from the optimistic outer value after a thrown write.
    stampOutcome = e?.code === 'LOCK_RELEASE_FAILED' && e.operationResult
      ? e.operationResult : {
        ...stampOutcome,
        stamped: false,
        outcome: 'attribution-unknown',
        recovery: 'recovery-required',
        reason: (e && (e.code || e.message)) ? String(e.code || e.message) : 'stamp-failed',
        primaryError: { code: e?.code || null, message: String(e?.message || e) },
      };
    if (releaseFailures.length) stampOutcome = {
      ...stampOutcome,
      recovery: 'recovery-required',
      lockReleaseFailures: releaseFailures,
      lockRecovery: e.recovery,
    };
  }

  return stampOutcome;
}

/** A completed stamp can still require lock cleanup; callers must retain both. */
export function stampNeedsRecovery(outcome) {
  return outcome?.stamped === false || (outcome?.lockReleaseFailures?.length || 0) > 0;
}

/** Human diagnostic distinguishes missing attribution from completed stamping. */
export function stampRecoveryMessage(outcome) {
  const material = outcome?.stamped === true ? 'authorship stamp landed'
    : `authorship stamp failed (${outcome?.outcome}: ${outcome?.reason}) — attribution unknown`;
  const cleanup = outcome?.lockReleaseFailures?.length
    ? '; lock cleanup failed: ' + outcome.lockReleaseFailures.map(f =>
      `${f.lockPath} (${f.releaseResult?.reason}${f.releaseResult?.error ? ': ' + f.releaseResult.error : ''})`).join('; ') +
      '; inspect the named lock and material outcome; do not repeat the operation'
    : '; inspect the baseline before reconciling or re-stamping';
  return material + cleanup + ' — recovery-required';
}

/** Convenience single-file wrapper around stampFiles. Returns the same
 *  truthful outcome. */
export function stampFile(projectDir, path, hash, lastWrittenBy, { now, extra } = {}) {
  return stampFiles(projectDir, [{ path, hash, lastWrittenBy, extra }], { now });
}
