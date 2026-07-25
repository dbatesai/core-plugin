/**
 * check-context-integrity.mjs — does the agent know when it's blind?
 *
 * At bootstrap the agent loads MEMORY.md (capped by the harness injection budget) and
 * reads PROJECT.md (which can exceed one Read). When either gets truncated, the agent
 * was answering from partial context without knowing it. This computes a one-line marker
 * the agent surfaces BEFORE its first substantive answer, naming exactly what was dropped.
 *
 * Pure function (testable, no I/O): caller passes the measured byte/line extents. The CLI
 * wrapper measures them off disk via statSync + a line count and prints the marker.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI:
 *   node check-context-integrity.mjs --memory <MEMORY.md> --project <PROJECT.md> \
 *        --project-read-lines <N> [--memory-cap-bytes 24576]
 *   prints the marker (CONTEXT-COMPLETE or CONTEXT-PARTIAL: ...), exit 0 always.
 */

import { statSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MEMORY_CAP_BYTES = 24576; // ~24KB harness injection budget
export const BYTES_PER_UNIT = 400;             // rough MEMORY.md entry size for the lost-count estimate

/**
 * @param {object} a
 * @param {number} a.memoryBytes        — actual MEMORY.md size in bytes
 * @param {number} [a.memoryCapBytes]   — injection cap (default 24576)
 * @param {number} a.projectTotalLines  — total lines in PROJECT.md
 * @param {number} a.projectReadLines   — lines actually read this bootstrap
 * @returns {{ ok: boolean, dropped: Array<{file,totalBytes?,availableBytes?,estimatedUnitsLost?,totalLines?,readLines?}>, marker: string }}
 */
export function checkContextIntegrity({
  memoryBytes = 0,
  memoryCapBytes = DEFAULT_MEMORY_CAP_BYTES,
  projectTotalLines = 0,
  projectReadLines = 0,
} = {}) {
  const dropped = [];
  const parts = [];

  if (memoryBytes > memoryCapBytes) {
    const droppedBytes = memoryBytes - memoryCapBytes;
    const estimatedUnitsLost = Math.ceil(droppedBytes / BYTES_PER_UNIT);
    dropped.push({ file: 'MEMORY.md', totalBytes: memoryBytes, availableBytes: memoryCapBytes, estimatedUnitsLost });
    parts.push(`MEMORY.md dropped ~${estimatedUnitsLost} entries (>${memoryCapBytes}B cap)`);
  }

  if (projectTotalLines > 0 && projectReadLines < projectTotalLines) {
    dropped.push({ file: 'PROJECT.md', totalLines: projectTotalLines, readLines: projectReadLines });
    parts.push(`PROJECT.md loaded ${projectReadLines}/${projectTotalLines} lines`);
  }

  const ok = dropped.length === 0;
  const marker = ok ? 'CONTEXT-COMPLETE' : `CONTEXT-PARTIAL: ${parts.join('; ')}`;
  return { ok, dropped, marker };
}

function countLines(path) {
  try { return readFileSync(path, 'utf8').split('\n').length; } catch { return 0; }
}
function sizeBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function main(argv) {
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const memoryPath = opt('memory');
  const projectPath = opt('project');
  const memoryCapBytes = Number(opt('memory-cap-bytes')) || DEFAULT_MEMORY_CAP_BYTES;
  const projectReadLines = Number(opt('project-read-lines')) || 0;

  const res = checkContextIntegrity({
    memoryBytes: memoryPath ? sizeBytes(memoryPath) : 0,
    memoryCapBytes,
    projectTotalLines: projectPath ? countLines(projectPath) : 0,
    projectReadLines,
  });
  process.stdout.write(res.marker + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
