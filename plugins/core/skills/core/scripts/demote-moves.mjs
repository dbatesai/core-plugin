/**
 * demote-moves.mjs — auto-demote closed §Moves bullets to PROJECT-ARCHIVE.md.
 *
 * Phase 1b of the DC-85 memory architecture redesign. Closed bullets ([x])
 * whose most-recent backing-unit `updated:` date is >30 days old AND all
 * cited units are in stable terminal status get moved to PROJECT-ARCHIVE.md
 * §Moves under a date-stamped subsection. A one-line stub pointer replaces
 * the original bullet so the trail back to the archive entry is preserved.
 *
 * Conservative defaults (advisor 2026-05-24):
 *  - Bullets with no backing-unit citation never demote.
 *  - Bullets where any cited unit is missing or still active never demote.
 *  - The 30-day floor uses max(updated:) across cited units, not min.
 *
 * Active items ([ ]) and partial items ([~]) are never touched.
 *
 * Per David's 2026-05-24 reframe: auto-applies by default. --dry-run is the
 * agent's own inspection mode (not a permanent user-ratification gate).
 *
 * Per DC-77 the script ships with the plugin (not per-project).
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent, todayUTC } from './log-event.mjs';

export const TERMINAL_STATUSES = ['resolved', 'archived', 'superseded', 'closed'];
export const CLOSE_AGE_DAYS = 30;
export const LARGE_BATCH_WARNING_THRESHOLD = 20;
export const ARCHIVE_FILE = 'PROJECT-ARCHIVE.md';
export const ARCHIVE_MOVES_HEADING = '## §Moves';

// ---------- Section + bullet extraction ----------

export function extractMovesSection(text) {
  const headingRe = /^##\s+Moves\s*$/m;
  const m = headingRe.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const end = nextHeading ? start + nextHeading.index : text.length;
  return text.slice(start, end);
}

export function parseBullets(movesBody) {
  if (!movesBody || !movesBody.trim()) return [];
  const lines = movesBody.split('\n');
  const bullets = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const top = line.match(/^- \[([ x~\-])\]\s?(.*)$/);
    if (top) {
      if (cur) bullets.push(cur);
      cur = {
        checkbox: top[1],
        text: top[2] || '',
        rawLines: [line],
        rawIndex: i,
        lineCount: 1,
      };
    } else if (cur) {
      if (line.startsWith('  ') || line.startsWith('\t')) {
        cur.rawLines.push(line);
        cur.text += '\n' + line;
        cur.lineCount++;
      } else if (line.trim() === '') {
        const next = lines[i + 1] || '';
        if (next.startsWith('  ') || next.startsWith('\t')) {
          cur.rawLines.push(line);
          cur.text += '\n' + line;
          cur.lineCount++;
        } else {
          bullets.push(cur);
          cur = null;
        }
      } else {
        bullets.push(cur);
        cur = null;
      }
    }
  }
  if (cur) bullets.push(cur);
  return bullets;
}

// ---------- Backing-unit reference extraction ----------

export function extractBackingUnitRefs(text) {
  if (!text) return [];
  const refs = new Set();

  const backtickRe = /`([a-z0-9][a-z0-9-]+)`/g;
  for (const m of text.matchAll(backtickRe)) {
    const id = m[1].replace(/\.md$/, '');
    if (looksLikeUnitId(id)) refs.add(id);
  }

  const pathRe = /_memories\/([a-z0-9][a-z0-9-]+)\.md/g;
  for (const m of text.matchAll(pathRe)) {
    refs.add(m[1]);
  }

  const bareRe = /\b(dc-\d+(?:-[a-z0-9-]+)?|risk-\d+(?:-[a-z0-9-]+)?|obs-[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2})\b/gi;
  for (const m of text.matchAll(bareRe)) {
    refs.add(m[1].toLowerCase());
  }

  return Array.from(refs);
}

function looksLikeUnitId(id) {
  return /^(dc-\d+|risk-\d+|obs-[a-z]|oq-|who-|reference-|cluster-)/.test(id);
}

// ---------- Unit loading ----------

function readUnit(memoriesDir, id) {
  const path = join(memoriesDir, `${id}.md`);
  if (!existsSync(path)) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const fm = parseFrontmatter(raw);
  return { id, path, fm };
}

function parseFrontmatter(text) {
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  const raw = text.slice(4, end);
  const fm = {};
  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const k = line.slice(0, colonIdx).trim();
    const v = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (v !== '') fm[k] = v;
  }
  return fm;
}

// ---------- Classification ----------

function ageInDays(updatedIso, todayIso) {
  const u = new Date(`${updatedIso}T00:00:00Z`);
  const t = new Date(`${todayIso}T00:00:00Z`);
  return Math.floor((t - u) / 86_400_000);
}

export function classifyBullet(bullet, projectDir, { today } = {}) {
  if (bullet.checkbox !== 'x') {
    return { decision: 'keep', reason: 'not-closed' };
  }
  const refs = extractBackingUnitRefs(bullet.text);
  if (refs.length === 0) {
    return { decision: 'keep', reason: 'no-backing-units' };
  }
  const memoriesDir = join(projectDir, '_memories');
  const units = refs.map(id => readUnit(memoriesDir, id));
  if (units.some(u => u === null)) {
    return { decision: 'keep', reason: 'missing-cited-unit', refs };
  }
  const stillActive = units.find(u => {
    const status = String(u.fm.status || 'active').toLowerCase();
    return !TERMINAL_STATUSES.includes(status);
  });
  if (stillActive) {
    return { decision: 'keep', reason: 'cited-unit-still-active', activeUnit: stillActive.id };
  }
  const dates = units.map(u => u.fm.updated || u.fm.created).filter(Boolean).sort();
  if (dates.length === 0) {
    return { decision: 'keep', reason: 'no-updated-dates' };
  }
  const maxUpdated = dates[dates.length - 1];
  const todayIso = today || todayUTC();
  const age = ageInDays(maxUpdated, todayIso);
  if (age < CLOSE_AGE_DAYS) {
    return { decision: 'keep', reason: 'too-recent', maxUpdated, ageDays: age };
  }
  return { decision: 'demote', maxUpdated, ageDays: age, refs };
}

// ---------- Stub + archive rendering ----------

function extractBulletTitle(text) {
  const m = text.match(/^\s*\*\*([^*]+)\*\*/);
  if (m) return m[1].trim();
  const first = text.split('\n')[0].trim();
  return first.length > 140 ? first.slice(0, 137) + '...' : first;
}

function renderStub(bullet, today) {
  const title = extractBulletTitle(bullet.text);
  return `- [x] **${title}** → see \`PROJECT-ARCHIVE.md §Moves ${today}\``;
}

function renderArchiveBlock(demotions, today) {
  const lines = [`### ${today}`, ''];
  for (const d of demotions) {
    lines.push(d.bullet.rawLines.join('\n'));
    lines.push('');
  }
  return lines.join('\n');
}

function ensureArchiveFile(projectDir) {
  const path = join(projectDir, ARCHIVE_FILE);
  if (!existsSync(path)) {
    const header = `# CORE PROJECT.md Archive\n\n> **Single-WRITE archive of entries migrated from \`PROJECT.md\`.**\n> Never read at bootstrap. Provides DELETE granularity for the user.\n\n> Newest first.\n\n---\n\n`;
    writeFileSync(path, header);
  }
  return path;
}

function appendToArchiveMoves(archivePath, block) {
  let text = readFileSync(archivePath, 'utf8');
  const headingIdx = text.indexOf(ARCHIVE_MOVES_HEADING);
  if (headingIdx === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    text = text + sep + '\n' + ARCHIVE_MOVES_HEADING + '\n\n' + block + '\n';
  } else {
    const lineEnd = text.indexOf('\n', headingIdx);
    const insertAt = lineEnd === -1 ? text.length : lineEnd + 1;
    text = text.slice(0, insertAt) + '\n' + block + '\n' + text.slice(insertAt);
  }
  writeFileSync(archivePath, text);
}

// ---------- Public API ----------

export function demoteMoves(projectDir, { today, dryRun = false } = {}) {
  const todayIso = today || todayUTC();
  const projectMdPath = join(projectDir, 'PROJECT.md');
  let text;
  try { text = readFileSync(projectMdPath, 'utf8'); }
  catch (e) { throw new Error(`PROJECT.md not readable at ${projectMdPath}: ${e.message}`); }

  const moves = extractMovesSection(text);
  if (moves === null) {
    return { demoted: 0, kept: 0, candidates: [], dryRun, reason: 'no-moves-section' };
  }

  const bullets = parseBullets(moves);
  const demotions = [];
  const kept = [];
  for (const bullet of bullets) {
    const result = classifyBullet(bullet, projectDir, { today: todayIso });
    if (result.decision === 'demote') {
      demotions.push({ bullet, result, title: extractBulletTitle(bullet.text) });
    } else {
      kept.push({ bullet, result });
    }
  }

  const stats = {
    demoted: demotions.length,
    kept: kept.length,
    candidates: demotions.map(d => ({
      title: d.title,
      maxUpdated: d.result.maxUpdated,
      ageDays: d.result.ageDays,
      refs: d.result.refs,
    })),
    dryRun,
  };

  logEvent(projectDir, 'hygiene-log.jsonl', {
    kind: 'demote-moves',
    demoted: stats.demoted,
    kept: stats.kept,
    dry_run: dryRun,
    candidates: stats.candidates,
  }, { today: todayIso });

  if (demotions.length >= LARGE_BATCH_WARNING_THRESHOLD) {
    logEvent(projectDir, 'hygiene-log.jsonl', {
      kind: 'demote-moves-large-batch',
      candidate_count: demotions.length,
      threshold: LARGE_BATCH_WARNING_THRESHOLD,
    }, { today: todayIso });
    process.stderr.write(
      `warn: demote-moves found ${demotions.length} candidates (threshold ${LARGE_BATCH_WARNING_THRESHOLD}). ` +
      `First-run scale on this project; expected to taper.\n`
    );
  }

  if (dryRun || demotions.length === 0) return stats;

  const archivePath = ensureArchiveFile(projectDir);
  const block = renderArchiveBlock(demotions, todayIso);
  appendToArchiveMoves(archivePath, block);

  const newMoves = rewriteMovesWithStubs(moves, bullets, demotions, todayIso);
  const beforeMoves = text.indexOf(moves);
  const afterMoves = beforeMoves + moves.length;
  const newText = text.slice(0, beforeMoves) + newMoves + text.slice(afterMoves);
  writeFileSync(projectMdPath, newText);

  return stats;
}

function rewriteMovesWithStubs(originalMoves, bullets, demotions, today) {
  const demotionSet = new Set(demotions.map(d => d.bullet.rawIndex));
  const lines = originalMoves.split('\n');
  const byIndex = new Map(bullets.map(b => [b.rawIndex, b]));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (byIndex.has(i)) {
      const b = byIndex.get(i);
      if (demotionSet.has(i)) {
        out.push(renderStub(b, today));
        i = b.rawIndex + b.rawLines.length - 1;
      } else {
        for (let j = 0; j < b.rawLines.length; j++) out.push(b.rawLines[j]);
        i = b.rawIndex + b.rawLines.length - 1;
      }
    } else {
      out.push(lines[i]);
    }
  }
  return out.join('\n');
}

// ---------- CLI ----------

export function main(argv) {
  const args = argv.slice();
  let projectDir = process.cwd();
  let dryRun = false;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') asJson = true;
    else if (!a.startsWith('--')) projectDir = resolve(a);
  }

  let stats;
  try { stats = demoteMoves(projectDir, { dryRun }); }
  catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return 0;
  }
  const mode = dryRun ? ' (dry-run)' : '';
  process.stdout.write(`demote-moves${mode}: ${stats.demoted} demoted, ${stats.kept} kept.\n`);
  if (stats.candidates && stats.candidates.length) {
    for (const c of stats.candidates) {
      process.stdout.write(`  • ${c.title}  (age ${c.ageDays}d)\n`);
    }
  }
  return 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
