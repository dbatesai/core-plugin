#!/usr/bin/env node
/**
 * generate-memory-index.mjs
 *
 * Rewrites the "## Top project units" section of MEMORY.md from priority.mjs
 * ranking output. Preserves all other sections verbatim. Preserves existing
 * one-line descriptions for units that remain in top-N; otherwise cascades
 * through frontmatter `description:`, first H1 of the body, and first non-blank
 * body line before giving up with `(description pending)`.
 *
 * Paths are emitted relative to the project root (the parent of `_memories/`),
 * not relative to MEMORY.md's directory. Claude Code resolves these against
 * the session CWD (the project root); shorter project-root-relative paths are
 * portable across the harness's MEMORY.md location, which may sit outside the
 * project tree (e.g. `~/.claude/projects/<encoded>/memory/`).
 *
 * Usage:
 *   node generate-memory-index.mjs <project>/_memories \
 *        --memory-md <path-to-MEMORY.md> \
 *        [--top N] [--today YYYY-MM-DD] [--dry-run]
 *
 * --dry-run: compute what would change but write nothing.
 */

import { readFileSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankUnits } from './priority.mjs';
import { mapProjectPathToSlug } from './project-slug.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

const SECTION_HEADER_RE = /^## Top project units/;
const EXISTING_LINE_RE = /^- \[([^\]]+)\]\(([^)]+)\) — (.+)$/;
const FALLBACK_DESCRIPTION = '(description pending)';

export function parseExistingDescriptions(memoryMdText) {
  const map = new Map();
  for (const line of memoryMdText.split('\n')) {
    const m = line.match(EXISTING_LINE_RE);
    if (m) map.set(m[1], m[3]);
  }
  return map;
}

export function extractH1(unitText) {
  unitText = unitText.replace(/\r\n?/g, '\n'); // CRLF tolerance (review M1)
  let body = unitText;
  if (unitText.startsWith('---\n')) {
    const end = unitText.indexOf('\n---\n', 4);
    if (end > 0) body = unitText.slice(end + 5);
  }
  for (const line of body.split('\n')) {
    const m = line.match(/^# (.+)$/);
    if (m) return m[1].trim();
  }
  return FALLBACK_DESCRIPTION;
}

export function extractFirstBodyLine(unitText) {
  unitText = unitText.replace(/\r\n?/g, '\n'); // CRLF tolerance (review M1)
  let body = unitText;
  if (unitText.startsWith('---\n')) {
    const end = unitText.indexOf('\n---\n', 4);
    if (end > 0) body = unitText.slice(end + 5);
  }
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/^[#>*-]+\s*/, '').trim();
    if (stripped) return stripped;
  }
  return FALLBACK_DESCRIPTION;
}

// Description resolution cascade: existing curated → fm.description → H1 → first body line → fallback.
// `existing` is a string or undefined (caller resolves preserved curation).
export function resolveDescription(existing, fm, unitText) {
  if (existing) return existing;
  if (fm && fm.description) return String(fm.description).trim();
  const h1 = extractH1(unitText);
  if (h1 !== FALLBACK_DESCRIPTION) return h1;
  return extractFirstBodyLine(unitText);
}

// Returns a Date for a YYYY-MM-DD arg, or null if the arg is present but malformed
// (so the caller can refuse cleanly rather than throw a RangeError downstream on toISOString).
function todayFromArg(arg) {
  if (arg) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) return null;
    const [y, m, d] = arg.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function renderPriorityBlock({ memoriesDir, topN, today, existingDescriptions }) {
  // rankUnits applies the bi-temporal suppression invariant + load-error
  // filtering (SOD-003/MEM-011) — the index is a retrieval surface.
  const ranked = rankUnits(memoriesDir, { today });
  const top = ranked.slice(0, topN);

  const projectRoot = dirname(memoriesDir);
  const dateStr = today.toISOString().slice(0, 10);

  const lines = [`## Top project units (refreshed from priority.mjs --top ${topN}, ${dateStr})`, ''];
  for (const [, u] of top) {
    const relPath = relative(projectRoot, String(u.path)).replace(/\\/g, '/');
    const existing = existingDescriptions.get(u.id);
    let desc;
    try {
      const unitText = readFileSync(u.path, 'utf8');
      desc = resolveDescription(existing, u.fm, unitText);
    } catch {
      desc = existing || FALLBACK_DESCRIPTION;
    }
    lines.push(`- [${u.id}](${relPath}) — ${desc}`);
  }
  return lines.join('\n');
}

export function spliceSection(memoryMdText, newSection) {
  const lines = memoryMdText.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (SECTION_HEADER_RE.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) {
    // Section absent — append it so the script is idempotent on first run against
    // a MEMORY.md that predates this section (local-llm-build, early BBLens, etc.).
    process.stderr.write("Created '## Top project units' section in MEMORY.md\n");
    const newLines = newSection.split('\n');
    while (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
    const trimmed = memoryMdText.trimEnd();
    return trimmed + '\n\n' + newLines.join('\n') + '\n';
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  // Strip trailing blank lines from the new section; preserve following structure
  const newLines = newSection.split('\n');
  while (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const trailingBlank = endIdx < lines.length ? [''] : [];
  const out = [
    ...lines.slice(0, startIdx),
    ...newLines,
    ...trailingBlank,
    ...lines.slice(endIdx),
  ].join('\n');
  // MEM-020: when the spliced section is last in the file, the join ends with
  // no final newline — breaking POSIX convention and causing diff churn on the
  // next edit. Normalize to exactly one trailing newline.
  return out.replace(/\n*$/, '\n');
}

// Cross-project contamination guard.
//
// The writer computes the priority block from <source>/_memories and writes it
// into the --memory-md target. Nothing structural stops you from pairing one
// project's _memories with another project's MEMORY.md — and when that happens
// the target's units are silently overwritten with the source's — a destructive
// cross-project contamination with no recovery path.
//
// Claude Code maps a project cwd to ~/.claude/projects/<mapped-cwd>/memory/MEMORY.md
// where <mapped-cwd> is the absolute cwd with path separators turned into dashes.
// So the target's project identity is recoverable from its path, and we can
// assert it matches the source project (the parent of _memories) before writing.
//
// Returns null when same-project (or when the target isn't a standard Claude Code
// memory path — test fixtures, custom targets — where we can't assert and don't
// block). Returns a mismatch descriptor otherwise. Fail-safe: on any doubt about
// a STANDARD path we refuse, because a false refusal is recoverable and a silent
// contamination is data loss.
export function projectIdentityMismatch(memoriesDir, memoryMdPath) {
  const m = String(memoryMdPath).match(/[/\\]projects[/\\]([^/\\]+)[/\\]memory[/\\]MEMORY\.md$/);
  if (!m) return null; // non-standard target — cannot assert identity, don't block
  const actualMapped = m[1];
  const projectRoot = dirname(memoriesDir);
  const expectedMapped = mapProjectPathToSlug(projectRoot);
  if (actualMapped === expectedMapped) return null;
  return { projectRoot, expectedMapped, actualMapped };
}

export function main(argv) {
  let memoriesDirArg = null;
  let memoryMdPath = null;
  let topN = 30;
  let todayArg = null;
  let dryRun = false;

  let topRaw = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memory-md') memoryMdPath = argv[++i];
    else if (a === '--top') topRaw = argv[++i];
    else if (a === '--today') todayArg = argv[++i];
    else if (a === '--dry-run') dryRun = true;
    else if (!a.startsWith('--')) memoriesDirArg = a;
  }

  // M13: an unvalidated parseInt('--top garbage') yields NaN, and ranked.slice(0, NaN) is
  // EMPTY — which then OVERWRITES the curated MEMORY.md top-units block with nothing (silent
  // data-thinning, not an error). Validate: --top must be a positive integer or we refuse.
  if (topRaw != null) {
    if (!/^\d+$/.test(String(topRaw).trim()) || parseInt(topRaw, 10) < 1) {
      process.stderr.write(`error: --top must be a positive integer (got ${JSON.stringify(topRaw)}); refusing to thin MEMORY.md.\n`);
      return 2;
    }
    topN = parseInt(topRaw, 10);
  }

  if (!memoriesDirArg || !memoryMdPath) {
    process.stderr.write('usage: generate-memory-index.mjs <project>/_memories --memory-md <path> [--top N] [--today YYYY-MM-DD]\n');
    return 2;
  }

  const memoriesDir = resolve(memoriesDirArg);
  memoryMdPath = resolve(memoryMdPath);

  // Guard the SOURCE dir too (mirrors the sibling generators): a bad/typo'd _memories path
  // would otherwise throw an uncaught ENOENT deep in iterUnits→readdirSync. Refuse with exit 2.
  try { readdirSync(memoriesDir); }
  catch { process.stderr.write(`error: _memories source dir not readable: ${memoriesDir}\n`); return 2; }

  const mismatch = projectIdentityMismatch(memoriesDir, memoryMdPath);
  if (mismatch) {
    process.stderr.write(
      'cross-project guard: REFUSING to write — source and target are different projects.\n' +
      `  _memories source project: ${mismatch.expectedMapped} (from ${mismatch.projectRoot})\n` +
      `  --memory-md target project: ${mismatch.actualMapped}\n` +
      'Writing would overwrite one project\'s MEMORY.md priority block with another\'s units.\n' +
      'Pass a --memory-md path that belongs to the same project as the _memories source.\n'
    );
    return 3;
  }

  const today = todayFromArg(todayArg);
  if (today === null) {
    process.stderr.write(`error: --today must be YYYY-MM-DD (got ${JSON.stringify(todayArg)})\n`);
    return 2;
  }

  // A missing target MEMORY.md is an operator/setup error, not a crash: readFileSync would
  // throw an uncaught ENOENT (exit 1, ugly stack). Refuse cleanly with exit 2 instead.
  if (!existsSync(memoryMdPath)) {
    process.stderr.write(`error: --memory-md target does not exist: ${memoryMdPath}\n`);
    return 2;
  }
  const oldText = readFileSync(memoryMdPath, 'utf8');
  const existingDescriptions = parseExistingDescriptions(oldText);
  const newSection = renderPriorityBlock({
    memoriesDir, topN, today, existingDescriptions,
  });
  const newText = spliceSection(oldText, newSection);

  if (newText === oldText) {
    process.stderr.write(`No change: priority block already current (${topN} units, ${today.toISOString().slice(0, 10)})\n`);
    return 0;
  }

  if (dryRun) {
    process.stderr.write(`Dry run: would rewrite priority block in ${memoryMdPath} (${topN} units) — nothing written\n`);
    return 0;
  }

  atomicWriteFileSync(memoryMdPath, newText);
  process.stderr.write(`Rewrote priority block in ${memoryMdPath} (${topN} units)\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
const _argv1 = _canon(process.argv[1]);
const _self = _canon(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_argv1)} self=${JSON.stringify(_self)} match=${_argv1 === _self}\n`);
}
if (_argv1 === _self) {
  process.exit(main(process.argv.slice(2)));
}
