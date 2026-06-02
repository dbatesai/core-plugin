/**
 * Regenerate <project>/_memories/INDEX-risks.md from risk-*.md units.
 *
 * Walks `<project>/_memories/risk-*.md` (top-level only — archived risks in
 * `_memories/archive/` stay out of the index), parses frontmatter for
 * id / status / date, pulls the H1 line from the body as the summary, sorts
 * numeric ids first then alphabetic, writes the markdown table.
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs \
 *       <project>/_memories/
 *   node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs \
 *       --store <project>/_memories/
 */

import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';

export const RISK_NUMERIC = /^risk-(\d+)-.+\.md$/;
export const RISK_NAMED = /^risk-([a-z][a-z0-9-]*)\.md$/;
export const SUMMARY_MAX = 100;

// M1: delegates to the shared flat parser (was a local copy). Export kept for the callsite.
export function parseFrontmatter(text) {
  return parseFlatFrontmatter(text);
}

// M12: a `|` in any cell value splits the markdown table row and corrupts the substring
// check-units index-drift detection relies on. Escape pipes + flatten newlines per cell.
export function escapeCell(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
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
  const numeric = [];
  const named = [];
  for (const fname of readdirSync(memoriesDir).sort()) {
    const mNum = fname.match(RISK_NUMERIC);
    const mName = fname.match(RISK_NAMED);
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
    if (mNum) {
      numeric.push({ ...row, sortKey: parseInt(mNum[1], 10) });
    } else {
      named.push(row);
    }
  }
  numeric.sort((a, b) => a.sortKey - b.sortKey);
  named.sort((a, b) => a.id.localeCompare(b.id));
  const rows = [...numeric, ...named];

  const lines = [
    '# Risks Index',
    '',
    '> Auto-generated from `_memories/risk-*.md` frontmatter (flat layout per DC-68).',
    '> Do not edit manually — re-run `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs`',
    '> to regenerate. Script ships with the plugin per DC-77.',
    '',
    `**${rows.length} risks indexed.**`,
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

export function parseStoreArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--store') return argv[i + 1];
    if (!argv[i].startsWith('--')) return argv[i];
  }
  return null;
}

export function main(argv) {
  const storeArg = parseStoreArg(argv);
  const memoriesDir = storeArg
    ? resolveMemoriesDir(storeArg)
    : resolve(process.cwd(), '_memories');

  try { readdirSync(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} is not a directory\n`);
    return 2;
  }

  const indexPath = join(memoriesDir, 'INDEX-risks.md');
  const content = buildIndex(memoriesDir);
  writeFileSync(indexPath, content);
  console.log(`Wrote ${indexPath}`);
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
