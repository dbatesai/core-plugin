/**
 * metrics-dedupe.mjs — shared read-side replay dedupe for the classified and
 * detector metrics stores.
 *
 * Extracted 2026-07-22 (Hale's replay-identity principle, metrics-evidence
 * contract item 3): the capture side is append-only on purpose — a session
 * re-processed at close AND at a later catch-up, or a manual /process-memory
 * re-run, appends the same turns again. Nothing wrong with that at write time
 * (capture is ground truth and replayable); the dishonesty would be READ time
 * treating replayed rows as new evidence. Live proof from the CORE workspace
 * the day this shipped: 166 classified rows, 147 unique replay identities —
 * an 11% count inflation, entirely inside single-day files, plus one genuine
 * conflict (same session/turn/versions classified twice with different
 * states because the second run saw the grown transcript).
 *
 * Replay identity (Hale): reprocessing the same (harness, session, turn,
 * producer/schema version) must leave totals unchanged. Policy:
 *
 *   - One row survives per turn identity (harness, session_id, turn_idx).
 *   - Across producer versions for the same turn, the NEWEST
 *     (classifier_version, proxy_version, schema_version) wins — a
 *     re-classification after an upgrade is a correction, not additional
 *     evidence, and the rollup's own calibration guard already treats
 *     versions as incompatible instruments. Older rows count as `superseded`.
 *   - Same identity AND same versions more than once: the winner is chosen
 *     DETERMINISTICALLY, never by input order (Hale's 2026-07-22 audit:
 *     last-written let file-read order pick the winner — reversing input
 *     reversed the aggregate). Rule: later-dated file wins; same day,
 *     lexicographically smaller state wins; same state, smaller full content
 *     signature wins. Dropped rows count as `replays`; if a dropped row
 *     disagrees with the kept row's state, that is a `conflict` — counted
 *     and surfaced, never silent.
 *   - Rows with no affirmative identity (missing/blank session_id, the
 *     writer's 'no-session-context' fallback, or a non-integer turn_idx) are
 *     KEPT as-is and counted as `unkeyed` — refusing to guess beats silently
 *     destroying rows we cannot prove are replays.
 *   - Rows written before the `harness` field existed only dedupe against
 *     rows that also lack it (identity must match exactly); session ids are
 *     harness-scoped UUIDs in practice, and the live store has zero
 *     cross-era re-classifications, so this caveat is currently inert.
 *
 * Day attribution — EXPLICIT POLICY (Hale item 4, 2026-07-22): replayed
 * sessions attribute to the replay's day. Winners keep the day of the WINNING
 * row, so a session replayed on a later date counts once, on the date of its
 * authoritative row — corpus totals are stable under replay by construction,
 * and the day a judgment counts under is the day that judgment was actually
 * produced. Consumers state this policy in their output; it is never silent.
 *
 * Instrument-cohort gate (Hale's 2026-07-22 addendum — correctness, not
 * preference): dedupe alone does NOT make an aggregate honest. An old-version
 * row with no newer counterpart survives dedupe, so a store mixing 0.2.0-era
 * and 0.3.0-era rows would aggregate BOTH instruments' judgments while
 * calibration was validated against 0.3.0 only. `cohortClassifiedByDay`
 * therefore selects exactly one (schema_version, classifier_version,
 * proxy_version) cohort after dedupe; rows outside it are NEVER counted —
 * they are reported as an explicit coverage gap (count + versions present).
 *
 * Consumers: metrics-rollup.mjs and metrics-package.mjs (workspaceMetrics).
 * The detector store currently has NO aggregate reader (only the writer);
 * dedupeDetectorRows exists so the first reader starts honest.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Fail-open: never throws.
 */

/** Parse '1.2.3'-shaped versions to a comparable numeric triple; unparseable → [0,0,0]. */
function semverTriple(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function cmpArrays(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0; const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

const UNKEYED_SESSION = 'no-session-context';

function sessionOf(row) {
  const sid = typeof row.session_id === 'string' ? row.session_id.trim() : '';
  return sid && sid !== UNKEYED_SESSION ? sid : null;
}

/** Stable content signature (sorted keys) for conflict detection on detector rows. */
function contentSignature(row, excludeKeys) {
  const entries = Object.entries(row)
    .filter(([k]) => !excludeKeys.has(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

function emptyStats() {
  return { rows_read: 0, rows_kept: 0, replays_dropped: 0, superseded_dropped: 0, conflicts: 0, unkeyed_kept: 0 };
}

/**
 * Generic grouped dedupe over [{ day, rows }] (ascending day order — callers
 * pass files sorted by date so "later position = written later" holds).
 * keyOf(row) → identity string or null (null = unkeyed, always kept).
 * rankOf(row) → comparable array (higher wins).
 * conflictOf(kept, dropped) → true when a same-rank dropped row disagrees.
 * tieBreak(a, b) → the winning entry ({day, seq, row, rank}) for equal-rank
 *   pairs; when omitted, the later-read row wins (legacy detector behavior —
 *   the detector store has no production consumer; flagged, not invented).
 * Returns { days: { [day]: rows[] }, stats } — every input day key present.
 */
function dedupeGrouped(daysInput, { keyOf, rankOf, conflictOf, tieBreak }) {
  const stats = emptyStats();
  const entries = []; // { day, seq, row } for unkeyed rows
  const groups = new Map(); // key → { winner: {day, seq, row, rank}, losers: [{row, rank}] }
  let seq = 0;
  const dayKeys = [];
  for (const { day, rows } of daysInput || []) {
    dayKeys.push(day);
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      stats.rows_read += 1;
      seq += 1;
      let key = null;
      try { key = keyOf(row); } catch { key = null; }
      if (key == null) {
        stats.unkeyed_kept += 1;
        entries.push({ day, seq, row });
        continue;
      }
      const rank = rankOf(row);
      const g = groups.get(key);
      if (!g) { groups.set(key, { winner: { day, seq, row, rank } }); continue; }
      const cmp = cmpArrays(rank, g.winner.rank);
      if (cmp > 0) {
        // Newer producer version wins; the old winner is superseded.
        stats.superseded_dropped += 1;
        g.winner = { day, seq, row, rank };
      } else if (cmp === 0) {
        // Same versions: a replay. Count it, flag disagreement, and pick the
        // winner via tieBreak (deterministic for classified rows — input
        // order must never choose the surviving state).
        stats.replays_dropped += 1;
        if (conflictOf(row, g.winner.row)) stats.conflicts += 1;
        const cand = { day, seq, row, rank };
        g.winner = tieBreak ? tieBreak(g.winner, cand) : cand;
      } else {
        // Older producer version replayed after a newer one already exists.
        stats.superseded_dropped += 1;
      }
    }
  }
  for (const g of groups.values()) entries.push(g.winner);
  entries.sort((a, b) => a.seq - b.seq);
  const days = {};
  for (const day of dayKeys) days[day] = days[day] || [];
  for (const e of entries) (days[e.day] = days[e.day] || []).push(e.row);
  stats.rows_kept = entries.length;
  return { days, stats };
}

// ---------------- classified rows ----------------

function classifiedKey(row) {
  const sid = sessionOf(row);
  if (!sid || !Number.isInteger(row.turn_idx)) return null;
  return [typeof row.harness === 'string' ? row.harness : '', sid, row.turn_idx].join('|');
}

function classifiedRank(row) {
  return [
    ...semverTriple(row.classifier_version),
    Number.isFinite(row.proxy_version) ? row.proxy_version : 0,
    ...semverTriple(row.schema_version),
  ];
}

function classifiedConflict(a, b) {
  return String(a.state ?? '') !== String(b.state ?? '');
}

const NO_EXCLUDE = new Set();

/**
 * Deterministic equal-rank winner for classified rows (Hale item 3,
 * 2026-07-22): the same full replay identity + the same producer versions
 * observed more than once must resolve to the SAME winner under any input
 * order. Rule, in priority order:
 *   1. The row from the LATER-dated file wins. The file date is data, not
 *      read order; a catch-up replay on a later day is the later observation,
 *      and this matches the replay-day attribution policy.
 *   2. Same day, states differ: the lexicographically SMALLER state wins.
 *      Any total order gives determinism; lexicographic-min is chosen because
 *      over the classifier's state vocabulary ('capture-miss' <
 *      'mechanics-failure' < 'rec-fail-tier-0' < 'rec-fail-tier-1-3-trigger'
 *      < 'tier-0-win' < 'tier-1-3-win') it resolves contradictions toward the
 *      failure reading — the aggregate never resolves self-contradictory
 *      evidence in its own favor (R-1 honesty spine). The disagreement is
 *      still counted as a conflict either way.
 *   3. Same day, same state: smaller full content signature wins — pure
 *      determinism; aggregation reads `state`, so this only stabilizes which
 *      identical-state row's ancillary fields survive.
 */
function classifiedTieBreak(a, b) {
  if (a.day !== b.day) return a.day > b.day ? a : b;
  const sa = String(a.row.state ?? ''); const sb = String(b.row.state ?? '');
  if (sa !== sb) return sa < sb ? a : b;
  return contentSignature(a.row, NO_EXCLUDE) <= contentSignature(b.row, NO_EXCLUDE) ? a : b;
}

/**
 * Dedupe classified rows grouped by day: input [{ day, rows }] in ascending
 * date order; output { days: { [day]: rows[] }, stats }. Winners are
 * attributed to the day of the surviving row.
 */
export function dedupeClassifiedByDay(daysInput) {
  return dedupeGrouped(daysInput, { keyOf: classifiedKey, rankOf: classifiedRank, conflictOf: classifiedConflict, tieBreak: classifiedTieBreak });
}

// ---------------- instrument-cohort gate ----------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
// Version labels ship in the coverage gap (rollup output + the shared
// package's numbers-only block), so they must stay whitelist-safe: only
// version-shaped values pass; anything else — including free text a corrupt
// row could carry — folds to 'other'. Counts are never lost, labels are.
const foldSemver = (v) => (typeof v === 'string' && SEMVER_RE.test(v) ? v : 'other');
const foldProxy = (v) => (Number.isInteger(v) ? String(v) : 'other');

function inCohort(row, cohort) {
  return row.schema_version === cohort.schema_version
    && row.classifier_version === cohort.classifier_version
    && row.proxy_version === cohort.proxy_version;
}

/**
 * Dedupe classified rows, then select exactly ONE instrument cohort —
 * `cohort` is { schema_version, classifier_version, proxy_version }, normally
 * the current constants from classify-turns.mjs. Only in-cohort survivors may
 * be aggregated; every surviving row outside the cohort is excluded and
 * reported in `coverage_gap` (count + versions present), never silently
 * counted. This is the correctness gate from Hale's 2026-07-22 addendum: an
 * old-instrument row with no newer counterpart survives dedupe, and without
 * this gate it would be summed into numbers whose calibration was validated
 * against the current instrument only.
 *
 * Returns { days, stats, cohort, coverage_gap } where `days` holds in-cohort
 * rows only and coverage_gap = { rows_excluded, versions: { label: count } }.
 */
export function cohortClassifiedByDay(daysInput, cohort) {
  const { days, stats } = dedupeClassifiedByDay(daysInput);
  const cohortDays = {};
  const versions = {};
  let excluded = 0;
  for (const [day, rows] of Object.entries(days)) {
    cohortDays[day] = [];
    for (const row of rows) {
      if (inCohort(row, cohort)) { cohortDays[day].push(row); continue; }
      excluded += 1;
      const label = `schema=${foldSemver(row.schema_version)} classifier=${foldSemver(row.classifier_version)} proxy=${foldProxy(row.proxy_version)}`;
      versions[label] = (versions[label] || 0) + 1;
    }
  }
  const sortedVersions = Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    days: cohortDays,
    stats,
    cohort: {
      schema_version: cohort.schema_version,
      classifier_version: cohort.classifier_version,
      proxy_version: cohort.proxy_version,
    },
    coverage_gap: { rows_excluded: excluded, versions: sortedVersions },
  };
}

/**
 * One honest line about the cohort gate, e.g.
 * "instrument cohort 1.0.0/0.3.0/p2: 3 rows outside cohort EXCLUDED from
 *  aggregates (3× schema=1.0.0 classifier=0.2.0 proxy=2)" — or the all-clear
 * "instrument cohort 1.0.0/0.3.0/p2: all deduped rows in cohort".
 */
export function formatCoverageGapNote({ cohort, coverage_gap: gap } = {}) {
  if (!cohort || !gap) return null;
  const id = `${cohort.schema_version}/${cohort.classifier_version}/p${cohort.proxy_version}`;
  if (!gap.rows_excluded) return `instrument cohort ${id}: all deduped rows in cohort`;
  const vs = Object.entries(gap.versions).map(([label, n]) => `${n}× ${label}`).join('; ');
  return `instrument cohort ${id}: ${gap.rows_excluded} row${gap.rows_excluded === 1 ? '' : 's'} outside cohort EXCLUDED from aggregates (${vs})`;
}

/** Flat convenience wrapper: rows in write order → { rows, stats }. */
export function dedupeClassifiedRows(rows) {
  const { days, stats } = dedupeClassifiedByDay([{ day: '_', rows }]);
  return { rows: days._ || [], stats };
}

// ---------------- detector rows ----------------

// Per-detector discriminator: what makes two rows the SAME finding within a
// session. Unknown detectors get no key (kept, counted unkeyed) — never guess.
const DETECTOR_DISCRIMINATOR = {
  'citation-resolver': (r) => (typeof r.raw === 'string' ? r.raw : null),
  'stale-context': (r) => (typeof r.filename === 'string' ? r.filename : null),
  'anticipation-gap': (r) => (Number.isInteger(r.turn_idx) ? String(r.turn_idx) : null),
  'absence-with-deadline': (r) => (typeof r.filename === 'string' ? r.filename : null),
};

const DETECTOR_VERSION_KEYS = new Set(['detector_version', 'schema_version', 'session_id']);

function detectorKey(row) {
  const sid = sessionOf(row);
  const disc = DETECTOR_DISCRIMINATOR[row.detector];
  if (!sid || !disc) return null;
  const d = disc(row);
  if (d == null) return null;
  return [row.detector, sid, d].join('|');
}

function detectorRank(row) {
  return [...semverTriple(row.detector_version), ...semverTriple(row.schema_version)];
}

function detectorConflict(a, b) {
  return contentSignature(a, DETECTOR_VERSION_KEYS) !== contentSignature(b, DETECTOR_VERSION_KEYS);
}

/** Dedupe detector rows grouped by day: input [{ day, rows }] ascending. */
export function dedupeDetectorsByDay(daysInput) {
  return dedupeGrouped(daysInput, { keyOf: detectorKey, rankOf: detectorRank, conflictOf: detectorConflict });
}

/** Flat convenience wrapper: rows in write order → { rows, stats }. */
export function dedupeDetectorRows(rows) {
  const { days, stats } = dedupeDetectorsByDay([{ day: '_', rows }]);
  return { rows: days._ || [], stats };
}

// ---------------- shared surfacing ----------------

/**
 * One honest human-readable note, e.g.
 * "166 rows read, 147 after replay-dedupe (16 replays, 3 superseded, 1 conflict)".
 * Returns the note even when nothing was dropped, so consumers can choose
 * always-on (rollup markdown) vs only-when-lossy (the one-line signal).
 */
export function formatDedupeNote(stats) {
  if (!stats) return null;
  const parts = [];
  if (stats.replays_dropped) parts.push(`${stats.replays_dropped} replay${stats.replays_dropped === 1 ? '' : 's'}`);
  if (stats.superseded_dropped) parts.push(`${stats.superseded_dropped} superseded`);
  if (stats.conflicts) parts.push(`${stats.conflicts} conflict${stats.conflicts === 1 ? '' : 's'}`);
  if (stats.unkeyed_kept) parts.push(`${stats.unkeyed_kept} unkeyed kept`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `${stats.rows_read} rows read, ${stats.rows_kept} after replay-dedupe${detail}`;
}
