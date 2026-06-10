/**
 * demote-state-narrative.mjs — Phase 1c of the DC-85 memory architecture
 * redesign. Demotes stale §State narrative bullets in PROJECT.md to
 * PROJECT-ARCHIVE.md §State, leaving a one-line stub pointer in place.
 *
 * A §State bullet is demotable when:
 *  - It has at least one `*Backed by ...*` italicized footer citation.
 *  - All cited units are present in `_memories/` and in terminal status
 *    (retired / archived / superseded — shared vocab, SYN-005).
 *  - The most-recent backing-unit `updated:` date is >60 days old.
 *
 * Conservative defaults (mirrors demote-moves.mjs):
 *  - Bullets with no `*Backed by ...*` citation never demote.
 *  - Bullets where any cited unit is missing or still active never demote.
 *  - max(updated:) is used across cited units, not min — newer cited unit
 *    keeps the bullet current even if older ones are stale.
 *  - Citation styles other than the strict `*Backed by ...*` footer
 *    (e.g. older `*DC-XX.*` shorthand) fall into the no-citation bucket
 *    by design — DC-93 §3 names this explicitly.
 *
 * Default mode is DRY-RUN per DC-93 + the PROJECT.md §Moves Phase 1c entry.
 * Only `--apply` writes. This differs from demote-moves.mjs (auto-applies
 * per DC-89) because §State demotion is materially riskier: bullets are
 * current-truth statements rather than already-closed work items, and the
 * criteria are tuned for §State-heavy non-CORE corpora that haven't been
 * exercised yet. Flip the default in a tracked decision once cross-corpus
 * validation produces clean candidate lists for N sessions.
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
import { extractBackingUnitRefs } from './demote-moves.mjs';

// Terminal statuses come from the shared vocabulary (SYN-005). This resolves
// the 2026-05-27 criteria-vs-corpus mismatch noted here previously: 'retired'
// (229-active/3-retired corpus) is now terminal in BOTH demoters at once, and
// the out-of-schema 'resolved'/'closed' no longer gate. Symmetry with
// demote-moves is structural now — both import the same Set.
export { TERMINAL_STATUSES } from './unit-vocab.mjs';
import { TERMINAL_STATUSES } from './unit-vocab.mjs';
export const STATE_CLOSE_AGE_DAYS = 60;
export const LARGE_BATCH_WARNING_THRESHOLD = 20;
export const ARCHIVE_FILE = 'PROJECT-ARCHIVE.md';
export const ARCHIVE_STATE_HEADING = '## §State';
// Only the strict `*Backed by ...*` footer counts as a citation for v1
// (DC-93 §3). Older styles intentionally don't match — they keep the
// bullet on the conservative no-citation path until a HTML-marker
// upgrade lands.
export const BACKED_BY_PATTERN = /\*Backed by [^*]+\*/;

// ---------- Section + bullet extraction ----------

export function extractStateSection(text) {
  const headingRe = /^##\s+State\s*$/m;
  const m = headingRe.exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  const nextHeading = /^##\s+/m.exec(rest);
  const end = nextHeading ? start + nextHeading.index : text.length;
  return text.slice(start, end);
}

// §State bullets are top-level `- **Title.**` (no checkbox, unlike §Moves).
// Continuation lines are indented or blank-then-indented. Non-bullet content
// (preamble paragraphs, separators) passes through untouched at write time.
export function parseStateBullets(stateBody) {
  if (!stateBody || !stateBody.trim()) return [];
  const lines = stateBody.split('\n');
  const bullets = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Top-level bullet: `- **Title.**` — bold opener required. The bold
    // opener distinguishes §State bullets from incidental list items inside
    // bullet bodies (e.g. nested "- detail" lines).
    const top = line.match(/^- \*\*(.+)$/);
    if (top) {
      if (cur) bullets.push(cur);
      cur = {
        text: line.slice(2),
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

// ---------- Local helpers (mirrors demote-moves file-locals; see Path B
// in 2026-05-27-phase-1c-implementation-plan.md for the duplicate-vs-extract
// reasoning). Refactor into a shared `_demote-helpers.mjs` when a third
// demote-* script needs them.

// Flat frontmatter map for a unit (M1: shared parser, was a local copy).
function parseFrontmatter(text) {
  return parseFlatFrontmatter(text)[0];
}

function readUnit(memoriesDir, id) {
  const path = join(memoriesDir, `${id}.md`);
  if (!existsSync(path)) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const fm = parseFrontmatter(raw);
  return { id, path, fm };
}

function ageInDays(updatedIso, todayIso) {
  const u = new Date(`${updatedIso}T00:00:00Z`);
  const t = new Date(`${todayIso}T00:00:00Z`);
  return Math.floor((t - u) / 86_400_000);
}

function extractBulletTitle(text) {
  const m = text.match(/^\s*\*\*([^*]+)\*\*/);
  if (m) return m[1].trim();
  const first = text.split('\n')[0].trim();
  return first.length > 140 ? first.slice(0, 137) + '...' : first;
}

// ---------- Classification ----------

export function classifyStateBullet(bullet, projectDir, { today, recencyDays = STATE_CLOSE_AGE_DAYS } = {}) {
  // Strict footer match is the only path to "has citations" in v1 —
  // extractBackingUnitRefs alone would catch backticked unit ids elsewhere
  // in the bullet body and treat them as citations. DC-93 §3 chose the
  // strict-footer-only interpretation; widen later only on dry-run evidence.
  if (!BACKED_BY_PATTERN.test(bullet.text)) {
    return { decision: 'keep', reason: 'no-backing-units' };
  }
  const refs = extractBackingUnitRefs(bullet.text);
  if (refs.length === 0) {
    // Footer present but no resolvable unit ids — formatting drift; treat as
    // missing rather than no-citation to surface the case in dry-run output.
    return { decision: 'keep', reason: 'unparseable-citation' };
  }
  const memoriesDir = join(projectDir, '_memories');
  const units = refs.map(id => readUnit(memoriesDir, id));
  if (units.some(u => u === null)) {
    return { decision: 'keep', reason: 'missing-cited-unit', refs };
  }
  const stillActive = units.find(u => {
    const status = String(u.fm.status || 'active').toLowerCase();
    return !TERMINAL_STATUSES.has(status);
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
  if (!Number.isFinite(age) || age < recencyDays) {
    // NaN (malformed date) keeps the item rather than silently demoting it.
    return { decision: 'keep', reason: Number.isFinite(age) ? 'too-recent' : 'unparseable-date', maxUpdated, ageDays: age };
  }
  return { decision: 'demote', maxUpdated, ageDays: age, refs };
}

// ---------- Stub + archive rendering ----------

function renderStateStub(bullet, today) {
  const title = extractBulletTitle(bullet.text);
  return `- **${title}** → see \`PROJECT-ARCHIVE.md §State ${today}\``;
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

function appendToArchiveState(archivePath, block) {
  let text = readFileSync(archivePath, 'utf8');
  const headingIdx = text.indexOf(ARCHIVE_STATE_HEADING);
  if (headingIdx === -1) {
    const sep = text.endsWith('\n') ? '' : '\n';
    text = text + sep + '\n' + ARCHIVE_STATE_HEADING + '\n\n' + block + '\n';
  } else {
    const lineEnd = text.indexOf('\n', headingIdx);
    const insertAt = lineEnd === -1 ? text.length : lineEnd + 1;
    text = text.slice(0, insertAt) + '\n' + block + '\n' + text.slice(insertAt);
  }
  atomicWriteFileSync(archivePath, text);
}

function rewriteStateWithStubs(originalState, bullets, demotions, today) {
  const demotionSet = new Set(demotions.map(d => d.bullet.rawIndex));
  const lines = originalState.split('\n');
  const byIndex = new Map(bullets.map(b => [b.rawIndex, b]));
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (byIndex.has(i)) {
      const b = byIndex.get(i);
      if (demotionSet.has(i)) {
        out.push(renderStateStub(b, today));
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

// ---------- Public API ----------

export function demoteStateNarrative(projectDir, { today, apply = false } = {}) {
  const todayIso = today || todayUTC();
  const projectMdPath = join(projectDir, 'PROJECT.md');
  let text;
  try { text = readFileSync(projectMdPath, 'utf8'); }
  catch (e) { throw new Error(`PROJECT.md not readable at ${projectMdPath}: ${e.message}`); }

  const state = extractStateSection(text);
  if (state === null) {
    return { demoted: 0, kept: 0, candidates: [], dry_run: !apply, reason: 'no-state-section' };
  }

  const bullets = parseStateBullets(state);
  if (bullets.length === 0) {
    const stats = { demoted: 0, kept: 0, candidates: [], dry_run: !apply, reason: 'no-state-bullets' };
    logEvent(projectDir, 'hygiene-log.jsonl', {
      kind: 'demote-state',
      demoted: 0,
      kept: 0,
      dry_run: !apply,
      candidates: [],
    }, { today: todayIso });
    return stats;
  }

  const demotions = [];
  const kept = [];
  for (const bullet of bullets) {
    const result = classifyStateBullet(bullet, projectDir, { today: todayIso });
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
    dry_run: !apply,
  };

  logEvent(projectDir, 'hygiene-log.jsonl', {
    kind: 'demote-state',
    demoted: stats.demoted,
    kept: stats.kept,
    dry_run: !apply,
    candidates: stats.candidates,
  }, { today: todayIso });

  if (demotions.length >= LARGE_BATCH_WARNING_THRESHOLD) {
    logEvent(projectDir, 'hygiene-log.jsonl', {
      kind: 'demote-state-large-batch',
      candidate_count: demotions.length,
      threshold: LARGE_BATCH_WARNING_THRESHOLD,
    }, { today: todayIso });
    process.stderr.write(
      `warn: demote-state-narrative found ${demotions.length} candidates (threshold ${LARGE_BATCH_WARNING_THRESHOLD}). ` +
      `First-run scale; verify before --apply.\n`
    );
  }

  if (!apply || demotions.length === 0) return stats;

  const archivePath = ensureArchiveFile(projectDir);
  const block = renderArchiveBlock(demotions, todayIso);
  appendToArchiveState(archivePath, block);

  const newState = rewriteStateWithStubs(state, bullets, demotions, todayIso);
  const beforeState = text.indexOf(state);
  const afterState = beforeState + state.length;
  const newText = text.slice(0, beforeState) + newState + text.slice(afterState);
  // M4: PROJECT.md written last + atomically — see the matching note in demote-moves.mjs.
  atomicWriteFileSync(projectMdPath, newText);

  return stats;
}

// ---------- CLI ----------

export function main(argv) {
  const args = argv.slice();
  let projectDir = process.cwd();
  let apply = false;
  let asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;       // explicit no-op; v1 default is already dry-run
    else if (a === '--json') asJson = true;
    else if (!a.startsWith('--')) projectDir = resolve(a);
  }

  let stats;
  try { stats = demoteStateNarrative(projectDir, { apply }); }
  catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 2;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
    return 0;
  }
  const verb = apply ? 'demoted' : 'would demote';
  const mode = apply ? '' : ' (dry-run; pass --apply to write)';
  process.stdout.write(`demote-state-narrative${mode}: ${verb} ${stats.demoted}, kept ${stats.kept}.\n`);
  if (stats.candidates && stats.candidates.length) {
    for (const c of stats.candidates) {
      process.stdout.write(`  • ${c.title}  (max-updated ${c.maxUpdated}, age ${c.ageDays}d, refs ${c.refs.length})\n`);
    }
  }
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
