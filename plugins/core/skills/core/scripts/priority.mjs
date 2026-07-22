/**
 * Priority function for CORE memory units, per DC-69.
 *
 * priority(unit, t) = w_R · R + w_F · F + w_S · S + w_A · A + P
 *
 * R = exp(-recency_days / τ), τ=60 days.
 * F = distinct surface-types the unit appears in, normalized by 6.
 * S = source-type weight (PROJECT.md=1.0 … transcript=0.2).
 * A = Jaccard overlap of unit topics with session-intent topics.
 * P = pin contribution (floor 0.7 / floor 0.9 / override 1.5; pinned:false is neutral).
 *
 * Per DC-77 the script lives in the plugin, not per-project.
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { scoreUnitFile, scoreProxyRS } from './priority.mjs';
 *   const s = scoreUnitFile('_memories/dc-67-no-mcp.md',
 *                           { sessionTopics: ['memory-architecture'] });
 *
 * CLI:
 *   node priority.mjs <project>/_memories/ [--top N] [--intent t1,t2,...]
 *                     [--today YYYY-MM-DD] [--sections] [--top-per-section N]
 *                     [--log <path>] [--log-label <string>] [--include-invalid]
 *
 * --log appends one JSONL audit entry per invocation to <path>. Useful for
 * render-on-change observability — protocols/data-storage.md §PROJECT.md ↔ units
 * rendering names the suggested log location.
 */

import { readFileSync, readdirSync, appendFileSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isActiveStatus } from './unit-vocab.mjs';

// ---------- DC-69 constants ----------

export const W_R = 0.30;
export const W_F = 0.15;
export const W_S = 0.20;
export const W_A = 0.35;
export const TAU_DAYS = 60.0;
export const SCORE_PRUNE_THRESHOLD = 0.3;

const SOURCE_TYPE_WEIGHTS = {
  'PROJECT.md': 1.0,
  configuration: 0.9,
  operational: 0.7,
  summary: 0.5,
  output: 0.5,
  session_log: 0.3,
  transcript: 0.2,
};

const PIN_CONTRIBUTION = {
  floor: ['floor', 0.7],
  true: ['floor', 0.9],
  always: ['override', 1.5],
  // `pinned: false` is NEUTRAL by decision (MEM-005, 2026-06-09): the
  // multiply-0.3 demotion DC-69 sketched was never reachable — pinContribution
  // short-circuits false to ['none', 0.0] — no live unit uses pinned:false,
  // and silently activating a 70% penalty would be an unasked-for behavior
  // change. DC-69's unit (CORE workshop store) is to be amended to record
  // "false → neutral"; this table row was dead code and is gone.
};

// ---------- Frontmatter parsing ----------

function _coerce(value) {
  const t = value.trim();
  // Flow-style YAML array: `[a, b, c]` → ['a','b','c']. Without this the bracketed
  // form is kept as a scalar string, and downstream list checks (e.g. check-units
  // topics-format) false-warn on perfectly valid inline arrays.
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => _coerce(s)).filter((s) => s !== '');
  }
  const v = t.replace(/^["']|["']$/g, '');
  const lo = v.toLowerCase();
  if (lo === 'true') return true;
  if (lo === 'false') return false;
  const i = Number(v);
  if (!isNaN(i) && v !== '') return i;
  return v;
}

function _parseInlineMap(text) {
  const result = {};
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && (text[i] === ' ' || text[i] === ',')) i++;
    if (i >= n) break;
    const colon = text.indexOf(':', i);
    if (colon === -1) break;
    const key = text.slice(i, colon).trim();
    i = colon + 1;
    while (i < n && text[i] === ' ') i++;
    let val;
    if (i < n && text[i] === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\' && j + 1 < n) { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      val = text.slice(i + 1, j);
      i = j + 1;
    } else {
      let j = i;
      while (j < n && text[j] !== ',') j++;
      val = text.slice(i, j).trim();
      i = j;
    }
    if (key) result[key] = val;
  }
  return result;
}

/** Normalize CRLF (and lone CR) to LF so frontmatter delimiter detection and
 *  line splitting work on Windows/OneDrive-authored units (review M1). */
export function normalizeNewlines(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : text;
}

// priority.mjs owns its own frontmatter parser (rather than importing frontmatter-flat.mjs)
// on purpose: priority is the base unit module that many scripts — including the parser's
// other callers — import, so taking a dependency the other way risks an import cycle. Both
// parsers normalize CRLF, so they agree on behavior; this is a deliberate duplication, not drift.
export function parseFrontmatter(rawText) {
  const text = normalizeNewlines(rawText);
  if (!text.startsWith('---\n')) return [{}, text];
  const end = text.indexOf('\n---', 4);
  if (end === -1) return [{}, text];
  const rawFm = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n+/, '');
  const fm = {};
  let currentList = null;
  let currentDict = null;

  for (const line of rawFm.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const stripped = line.trim();
    if (indent === 0) {
      currentDict = null;
      if (!stripped.includes(':')) continue;
      const colonIdx = stripped.indexOf(':');
      const k = stripped.slice(0, colonIdx).trim();
      const v = stripped.slice(colonIdx + 1).trim();
      if (v === '') {
        currentList = [];
        fm[k] = currentList;
      } else {
        fm[k] = _coerce(v);
        currentList = null;
      }
    } else if (stripped.startsWith('- ')) {
      const item = stripped.slice(2).trim();
      if (item.startsWith('{') && item.endsWith('}')) {
        currentDict = _parseInlineMap(item.slice(1, -1));
        if (currentList !== null) currentList.push(currentDict);
      } else if (item.includes(':') && !item.startsWith('http')) {
        const colonIdx = item.indexOf(':');
        const k = item.slice(0, colonIdx).trim();
        const v = item.slice(colonIdx + 1).trim();
        currentDict = { [k]: _coerce(v) };
        if (currentList !== null) currentList.push(currentDict);
      } else {
        if (currentList !== null) currentList.push(_coerce(item));
        currentDict = null;
      }
    } else if (currentDict !== null && stripped.includes(':')) {
      const colonIdx = stripped.indexOf(':');
      const k = stripped.slice(0, colonIdx).trim();
      const v = stripped.slice(colonIdx + 1).trim();
      currentDict[k] = _coerce(v);
    }
  }
  return [fm, body];
}

export function loadUnit(path) {
  const text = readFileSync(path, 'utf8');
  const [fm, body] = parseFrontmatter(text);
  const id = fm.id !== undefined ? String(fm.id) : basename(path, '.md');
  return { path, fm, body, id };
}

// ---------- Signal computations ----------

export function parseIsoDate(s) {
  if (!s) return null;
  const str = String(s).trim();
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

function _todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function recencyDays(unit, today) {
  const candidates = [
    parseIsoDate(unit.fm.last_accessed),
    parseIsoDate(unit.fm.updated),
    parseIsoDate(unit.fm.created),
  ].filter(Boolean);
  if (!candidates.length) return 365.0;
  const freshest = new Date(Math.max(...candidates.map(d => d.getTime())));
  return Math.max(0, (today.getTime() - freshest.getTime()) / 86_400_000);
}

export function signalR(unit, today) {
  return Math.exp(-recencyDays(unit, today) / TAU_DAYS);
}

export function signalF(unit) {
  const sources = Array.isArray(unit.fm.sources) ? unit.fm.sources : [];
  const surfacesSeen = new Set();
  for (const src of sources) {
    if (typeof src !== 'string') continue;
    const s = src.toLowerCase();
    if (s.includes('project.md')) surfacesSeen.add('PROJECT.md');
    else if (s.includes('dm-profile')) surfacesSeen.add('dm-profile');
    else if (s.includes('summary') || s.includes('handoff')) surfacesSeen.add('summaries');
    else if (s.includes('session')) surfacesSeen.add('sessions');
    else if (s.includes('output') || s.startsWith('outputs/')) surfacesSeen.add('outputs');
    else if (s.includes('inbox')) surfacesSeen.add('inbox');
  }
  return surfacesSeen.size / 6.0;
}

// MEM-018: a unit with NO sources used to default to 0.5 — equal to an
// explicitly summary-sourced unit, so unknown provenance ranked as well as
// known-good provenance on the S dimension. Unknown now scores the
// session_log tier: below summary (0.5), above transcript (0.2).
export const NO_SOURCES_DEFAULT_S = 0.3;

export function signalS(unit) {
  // A scalar `sources: PROJECT.md` (string, not list) is valid-but-informal
  // frontmatter — coerce it to a single-element list so it scores as one
  // source instead of silently falling to NO_SOURCES_DEFAULT_S.
  const raw = unit.fm.sources;
  const sources = Array.isArray(raw) ? raw
    : (typeof raw === 'string' && raw.trim() !== '') ? [raw]
    : [];
  let best = 0.0;
  for (const src of sources) {
    if (typeof src !== 'string') continue;
    const s = src.toLowerCase();
    if (s.includes('project.md')) best = Math.max(best, SOURCE_TYPE_WEIGHTS['PROJECT.md']);
    else if (s.includes('dm-profile') || s.includes('settings') || s.includes('config')) best = Math.max(best, SOURCE_TYPE_WEIGHTS.configuration);
    else if (s.includes('swarm-effectiveness') || s.includes('dream-cycle')) best = Math.max(best, SOURCE_TYPE_WEIGHTS.operational);
    else if (s.includes('summary') || s.includes('handoff') || s.includes('output') || s.startsWith('outputs/')) best = Math.max(best, SOURCE_TYPE_WEIGHTS.summary);
    else if (s.includes('session')) best = Math.max(best, SOURCE_TYPE_WEIGHTS.session_log);
  }
  return best > 0 ? best : NO_SOURCES_DEFAULT_S;
}

export function signalA(unit, sessionTopics) {
  const unitTopics = new Set(Array.isArray(unit.fm.topics) ? unit.fm.topics : []);
  const session = new Set(sessionTopics);
  if (!unitTopics.size || !session.size) return 0.0;
  let intersection = 0;
  for (const t of unitTopics) { if (session.has(t)) intersection++; }
  const union = new Set([...unitTopics, ...session]).size;
  return intersection / union;
}

export function pinContribution(unit) {
  const pin = unit.fm.pinned;
  if (pin === null || pin === undefined || pin === false) return ['none', 0.0];
  const key = String(pin).toLowerCase();
  return PIN_CONTRIBUTION[key] || ['none', 0.0];
}

// ---------- Main scoring function ----------

export function score(unit, sessionTopics = [], today = null) {
  const t = today || _todayUTC();
  const R = signalR(unit, t);
  const F = signalF(unit);
  const S = signalS(unit);
  const A = signalA(unit, sessionTopics);
  const [pinMode, pinVal] = pinContribution(unit);

  const base = W_R * R + W_F * F + W_S * S + W_A * A;

  if (pinMode === 'override') return pinVal;
  if (pinMode === 'floor') return Math.max(base, pinVal);
  if (pinMode === 'multiply') return base * pinVal;
  return base;
}

export function scoreUnitFile(path, { sessionTopics = [], today = null } = {}) {
  return score(loadUnit(path), sessionTopics, today);
}

export function scoreProxyRS(unit, today = null) {
  const t = today || _todayUTC();
  return signalR(unit, t) * signalS(unit);
}

export function extractEdges(unit) {
  const edgesRaw = unit.fm.edges;
  if (!Array.isArray(edgesRaw)) return [];
  const result = [];
  for (const item of edgesRaw) {
    if (!item || typeof item !== 'object') continue;
    if (item.type && item.target) {
      result.push({ type: String(item.type), target: String(item.target), note: String(item.note || '') });
    }
  }
  return result;
}

// ---------- Validity dimension (read-time predicates) ----------
//
// Validity (t_valid/t_invalid) is a unit dimension — the same kind of thing as
// topics or confidence-level. Its read predicates live here in the canonical
// unit module so every reader (priority, retrieval suppression, bitemporal CLI,
// impact-trace, hygiene) shares ONE definition instead of re-deriving it. Per
// the validity-dimension consolidation (2026-06-02): no second store-walk, no
// parallel "bi-temporal layer."
//
//   t_valid    when the fact became true in the world. Defaults to `created`
//              (computed here, NOT stored) — for a fact born from conversation
//              or a local file, "when it became true" is when CORE recorded it.
//              Written explicitly only when world-time diverges from record-time
//              (the overlay case: an extractor reading a source's own timestamp).
//   t_invalid  when the fact stopped being true. Empty while it holds; stamped
//              by supersession (B supersedes A ⇒ A.t_invalid = B.t_valid).

/**
 * The effective world-time validity interval for a unit. t_valid defaults to
 * created when not explicitly set; t_invalid is null (open) until supersession
 * stamps it.
 * @returns {{ t_valid: string|null, t_invalid: string|null }} ISO date strings
 */
export function effectiveValidity(unit) {
  const fm = unit.fm || {};
  const tValid = fm.t_valid ? String(fm.t_valid).trim() : (fm.created ? String(fm.created).trim() : null);
  const tInvalid = fm.t_invalid ? String(fm.t_invalid).trim() : null;
  return { t_valid: tValid, t_invalid: tInvalid };
}

/** Was this unit valid at `dateStr`? t_valid <= date AND (t_invalid is null OR date < t_invalid). */
export function validAt(unit, dateStr) {
  const date = parseIsoDate(dateStr);
  if (!date) return false;
  const { t_valid, t_invalid } = effectiveValidity(unit);
  const vFrom = parseIsoDate(t_valid);
  if (vFrom && date.getTime() < vFrom.getTime()) return false;
  if (t_invalid) {
    const vTo = parseIsoDate(t_invalid);
    if (vTo && date.getTime() >= vTo.getTime()) return false;
  }
  return true;
}

/** Is this unit invalidated as of `today` (t_invalid in the past)? */
export function isInvalidated(unit, today) {
  const { t_invalid } = effectiveValidity(unit);
  if (!t_invalid) return false;
  const vTo = parseIsoDate(t_invalid);
  return !!vTo && vTo.getTime() <= today.getTime();
}

// ---------- Section mapping for PROJECT.md render ----------

const TYPE_TO_SECTION = {
  decision: 'Decisions & Risks',
  risk: 'Decisions & Risks',
  person: 'People',
  deliverable: 'Moves',
  principle: 'Notes',
  explainer: 'Notes',
  'review-finding': 'Notes',
  observation: 'Notes',
  topic: 'Notes',
  reference: 'Notes',
  feedback: 'Notes',
  memory: 'Notes',
};

const PREFIX_TO_SECTION = [
  ['dc-', 'Decisions & Risks'],
  ['risk-', 'Decisions & Risks'],
  ['who-', 'People'],
  ['del-', 'Moves'],
  ['rf-', 'Notes'],
  ['exp-', 'Notes'],
  ['pr-', 'Notes'],
  ['obs-', 'Notes'],
  ['topic-', 'Notes'],
];

export function unitSection(unit) {
  const typ = String(unit.fm.type || '').toLowerCase();
  if (TYPE_TO_SECTION[typ]) return TYPE_TO_SECTION[typ];
  const stem = basename(String(unit.path), '.md').toLowerCase();
  for (const [prefix, section] of PREFIX_TO_SECTION) {
    if (stem.startsWith(prefix)) return section;
  }
  return 'Notes';
}

// ---------- Unit iteration ----------

export function iterUnits(memoriesDir) {
  const units = [];
  for (const fname of readdirSync(memoriesDir).sort()) {
    if (!fname.endsWith('.md')) continue;
    if (fname.startsWith('_') || fname.startsWith('INDEX') || fname === 'README.md') continue;
    const path = join(memoriesDir, fname);
    try {
      const u = loadUnit(path);
      if (!Object.keys(u.fm).length) {
        // Malformed/absent frontmatter parses to an empty map and would score
        // on pure defaults, surfacing unflagged in ranked output (MEM-011).
        // Tag it so rankUnits() excludes it; the stderr warn makes the damage
        // visible (check-units reports the same file as a schema failure).
        u.fm._load_error = true;
        process.stderr.write(`warn: ${fname}: no parseable frontmatter — excluded from ranking\n`);
      }
      units.push(u);
    } catch (e) {
      // The old bare catch swallowed read failures silently (MEM-011).
      process.stderr.write(`warn: ${fname}: failed to load (${e && e.message ? e.message : e}) — excluded from ranking\n`);
    }
  }
  return units;
}

/**
 * iterArchivedUnits — the ONE archive-aware companion to iterUnits, for the
 * explicit-history modes only (Hale's 2026-07-21 finding): retired-in-active
 * enforcement (check-units.mjs) actively pushes retired units into
 * `archive/`, but iterUnits is top-level-only by design (default retrieval
 * must stay non-recursive, per ARCHITECTURE.md/data-storage.md). Once a unit
 * physically moves to `archive/`, it silently disappeared from every
 * "--include-invalid" / cold-history caller too, not just default retrieval
 * -- that's a real regression for a memory product whose MVP is complete
 * recall, not a side effect of "cleanup." Callers that mean to see cold
 * history (rankUnits with includeInvalidated:true, graph-walk's same flag,
 * bitemporal's inherently-historical queries) merge this in; default,
 * non-invalidated retrieval never calls this function.
 */
export function iterArchivedUnits(memoriesDir) {
  const archiveDir = join(memoriesDir, 'archive');
  const units = [];
  let entries;
  try { entries = readdirSync(archiveDir).sort(); } catch { return units; }
  for (const fname of entries) {
    if (!fname.endsWith('.md')) continue;
    if (fname.startsWith('_') || fname.startsWith('INDEX') || fname === 'README.md') continue;
    try {
      units.push(loadUnit(join(archiveDir, fname)));
    } catch (e) {
      process.stderr.write(`warn: archive/${fname}: failed to load (${e && e.message ? e.message : e}) — excluded\n`);
    }
  }
  return units;
}

/**
 * Rank every loadable, currently-valid unit (SOD-003). The bi-temporal
 * suppression invariant — default retrieval excludes invalidated units
 * (ARCHITECTURE.md, data-storage.md) — is applied HERE so every consumer
 * (the CLI, generate-memory-index, any wrapper) inherits it instead of
 * re-deriving it. Cold history stays reachable with includeInvalidated:true,
 * which also merges in archive/ (iterArchivedUnits) so a physically
 * relocated retired unit stays reachable for an explicit historical query.
 * @returns {Array<[number, object]>} [score, unit] pairs, descending.
 */
export function rankUnits(memoriesDir, { sessionTopics = [], today = null, includeInvalidated = false } = {}) {
  const t = today || _todayUTC();
  const pool = includeInvalidated ? iterUnits(memoriesDir).concat(iterArchivedUnits(memoriesDir)) : iterUnits(memoriesDir);
  const ranked = pool
    .filter(u => !u.fm._load_error)
    .filter(u => includeInvalidated || isActiveStatus(u.fm))
    .filter(u => includeInvalidated || !isInvalidated(u, t))
    .map(u => [score(u, sessionTopics, t), u]);
  ranked.sort((a, b) => b[0] - a[0]);
  return ranked;
}

// ---------- CLI ----------

export function _todayFromArg(arg) {
  // A malformed --today (fails parseIsoDate's regex) must fall back to today, not
  // null — a null `today` then throws TypeError at today.toISOString() in the
  // display path. Siblings (graph-walk, check-units) defend the same way (M3).
  return (arg && parseIsoDate(arg)) || _todayUTC();
}

function _cliSections(ranked, topK) {
  const sections = {
    'What & Why': [],
    State: [],
    People: [],
    Moves: [],
    'Decisions & Risks': [],
    Notes: [],
  };
  for (const [s, u] of ranked) {
    const sec = unitSection(u);
    const bucket = sections[sec] || sections.Notes;
    if (bucket.length < topK) {
      bucket.push({ unit_id: u.id, path: String(u.path), priority: Math.round(s * 10000) / 10000, type: u.fm.type || '', topics: u.fm.topics || [] });
    }
  }
  console.log(JSON.stringify(sections, null, 2));
  return 0;
}

export function writeAuditEntry(logPath, entry) {
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

export function main(argv) {
  let memoriesDirArg = '_memories';
  let topN = 10;
  let intentStr = '';
  let todayArg = null;
  let sections = false;
  let topPerSection = 5;
  let logPath = null;
  let logLabel = null;
  let includeInvalid = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--top') { topN = parseInt(argv[++i], 10); }
    else if (a === '--intent') { intentStr = argv[++i]; }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (a === '--sections') { sections = true; }
    else if (a === '--top-per-section') { topPerSection = parseInt(argv[++i], 10); }
    else if (a === '--log') { logPath = argv[++i]; }
    else if (a === '--log-label') { logLabel = argv[++i]; }
    else if (a === '--include-invalid') { includeInvalid = true; }
    else if (!a.startsWith('--')) { memoriesDirArg = a; }
  }

  const memoriesDir = resolve(memoriesDirArg);
  try { readdirSync(memoriesDir); } catch {
    process.stderr.write(`error: ${memoriesDir} is not a directory\n`);
    return 2;
  }

  const intent = intentStr ? intentStr.split(',').map(s => s.trim()).filter(Boolean) : [];
  const today = _todayFromArg(todayArg);

  const ranked = rankUnits(memoriesDir, { sessionTopics: intent, today, includeInvalidated: includeInvalid });

  if (logPath) {
    const rankings = ranked.slice(0, topN).map(([s, u]) => ({
      unit_id: u.id,
      score: Math.round(s * 10000) / 10000,
      topics: u.fm.topics || [],
    }));
    const entry = {
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      memories_dir: memoriesDir,
      top_n: topN,
      intent,
      sections,
      rankings,
    };
    if (logLabel) entry.label = logLabel;
    writeAuditEntry(logPath, entry);
  }

  if (sections) return _cliSections(ranked, topPerSection);

  console.log(`Ranking ${ranked.length} units in ${memoriesDir}`);
  console.log(`Date: ${today.toISOString().slice(0, 10)}, intent topics: ${intent.length ? intent.join(',') : '(none)'}`);
  console.log('-'.repeat(64));
  for (const [s, u] of ranked.slice(0, topN)) {
    const topics = u.fm.topics || [];
    console.log(`  ${s.toFixed(3)}  ${u.id.padEnd(42)}  topics=${JSON.stringify(topics)}`);
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
