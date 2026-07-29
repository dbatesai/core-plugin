/**
 * fs-atomic.mjs — atomic file writes for irreplaceable surfaces (M4 / H3).
 *
 * The hygiene mutators (demote-moves, demote-state-narrative, compact-project,
 * hot-section) and workspace-fork-check all rewrite files the user cannot easily
 * reconstruct — PROJECT.md, PROJECT-ARCHIVE.md, the local workspace pointer. A bare
 * writeFileSync truncates the target the instant it opens the fd, so an interrupted
 * write (crash, EACCES mid-write, ENOSPC, a kill) leaves a half-written or empty file.
 *
 * atomicWriteFileSync writes to a sibling temp file then renames over the target.
 * rename is atomic on POSIX and replaces-in-place on Windows (Node 16+), so a reader
 * (or a crash) ever sees only the complete old file or the complete new one — never a
 * partial. The temp file lives in the SAME directory as the target so the rename stays
 * on one filesystem (a cross-device rename would fall back to a non-atomic copy).
 *
 * Windows caveat: renameSync can throw EPERM/EACCES if another process holds the TARGET
 * open (an editor, antivirus, or a sync client mid-scan). That error propagates and the
 * temp file is cleaned up, so the target is never corrupted — strictly safer than the bare
 * writeFileSync this replaced (which would truncate). The caller sees a throw, not a partial.
 * The rename now retries transient EPERM/EACCES up to 3× on Windows (these
 * locks are usually a sync client or antivirus mid-scan and clear in tens of
 * milliseconds); POSIX still throws immediately.
 *
 * iCloud Drive caveat: the visible sibling `.<name>.tmp-*` file can be
 * uploaded as a conflict copy if the sync client races the rename. Not
 * mitigated in code — a `.nosync` temp location would force the rename across
 * directories on some setups, breaking same-filesystem atomicity. If conflict
 * copies appear in an iCloud-synced store, move the store out of iCloud Drive.
 * Documented for operators in scripts/README.md §Cloud-synced stores.
 *
 * The script ships with the plugin by convention. The plugin ships .mjs (Node.js) only.
 */

import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

let _counter = 0;

export const RENAME_RETRIES = 3;
export const RENAME_RETRY_DELAY_MS = 50;

// Synchronous sleep without burning CPU: Atomics.wait blocks the thread for
// the timeout. Fine here — these scripts are short-lived CLI tools.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * renameSync with a bounded WINDOWS-ONLY retry.
 * On Windows, OneDrive's sync client or antivirus can hold the rename TARGET
 * open for a moment, surfacing as transient EPERM/EACCES; retry up to
 * RENAME_RETRIES attempts with a short delay. POSIX gets NO retry — rename is
 * atomic there and an EPERM is a real permissions problem worth throwing
 * immediately. The injection params (isWindows/renameFn/delayMs) exist for tests.
 */
export function renameWithRetrySync(from, to, {
  isWindows = process.platform === 'win32',
  retries = RENAME_RETRIES,
  delayMs = RENAME_RETRY_DELAY_MS,
  renameFn = renameSync,
} = {}) {
  const attempts = isWindows ? retries : 1;
  for (let i = 0; i < attempts; i++) {
    try { renameFn(from, to); return; }
    catch (e) {
      const transient = isWindows && (e.code === 'EPERM' || e.code === 'EACCES');
      if (!transient || i === attempts - 1) throw e;
      sleepSync(delayMs);
    }
  }
}

/**
 * Write `data` to `filePath` atomically (temp-file + rename).
 * @param {string} filePath  destination path
 * @param {string|Buffer} data  contents
 * @param {string} [encoding='utf8']
 */
export function atomicWriteFileSync(filePath, data, encoding = 'utf8') {
  const tmp = join(dirname(filePath), `.${basename(filePath)}.tmp-${process.pid}-${++_counter}`);
  try {
    writeFileSync(tmp, data, encoding);
    renameWithRetrySync(tmp, filePath);
  } catch (e) {
    // Best-effort cleanup of the temp file; never mask the original error.
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
