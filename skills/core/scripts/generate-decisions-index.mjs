/**
 * Regenerate <project>/_memories/INDEX-decisions.md from dc-*.md units.
 *
 * Walks `<project>/_memories/dc-*.md` (top-level only — archived units in
 * `_memories/archive/` stay out of the index), parses frontmatter for
 * id / status / date, pulls the H1 line from the body as the summary, sorts
 * by the numeric DC id, and writes the markdown table.
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs \
 *       <project>/_memories/
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DC_PATTERN = /^dc-(\d+)-.+\.md$/;
export const SUMMARY_MAX = 100;

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

export function extractSummary(body) {
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s.startsWith('# ')) return s.slice(2).trim();
  }
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('#')) return s;
  }
  return '';
}

export function bestDate(fm) {
  for (const key of ['updated', 'created', 'date']) {
    if (fm[key]) return String(fm[key]).slice(0, 10);
  }
  return 'unknown';
}

export function truncate(text, maxLen = SUMMARY_MAX) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).trimEnd() + '…';
}

export function buildIndex(memoriesDir) {
  const rows = [];
  for (const fname of readdirSync(memoriesDir).sort()) {
    const m = fname.match(DC_PATTERN);
    if (!m) continue;
    let text;
    try { text = readFileSync(join(memoriesDir, fname), 'utf8'); } catch { continue; }
    const [fm, body] = parseFrontmatter(text);
    rows.push({
      sortKey: parseInt(m[1], 10),
      id: fm.id || fname.replace(/\.md$/, ''),
      date: bestDate(fm),
      status: fm.status || 'unknown',
      summary: truncate(extractSummary(body)),
    });
  }
  rows.sort((a, b) => a.sortKey - b.sortKey);

  const lines = [
    '# Decisions Index',
    '',
    '> Auto-generated from `_memories/dc-*.md` frontmatter (flat layout per DC-68).',
    '> Do not edit manually — re-run `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs`',
    '> to regenerate. Script ships with the plugin per DC-77.',
    '',
    `**${rows.length} decisions indexed.**`,
    '',
    '| ID | Date | Status | Summary |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.id} | ${r.date} | ${r.status} | ${r.summary} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function main(argv) {
  const memoriesDir = argv[0]
    ? resolve(argv[0])
    : resolve(process.cwd(), '_memories');

  try { readdirSync(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} is not a directory\n`);
    return 2;
  }

  const indexPath = join(memoriesDir, 'INDEX-decisions.md');
  const content = buildIndex(memoriesDir);
  writeFileSync(indexPath, content);
  console.log(`Wrote ${indexPath}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
