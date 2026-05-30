#!/usr/bin/env node
/**
 * hot-section.mjs — manage the rendered hot section atop <project>/PROJECT.md.
 *
 * Phase 1a of the DC-85 memory architecture redesign. The hot section is a
 * short (target 5-7 lines, hard cap enforced in Phase 1b) agent-composed
 * synthesis of what matters right now. The priority function surfaces
 * candidates; the agent composes the prose; this script handles file plumbing.
 *
 * Subcommands:
 *
 *   hot-section.mjs candidates <project> [--top N] [--json] [--session-topic <t>]*
 *       List top-N priority candidates for the synthesis pass.
 *
 *   hot-section.mjs apply <project> --text "..." | --file <path>
 *       Write or replace the hot section in PROJECT.md (idempotent).
 *
 *   hot-section.mjs current <project>
 *       Print the current hot-section body (empty if none).
 *
 *   hot-section.mjs clear <project>
 *       Remove the hot section. No-op when absent.
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterUnits, score } from './priority.mjs';
import { logEvent } from './log-event.mjs';

export const HOT_BEGIN = '<!-- HOT-SECTION:BEGIN -->';
export const HOT_END = '<!-- HOT-SECTION:END -->';
export const HOT_HEADING = '## Right now';
export const DEFAULT_CANDIDATE_COUNT = 12;

// Phase 1b — token budget enforcement.
// DC-85 R1 caps the hot tier at 500 tokens. Char-to-token factor 0.30 matches
// the convention shared with compact-project.mjs's PROJECT_MD_CAP_BYTES math.
export const HOT_SECTION_TOKEN_BUDGET = 500;
export const TOKENS_PER_BYTE = 0.30;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(String(text), 'utf8') * TOKENS_PER_BYTE);
}

// ---------- File plumbing ----------

function readProjectMd(projectDir) {
  const path = join(projectDir, 'PROJECT.md');
  try {
    return { path, text: readFileSync(path, 'utf8') };
  } catch (e) {
    throw new Error(`PROJECT.md not readable at ${path}: ${e.message}`);
  }
}

function findExistingBlock(text) {
  const beginIdx = text.indexOf(HOT_BEGIN);
  const endIdx = text.indexOf(HOT_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) return null;
  // Inclusive of trailing newline after the end marker, so replacement is clean.
  let blockEnd = endIdx + HOT_END.length;
  while (blockEnd < text.length && text[blockEnd] === '\n') blockEnd++;
  return { start: beginIdx, end: blockEnd };
}

function renderBlock(text, timestamp) {
  const trimmed = String(text || '').trim();
  return `${HOT_BEGIN}\n${HOT_HEADING}\n\n${trimmed}\n\n*Synthesized ${timestamp}*\n${HOT_END}\n\n`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// ---------- Public API ----------

export function applyHotSection(projectDir, text, { now, allowOverBudget = false } = {}) {
  const tokens = estimateTokens(text);
  if (tokens > HOT_SECTION_TOKEN_BUDGET && !allowOverBudget) {
    logEvent(projectDir, 'retrieval-log.jsonl', {
      kind: 'hot-section-over-budget',
      tokens,
      budget: HOT_SECTION_TOKEN_BUDGET,
    });
    const err = new Error(
      `Hot section over budget: ${tokens} tokens > ${HOT_SECTION_TOKEN_BUDGET}. ` +
      `Recompose with fewer/shorter paragraphs, or pass { allowOverBudget: true } as an escape hatch.`
    );
    err.code = 'HOT_SECTION_OVER_BUDGET';
    err.tokens = tokens;
    err.budget = HOT_SECTION_TOKEN_BUDGET;
    throw err;
  }

  const { path, text: original } = readProjectMd(projectDir);
  const block = renderBlock(text, now || nowIso());
  const existing = findExistingBlock(original);
  let updated;
  if (existing) {
    updated = original.slice(0, existing.start) + block + original.slice(existing.end);
  } else {
    // Insert before the first `## What & Why` heading. If that's missing,
    // append the block to the end (defensive — unusual but well-defined).
    const insertAt = original.indexOf('## What & Why');
    if (insertAt === -1) {
      updated = original.endsWith('\n') ? original + '\n' + block : original + '\n\n' + block;
    } else {
      updated = original.slice(0, insertAt) + block + original.slice(insertAt);
    }
  }
  if (updated !== original) writeFileSync(path, updated);
  logEvent(projectDir, 'retrieval-log.jsonl', {
    kind: 'hot-section-synthesis',
    tokens,
    budget: HOT_SECTION_TOKEN_BUDGET,
    over_budget: tokens > HOT_SECTION_TOKEN_BUDGET,
    applied: updated !== original,
  });
  return updated;
}

export function currentHotSection(projectDir) {
  const { text } = readProjectMd(projectDir);
  const block = findExistingBlock(text);
  if (!block) return '';
  const inner = text.slice(text.indexOf(HOT_BEGIN) + HOT_BEGIN.length, text.indexOf(HOT_END));
  // Strip the `## Right now` heading and the `*Synthesized ...*` footer to
  // return just the composed body.
  return inner
    .replace(new RegExp(`^\\s*${HOT_HEADING}\\s*`), '')
    .replace(/\n\s*\*Synthesized [^*]+\*\s*$/, '')
    .trim();
}

export function clearHotSection(projectDir) {
  const { path, text: original } = readProjectMd(projectDir);
  const existing = findExistingBlock(original);
  if (!existing) return original;
  const updated = original.slice(0, existing.start) + original.slice(existing.end);
  if (updated !== original) writeFileSync(path, updated);
  return updated;
}

export function candidatesForSynthesis(projectDir, { top = DEFAULT_CANDIDATE_COUNT, sessionTopics = [], today = null } = {}) {
  const memoriesDir = join(projectDir, '_memories');
  let units;
  try { units = iterUnits(memoriesDir); } catch { return []; }
  if (!Array.isArray(units) || units.length === 0) return [];

  const scored = units
    .filter(u => {
      const status = String(u.fm.status || '').toLowerCase();
      return !status || status === 'active';
    })
    .map(u => {
      const s = score(u, sessionTopics, today);
      return {
        id: String(u.fm.id || basename(u.path, '.md')),
        type: String(u.fm.type || ''),
        score: Number(s.toFixed(4)),
        topics: Array.isArray(u.fm.topics) ? u.fm.topics.slice() : [],
        updated: u.fm.updated ? String(u.fm.updated) : '',
        title: extractTitle(u),
        path: u.path,
      };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, top);
}

function extractTitle(unit) {
  if (typeof unit.body !== 'string') return '';
  const lines = unit.body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Strip leading `#` heading marks if present
    const noHash = line.replace(/^#+\s*/, '').trim();
    if (noHash) {
      // Cap at ~140 chars to keep candidate output tidy
      return noHash.length > 140 ? noHash.slice(0, 137) + '...' : noHash;
    }
  }
  return '';
}

// ---------- CLI ----------

function parseArgs(argv) {
  // First positional after the subcommand is the project dir.
  const out = { flags: new Map(), positionals: [] };
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out.flags.set(key, true); i++; continue; }
      // Allow --session-topic to repeat
      if (key === 'session-topic') {
        const arr = out.flags.get(key);
        if (Array.isArray(arr)) arr.push(next);
        else out.flags.set(key, [next]);
      } else {
        out.flags.set(key, next);
      }
      i += 2;
    } else {
      out.positionals.push(tok);
      i++;
    }
  }
  return out;
}

function resolveProjectDir(positional) {
  return positional ? resolve(positional) : resolve(process.cwd());
}

function loadText(flags) {
  if (flags.has('text')) return String(flags.get('text'));
  if (flags.has('file')) return readFileSync(String(flags.get('file')), 'utf8');
  // Read from stdin (best-effort sync) when neither --text nor --file provided.
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw && raw.trim()) return raw;
  } catch {}
  return '';
}

function cmdCandidates(args) {
  const projectDir = resolveProjectDir(args.positionals[0]);
  const top = args.flags.has('top') ? Number(args.flags.get('top')) : DEFAULT_CANDIDATE_COUNT;
  const sessionTopics = args.flags.has('session-topic') ? args.flags.get('session-topic') : [];
  const cands = candidatesForSynthesis(projectDir, { top, sessionTopics });
  if (args.flags.has('json')) {
    process.stdout.write(JSON.stringify(cands, null, 2) + '\n');
    return 0;
  }
  if (cands.length === 0) {
    process.stdout.write('(no candidates — _memories/ is empty or unreadable)\n');
    return 0;
  }
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const topicStr = c.topics.length ? c.topics.join(', ') : '(none)';
    process.stdout.write(`[${i + 1}] ${c.id} — ${c.type}, score=${c.score}\n`);
    if (c.title) process.stdout.write(`    ${c.title}\n`);
    process.stdout.write(`    topics: ${topicStr}; updated: ${c.updated || '(unknown)'}\n\n`);
  }
  return 0;
}

function cmdApply(args) {
  const projectDir = resolveProjectDir(args.positionals[0]);
  const text = loadText(args.flags);
  if (!text || !text.trim()) {
    process.stderr.write('error: no synthesis text provided (use --text "..." or --file PATH, or pipe to stdin)\n');
    return 2;
  }
  applyHotSection(projectDir, text);
  process.stdout.write(`PROJECT.md: hot section applied (${text.trim().split('\n').length} lines).\n`);
  return 0;
}

function cmdCurrent(args) {
  const projectDir = resolveProjectDir(args.positionals[0]);
  const cur = currentHotSection(projectDir);
  if (cur) process.stdout.write(cur + '\n');
  return 0;
}

function cmdClear(args) {
  const projectDir = resolveProjectDir(args.positionals[0]);
  const before = readProjectMd(projectDir).text;
  clearHotSection(projectDir);
  const after = readProjectMd(projectDir).text;
  if (before === after) process.stdout.write('No hot section present; nothing to clear.\n');
  else process.stdout.write('PROJECT.md: hot section cleared.\n');
  return 0;
}

export function main(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const args = parseArgs(rest);
  switch (sub) {
    case 'candidates': return cmdCandidates(args);
    case 'apply':      return cmdApply(args);
    case 'current':    return cmdCurrent(args);
    case 'clear':      return cmdClear(args);
    default:
      process.stderr.write(`error: unknown subcommand '${sub}'\n`);
      process.stderr.write(USAGE);
      return 2;
  }
}

const USAGE = `Usage:
  hot-section.mjs candidates <project> [--top N] [--json] [--session-topic <t>]*
  hot-section.mjs apply      <project> --text "..." | --file <path> | (stdin)
  hot-section.mjs current    <project>
  hot-section.mjs clear      <project>
`;

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
