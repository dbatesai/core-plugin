#!/usr/bin/env node
/**
 * generate-memory-index.mjs
 *
 * Rewrites the "## Top project units" section of MEMORY.md from priority.mjs
 * ranking output. Preserves all other sections verbatim. Preserves existing
 * one-line descriptions for units that remain in top-N; falls back to the
 * first H1 of the unit body for newly-promoted units.
 *
 * Usage:
 *   node generate-memory-index.mjs <project>/_memories \
 *        --memory-md <path-to-MEMORY.md> \
 *        [--top N] [--today YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { iterUnits, score } from './priority.mjs';

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

function todayFromArg(arg) {
  if (arg) {
    const [y, m, d] = arg.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function renderPriorityBlock({ memoriesDir, memoryMdPath, topN, today, existingDescriptions }) {
  const ranked = iterUnits(memoriesDir).map(u => [score(u, [], today), u]);
  ranked.sort((a, b) => b[0] - a[0]);
  const top = ranked.slice(0, topN);

  const memoryDir = dirname(memoryMdPath);
  const dateStr = today.toISOString().slice(0, 10);

  const lines = [`## Top project units (refreshed from priority.mjs --top ${topN}, ${dateStr})`, ''];
  for (const [, u] of top) {
    const relPath = relative(memoryDir, String(u.path));
    let desc = existingDescriptions.get(u.id);
    if (!desc) {
      try {
        desc = extractH1(readFileSync(u.path, 'utf8'));
      } catch {
        desc = FALLBACK_DESCRIPTION;
      }
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
    throw new Error('Could not find "## Top project units" section in MEMORY.md');
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  // Strip trailing blank lines from the new section; preserve following structure
  const newLines = newSection.split('\n');
  while (newLines.length && newLines[newLines.length - 1] === '') newLines.pop();
  const trailingBlank = endIdx < lines.length ? [''] : [];
  return [
    ...lines.slice(0, startIdx),
    ...newLines,
    ...trailingBlank,
    ...lines.slice(endIdx),
  ].join('\n');
}

export function main(argv) {
  let memoriesDirArg = null;
  let memoryMdPath = null;
  let topN = 30;
  let todayArg = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--memory-md') memoryMdPath = argv[++i];
    else if (a === '--top') topN = parseInt(argv[++i], 10);
    else if (a === '--today') todayArg = argv[++i];
    else if (!a.startsWith('--')) memoriesDirArg = a;
  }

  if (!memoriesDirArg || !memoryMdPath) {
    process.stderr.write('usage: generate-memory-index.mjs <project>/_memories --memory-md <path> [--top N] [--today YYYY-MM-DD]\n');
    return 2;
  }

  const memoriesDir = resolve(memoriesDirArg);
  memoryMdPath = resolve(memoryMdPath);
  const today = todayFromArg(todayArg);

  const oldText = readFileSync(memoryMdPath, 'utf8');
  const existingDescriptions = parseExistingDescriptions(oldText);
  const newSection = renderPriorityBlock({
    memoriesDir, memoryMdPath, topN, today, existingDescriptions,
  });
  const newText = spliceSection(oldText, newSection);

  if (newText === oldText) {
    process.stderr.write(`No change: priority block already current (${topN} units, ${today.toISOString().slice(0, 10)})\n`);
    return 0;
  }

  writeFileSync(memoryMdPath, newText);
  process.stderr.write(`Rewrote priority block in ${memoryMdPath} (${topN} units)\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
const _argv1 = _canon(process.argv[1]);
const _self = _canon(new URL(import.meta.url).pathname);
if (process.env.CORE_DEBUG_CLI_ENTRY === '1') {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_argv1)} self=${JSON.stringify(_self)} match=${_argv1 === _self}\n`);
}
if (_argv1 === _self) {
  process.exit(main(process.argv.slice(2)));
}
