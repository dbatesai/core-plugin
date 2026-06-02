/**
 * demote-moves.mjs — auto-demote closed §Moves bullets to PROJECT-ARCHIVE.md.
 *
 * Phase 1b of the DC-85 memory architecture redesign. Closed bullets ([x])
 * older than the 30-day floor get moved to PROJECT-ARCHIVE.md §Moves under a
 * date-stamped subsection. A one-line stub pointer replaces the original
 * bullet so the trail back to the archive entry is preserved.
 *
 * Demotion rule (default, loosened 2026-06-02): a completed item is done —
 * it leaves the agenda on checkbox-state + age, regardless of whether its
 * backing-unit `status:` was kept tidy. Age comes from the most-recent date
 * IN THE BULLET TEXT (the completion-time proxy — "shipped 2026-05-27"),
 * falling back to max(updated:/created:) across any cited units when the
 * bullet carries no date. Keep only when no age can be proven at all.
 *
 * Why the change: the original gate required ALL cited units to be in
 * terminal status AND ≥30 days stale. On a real corpus that left 75 shipped
 * items stranded on the agenda (PROJECT.md grew to 196KB) — an [x] item whose
 * referenced decision is still `active`, or that carried no `*Backed by*`
 * footer, never demoted. A done item is done; the active unit it cites is a
 * reference, not a reason to keep the finished work on the agenda.
 *
 * --strict restores the original conservative gate (require refs present, all
 * cited units terminal, age from unit dates) for callers that want it.
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
  text = text.replace(/\r\n?/g, '\n'); // CRLF tolerance (review M1)
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

/**
 * The most-recent YYYY-MM-DD anchored date in the bullet text — the
 * completion-time proxy for a closed item ("shipped 2026-05-27"). Returns null
 * when the bullet carries no date. Ignores dates inside `[[unit-name-...]]`
 * wikilinks and obs-id slugs so a unit reference doesn't masquerade as a
 * completion date — those are matched by extractBackingUnitRefs, not here.
 */
export function extractMostRecentDate(text) {
  if (!text) return null;
  // Strip wikilinks and bare obs-ids (they embed dates that aren't completion dates).
  const cleaned = text
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\bobs-[a-z0-9-]*\d{4}-\d{2}-\d{2}\b/gi, ' ');
  const dates = [];
  for (const m of cleaned.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [iso, y, mo, d] = m;
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) dates.push(iso);
  }
  if (!dates.length) return null;
  dates.sort();
  return dates[dates.length - 1];
}

/**
 * Strict (original) gate: require backing-unit citations, all present, all in
 * terminal status, then age from max(updated:/created:) across them. Preserved
 * behind --strict for callers that want the conservative behavior.
 */
function classifyBulletStrict(bullet, memoriesDir, todayIso) {
  const refs = extractBackingUnitRefs(bullet.text);
  if (refs.length === 0) return { decision: 'keep', reason: 'no-backing-units' };
  const units = refs.map(id => readUnit(memoriesDir, id));
  if (units.some(u => u === null)) return { decision: 'keep', reason: 'missing-cited-unit', refs };
  const stillActive = units.find(u => !TERMINAL_STATUSES.includes(String(u.fm.status || 'active').toLowerCase()));
  if (stillActive) return { decision: 'keep', reason: 'cited-unit-still-active', activeUnit: stillActive.id };
  const dates = units.map(u => u.fm.updated || u.fm.created).filter(Boolean).sort();
  if (dates.length === 0) return { decision: 'keep', reason: 'no-updated-dates' };
  const maxUpdated = dates[dates.length - 1];
  const age = ageInDays(maxUpdated, todayIso);
  if (age < CLOSE_AGE_DAYS) return { decision: 'keep', reason: 'too-recent', maxUpdated, ageDays: age };
  return { decision: 'demote', maxUpdated, ageDays: age, refs, ageSource: 'backing-unit' };
}

export function classifyBullet(bullet, projectDir, { today, strict = false } = {}) {
  if (bullet.checkbox !== 'x') {
    return { decision: 'keep', reason: 'not-closed' };
  }
  const memoriesDir = join(projectDir, '_memories');
  const todayIso = today || todayUTC();

  if (strict) return classifyBulletStrict(bullet, memoriesDir, todayIso);

  // Loosened default: a completed item is done. Age it by the date in the
  // bullet text (completion proxy) first; fall back to cited-unit dates only
  // when the bullet itself carries no date. Backing-unit status no longer gates.
  const refs = extractBackingUnitRefs(bullet.text);
  const textDate = extractMostRecentDate(bullet.text);
  let maxUpdated = textDate;
  let ageSource = 'bullet-text';
  if (!maxUpdated) {
    const units = refs.map(id => readUnit(memoriesDir, id)).filter(Boolean);
    const dates = units.map(u => u.fm.updated || u.fm.created).filter(Boolean).sort();
    if (dates.length) { maxUpdated = dates[dates.length - 1]; ageSource = 'backing-unit'; }
  }
  if (!maxUpdated) {
    // Can't prove the item is aged — keep it rather than demote a possibly-recent one.
    return { decision: 'keep', reason: 'no-age-signal', refs };
  }
  const age = ageInDays(maxUpdated, todayIso);
  if (age < CLOSE_AGE_DAYS) {
    return { decision: 'keep', reason: 'too-recent', maxUpdated, ageDays: age, ageSource };
  }
  return { decision: 'demote', maxUpdated, ageDays: age, refs, ageSource };
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

export function demoteMoves(projectDir, { today, dryRun = false, strict = false } = {}) {
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
    const result = classifyBullet(bullet, projectDir, { today: todayIso, strict });
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
  let strict = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') asJson = true;
    else if (a === '--strict') strict = true;
    else if (!a.startsWith('--')) projectDir = resolve(a);
  }

  let stats;
  try { stats = demoteMoves(projectDir, { dryRun, strict }); }
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
