/**
 * check-inbox.mjs — mechanical pre-flight for inbox.md graduation blocks.
 *
 * The source-registration framework (§4) lands Mode B/C observation blocks in
 * <project>/inbox.md as standalone frontmatter+body blocks. Graduating them is
 * agent-behavioral (process-memory Step 1); this script is the mechanical half:
 * it validates block STRUCTURE so a malformed extractor write is caught before
 * any judgment work, and gives high-volume extractors a pass/fail signal at
 * write time. Read-only — it never graduates, moves, or edits anything.
 *
 * Checks per mode-tagged block (a block whose frontmatter carries `mode`):
 *   FAIL required-field   — any of id/type/status/source/extracted-at/confidence-level missing
 *   FAIL mode-value       — mode not B or C
 *   FAIL judgment-needed  — Mode C without judgment-needed
 *   FAIL confidence-value — confidence-level not sourced|inferred|reconstructed
 *   FAIL graduation-field — ratified `stability-class` present (extractors set only
 *                           `proposed-stability-class`; ratification is graduation's job)
 *   FAIL duplicate-id     — same id on two inbox blocks
 *   WARN status-active    — extractor pre-set status: active (Mode B/C land draft/pending)
 *   WARN judgment-on-b    — judgment-needed on a Mode B block (B is routine confirmation)
 *   WARN id-collision     — id already names a unit in the project store
 *   WARN empty-body       — frontmatter with no body prose
 *   WARN sourced-without-anchor — confidence-level: sourced but the body has no verbatim
 *                           quote or source locator (timestamp, page/section, msg-id/date)
 *   INFO untagged-block   — frontmatter block without `mode` (legacy classify path)
 *
 * The script ships with the plugin. Node.js (.mjs) only.
 *
 * CLI:
 *   node check-inbox.mjs <project-path> [--json]
 *
 * Exit codes: 0 = pass, 1 = warnings, 2 = failures, 3 = setup error.
 * A missing or empty inbox.md is a pass — nothing to check.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VALID_MODES = new Set(['B', 'C']);
export const VALID_CONFIDENCE = new Set(['sourced', 'inferred', 'reconstructed']);
export const REQUIRED_BLOCK_FIELDS = ['id', 'type', 'status', 'source', 'extracted-at', 'confidence-level'];
export const GRADUATION_ONLY_FIELDS = ['stability-class'];

// A verbatim quoted span (curly or straight quotes, 8+ chars) or a locator into the
// cited source: transcript timestamp, doc page/section, chat msg-id, or a date.
const SOURCE_ANCHOR_PATTERNS = [
  /"[^"]{8,}"/,
  /“[^”]{8,}”/,
  /^\s*>/m,
  /\b\d{1,2}:\d{2}(:\d{2})?\b/,
  /\bp{1,2}\.\s*\d+\b/i,
  /§\s*\d+/,
  /\bline\s+\d+\b/i,
  /\bmsg[-_]?id\b/i,
  /\bmessage\s*#?\d+\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
];

/** True if the body carries a verbatim quote or a locator into the cited source. */
export function hasSourceAnchor(body) {
  const text = String(body || '');
  return SOURCE_ANCHOR_PATTERNS.some((re) => re.test(text));
}

/** Parse inbox.md into { fm, body, line } blocks. Flat key: value frontmatter only. */
export function parseInboxBlocks(content) {
  const lines = String(content).split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() !== '---') { i++; continue; }
    const fmStart = i + 1;
    let j = fmStart;
    while (j < lines.length && lines[j].trim() !== '---') j++;
    if (j >= lines.length) break; // unterminated fence — not a block
    const fmLines = lines.slice(fmStart, j);
    if (!fmLines.some((l) => /^[A-Za-z0-9_-]+\s*:/.test(l))) { i = j + 1; continue; }
    const fm = {};
    for (const raw of fmLines) {
      const m = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
    let k = j + 1;
    const body = [];
    while (k < lines.length && lines[k].trim() !== '---') { body.push(lines[k]); k++; }
    blocks.push({ fm, body: body.join('\n').trim(), line: fmStart });
    i = k;
  }
  return blocks;
}

/** Collect unit-id stems already in the project store (top level + observations/). */
export function existingUnitIds(projectDir) {
  const ids = new Set();
  const roots = [join(projectDir, '_memories')];
  while (roots.length) {
    const dir = roots.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === '_validation') continue;
        roots.push(join(dir, e.name));
      } else if (e.name.endsWith('.md')) {
        ids.add(basename(e.name, '.md'));
      }
    }
  }
  return ids;
}

/** Validate <project>/inbox.md. Returns a report array of {level, check, block_id, detail}. */
export function checkInbox(projectDir) {
  const report = [];
  const inboxPath = join(projectDir, 'inbox.md');
  if (!existsSync(inboxPath)) return report;
  const content = readFileSync(inboxPath, 'utf8');
  if (!content.trim()) return report;

  const blocks = parseInboxBlocks(content);
  const storeIds = existingUnitIds(projectDir);
  const seenIds = new Map();

  blocks.forEach((b, idx) => {
    const bid = b.fm.id || `block-${idx + 1}@line-${b.line}`;

    if (!('mode' in b.fm)) {
      report.push({ level: 'INFO', check: 'untagged-block', block_id: bid, detail: 'Frontmatter block without `mode` — routes through the legacy classify path, not Mode B/C graduation' });
      return;
    }

    for (const fld of REQUIRED_BLOCK_FIELDS) {
      if (!(fld in b.fm) || b.fm[fld] === '') {
        report.push({ level: 'FAIL', check: 'required-field', block_id: bid, detail: `Missing required draft field: '${fld}'` });
      }
    }

    const mode = String(b.fm.mode).trim().toUpperCase();
    if (!VALID_MODES.has(mode)) {
      report.push({ level: 'FAIL', check: 'mode-value', block_id: bid, detail: `mode '${b.fm.mode}' is not B or C` });
    } else if (mode === 'C' && !String(b.fm['judgment-needed'] || '').trim()) {
      report.push({ level: 'FAIL', check: 'judgment-needed', block_id: bid, detail: 'Mode C block requires judgment-needed naming the question for the user' });
    } else if (mode === 'B' && String(b.fm['judgment-needed'] || '').trim()) {
      report.push({ level: 'WARN', check: 'judgment-on-b', block_id: bid, detail: 'judgment-needed on a Mode B block — B is routine confirmation; reclassify as C or drop the field' });
    }

    const conf = String(b.fm['confidence-level'] || '').trim().toLowerCase();
    if (conf && !VALID_CONFIDENCE.has(conf)) {
      report.push({ level: 'FAIL', check: 'confidence-value', block_id: bid, detail: `confidence-level '${b.fm['confidence-level']}' not in: ${[...VALID_CONFIDENCE].join(', ')}` });
    } else if (conf === 'sourced' && !hasSourceAnchor(b.body)) {
      report.push({ level: 'WARN', check: 'sourced-without-anchor', block_id: bid, detail: "confidence-level: sourced but no verbatim quote or source locator (timestamp, page/section, msg-id, date) in the body — add one or drop to 'inferred'" });
    }

    for (const fld of GRADUATION_ONLY_FIELDS) {
      if (fld in b.fm) {
        report.push({ level: 'FAIL', check: 'graduation-field', block_id: bid, detail: `'${fld}' is set at graduation, not by the extractor — use 'proposed-${fld}'` });
      }
    }

    if (String(b.fm.status || '').trim().toLowerCase() === 'active') {
      report.push({ level: 'WARN', check: 'status-active', block_id: bid, detail: "Inbox blocks land as draft/pending; 'active' is stamped at graduation" });
    }

    if (b.fm.id) {
      if (seenIds.has(b.fm.id)) {
        report.push({ level: 'FAIL', check: 'duplicate-id', block_id: bid, detail: `id also used by block ${seenIds.get(b.fm.id)}` });
      }
      seenIds.set(b.fm.id, idx + 1);
      if (storeIds.has(b.fm.id) || storeIds.has(`obs-${b.fm.id}`)) {
        report.push({ level: 'WARN', check: 'id-collision', block_id: bid, detail: 'A unit with this id already exists in the store — confirm this is an update, not a re-extract' });
      }
    }

    if (!b.body) {
      report.push({ level: 'WARN', check: 'empty-body', block_id: bid, detail: 'Block has frontmatter but no body prose' });
    }
  });

  return report;
}

function main(argv) {
  const args = argv.filter((a) => a !== '--json');
  const json = argv.includes('--json');
  const projectDir = args[0] ? resolve(args[0]) : null;
  if (!projectDir) { process.stderr.write('usage: node check-inbox.mjs <project-path> [--json]\n'); return 3; }
  if (!existsSync(projectDir)) { process.stderr.write(`setup error: ${projectDir} does not exist\n`); return 3; }

  const inboxPath = join(projectDir, 'inbox.md');
  if (!existsSync(inboxPath) || !readFileSync(inboxPath, 'utf8').trim()) {
    process.stdout.write(json ? JSON.stringify({ report: [], summary: 'no inbox' }) + '\n' : 'No inbox to check — inbox.md missing or empty.\n');
    return 0;
  }

  const report = checkInbox(projectDir);
  const fails = report.filter((r) => r.level === 'FAIL').length;
  const warns = report.filter((r) => r.level === 'WARN').length;

  if (json) {
    process.stdout.write(JSON.stringify({ report, summary: { fail: fails, warn: warns, info: report.length - fails - warns } }, null, 2) + '\n');
  } else {
    for (const r of report) process.stdout.write(`${r.level}  ${r.check}  [${r.block_id}]  ${r.detail}\n`);
    process.stdout.write(`check-inbox: ${fails} FAIL, ${warns} WARN, ${report.length - fails - warns} INFO\n`);
  }
  return fails ? 2 : warns ? 1 : 0;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exit(main(process.argv.slice(2)));
