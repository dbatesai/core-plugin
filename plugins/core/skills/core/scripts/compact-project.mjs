/**
 * Compact <project>/PROJECT.md by replacing full-text §Decisions entries with
 * one-line stubs pointing at canonical units in `_memories/`.
 *
 * Matches the DC-48 stub-every-archived-decision pattern: every DC entry
 * becomes a stub. Full text lives in the unit; PROJECT.md is the rendered view.
 *
 * Idempotent — skips entries already in stub form (single-line, no `**...**`
 * paragraph body, ending in a `→ _memories/...md` pointer).
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs <project>
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs --check <project>
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs <project> --check
 *
 * --check reports whether PROJECT.md is over the size cap; it does not write.
 */

import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './log-event.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';

export const DECISIONS_HEADER = '**Decisions (dated, append-only):**';
export const RISKS_HEADER_PATTERN = /^\*\*Risks \(/;
// 80% of the Read-tool 25000-token cap, char-to-token factor 0.30:
// 0.8 * 25000 / 0.30 ≈ 67000 bytes. Matches protocols/startup.md's cap heuristic.
export const PROJECT_MD_CAP_BYTES = 67000;
// Phase 1b — DC-85 R1 soft target. 70KB ≈ 21K tokens at the 0.30 factor.
// compact-project never refuses to write; this is advisory. When PROJECT.md
// exceeds the target, a structured project-md-over-cap event emits so the
// Phase 5 monitoring loop can react. demote-moves handles §Moves growth;
// §State narrative compaction is Phase 1c. Renamed from HARD_CAP_BYTES on
// 2026-05-24 (session 34) — the old name implied enforcement the script
// never had.
export const SOFT_TARGET_BYTES = 70000;
// Back-compat export for any consumer still on the old name. Remove when no
// callers reference it. Tracked via the project-md-over-cap event payload.
export const HARD_CAP_BYTES = SOFT_TARGET_BYTES;

export function parseArgv(argv) {
  const flags = new Set();
  let positional = null;
  for (const a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else if (positional === null) positional = a;
  }
  return { positional, flags };
}

// M1: delegates to the shared flat parser (was a local copy). Export kept for the callsite.
export function parseFrontmatter(text) {
  return parseFlatFrontmatter(text);
}

export function loadUnits(memoriesDir) {
  const units = new Map();
  for (const fname of readdirSync(memoriesDir)) {
    if (!fname.startsWith('dc-') || !fname.endsWith('.md')) continue;
    const m = fname.match(/^dc-(\d+)-(.+)\.md$/);
    if (!m) continue;
    const path = join(memoriesDir, fname);
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const [fm, body] = parseFrontmatter(text);
    const titleMatch = body.match(/^#\s+(.+?)\s*$/m);
    const title = titleMatch ? titleMatch[1].replace(/^DC-\d+:\s*/, '') : '';
    units.set(parseInt(m[1], 10), {
      dc: parseInt(m[1], 10),
      slug: m[2],
      filename: fname,
      status: fm.status || 'active',
      updated: fm.updated || fm.created || 'unknown',
      title,
    });
  }
  return units;
}

export function extractSummary(entry) {
  const bodyMatch = entry.match(/\*\*DC-\d+:\s*([^*]+?)\*\*\s*(.*)/s);
  if (!bodyMatch) return '';
  const afterTitle = bodyMatch[2];
  const firstSentence = afterTitle.match(/^([^.]{20,200}\.)/);
  if (firstSentence) return firstSentence[1].trim();
  return afterTitle.slice(0, 140).trim();
}

export function isAlreadyStub(entry) {
  if (entry.includes('\n')) {
    const nonEmpty = entry.split('\n').filter(l => l.trim()).length;
    if (nonEmpty > 1) return false;
  }
  if (entry.length > 400) return false;
  if (!entry.match(/→\s*`?_memories\//)) return false;
  return true;
}

export function buildStub(dc, entryDateBacktick, units, fallbackTitle) {
  const unit = units.get(dc);
  if (!unit) return null;
  // Prefer the unit's H1 title; fall back to the title extracted from the
  // current PROJECT.md entry; finally a placeholder.
  const title = unit.title || fallbackTitle || '(see unit)';
  const status = unit.status !== 'active' ? ` (status: ${unit.status})` : '';
  return `- ${entryDateBacktick} — **DC-${dc}: ${title}** → \`_memories/${unit.filename}\`${status}`;
}

export function extractFallbackTitle(entryBlock, dc) {
  // Match the bold prefix `**DC-XX: <title>**` or `**DC-XX: <title>.**` in
  // the existing entry text. Title runs from after the colon to the first
  // closing `**` marker.
  const re = new RegExp(`\\*\\*DC-${dc}:\\s*([^*]+?)\\*\\*`);
  const m = entryBlock.match(re);
  if (!m) return null;
  return m[1].trim().replace(/\.$/, '');
}

export function compactDecisions(text, units) {
  const decIdx = text.indexOf(DECISIONS_HEADER);
  if (decIdx === -1) return { text, stats: { compacted: 0, skipped: 0, missing: 0 } };

  const lines = text.split('\n');
  const decLineIdx = lines.findIndex(l => l.includes(DECISIONS_HEADER));
  if (decLineIdx === -1) return { text, stats: { compacted: 0, skipped: 0, missing: 0 } };

  // Find end of §Decisions: first line after decLineIdx matching the risks header
  let endLineIdx = lines.length;
  for (let i = decLineIdx + 1; i < lines.length; i++) {
    if (RISKS_HEADER_PATTERN.test(lines[i])) {
      endLineIdx = i;
      break;
    }
  }

  let compacted = 0, skipped = 0, missing = 0;
  // Preserve everything before the §Decisions header verbatim.
  const newLines = lines.slice(0, decLineIdx);
  let i = decLineIdx;
  while (i < endLineIdx) {
    const line = lines[i];
    const m = line.match(/^- \`([^`]+)\`\s*—\s*\*?\*?DC-(\d+):/);
    if (!m) {
      newLines.push(line);
      i++;
      continue;
    }
    const entryDate = m[1];
    const dc = parseInt(m[2], 10);

    // Collect the entire entry — this line plus any lines until the next entry
    // (which starts with `- \`` at column 0) or blank-then-entry boundary.
    let j = i + 1;
    while (j < endLineIdx) {
      if (lines[j].match(/^- \`/) || RISKS_HEADER_PATTERN.test(lines[j])) break;
      j++;
    }
    const entryBlock = lines.slice(i, j).join('\n').trimEnd();

    if (isAlreadyStub(entryBlock)) {
      newLines.push(entryBlock);
      skipped++;
    } else {
      const fallbackTitle = extractFallbackTitle(entryBlock, dc);
      const stub = buildStub(dc, `\`${entryDate}\``, units, fallbackTitle);
      if (stub) {
        newLines.push(stub);
        compacted++;
      } else {
        newLines.push(entryBlock);
        missing++;
      }
    }
    // Preserve the blank line if there was one between entries
    if (j < endLineIdx && lines[j].trim() === '') {
      // We'll add a single blank line below in the join
    }
    newLines.push('');
    i = j;
    while (i < endLineIdx && lines[i].trim() === '') i++;
  }

  // Append everything from the risks header onward
  for (let k = endLineIdx; k < lines.length; k++) {
    newLines.push(lines[k]);
  }

  // Collapse triple-blank lines
  const joined = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: joined, stats: { compacted, skipped, missing } };
}

export function sectionSizes(text) {
  if (!text) return {};
  const lines = text.split('\n');
  const sizes = {};
  let currentName = null;
  let currentBytes = 0;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      if (currentName !== null) {
        sizes[currentName] = (sizes[currentName] || 0) + currentBytes;
      }
      currentName = m[1];
      currentBytes = 0;
    } else if (currentName !== null) {
      currentBytes += Buffer.byteLength(line + '\n', 'utf8');
    }
  }
  if (currentName !== null) {
    sizes[currentName] = (sizes[currentName] || 0) + currentBytes;
  }
  return sizes;
}

function formatSectionSizes(sizes) {
  const entries = Object.entries(sizes).sort((a, b) => b[1] - a[1]);
  return entries.map(([name, bytes]) => `  ${name.padEnd(24)} ${bytes.toString().padStart(8)} bytes`).join('\n');
}

export function main(argv) {
  const { positional, flags } = parseArgv(argv);
  const projectDir = positional ? resolve(positional) : resolve(process.cwd());
  const projectMd = join(projectDir, 'PROJECT.md');
  const memoriesDir = join(projectDir, '_memories');

  let text;
  try { text = readFileSync(projectMd, 'utf8'); } catch {
    process.stderr.write(`error: ${projectMd} not readable\n`);
    return 2;
  }

  if (flags.has('check')) {
    const size = Buffer.byteLength(text, 'utf8');
    const status = size > PROJECT_MD_CAP_BYTES ? 'OVER cap' : 'under cap';
    console.log(`PROJECT.md: ${size} bytes (${status}; cap ${PROJECT_MD_CAP_BYTES} bytes).`);
    return 0;
  }

  if (flags.has('section-sizes')) {
    const sizes = sectionSizes(text);
    const total = Buffer.byteLength(text, 'utf8');
    console.log(`PROJECT.md: ${total} bytes total. Section breakdown:`);
    console.log(formatSectionSizes(sizes));
    return 0;
  }

  let units;
  try { units = loadUnits(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} not readable\n`);
    return 2;
  }

  const before = Buffer.byteLength(text, 'utf8');
  const { text: newText, stats } = compactDecisions(text, units);
  const after = Buffer.byteLength(newText, 'utf8');
  const wrote = newText !== text;
  if (wrote) atomicWriteFileSync(projectMd, newText);

  const sizes = sectionSizes(newText);
  logEvent(projectDir, 'hygiene-log.jsonl', {
    kind: 'compact-project',
    before_bytes: before,
    after_bytes: after,
    delta_bytes: before - after,
    compacted: stats.compacted,
    skipped: stats.skipped,
    missing: stats.missing,
    section_sizes: sizes,
  });

  if (after > SOFT_TARGET_BYTES) {
    logEvent(projectDir, 'hygiene-log.jsonl', {
      kind: 'project-md-over-cap',
      bytes: after,
      soft_target: SOFT_TARGET_BYTES,
      hard_cap: SOFT_TARGET_BYTES,  // back-compat field name
      section_sizes: sizes,
    });
    process.stderr.write(
      `note: PROJECT.md is ${after} bytes (over soft target ${SOFT_TARGET_BYTES}). ` +
      `§Decisions compaction left ${after} bytes; demote-moves and §State narrative ` +
      `compaction (Phase 1c) handle the remaining sections. Advisory only — the script never refuses to write.\n`
    );
  }

  if (!wrote) {
    console.log(`No changes — §Decisions already compact (${after} bytes).`);
    return 0;
  }

  const delta = before - after;
  const pct = (delta / before * 100).toFixed(1);
  console.log(`PROJECT.md: ${before} → ${after} bytes (${delta > 0 ? '-' : '+'}${Math.abs(delta)} = ${pct}%)`);
  console.log(`§Decisions: ${stats.compacted} compacted, ${stats.skipped} already-stub, ${stats.missing} no-unit`);
  return 0;
}

// CLI entry guard. Set CORE_DEBUG_CLI_ENTRY=1 to log both strings if invocation
// silently no-ops (path-normalization, symlinks, OneDrive virtualization, etc.).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
