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
 * Ships with the plugin by convention; .mjs (Node.js) only.
 *
 * The MEMORY surface is HARNESS-AWARE. Auto-memory is a Claude Code surface
 * (`~/.claude/projects/<slug>/memory/MEMORY.md`); Codex has no equivalent
 * file. The CLI resolves the surface for the detected (or `--harness`-named)
 * harness: on Claude Code it derives the path from the cwd via the canonical
 * slug encoding; on any harness without the surface the memory check is
 * EXPLICITLY SKIPPED and the marker says so — never a false CONTEXT-COMPLETE
 * from measuring a Claude-only path that cannot exist. `--memory <path>`
 * remains the explicit override and wins over detection.
 *
 * CLI:
 *   node check-context-integrity.mjs [--memory <MEMORY.md>] [--harness claude-code|codex]
 *        [--cwd <project-root>] --project <PROJECT.md> \
 *        --project-read-lines <N> [--memory-cap-bytes 24576]
 *   prints the marker (CONTEXT-COMPLETE or CONTEXT-PARTIAL: ...), exit 0 always.
 */

import { statSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectHarness } from './configure-project.mjs';
import { mapProjectPathToSlug } from './project-slug.mjs';

export const DEFAULT_MEMORY_CAP_BYTES = 24576; // ~24KB harness injection budget
export const BYTES_PER_UNIT = 400;             // rough MEMORY.md entry size for the lost-count estimate

/**
 * Resolve the harness auto-memory surface for the integrity check.
 *
 * @param {object} [a]
 * @param {string} [a.harness]      — explicit harness name; detected from env otherwise
 * @param {string} [a.explicitPath] — explicit MEMORY.md path (`--memory`); wins over detection
 * @param {string} [a.cwd]          — project root the slug encodes (default process.cwd())
 * @param {string} [a.home]         — home dir override (tests)
 * @param {object} [a.env]          — env for harness detection (tests)
 * @returns {{ harness: string|null, path: string|null, skipped: boolean, reason?: string }}
 */
export function resolveAutoMemorySurface({
  harness = null,
  explicitPath = null,
  cwd = process.cwd(),
  home = homedir(),
  env = process.env,
} = {}) {
  if (explicitPath) return { harness: harness || null, path: explicitPath, skipped: false };
  const h = harness || detectHarness(env);
  if (h === 'claude-code') {
    return {
      harness: h,
      path: join(home, '.claude', 'projects', mapProjectPathToSlug(cwd), 'memory', 'MEMORY.md'),
      skipped: false,
    };
  }
  // No auto-memory FILE surface on this harness. The check is explicitly
  // skipped and named in the marker — a Claude-only path measured on Codex
  // would always read 0 bytes and produce a false CONTEXT-COMPLETE.
  return { harness: h, path: null, skipped: true, reason: `no-auto-memory-file-surface-on-${h}` };
}

/**
 * @param {object} a
 * @param {number} a.memoryBytes        — actual MEMORY.md size in bytes
 * @param {number} [a.memoryCapBytes]   — injection cap (default 24576)
 * @param {string} [a.memorySkippedReason] — when set, the memory surface was not
 *        measured (harness has none); the marker names the skip instead of
 *        silently asserting the memory side is complete
 * @param {number} a.projectTotalLines  — total lines in PROJECT.md
 * @param {number} a.projectReadLines   — lines actually read this bootstrap
 * @returns {{ ok: boolean, dropped: Array<{file,totalBytes?,availableBytes?,estimatedUnitsLost?,totalLines?,readLines?}>, memorySkipped: null|{reason: string}, marker: string }}
 */
export function checkContextIntegrity({
  memoryBytes = 0,
  memoryCapBytes = DEFAULT_MEMORY_CAP_BYTES,
  memorySkippedReason = null,
  projectTotalLines = 0,
  projectReadLines = 0,
} = {}) {
  const dropped = [];
  const parts = [];

  if (!memorySkippedReason && memoryBytes > memoryCapBytes) {
    const droppedBytes = memoryBytes - memoryCapBytes;
    const estimatedUnitsLost = Math.ceil(droppedBytes / BYTES_PER_UNIT);
    dropped.push({ file: 'MEMORY.md', totalBytes: memoryBytes, availableBytes: memoryCapBytes, estimatedUnitsLost });
    parts.push(`MEMORY.md dropped ~${estimatedUnitsLost} entries (>${memoryCapBytes}B cap)`);
  }

  if (projectTotalLines > 0 && projectReadLines < projectTotalLines) {
    dropped.push({ file: 'PROJECT.md', totalLines: projectTotalLines, readLines: projectReadLines });
    parts.push(`PROJECT.md loaded ${projectReadLines}/${projectTotalLines} lines`);
  }

  const memorySkipped = memorySkippedReason ? { reason: String(memorySkippedReason) } : null;
  const ok = dropped.length === 0;
  // The skip is named in the marker either way: a skipped surface is not a
  // verified-complete surface, and the readiness narration needs to know.
  const skipSuffix = memorySkipped ? `MEMORY.md check skipped (${memorySkipped.reason})` : null;
  const marker = ok
    ? (skipSuffix ? `CONTEXT-COMPLETE (${skipSuffix})` : 'CONTEXT-COMPLETE')
    : `CONTEXT-PARTIAL: ${[...parts, ...(skipSuffix ? [skipSuffix] : [])].join('; ')}`;
  return { ok, dropped, memorySkipped, marker };
}

function countLines(path) {
  try { return readFileSync(path, 'utf8').split('\n').length; } catch { return 0; }
}
function sizeBytes(path) {
  try { return statSync(path).size; } catch { return 0; }
}

function main(argv) {
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const projectPath = opt('project');
  const memoryCapBytes = Number(opt('memory-cap-bytes')) || DEFAULT_MEMORY_CAP_BYTES;
  const projectReadLines = Number(opt('project-read-lines')) || 0;

  // Harness-aware memory surface: explicit --memory wins; otherwise resolve
  // per detected/declared harness. A harness with no auto-memory file surface
  // (Codex) gets an EXPLICIT skip named in the marker, never a false check
  // against the Claude-only path.
  const surface = resolveAutoMemorySurface({
    harness: opt('harness'),
    explicitPath: opt('memory'),
    cwd: opt('cwd') || process.cwd(),
  });

  const res = checkContextIntegrity({
    memoryBytes: surface.path ? sizeBytes(surface.path) : 0,
    memoryCapBytes,
    memorySkippedReason: surface.skipped ? surface.reason : null,
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
