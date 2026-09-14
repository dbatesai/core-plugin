/**
 * Regenerate <project>/_memories/INDEX-<kind>.md from one unit family.
 *
 *   --kind decisions   walks `dc-*.md`   → INDEX-decisions.md
 *   --kind risks       walks `risk-*.md` → INDEX-risks.md
 *
 * Top-level units only — archived units in `_memories/archive/` stay out of the
 * index. Parses frontmatter for id / status / date, pulls the H1 line from the
 * body as the summary, sorts numeric ids first (by number) then named ids
 * (alphabetic), and writes the markdown table atomically. The per-kind facts —
 * file pattern, index filename, title, noun — live in the KINDS table; nothing
 * else differs between the families.
 *
 * By design the script ships with the plugin (not per-project); Node.js (.mjs)
 * only, zero dependencies.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-unit-index.mjs --kind decisions [<project>/_memories/]
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-unit-index.mjs --kind risks --store <project>
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { truncate as sharedTruncate } from './text-truncate.mjs';
import { isCliEntry } from './cli-entry.mjs';

export const KINDS = {
  decisions: { numeric: /^dc-(\d+)-.+\.md$/, named: /^dc-([a-z][a-z0-9-]*)\.md$/, glob: 'dc-*.md', index: 'INDEX-decisions.md', title: 'Decisions Index', noun: 'decisions' },
  risks: { numeric: /^risk-(\d+)-.+\.md$/, named: /^risk-([a-z][a-z0-9-]*)\.md$/, glob: 'risk-*.md', index: 'INDEX-risks.md', title: 'Risks Index', noun: 'risks' },
};
export const SUMMARY_MAX = 100;

export function kindOrThrow(kind) {
  const k = KINDS[kind];
  if (!k) throw new Error(`generate-unit-index: unknown kind "${kind}" (expected one of ${Object.keys(KINDS).join(', ')})`);
  return k;
}

// Delegates to the shared flat parser. Export kept for the callsite.
export function parseFrontmatter(text) {
  return parseFlatFrontmatter(text);
}

// A `|` in any cell value (an H1 like "DC-NN: A | B") splits the markdown table
// row and corrupts the substring check-units index-drift detection relies on.
// Escape pipes and backslashes, flatten any stray newline, so each value stays
// one well-formed cell.
export function escapeCell(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
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

// Delegates to the shared surrogate-safe helper — see text-truncate.mjs for why
// truncation lives in one shared helper instead of per-script copies.
export function truncate(text, maxLen = SUMMARY_MAX) {
  return sharedTruncate(text, maxLen);
}

export function buildIndex(memoriesDir, kind) {
  const k = kindOrThrow(kind);
  const numeric = [];
  const named = [];
  for (const fname of readdirSync(memoriesDir).sort()) {
    const mNum = fname.match(k.numeric);
    const mName = fname.match(k.named);
    if (!mNum && !mName) continue;
    let text;
    try { text = readFileSync(join(memoriesDir, fname), 'utf8'); } catch { continue; }
    const [fm, body] = parseFrontmatter(text);
    const row = {
      id: fm.id || fname.replace(/\.md$/, ''),
      date: bestDate(fm),
      status: fm.status || 'unknown',
      summary: truncate(extractSummary(body)),
    };
    if (mNum) numeric.push({ ...row, sortKey: parseInt(mNum[1], 10) });
    else named.push(row);
  }
  numeric.sort((a, b) => a.sortKey - b.sortKey);
  named.sort((a, b) => a.id.localeCompare(b.id));
  const rows = [...numeric, ...named];

  const lines = [
    `# ${k.title}`,
    '',
    `> Auto-generated from \`_memories/${k.glob}\` frontmatter (flat layout by convention).`,
    `> Do not edit manually — re-run \`\${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-unit-index.mjs --kind ${kind}\``,
    '> to regenerate. Script ships with the plugin.',
    '',
    `**${rows.length} ${k.noun} indexed.**`,
    '',
    '| ID | Date | Status | Summary |',
    '|---|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${escapeCell(r.id)} | ${escapeCell(r.date)} | ${escapeCell(r.status)} | ${escapeCell(r.summary)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

export function resolveMemoriesDir(input) {
  const candidate = resolve(input);
  if (candidate.endsWith('/_memories') || candidate.endsWith('\\_memories')) return candidate;
  try {
    const stat = readdirSync(join(candidate, '_memories'));
    if (stat) return join(candidate, '_memories');
  } catch { /* no _memories subdir — caller passed _memories itself or a wrong path */ }
  return candidate;
}

export function parseArgs(argv) {
  let kind = null; let store = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kind') { kind = argv[++i]; continue; }
    if (argv[i] === '--store') { store = argv[++i]; continue; }
    if (!argv[i].startsWith('--') && store === null) store = argv[i];
  }
  return { kind, store };
}

export function main(argv) {
  const { kind, store } = parseArgs(argv);
  if (!kind || !KINDS[kind]) {
    process.stderr.write(`generate-unit-index: pass --kind ${Object.keys(KINDS).join('|')}\n`);
    return 2;
  }
  const memoriesDir = store ? resolveMemoriesDir(store) : resolve(process.cwd(), '_memories');

  try { readdirSync(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} is not a directory\n`);
    return 2;
  }

  const indexPath = join(memoriesDir, KINDS[kind].index);
  const content = buildIndex(memoriesDir, kind);
  // Atomic write: a crash mid-write leaves a truncated index, and check-units
  // reads its substring form for drift detection — a half-written index would
  // read as drift. Atomic replace means the reader sees the old or the new file.
  atomicWriteFileSync(indexPath, content);
  console.log(`Wrote ${indexPath}`);
  return 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
