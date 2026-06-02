/**
 * metrics-detectors.mjs — Layer 2 silent-failure detectors.
 *
 * Standard observability is "X happened, log it." Silent-failure detection is
 * "X should have happened given Y — did it?" This module runs the process-failure
 * detectors that have a crisp ground truth (spec §8, §17.12). Three gold detectors:
 *
 *   citation-resolver    — every DC-XX / R-XX / [[name]] the agent asserted is
 *                          resolved against the unit store. A broken reference inside
 *                          a confident assertion is a silent-citation-failure.
 *
 *   stale-context        — every unit the agent read (via tool calls) that hasn't been
 *                          updated in > STALE_THRESHOLD_DAYS AND whose status is not
 *                          final/stable. Flags stale material presented as current.
 *
 *   anticipation-gap     — project-vocabulary terms the user had to introduce because
 *                          the agent hadn't surfaced them first. Heuristic proxy for
 *                          "the agent should have raised this unprompted."
 *
 * Privacy-gated (spec §18) and fail-open. Per DC-77 ships with the plugin;
 * per DC-80 .mjs only.
 *
 * CLI:  node metrics-detectors.mjs <project> [--harness claude-code|codex] [--json]
 */

import { readdirSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTranscript } from './read-transcript.mjs';
import { todayUTC, resolveSessionId, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';

export const DETECTOR_VERSION = '0.2.0';

// ============================================================
// Citation resolver
// ============================================================

const CITATION_RE = /\bDC-(\d+)\b|\bR-(\d+)\b|\[\[([^\]]+)\]\]/g;

/** Extract every unit-citation the agent made. Returns [{raw, kind, key}]. */
export function extractCitations(text) {
  const out = [];
  if (!text) return out;
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text))) {
    if (m[1]) out.push({ raw: m[0], kind: 'decision', key: `dc-${m[1]}` });
    else if (m[2]) out.push({ raw: m[0], kind: 'risk', key: `risk-${m[2]}` });
    else if (m[3]) out.push({ raw: m[0], kind: 'wikilink', key: m[3].trim().toLowerCase() });
  }
  return out;
}

/**
 * Index the unit store: the set of unit ids (filenames sans .md, lowercased) and
 * the set of claim-keys (`dc-<n>`, `risk-<n>`) derived from those filenames so a
 * `DC-104` citation resolves to `dc-104-harness-agnostic-...md`.
 */
export function buildUnitIndex(memoriesDir) {
  const ids = new Set();
  const claimKeys = new Set();
  walkMd(memoriesDir, (name) => {
    const id = name.replace(/\.md$/, '').toLowerCase();
    ids.add(id);
    const m = id.match(/^(dc|risk|r)-(\d+)/);
    if (m) claimKeys.add(`${m[1] === 'r' ? 'risk' : m[1]}-${m[2]}`);
  });
  return { ids, claimKeys };
}

/** Does a citation resolve to a real unit? */
export function resolveCitation(citation, index) {
  if (citation.kind === 'wikilink') {
    if (index.ids.has(citation.key)) return true;
    for (const id of index.ids) if (id.startsWith(citation.key)) return true;
    return false;
  }
  return index.claimKeys.has(citation.key);
}

export function runCitationResolver(events, index) {
  const broken = [];
  const seen = new Set();
  for (const ev of events || []) {
    if (ev.role !== 'assistant' || ev.kind !== 'text') continue;
    for (const c of extractCitations(ev.text)) {
      if (seen.has(c.raw)) continue;
      seen.add(c.raw);
      if (!resolveCitation(c, index)) broken.push(c);
    }
  }
  return broken;
}

// ============================================================
// Stale-context tripwire
// ============================================================

export const STALE_THRESHOLD_DAYS = 30;

const STABLE_STATUSES = new Set(['final', 'stable', 'foundational', 'closed', 'archived', 'superseded']);

/** Parse the minimal frontmatter we need from a unit file. */
export function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

function daysBetween(dateStr, today) {
  try {
    const then = new Date(dateStr + 'T00:00:00Z');
    const now = new Date(today + 'T00:00:00Z');
    if (isNaN(then.getTime()) || isNaN(now.getTime())) return 0;
    return (now - then) / (1000 * 60 * 60 * 24);
  } catch { return 0; }
}

function isStableUnit(fm) {
  return STABLE_STATUSES.has((fm.status || '').toLowerCase()) ||
    STABLE_STATUSES.has((fm['stability-class'] || '').toLowerCase());
}

/**
 * Extract relative paths inside `_memories/` from tool-event text.
 * Matches  _memories/foo.md  and  _memories/subdir/foo.md  (forward or back slash).
 */
export function extractReadUnitFilenames(events) {
  const names = new Set();
  const RE = /_memories[/\\]([^\s"',)<>]+\.md)/gi;
  for (const ev of events || []) {
    if (ev.kind !== 'tool') continue;
    const text = ev.text || '';
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(text))) names.add(m[1].replace(/\\/g, '/'));
  }
  return [...names];
}

/**
 * For each unit the agent read this session, check if it's stale. Two signals:
 *   - superseded (HIGH): the unit's bi-temporal t_invalid is in the past — the
 *     fact stopped being true, yet the agent read it this session. This is the
 *     sharp signal (Phase 4 layer 1 feeding Phase 2): reading a fact known to be
 *     superseded is a stronger miss than mere age.
 *   - aged (MEDIUM): updated > thresholdDays ago AND status not final/stable.
 * Returns [{filename, reason, days_stale, status, t_invalid?}].
 */
export function runStaleContextTripwire(events, memoriesDir, today, thresholdDays = STALE_THRESHOLD_DAYS) {
  const filenames = extractReadUnitFilenames(events);
  if (!filenames.length) return [];

  const stale = [];
  for (const relpath of filenames) {
    let content;
    try { content = readFileSync(join(memoriesDir, relpath), 'utf8'); } catch { continue; }
    const fm = parseFrontmatter(content);

    // Superseded signal first (bi-temporal): t_invalid in the past, regardless of age.
    const tInvalid = fm.t_invalid ? String(fm.t_invalid).trim() : null;
    if (tInvalid && /^\d{4}-\d{2}-\d{2}$/.test(tInvalid) && tInvalid <= today) {
      stale.push({
        filename: relpath,
        reason: 'superseded',
        t_invalid: tInvalid,
        days_stale: Math.round(daysBetween(tInvalid, today)),
        status: fm.status || '?',
      });
      continue; // superseded subsumes aged — don't double-report
    }

    if (isStableUnit(fm)) continue;
    const updated = fm.updated || fm.created;
    if (!updated) continue;
    const days = daysBetween(updated, today);
    if (days > thresholdDays) {
      stale.push({
        filename: relpath,
        reason: 'aged',
        updated,
        days_stale: Math.round(days),
        status: fm.status || '?',
        stability_class: fm['stability-class'] || null,
      });
    }
  }
  return stale;
}

// ============================================================
// Anticipation-gap detector
// ============================================================

// Short/common tokens unlikely to be meaningful project vocabulary.
const GAP_STOPWORDS = new Set([
  'this', 'that', 'have', 'with', 'from', 'been', 'were', 'into',
  'when', 'then', 'than', 'they', 'them', 'some', 'more', 'also',
  'each', 'will', 'your', 'what', 'over', 'make', 'like', 'back',
  'only', 'just', 'both', 'same', 'high', 'open', 'next', 'last',
  // Generic CORE-domain words that appear in nearly every unit filename —
  // including them makes the detector fire on almost any project prompt.
  'core', 'project', 'memory', 'skill', 'skills', 'plugin', 'agent',
  'user', 'session', 'unit', 'units', 'system', 'work',
]);

// A term is distinctive only if it appears in at most this fraction of units.
// Words that show up across a large share of the corpus (project, memory, core)
// are generic noise, not the foundational nouns the spec's anticipation-gap
// signal is meant to catch ("severity scaled by how foundational").
export const MAX_DOC_FREQUENCY_FRACTION = 0.05;

/**
 * Build the distinctive-term vocabulary from unit filenames. Splits each filename
 * on hyphens (after stripping the type prefix + number), then keeps only terms
 * whose document frequency is below MAX_DOC_FREQUENCY_FRACTION of the corpus.
 * Returns a Set<string> of distinctive terms (so `.has()` answers "is this a
 * distinctive project term"). Rarity filtering is what kills the generic-word
 * over-fire on a large corpus while leaving small corpora (every term df=1) intact.
 */
export function buildVocabulary(memoriesDir) {
  const df = new Map(); // term -> count of units it appears in
  let unitCount = 0;
  try {
    walkMd(memoriesDir, (name) => {
      unitCount += 1;
      const base = name.replace(/\.md$/, '');
      const stripped = base.replace(/^(dc|risk|r|obs|rf)-[\d-]*/, '');
      const seen = new Set();
      for (const token of stripped.split('-')) {
        const t = token.toLowerCase();
        if (t.length >= 4 && !GAP_STOPWORDS.has(t)) seen.add(t);
      }
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    });
  } catch { /* ignore — fail open */ }

  // Threshold: at most MAX_DOC_FREQUENCY_FRACTION of units, with a floor of 3 so
  // small corpora (where every term is df=1) keep all their terms.
  const maxDf = Math.max(3, Math.ceil(unitCount * MAX_DOC_FREQUENCY_FRACTION));
  const vocab = new Set();
  for (const [term, count] of df) {
    if (count <= maxDf) vocab.add(term);
  }
  return vocab;
}

function tokenizeText(text) {
  return (text || '').toLowerCase().split(/\W+/).filter((t) => t.length >= 4);
}

// A "user" turn that is really skill/command-injection scaffold, not a person
// typing. These carry the harness's command sentinels or a skill's loaded prose;
// counting them as "the user introduced material" is a category error (it's the
// single biggest anticipation-gap over-fire source — every /command turn fires).
const COMMAND_INJECTION_RE = /<command-(name|message|args)>|Base directory for this skill:|<system-reminder>|This is the runtime half of/i;

export function isCommandInjection(text) {
  return COMMAND_INJECTION_RE.test(text || '');
}

/** Pair events into turns: {userText, assistantText}. */
function pairTurnsLocal(events) {
  const turns = [];
  let cur = null;
  for (const ev of events || []) {
    if (ev.role === 'user' && ev.kind === 'text') {
      if (cur) turns.push(cur);
      cur = { userText: ev.text || '', assistantText: '' };
    } else if (ev.role === 'assistant' && ev.kind === 'text') {
      if (cur) {
        cur.assistantText += '\n' + (ev.text || '');
      } else {
        // Leading assistant turn (e.g. bootstrap), track its mentions.
        turns.push({ userText: '', assistantText: ev.text || '' });
      }
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

/**
 * Detect turns where the user introduced project-vocabulary terms the agent
 * hadn't surfaced in prior turns. Returns [{turnIdx, terms}].
 *
 * Heuristic: term is in the vocabulary (unit filenames), appears in user
 * text this turn, and the agent hasn't mentioned it in any prior turn.
 */
export function runAnticipationGap(events, memoriesDir) {
  const vocab = buildVocabulary(memoriesDir);
  if (!vocab.size) return [];

  const turns = pairTurnsLocal(events);
  const gaps = [];
  const agentMentioned = new Set();

  for (let i = 0; i < turns.length; i++) {
    const { userText, assistantText } = turns[i];

    if (userText && !isCommandInjection(userText)) {
      const missed = [];
      for (const word of tokenizeText(userText)) {
        if (vocab.has(word) && !agentMentioned.has(word)) missed.push(word);
      }
      if (missed.length) gaps.push({ turnIdx: i, terms: [...new Set(missed)] });
    }

    // Accumulate what the agent mentions in this turn's response.
    for (const word of tokenizeText(assistantText)) {
      if (vocab.has(word)) agentMentioned.add(word);
    }
  }

  return gaps;
}

// ============================================================
// Absence-with-deadline detector (Phase 4 layer 4, concrete half)
// ============================================================

/**
 * Walk active open-question units with a `by-when` in the past. The startup
 * protocol already surfaces these at /orient; promoting it to a Layer-2 detector
 * makes the lapse a captured, escalatable event rather than a read-time-only
 * glance. The register-trigger half of the layer stays gated on DC-103.
 *
 * Returns [{filename, by_when, days_overdue}].
 */
export function runAbsenceWithDeadline(memoriesDir, today) {
  const out = [];
  walkMd(memoriesDir, (name, full) => {
    let content;
    try { content = readFileSync(full, 'utf8'); } catch { return; }
    const fm = parseFrontmatter(content);
    if ((fm.type || '').toLowerCase() !== 'open-question') return;
    if ((fm.status || 'active').toLowerCase() !== 'active') return;
    const byWhen = fm['by-when'] ? String(fm['by-when']).trim() : null;
    if (!byWhen || !/^\d{4}-\d{2}-\d{2}$/.test(byWhen)) return;
    if (byWhen < today) out.push({ filename: name, by_when: byWhen, days_overdue: Math.round(daysBetween(byWhen, today)) });
  }, 0, true);
  return out;
}

// ============================================================
// Shared helpers
// ============================================================

function walkMd(dir, cb, depth = 0, withPath = false) {
  if (depth > 5) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) walkMd(join(dir, e.name), cb, depth + 1, withPath);
    else if (e.name.endsWith('.md') && !e.name.startsWith('INDEX')) cb(e.name, join(dir, e.name));
  }
}

// ============================================================
// Unified runner
// ============================================================

export function runDetectors({ project, harness = 'claude-code', cwd, home = homedir(), sessionId, today, workspaceId, env }) {
  if (!metricsEnabled({ project, env })) {
    return { status: 'DISABLED', reason: 'metrics opt-in not set' };
  }
  const t = readTranscript({ harness, cwd: cwd || project, home });
  if (!t.available) return { status: 'UNAVAILABLE', reason: 'transcript unavailable' };

  const memoriesDir = join(project, '_memories');
  const index = buildUnitIndex(memoriesDir);
  const sid = resolveSessionId({ explicit: sessionId });
  const date = today || todayUTC();
  const wid = workspaceId || resolveWorkspaceId(project);

  const brokenCitations = runCitationResolver(t.events, index);
  const staleUnits = runStaleContextTripwire(t.events, memoriesDir, date);
  const anticipationGaps = runAnticipationGap(t.events, memoriesDir);
  const lapsedDeadlines = runAbsenceWithDeadline(memoriesDir, date);

  const records = [
    ...brokenCitations.map((c) => ({
      schema_version: '1.0.0',
      detector: 'citation-resolver',
      detector_version: DETECTOR_VERSION,
      session_id: sid,
      severity: 'high',
      raw: c.raw,
      kind: c.kind,
      key: c.key,
    })),
    ...staleUnits.map((s) => ({
      schema_version: '1.0.0',
      detector: 'stale-context',
      detector_version: DETECTOR_VERSION,
      session_id: sid,
      severity: s.reason === 'superseded' ? 'high' : 'medium',
      reason: s.reason,
      filename: s.filename,
      updated: s.updated || null,
      t_invalid: s.t_invalid || null,
      days_stale: s.days_stale,
      status: s.status,
      stability_class: s.stability_class || null,
    })),
    ...anticipationGaps.map((g) => ({
      schema_version: '1.0.0',
      detector: 'anticipation-gap',
      detector_version: DETECTOR_VERSION,
      session_id: sid,
      severity: 'low',
      provisional: true, // heuristic — filename-token match, not calibrated; never surface as graded
      turn_idx: g.turnIdx,
      terms: g.terms,
    })),
    ...lapsedDeadlines.map((d) => ({
      schema_version: '1.0.0',
      detector: 'absence-with-deadline',
      detector_version: DETECTOR_VERSION,
      session_id: sid,
      severity: 'high', // an open question past its committed date
      filename: d.filename,
      by_when: d.by_when,
      days_overdue: d.days_overdue,
    })),
  ];

  try {
    const dir = join(operationalMetricsDir(wid, { home }), 'detectors');
    mkdirSync(dir, { recursive: true });
    for (const r of records) appendFileSync(join(dir, `${date}.jsonl`), JSON.stringify(r) + '\n');
  } catch { /* best-effort */ }

  return {
    status: 'OK',
    workspace_id: wid,
    broken_citations: brokenCitations.length,
    stale_units: staleUnits.length,
    anticipation_gaps: anticipationGaps.length,
    lapsed_deadlines: lapsedDeadlines.length,
    records,
    unit_count: index.ids.size,
  };
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const r = runDetectors({ project, harness: opt('harness') || 'claude-code' });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (r.status !== 'OK') process.stdout.write(`metrics-detectors: ${r.status} (${r.reason})\n`);
  else {
    if (r.broken_citations === 0) process.stdout.write(`citation-resolver: clean (${r.unit_count} units indexed)\n`);
    else {
      process.stdout.write(`citation-resolver: ${r.broken_citations} broken reference(s):\n`);
      for (const c of r.records.filter((x) => x.detector === 'citation-resolver'))
        process.stdout.write(`  ✖ ${c.raw}\n`);
    }
    if (r.stale_units === 0) process.stdout.write(`stale-context: clean\n`);
    else {
      process.stdout.write(`stale-context: ${r.stale_units} stale unit(s) read this session:\n`);
      for (const s of r.records.filter((x) => x.detector === 'stale-context')) {
        const tag = s.reason === 'superseded'
          ? `SUPERSEDED ${s.t_invalid} (${s.days_stale}d ago)`
          : `aged ${s.days_stale}d, status: ${s.status}`;
        process.stdout.write(`  ⚠ ${s.filename} — ${tag}\n`);
      }
    }
    if (r.anticipation_gaps === 0) process.stdout.write(`anticipation-gap: clean\n`);
    else process.stdout.write(`anticipation-gap [PROVISIONAL — heuristic, uncalibrated]: ${r.anticipation_gaps} turn(s) where user introduced a distinctive project term first\n`);
    if (r.lapsed_deadlines === 0) process.stdout.write(`absence-with-deadline: clean\n`);
    else {
      process.stdout.write(`absence-with-deadline: ${r.lapsed_deadlines} open question(s) past their by-when:\n`);
      for (const d of r.records.filter((x) => x.detector === 'absence-with-deadline'))
        process.stdout.write(`  ⚠ ${d.filename} — due ${d.by_when} (${d.days_overdue}d overdue)\n`);
    }
  }
  process.exit(0);
}
