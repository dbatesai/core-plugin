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

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { iterUnits, score } from './priority.mjs';
import { logEvent } from './log-event.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { hashText, stampFile, readProjectCache } from './state-cache.mjs';
import {
  writeGuardDecision, withProjectMdWriterLock,
} from './lifecycle-core.mjs';

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

function countOccurrences(text, needle) {
  let count = 0, idx = 0;
  while ((idx = text.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

/**
 * findExistingBlock — fail-closed marker scan (Hale's point 4, 2026-07-22).
 * The old version paired the FIRST BEGIN with the FIRST END via bare indexOf,
 * which silently deleted any user text sitting between a duplicate BEGIN and
 * the END — a real repro Hale's probe caught (`hot_duplicate_markers`). Now it
 * matches decorate-graph.mjs's exact-one-pair rule byte-for-byte:
 *
 *   { ok: true,  block: null }          — no markers at all, clean slate.
 *   { ok: true,  block: {start,end} }   — exactly one correctly-ordered pair.
 *   { ok: false, block: null }          — ANY other shape (duplicate BEGIN,
 *                                         mismatched count, END before BEGIN):
 *                                         refuse to touch the file, don't guess.
 */
export function findExistingBlock(text) {
  const beginCount = countOccurrences(text, HOT_BEGIN);
  const endCount = countOccurrences(text, HOT_END);
  if (beginCount === 0 && endCount === 0) return { ok: true, block: null };
  if (beginCount !== 1 || endCount !== 1) return { ok: false, block: null };
  const beginIdx = text.indexOf(HOT_BEGIN);
  const endIdx = text.indexOf(HOT_END);
  if (endIdx < beginIdx) return { ok: false, block: null };
  // Inclusive of trailing newline after the end marker, so replacement is clean.
  let blockEnd = endIdx + HOT_END.length;
  while (blockEnd < text.length && text[blockEnd] === '\n') blockEnd++;
  return { ok: true, block: { start: beginIdx, end: blockEnd } };
}

/**
 * MALFORMED_HOT_MARKERS — thrown (byte-identical refusal, nothing written) when
 * PROJECT.md's hot-section markers aren't either "no markers" or "exactly one
 * ordered pair". Mirrors decorate-graph.mjs's MALFORMED_EDGES_MARKERS: a
 * corrupt/ambiguous marker state is a manual-look problem, never a guess.
 */
function malformedHotMarkersError(path) {
  const err = new Error(
    `malformed HOT-SECTION:BEGIN/END marker state in ${path} — refusing to touch this file ` +
    `(expected either zero markers or exactly one ordered BEGIN/END pair). ` +
    `Duplicate or out-of-order markers can hide user text; a manual look is needed.`
  );
  err.code = 'MALFORMED_HOT_MARKERS';
  err.path = path;
  return err;
}

function renderBlock(text, timestamp) {
  const trimmed = String(text || '').trim();
  return `${HOT_BEGIN}\n${HOT_HEADING}\n\n${trimmed}\n\n*Synthesized ${timestamp}*\n${HOT_END}\n\n`;
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

// Writer-boundary lock: applyHotSection/clearHotSection had NO lock at all
// around their PROJECT.md read-modify-write. Fixed 2026-07-22 with a private
// `.hot-section.lock`; superseded the SAME day by Hale's point 7 — a
// writer-local lock only serialises hot-section against ITSELF, so a
// concurrent compaction or demotion could still interleave with a hot-section
// apply on the same PROJECT.md. Now every PROJECT.md writer shares ONE lock
// (`withProjectMdWriterLock`, in lifecycle-core.mjs), which is what actually
// closes the cross-writer race.

/**
 * NeedsReconciliationError — thrown instead of writing when PROJECT.md's
 * human-authored region (everything outside the marker-delimited hot block)
 * already disagrees with the last established baseline. Mirrors the existing
 * HOT_SECTION_OVER_BUDGET pattern in this same file: a typed, catchable error
 * rather than a silent skip or a value the caller might not check.
 */
function needsReconciliationError(path, classification) {
  const err = new Error(
    `PROJECT.md needs reconciliation before a hot-section write: content outside the hot block ` +
    `already diverged from the last known baseline (classification: ${classification}). ` +
    `Refusing to rewrite/re-stamp over an unreconciled user edit.`
  );
  err.code = 'NEEDS_RECONCILIATION';
  err.path = path;
  err.classification = classification;
  return err;
}

/**
 * Refuse a write when PROJECT.md has a PRIOR established baseline that the
 * CURRENT (pre-write) bytes already disagree with outside the hot block.
 * Gated on `cachedStamp` being present, same reasoning as
 * decorate-graph.mjs's identical check: a file with no prior cache entry has
 * no established baseline to violate, so its first-ever hot-section write is
 * safe and is exactly how that baseline gets established.
 */
function assertReconciled(projectDir, path, currentText) {
  const cache = readProjectCache(projectDir);
  const cachedStamp = cache.files[path];
  const classification = classifyProjectMdChange(cachedStamp, currentText);
  // Shared refuse-or-proceed rule (lifecycle-core.mjs) — identical logic to
  // decorate-graph and compact-project. A PROJECT.md with NO cache stamp always
  // refuses now (Hale's 2026-07-22 root fix — session timing cannot prove
  // authorship). A freshly-rendered PROJECT.md is writable because its render
  // step stamped it at creation (lifecycle-detect.mjs stampCreatedBaseline
  // --kind project); an un-stamped no-baseline PROJECT.md is held, not written.
  const decision = writeGuardDecision({ cachedStamp, classification });
  if (!decision.proceed) throw needsReconciliationError(path, decision.classification);
}

// The edit-detection cache records, per file, who last wrote it and a content
// hash. applyHotSection writes PROJECT.md on CORE's behalf via a script, so the
// agent's "I wrote it" reflex never fires for it — left unrecorded, next session's
// edit-detection reads CORE's own hot-section render as a USER edit and misfires
// anti-resurrection. We stamp CORE authorship here so edit-detection can tell the
// difference. (Edit-detection ALSO excludes the marker-delimited hot block — see
// startup.md §"Load — returning workspace"; this stamp is the corroborating record
// and keeps `last_written_by` honest about who actually touched PROJECT.md.)
//
// Shared-write concurrency (2026-07-14): the stamp lands in the PER-PROJECT cache
// at <project>/_memories/_lib/state-cache.json — a single-owner file, so two
// projects closing at once can't clobber each other's hashes (the old global
// ~/.core/state-cache.json write was an unlocked read-modify-write). For one
// release, readers take the UNION of per-project + global (newer last_written
// wins); each stamp also prunes its file's entry from the global cache under the
// lock, so the union converges to per-project.
// Content outside the marker-delimited hot block, hashed on its own (Hale's
// hot-section-edit-attribution finding, 2026-07-21). `last_written_by:
// hot-section` alone is NOT trustworthy evidence for a later hash mismatch —
// it only says who wrote the PREVIOUS cached bytes, not the current ones. A
// legitimate user edit made after a hot-section apply would carry that same
// stale label and get silently misclassified as CORE's own synthesis,
// directly violating the user-control invariant. This hash is the actual,
// mechanically-verifiable signal: hot-section.mjs never touches anything
// outside its own markers, by construction, so if this hash still matches
// the cached one, nothing outside the hot block changed — full stop,
// regardless of what `last_written_by` claims.
export function hashOutsideHotBlock(text) {
  const t = String(text || '');
  const scan = findExistingBlock(t);
  // A malformed marker state hashes the WHOLE text as "outside" — same as
  // decorate-graph.mjs's hashOutsideEdgesBlock. The writers refuse to touch a
  // malformed file anyway, so this only matters when comparing a pre-malform
  // stamp, which correctly falls through to "outside changed".
  const block = scan.ok ? scan.block : null;
  const outside = block ? t.slice(0, block.start) + t.slice(block.end) : t;
  return hashText(outside);
}

/**
 * Deterministic classifier for a PROJECT.md hash mismatch against the cached
 * stamp (DC-77: this is a critical trust-boundary decision, not something to
 * leave to prose interpretation). Returns:
 *   'no-baseline'       — no cached outside_hash to compare against (older
 *                          cache entry predating this fix, or never stamped).
 *   'hot-block-only'     — everything outside the hot block is byte-identical
 *                          to the last recorded write; safe to treat as
 *                          CORE's own synthesis regardless of the mismatch.
 *   'outside-changed'    — content outside the hot block changed since the
 *                          last stamp. hot-section.mjs cannot have produced
 *                          this; MUST be treated as a possible user edit.
 */
export function classifyProjectMdChange(cachedStamp, currentText) {
  if (!cachedStamp || typeof cachedStamp.outside_hash !== 'string') return 'no-baseline';
  return hashOutsideHotBlock(currentText) === cachedStamp.outside_hash ? 'hot-block-only' : 'outside-changed';
}

export function recordProjectMdWrite(projectMdPath, { now = null, home = homedir() } = {}) {
  const currentText = (() => {
    try { return readFileSync(projectMdPath, 'utf8'); } catch { return ''; }
  })();
  const projectDir = dirname(resolve(projectMdPath));
  // Shared stamp-and-prune plumbing lives in state-cache.mjs (extracted
  // 2026-07-22 so decorate-graph.mjs didn't need a second copy of the same
  // lock/prune logic). The domain-specific piece — hashing OUTSIDE the hot
  // block so a later mismatch can be classified correctly — stays here,
  // passed through as `extra.outside_hash`. Returns the truthful stamp outcome
  // (Hale's point 6) so a caller can surface an attribution-unknown state.
  return stampFile(
    projectDir,
    resolve(projectMdPath),
    hashText(currentText),
    'hot-section',
    { now, home, extra: { outside_hash: hashOutsideHotBlock(currentText) } },
  );
}

// ---------- Public API ----------

export function applyHotSection(projectDir, text, { now, allowOverBudget = false, home } = {}) {
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

  // Shared PROJECT.md writer lock + pre-write reconciliation check + strict
  // marker refusal + live-preimage CAS (Hale's points 2, 4, 7). Acquire the
  // ONE lock every PROJECT.md writer shares, classify the human-authored
  // region against the pre-write baseline, refuse a malformed marker state
  // byte-identically, and re-verify the on-disk bytes immediately before the
  // atomic write so an out-of-lock writer can't be laundered either.
  const { updated, applied, stampOutcome } = withProjectMdWriterLock(projectDir, () => {
    const { path, text: original } = readProjectMd(projectDir);
    // Strict marker refusal FIRST — a malformed marker state must never be
    // parsed-past, guessed at, or written over (Hale's point 4).
    const scan = findExistingBlock(original);
    if (!scan.ok) throw malformedHotMarkersError(resolve(path));
    assertReconciled(projectDir, resolve(path), original);
    const block = renderBlock(text, now || nowIso());
    const existing = scan.block;
    let next;
    if (existing) {
      next = original.slice(0, existing.start) + block + original.slice(existing.end);
    } else {
      // Insert before the first `## What & Why` heading. If that's missing,
      // append the block to the end (defensive — unusual but well-defined).
      const insertAt = original.indexOf('## What & Why');
      if (insertAt === -1) {
        next = original.endsWith('\n') ? original + '\n' + block : original + '\n\n' + block;
      } else {
        next = original.slice(0, insertAt) + block + original.slice(insertAt);
      }
    }
    let outcome = { stamped: true };
    if (next !== original) {
      // Live-preimage compare-and-swap (Hale's point 2): re-read right before
      // the atomic write and refuse if the bytes moved since `original` — a
      // stale write here would silently discard whatever moved them.
      const live = readFileSync(path, 'utf8');
      if (live !== original) throw needsReconciliationError(resolve(path), 'stale-preimage');
      atomicWriteFileSync(path, next);
      outcome = recordProjectMdWrite(path, { now, home });
    }
    return { updated: next, applied: next !== original, stampOutcome: outcome };
  });

  logEvent(projectDir, 'retrieval-log.jsonl', {
    kind: 'hot-section-synthesis',
    tokens,
    budget: HOT_SECTION_TOKEN_BUDGET,
    over_budget: tokens > HOT_SECTION_TOKEN_BUDGET,
    applied,
    attribution: stampOutcome && stampOutcome.stamped === false ? stampOutcome.outcome : 'ok',
  });
  // Truthful stamp-failure surfacing (Hale's point 6): the hot section landed
  // on disk but its authorship stamp did not, so next lifecycle pass will read
  // it as an unreconciled edit. Say so loudly rather than report clean success.
  if (applied && stampOutcome && stampOutcome.stamped === false) {
    process.stderr.write(
      `hot-section: WROTE PROJECT.md but the authorship stamp failed ` +
      `(${stampOutcome.outcome}: ${stampOutcome.reason}) — attribution unknown, ` +
      `recovery-required: a reconcile/re-stamp is owed before the next render.\n`
    );
  }
  return updated;
}

export function currentHotSection(projectDir) {
  const { text } = readProjectMd(projectDir);
  const scan = findExistingBlock(text);
  // A malformed marker state can't be safely parsed — return empty rather than
  // guess at which BEGIN/END pair is "the" hot block.
  if (!scan.ok || !scan.block) return '';
  const inner = text.slice(text.indexOf(HOT_BEGIN) + HOT_BEGIN.length, text.indexOf(HOT_END));
  // Strip the `## Right now` heading and the `*Synthesized ...*` footer to
  // return just the composed body.
  return inner
    .replace(new RegExp(`^\\s*${HOT_HEADING}\\s*`), '')
    .replace(/\n\s*\*Synthesized [^*]+\*\s*$/, '')
    .trim();
}

export function clearHotSection(projectDir, { now, home } = {}) {
  return withProjectMdWriterLock(projectDir, () => {
    const { path, text: original } = readProjectMd(projectDir);
    const scan = findExistingBlock(original);
    // Strict marker refusal, same as applyHotSection (Hale's point 4): never
    // clear over a malformed/ambiguous marker state.
    if (!scan.ok) throw malformedHotMarkersError(resolve(path));
    if (!scan.block) return original;
    // Same authorship-boundary check as applyHotSection: a clear also
    // rewrites (removes) the generated region and re-stamps — it must not
    // do so over a human-authored region that already diverged unreconciled.
    assertReconciled(projectDir, resolve(path), original);
    const updated = original.slice(0, scan.block.start) + original.slice(scan.block.end);
    if (updated !== original) {
      // Live-preimage CAS (Hale's point 2).
      const live = readFileSync(path, 'utf8');
      if (live !== original) throw needsReconciliationError(resolve(path), 'stale-preimage');
      atomicWriteFileSync(path, updated);
      // Hale's second finding, same audit: clearHotSection wrote PROJECT.md but
      // never stamped the cache, leaving `last_hash`/`outside_hash` permanently
      // stale after a clear — edit-detection would then misread the clear
      // itself as an unattributed change on the very next check.
      recordProjectMdWrite(path, { now, home });
    }
    return updated;
  });
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
  try {
    applyHotSection(projectDir, text);
  } catch (e) {
    if (e.code === 'NEEDS_RECONCILIATION' || e.code === 'MALFORMED_HOT_MARKERS') {
      process.stderr.write(`hot-section: refusing to apply — ${e.message}\n`);
      return 1;
    }
    throw e;
  }
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
  try {
    clearHotSection(projectDir);
  } catch (e) {
    if (e.code === 'NEEDS_RECONCILIATION' || e.code === 'MALFORMED_HOT_MARKERS') {
      process.stderr.write(`hot-section: refusing to clear — ${e.message}\n`);
      return 1;
    }
    throw e;
  }
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
