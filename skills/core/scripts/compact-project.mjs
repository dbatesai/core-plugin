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
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DECISIONS_HEADER = '**Decisions (dated, append-only):**';
export const RISKS_HEADER_PATTERN = /^\*\*Risks \(/;

export function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return [{}, text];
  const end = text.indexOf('\n---', 4);
  if (end === -1) return [{}, text];
  const raw = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const fm = {};
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    if (!line.includes(':')) continue;
    const colonIdx = line.indexOf(':');
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (v !== '') fm[k] = v;
  }
  return [fm, body];
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

function main(argv) {
  const projectDir = argv[0]
    ? resolve(argv[0])
    : resolve(process.cwd());
  const projectMd = join(projectDir, 'PROJECT.md');
  const memoriesDir = join(projectDir, '_memories');

  let text;
  try { text = readFileSync(projectMd, 'utf8'); } catch {
    process.stderr.write(`error: ${projectMd} not readable\n`);
    return 2;
  }
  let units;
  try { units = loadUnits(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} not readable\n`);
    return 2;
  }

  const before = Buffer.byteLength(text, 'utf8');
  const { text: newText, stats } = compactDecisions(text, units);
  const after = Buffer.byteLength(newText, 'utf8');

  if (newText === text) {
    console.log(`No changes — §Decisions already compact (${after} bytes).`);
    return 0;
  }

  writeFileSync(projectMd, newText);
  const delta = before - after;
  const pct = (delta / before * 100).toFixed(1);
  console.log(`PROJECT.md: ${before} → ${after} bytes (${delta > 0 ? '-' : '+'}${Math.abs(delta)} = ${pct}%)`);
  console.log(`§Decisions: ${stats.compacted} compacted, ${stats.skipped} already-stub, ${stats.missing} no-unit`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
