/**
 * generate-summary-index.mjs — build <store>/_memories/_lib/unit-summaries.json,
 * one compact { id, summary, topics, status, updated } record per ACTIVE unit.
 *
 * The shared compact index behind DC-94a retrieval (retrieve-context.mjs) and the
 * DC-94b abstract-relevance prototype (select-relevant-units.mjs). One responsibility:
 * render the index. No scoring, no retrieval — those read this file.
 *
 * Parser choice (DC-94a, deviates from the build plan on purpose): the plan named
 * frontmatter-flat.mjs, but that flat parser silently DROPS multi-line `topics:` lists
 * (it skips every indented line). topics is load-bearing for the downstream retrieval
 * scorers, so this uses priority.mjs's canonical parseFrontmatter via loadUnit, which
 * parses lists. The flat parser would have shipped an index with empty topics.
 *
 * Per DC-77 the script ships with the plugin. Per DC-80 the plugin ships .mjs only.
 *
 * CLI:
 *   node generate-summary-index.mjs <storePath>
 *   node generate-summary-index.mjs --store <storePath>
 */

import { readdirSync, statSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadUnit } from './priority.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const SUMMARY_MAX = 240;

// First `# ` heading stripped, else first non-blank non-heading line. Mirrors
// generate-decisions-index.mjs extractSummary so the index reads the same shape.
export function deriveSummary(body) {
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s.startsWith('# ')) return s.slice(2).trim();
  }
  for (const line of body.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('#') && !s.startsWith('---')) return s;
  }
  return '';
}

function truncate(text, maxLen = SUMMARY_MAX) {
  const t = String(text ?? '');
  return t.length <= maxLen ? t : t.slice(0, maxLen - 1).trimEnd() + '…';
}

// Active = status missing or literally 'active'. Anything else (retired, archived,
// superseded, cold) is excluded from the retrieval surface.
function isActive(fm) {
  const s = fm.status === undefined || fm.status === null ? 'active' : String(fm.status).trim().toLowerCase();
  return s === 'active' || s === '';
}

function asTopicList(topics) {
  if (Array.isArray(topics)) return topics.map(String);
  if (topics === undefined || topics === null || topics === '') return [];
  return [String(topics)];
}

export function generateSummaryIndex(storePath) {
  const memoriesDir = join(resolve(storePath), '_memories');
  const units = [];
  let entries;
  try {
    entries = readdirSync(memoriesDir);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (name.startsWith('_') || name.startsWith('INDEX')) continue; // skip _lib, _validation, indexes
    const full = join(memoriesDir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    let unit;
    try { unit = loadUnit(full); } catch { continue; }
    const fm = unit.fm || {};
    if (!isActive(fm)) continue;
    units.push({
      id: unit.id,
      summary: truncate(deriveSummary(unit.body || '')),
      topics: asTopicList(fm.topics),
      status: fm.status === undefined ? 'active' : String(fm.status),
      updated: fm.updated ? String(fm.updated).slice(0, 10) : (fm.created ? String(fm.created).slice(0, 10) : ''),
    });
  }
  units.sort((a, b) => a.id.localeCompare(b.id));
  const out = { count: units.length, generated: '', units };

  const libDir = join(memoriesDir, '_lib');
  try { mkdirSync(libDir, { recursive: true }); } catch { /* ignore */ }
  atomicWriteFileSync(join(libDir, 'unit-summaries.json'), JSON.stringify(out, null, 2) + '\n');
  return out;
}

function main(argv) {
  const args = argv.filter(a => a !== '--store');
  const storePath = args[0] || '.';
  const res = generateSummaryIndex(storePath);
  console.log(`Wrote ${join(resolve(storePath), '_memories', '_lib', 'unit-summaries.json')} (${res.count} active units)`);
  return 0;
}

// CLI entry guard (matches generate-decisions-index.mjs). CORE_DEBUG_CLI_ENTRY=1 logs both
// resolved paths if the invocation silently no-ops (symlink/OneDrive path-normalization).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
