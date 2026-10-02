/** Automatic-close storage and explicit-purge boundary; never scans historical stores. */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveStoragePath, storagePinInvalid } from './log-event.mjs';
import { detectStoragePath } from './metrics-init.mjs';
import { requireTrustedHome } from './trusted-home.mjs';

const MARKER = 'core.generated-close/1';
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** Invalid pins must not silently fall back into a synced project. No pin repair here. */
export function closeStorageRoot(store, { storageRoot = null, home = requireTrustedHome(), env = process.env } = {}) {
  if (storageRoot) return resolve(storageRoot); // trusted in-process test seam only
  const projectDir = resolve(store);
  return storagePinInvalid(projectDir, { home, env })
    ? detectStoragePath({ projectDir, home }).path
    : resolveStoragePath(projectDir, { home, env });
}

function statIfPresent(path) {
  try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Create only the lock's parent before serialization, never a payload directory. */
export function prepareCloseStorageRoot(root) {
  const stat = statIfPresent(root);
  if (stat && !stat.isDirectory()) throw new Error(`unsafe close storage root: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
}

/** Refuse linked generated directories, even if their targets are readable. */
export function assertCloseDirectory(dir) {
  for (const path of [dirname(dirname(dir)), dirname(dir), dir]) {
    const stat = statIfPresent(path);
    if (stat && !stat.isDirectory()) throw new Error(`unsafe close directory: ${path}`);
  }
}

/** Establish owner-only directories and self-exclusion BEFORE writing any payload. */
export function prepareCloseDirectory(dir) {
  assertCloseDirectory(dir);
  for (const path of [dirname(dir), dir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try { chmodSync(path, 0o700); } catch { /* best-effort on ACL filesystems */ }
    const ignore = join(path, '.gitignore');
    const stat = statIfPresent(ignore);
    if (stat) {
      if (!stat.isFile() || readFileSync(ignore, 'utf8').trim() !== '*') {
        throw new Error(`unsafe close self-ignore: ${ignore}`);
      }
    } else {
      try { writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
      catch (e) {
        // Another first-time writer may establish the exact same exclusion.
        if (e.code !== 'EEXIST' || !statIfPresent(ignore)?.isFile()
          || readFileSync(ignore, 'utf8').trim() !== '*') throw e;
      }
    }
  }
}

/** Hash the body as well as marking it: a human-edited generated file is not purge-owned. */
export function markCloseSummary(body) {
  return `<!-- ${MARKER} sha256:${digest(body)} -->\n${body}`;
}

export function markCloseReceipt(receipt) {
  return { ...receipt, generated_close: { marker: MARKER, sha256: digest(JSON.stringify(receipt)) } };
}

export function assertCloseSummaryWritable(path) {
  if (statIfPresent(path) && !isGeneratedClose(path, 'summaries')) {
    throw new Error(`refusing to overwrite a non-generated or edited close summary: ${path}`);
  }
}

function isGeneratedClose(path, kind) {
  const stat = statIfPresent(path);
  if (!stat || !stat.isFile()) return false;
  const raw = readFileSync(path, 'utf8');
  if (kind === 'summaries') {
    const newline = raw.indexOf('\n');
    const body = raw.slice(newline + 1);
    return newline >= 0 && raw.slice(0, newline) === `<!-- ${MARKER} sha256:${digest(body)} -->`;
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return false; }
  if (!parsed || typeof parsed !== 'object') return false;
  const { generated_close: marker, ...body } = parsed;
  return marker?.marker === MARKER && marker.sha256 === digest(JSON.stringify(body))
    && typeof body.session_id === 'string' && basename(path) === `${digest(body.session_id)}.json`;
}

/**
 * A manual certification can deliberately retain a previously generated summary.
 * Protect its same-session summary too, without ever dereferencing summary_path.
 */
function manualReceiptOwnsSummary(dir, name) {
  const receiptDir = join(dirname(dir), 'receipts');
  assertCloseDirectory(receiptDir);
  const receipt = join(receiptDir, name.replace(/\.md$/, '.json'));
  const stat = statIfPresent(receipt);
  if (!stat) return false;
  if (!stat.isFile()) return true;
  let parsed;
  try { parsed = JSON.parse(readFileSync(receipt, 'utf8')); } catch { return true; }
  return parsed?.status === 'closed' || !isGeneratedClose(receipt, 'receipts');
}

/**
 * Only direct, hash-named, intact writer-marked files qualify. No recursion, no
 * summary_path traversal, no unlink of user edits, links, quarantines, or history.
 * Caller holds the shared capture lock for apply. The lock is advisory, not a
 * defense against a hostile same-user process replacing directories concurrently.
 */
export function purgeGeneratedCloseDirectory(dir, { apply = false } = {}) {
  const kind = basename(dir);
  if (!['summaries', 'receipts'].includes(kind) || basename(dirname(dir)) !== 'close') {
    throw new Error(`refusing generated close purge outside close/{summaries,receipts}: ${dir}`);
  }
  assertCloseDirectory(dir);
  const result = { candidates: [], deleted: [], kept: [] };
  if (!statIfPresent(dir)) return result;
  const pattern = kind === 'summaries' ? /^[a-f0-9]{64}\.md$/ : /^[a-f0-9]{64}\.json$/;
  for (const name of readdirSync(dir).sort()) {
    if (name === '.gitignore') continue;
    const path = join(dir, name);
    if (!pattern.test(name) || !isGeneratedClose(path, kind)
      || (kind === 'summaries' && manualReceiptOwnsSummary(dir, name))) {
      result.kept.push({ path, reason: 'not-intact-automatic-close' });
      continue;
    }
    result.candidates.push(path);
    if (apply) {
      // Recheck the boundary under the shared lock immediately before unlink.
      assertCloseDirectory(dir);
      if (!isGeneratedClose(path, kind)) throw new Error(`close artifact changed before purge: ${path}`);
      rmSync(path); // never recursive, never follow a payload's path field
      if (statIfPresent(path)) throw new Error(`close artifact still present after purge: ${path}`);
      result.deleted.push(path);
    }
  }
  return result;
}
