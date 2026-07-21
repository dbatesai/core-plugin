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

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent, todayUTC } from './log-event.mjs';
import { PROJECT_MD_CAP_BYTES } from './compact-project.mjs';

// Terminal statuses come from the shared vocabulary (SYN-005): retired/archived/
// superseded. 'resolved'/'closed' were never schema statuses and no longer gate;
// 'retired' — the schema's actual done-status — now demotes (it never did before).
export { TERMINAL_STATUSES } from './unit-vocab.mjs';
import { TERMINAL_STATUSES } from './unit-vocab.mjs';
export const CLOSE_AGE_DAYS = 30;
export const LARGE_BATCH_WARNING_THRESHOLD = 20;

// Size-pressure fallback (2026-07-21): the age floor above is tuned for a
// project whose Moves growth is slower than 30 days. A fast-moving project
// can stay over PROJECT.md's hard cap indefinitely even with this gate
// working exactly as designed, because nothing ages out fast enough. When
// PROJECT.md is over its hard cap AND a normal-floor pass finds zero
// candidates, retry with this shorter floor for that run only — the same
// shape as LARGE_BATCH_WARNING_THRESHOLD (an escalation keyed off observed
// file state, not a change to the default floor for normally-sized projects).
export const SIZE_PRESSURE_AGE_DAYS = 7;
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
    const top = line.match(/^- \[([ x~-])\]\s?(.*)$/);
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

// Flat frontmatter map for a unit (M1: shared parser, was a local copy).
function parseFrontmatter(text) {
  return parseFlatFrontmatter(text)[0];
}

// ---------- Classification ----------

function ageInDays(updatedIso, todayIso) {
  const u = new Date(`${updatedIso}T00:00:00Z`);
  const t = new Date(`${todayIso}T00:00:00Z`);
  return Math.floor((t - u) / 86_400_000);
}

/**
 * The most-recent NON-FUTURE YYYY-MM-DD in the bullet text — the completion-time
 * proxy for a closed item ("shipped 2026-05-27"). Returns null when the bullet
 * carries no usable date. Dates that aren't completion dates are stripped first:
 *   - `[[wikilink]]` targets and bare obs-ids (matched by extractBackingUnitRefs)
 *   - `(parenthetical citations)` like `(DC-106, 2026-06-01)` — this project's
 *     normal citation style; the date is a unit's date, not the work's
 *   - `\`backtick code spans\`` — version strings, the stub's own pointer date
 * Future dates (> today) are ignored: a planning/target date is not a completion
 * date, and counting it would either mask a real past date or disable aging.
 * (Review 2026-06-02d: P1/P2 citation-leak + future-date.)
 */
export function extractMostRecentDate(text, today = null) {
  if (!text) return null;
  const todayIso = today || todayUTC();
  const cleaned = text
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\bobs-[a-z0-9-]*\d{4}-\d{2}-\d{2}\b/gi, ' ')
    .replace(/`[^`]*`/g, ' ')        // backtick code spans (version strings, stub pointer date)
    .replace(/\([^)]*\)/g, ' ');     // parenthetical citations: (DC-106, 2026-06-01)
  const dates = [];
  for (const m of cleaned.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [iso, y, mo, d] = m;
    if (iso > todayIso) continue;
    // Reject impossible calendar dates (e.g. 2026-02-30) instead of letting them
    // roll forward in new Date() to a wrong age. The reconstructed date must match.
    const dt = new Date(Date.UTC(+y, +mo - 1, +d));
    if (dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d) dates.push(iso);
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
function classifyBulletStrict(bullet, memoriesDir, todayIso, ageFloorDays) {
  const refs = extractBackingUnitRefs(bullet.text);
  if (refs.length === 0) return { decision: 'keep', reason: 'no-backing-units' };
  const units = refs.map(id => readUnit(memoriesDir, id));
  if (units.some(u => u === null)) return { decision: 'keep', reason: 'missing-cited-unit', refs };
  const stillActive = units.find(u => !TERMINAL_STATUSES.has(String(u.fm.status || 'active').toLowerCase()));
  if (stillActive) return { decision: 'keep', reason: 'cited-unit-still-active', activeUnit: stillActive.id };
  const dates = units.map(u => u.fm.updated || u.fm.created).filter(Boolean).sort();
  if (dates.length === 0) return { decision: 'keep', reason: 'no-updated-dates' };
  const maxUpdated = dates[dates.length - 1];
  const age = ageInDays(maxUpdated, todayIso);
  // A malformed date yields NaN; `NaN < ageFloorDays` is false, which would fall
  // through to demote — silently dropping a possibly-recent item off the agenda.
  // Treat an un-ageable date as "keep", same as no date at all.
  if (!Number.isFinite(age) || age < ageFloorDays) return { decision: 'keep', reason: Number.isFinite(age) ? 'too-recent' : 'unparseable-date', maxUpdated, ageDays: age };
  return { decision: 'demote', maxUpdated, ageDays: age, refs, ageSource: 'backing-unit' };
}

/** A demotion stub left by a prior run: `… → see `PROJECT-ARCHIVE.md §Moves …``.
 *  It's an [x] bullet carrying re-ageable dates, so it must NOT re-enter the gate
 *  (else a later finalize demotes the stub → stub-of-stub, breaking the trail.
 *  Review 2026-06-02d HIGH, reproduced by two reviewers). */
const STUB_RE = /→\s*see\s+`?PROJECT-ARCHIVE\.md\s+§Moves/;

export function classifyBullet(bullet, projectDir, { today, strict = false, ageFloorDays = CLOSE_AGE_DAYS } = {}) {
  if (bullet.checkbox !== 'x') {
    return { decision: 'keep', reason: 'not-closed' };
  }
  if (STUB_RE.test(bullet.text)) {
    return { decision: 'keep', reason: 'already-stubbed' };
  }
  const memoriesDir = join(projectDir, '_memories');
  const todayIso = today || todayUTC();

  if (strict) return classifyBulletStrict(bullet, memoriesDir, todayIso, ageFloorDays);

  // Loosened default: a completed item is done. Age it by the date in the
  // bullet text (completion proxy) first; fall back to cited-unit dates only
  // when the bullet itself carries no date. Backing-unit status no longer gates.
  const refs = extractBackingUnitRefs(bullet.text);
  const textDate = extractMostRecentDate(bullet.text, todayIso);
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
  if (!Number.isFinite(age) || age < ageFloorDays) {
    // NaN (malformed date) keeps the item rather than silently demoting it.
    return { decision: 'keep', reason: Number.isFinite(age) ? 'too-recent' : 'unparseable-date', maxUpdated, ageDays: age, ageSource };
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
    atomicWriteFileSync(path, header);
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
  atomicWriteFileSync(archivePath, text);
}

// MEM-013: crash-retry idempotency. The write order is archive-append THEN
// PROJECT.md (deliberate — see the M4 note below); a crash between the two
// leaves the bullets archived but still on the agenda, and a retry would
// append a duplicate archive block. Skip any bullet whose exact raw lines are
// already in the archive; the retry still stubs it out of PROJECT.md.
export function alreadyArchived(archivePath, bullet) {
  let text;
  try { text = readFileSync(archivePath, 'utf8'); } catch { return false; }
  return text.includes(bullet.rawLines.join('\n'));
}

// ---------- Public API ----------

export function demoteMoves(projectDir, { today, dryRun = false, strict = false, applyLargeBatch = false } = {}) {
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

  function classifyAll(ageFloorDays) {
    const demos = [];
    const keeps = [];
    for (const bullet of bullets) {
      const result = classifyBullet(bullet, projectDir, { today: todayIso, strict, ageFloorDays });
      if (result.decision === 'demote') demos.push({ bullet, result, title: extractBulletTitle(bullet.text) });
      else keeps.push({ bullet, result });
    }
    return { demos, keeps };
  }

  let { demos: demotions, keeps: kept } = classifyAll(CLOSE_AGE_DAYS);
  let sizePressureApplied = false;
  let ageFloorDays = CLOSE_AGE_DAYS;

  // Size-pressure fallback: when the file is over its hard cap, check the
  // shorter floor regardless of what the normal floor already found — a
  // shorter floor is a strict superset (age >= floor demotes; 7 <= 30, so
  // everything the 30-day floor catches, the 7-day floor also catches, plus
  // anything 7-29 days old). Gating on "the normal floor found nothing" (the
  // original design, Hale's catch 2026-07-21) let a single old item mask
  // every other item still over cap: one 93-day bullet would demote, the
  // escalation would never fire, and dozens of 10-29-day bullets would sit
  // untouched on a file still massively over cap.
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes > PROJECT_MD_CAP_BYTES) {
    const escalated = classifyAll(SIZE_PRESSURE_AGE_DAYS);
    if (escalated.demos.length > demotions.length) {
      demotions = escalated.demos;
      kept = escalated.keeps;
      sizePressureApplied = true;
      ageFloorDays = SIZE_PRESSURE_AGE_DAYS;
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
  if (sizePressureApplied) {
    stats.sizePressureApplied = true;
    stats.ageFloorDays = ageFloorDays;
  }

  logEvent(projectDir, 'hygiene-log.jsonl', {
    kind: 'demote-moves',
    demoted: stats.demoted,
    kept: stats.kept,
    dry_run: dryRun,
    candidates: stats.candidates,
    size_pressure_applied: sizePressureApplied,
    age_floor_days: ageFloorDays,
  }, { today: todayIso });

  const largeBatch = demotions.length >= LARGE_BATCH_WARNING_THRESHOLD;
  if (largeBatch) {
    logEvent(projectDir, 'hygiene-log.jsonl', {
      kind: 'demote-moves-large-batch',
      candidate_count: demotions.length,
      threshold: LARGE_BATCH_WARNING_THRESHOLD,
      held: !dryRun && !applyLargeBatch,
    }, { today: todayIso });
    process.stderr.write(
      `warn: demote-moves found ${demotions.length} candidates (threshold ${LARGE_BATCH_WARNING_THRESHOLD}).\n`
    );
  }

  if (dryRun || demotions.length === 0) return stats;

  // A large first batch is a bulk migration of a user-owned file (PROJECT.md).
  // Hold it: write nothing, surface the candidates, and require an explicit
  // --apply-large-batch so a human looks before N items leave the agenda at once.
  // (Review 2026-06-02d MED: the warning otherwise fired AFTER the writes.)
  if (largeBatch && !applyLargeBatch) {
    stats.held = true;
    stats.held_reason = 'large-batch-needs-confirmation';
    process.stderr.write(
      `demote-moves: holding ${demotions.length} demotions (>= ${LARGE_BATCH_WARNING_THRESHOLD}). ` +
      `Nothing written. Review the candidates, then re-run with --apply-large-batch to proceed.\n`
    );
    return stats;
  }

  const archivePath = ensureArchiveFile(projectDir);
  const freshDemotions = demotions.filter(d => !alreadyArchived(archivePath, d.bullet));
  if (freshDemotions.length) {
    const block = renderArchiveBlock(freshDemotions, todayIso);
    appendToArchiveMoves(archivePath, block);
  }

  const newMoves = rewriteMovesWithStubs(moves, bullets, demotions, todayIso);
  const beforeMoves = text.indexOf(moves);
  const afterMoves = beforeMoves + moves.length;
  const newText = text.slice(0, beforeMoves) + newMoves + text.slice(afterMoves);
  // M4: PROJECT.md (the irreplaceable user surface) is written LAST and atomically.
  // Archive append already happened above — order is deliberate: on any failure here,
  // PROJECT.md is either old-intact or new-complete (rename is atomic), and the worst
  // crash outcome is a harmless extra archive block, never a truncated PROJECT.md.
  atomicWriteFileSync(projectMdPath, newText);

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
  let applyLargeBatch = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--json') asJson = true;
    else if (a === '--strict') strict = true;
    else if (a === '--apply-large-batch') applyLargeBatch = true;
    else if (!a.startsWith('--')) projectDir = resolve(a);
  }

  let stats;
  try { stats = demoteMoves(projectDir, { dryRun, strict, applyLargeBatch }); }
  catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return 0;
  }
  const mode = dryRun ? ' (dry-run)' : stats.held ? ' (HELD — nothing written)' : '';
  const verb = stats.held ? 'would demote' : 'demoted';
  process.stdout.write(`demote-moves${mode}: ${stats.demoted} ${verb}, ${stats.kept} kept.\n`);
  if (stats.sizePressureApplied) {
    process.stdout.write(`  size-pressure: PROJECT.md is over cap and the ${CLOSE_AGE_DAYS}-day floor found nothing — escalated to a ${stats.ageFloorDays}-day floor for this run.\n`);
  }
  if (stats.candidates && stats.candidates.length) {
    for (const c of stats.candidates) {
      process.stdout.write(`  • ${c.title}  (age ${c.ageDays}d)\n`);
    }
  }
  if (stats.held) process.stdout.write(`  → large batch held; re-run with --apply-large-batch to write.\n`);
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
