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
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 */

import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

let _counter = 0;

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
    renameSync(tmp, filePath);
  } catch (e) {
    // Best-effort cleanup of the temp file; never mask the original error.
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
