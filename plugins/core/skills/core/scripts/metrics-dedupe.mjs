/**
 * metrics-dedupe.mjs — shared read-side replay dedupe + instrument-cohort gate
 * for the classified metrics store.
 *
 * The capture side is append-only on purpose — a session re-processed at close
 * AND at a later catch-up, or a manual /process-memory re-run, appends the
 * same turns again. Nothing wrong with that at write time (capture is ground
 * truth and replayable); the dishonesty would be READ time treating replayed
 * rows as new evidence, mixing incompatible instruments, or inventing a state
 * for a genuine contradiction.
 *
 * The read side is TWO ordered steps (the
 * order is load-bearing, not preference):
 *
 *   1. COHORT FIRST. Partition the RAW rows into the exact
 *      (schema_version, classifier_version, proxy_version) cohort being
 *      aggregated. Only in-cohort rows continue. Every out-of-cohort row is
 *      reported as an explicit coverage gap (count + versions present) and can
 *      NEVER choose a winner inside the cohort. One instrument is never ranked
 *      above another absent an explicit migration — a future/newer-version row
 *      does not supersede a current-cohort row, it simply sits in the gap.
 *
 *   2. REPLAY-DEDUPE INSIDE THE COHORT. Reprocessing the same replay identity
 *      (harness, session, turn, classifier/proxy/schema version) must leave
 *      totals unchanged. Policy:
 *
 *        - Replay identity = (harness, session_id, turn_idx, classifier_version,
 *          proxy_version, schema_version). Same identity observed more than
 *          once with the SAME state is a pure replay: one row survives, the
 *          others are counted as `replays`.
 *        - IMMUTABLE OBSERVATION DAY: the surviving row keeps the
 *          EARLIEST/original observation day. A July 1 row replayed on July 22
 *          stays counted under July 1 — replay never moves history forward.
 *          "turns today" therefore means user turns first observed that day,
 *          not classifications produced that day.
 *        - CONFLICTS LEAVE THE DENOMINATORS: same replay identity
 *          observed with DIFFERENT states is an equal-authority contradiction.
 *          The aggregate does not pick a winner by string order or file date —
 *          determinism is not truth, and pessimistic fabrication is still
 *          fabrication. The whole contradicting group is EXCLUDED from the
 *          aggregate (out of both numerator and denominator) and counted as a
 *          `conflict`, visibly, never silently. (A genuinely later re-
 *          processing of the SAME state is still just a replay; the file date
 *          only stabilizes which identical-state row's ancillary fields
 *          survive — it never decides between contradicting states.)
 *        - Rows with no affirmative identity (missing/blank session_id, the
 *          writer's 'no-session-context' fallback, or a non-integer turn_idx)
 *          are KEPT as-is and counted as `unkeyed` — refusing to guess beats
 *          silently destroying rows we cannot prove are replays.
 *
 * Consumers: metrics-rollup.mjs and metrics-package.mjs (workspaceMetrics).
 *
 * Ships with the plugin by convention; .mjs (Node.js) only. Fail-open: never throws.
 */

const UNKEYED_SESSION = 'no-session-context';

function sessionOf(row) {
  const sid = typeof row.session_id === 'string' ? row.session_id.trim() : '';
  return sid && sid !== UNKEYED_SESSION ? sid : null;
}

function emptyStats() {
  return {
    rows_read: 0, rows_kept: 0, replays_dropped: 0, superseded_dropped: 0,
    conflicts: 0, conflict_rows_excluded: 0, unkeyed_kept: 0,
  };
}

// ---------------- replay identity ----------------

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const normVersion = (v) => (typeof v === 'string' && SEMVER_RE.test(v) ? v : 'na');
const normProxy = (v) => (Number.isInteger(v) ? String(v) : 'na');

/**
 * Replay identity string, or null when the row carries no affirmative identity.
 * The instrument versions ARE part of the identity: two rows for one turn under
 * DIFFERENT versions are two instruments, never replays of each other and never
 * a supersession — the cohort gate, not the deduper, decides which instrument
 * counts.
 */
function classifiedKey(row) {
  const sid = sessionOf(row);
  if (!sid || !Number.isInteger(row.turn_idx)) return null;
  return [
    typeof row.harness === 'string' ? row.harness : '',
    sid, row.turn_idx,
    normVersion(row.classifier_version),
    normProxy(row.proxy_version),
    normVersion(row.schema_version),
  ].join('|');
}

/**
 * Replay-dedupe classified rows grouped by day. Input [{ day, rows }] in
 * ascending date order; output { days: { [day]: rows[] }, stats } with every
 * input day key present. Callers that mix instruments should partition through
 * cohortClassifiedByDay first — this primitive keys ON the instrument version,
 * so different instruments simply never collide here, but the coverage-gap
 * accounting lives in the cohort gate.
 */
export function dedupeClassifiedByDay(daysInput) {
  const stats = emptyStats();
  const groups = new Map(); // key -> [{ day, seq, row }]
  const unkeyed = []; // { day, seq, row }
  let seq = 0;
  const dayKeys = [];
  for (const { day, rows } of daysInput || []) {
    dayKeys.push(day);
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      stats.rows_read += 1;
      seq += 1;
      let key = null;
      try { key = classifiedKey(row); } catch { key = null; }
      if (key == null) { stats.unkeyed_kept += 1; unkeyed.push({ day, seq, row }); continue; }
      const g = groups.get(key);
      if (g) g.push({ day, seq, row });
      else groups.set(key, [{ day, seq, row }]);
    }
  }

  const kept = [...unkeyed];
  for (const members of groups.values()) {
    if (members.length === 1) { kept.push(members[0]); continue; }
    const states = new Set(members.map((m) => String(m.row.state ?? '')));
    if (states.size > 1) {
      // Equal-authority same-instrument contradiction: no winner is invented.
      // Exclude the whole group from the aggregate; count it, never silent.
      stats.conflicts += 1;
      stats.conflict_rows_excluded += members.length;
      continue;
    }
    // Pure replay (same state): keep the EARLIEST observation (immutable
    // observation day); same day, the first-seen row in the deterministic
    // file-scan order (files are read in ascending-date order, rows in file
    // order). No content/state tiebreak — every replay here shares the same
    // state, so the choice only stabilizes which identical-state row's
    // ancillary fields survive; it never decides membership.
    const winner = members.reduce((best, m) => {
      if (m.day !== best.day) return m.day < best.day ? m : best;
      return m.seq < best.seq ? m : best;
    });
    stats.replays_dropped += members.length - 1;
    kept.push(winner);
  }

  kept.sort((a, b) => a.seq - b.seq);
  const days = {};
  for (const day of dayKeys) days[day] = days[day] || [];
  for (const e of kept) (days[e.day] = days[e.day] || []).push(e.row);
  stats.rows_kept = kept.length;
  return { days, stats };
}

/** Flat convenience wrapper: rows in write order → { rows, stats }. */
export function dedupeClassifiedRows(rows) {
  const { days, stats } = dedupeClassifiedByDay([{ day: '_', rows }]);
  return { rows: days._ || [], stats };
}

// ---------------- instrument-cohort gate ----------------

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
 * COHORT FIRST, then replay-dedupe inside the cohort. Select
 * exactly one (schema_version, classifier_version, proxy_version) cohort from
 * the RAW rows; only in-cohort rows are deduped and may aggregate. Every
 * out-of-cohort raw row is excluded and reported in `coverage_gap` (count +
 * versions present) — it can never choose a winner inside the cohort, and a
 * newer/future instrument does NOT supersede the current cohort's rows.
 *
 * Returns { days, stats, cohort, coverage_gap } where `days` holds in-cohort
 * deduped rows only, `stats.rows_read` counts in-cohort rows only (the gap is
 * counted separately), and coverage_gap = { rows_excluded, versions: { label: count } }.
 */
export function cohortClassifiedByDay(daysInput, cohort) {
  const inCohortDays = [];
  const versions = {};
  let excluded = 0;
  for (const { day, rows } of daysInput || []) {
    const inRows = [];
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      if (inCohort(row, cohort)) { inRows.push(row); continue; }
      excluded += 1;
      const label = `schema=${foldSemver(row.schema_version)} classifier=${foldSemver(row.classifier_version)} proxy=${foldProxy(row.proxy_version)}`;
      versions[label] = (versions[label] || 0) + 1;
    }
    inCohortDays.push({ day, rows: inRows });
  }
  const { days, stats } = dedupeClassifiedByDay(inCohortDays);
  const sortedVersions = Object.fromEntries(
    Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return {
    days,
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
 * "instrument cohort 1.0.0/0.3.0/p2: all in-cohort rows aggregated".
 */
export function formatCoverageGapNote({ cohort, coverage_gap: gap } = {}) {
  if (!cohort || !gap) return null;
  const id = `${cohort.schema_version}/${cohort.classifier_version}/p${cohort.proxy_version}`;
  if (!gap.rows_excluded) return `instrument cohort ${id}: all in-cohort rows aggregated`;
  const vs = Object.entries(gap.versions).map(([label, n]) => `${n}× ${label}`).join('; ');
  return `instrument cohort ${id}: ${gap.rows_excluded} row${gap.rows_excluded === 1 ? '' : 's'} outside cohort EXCLUDED from aggregates (${vs})`;
}

// ---------------- shared surfacing ----------------

/**
 * One honest human-readable note, e.g.
 * "166 rows read, 147 after replay-dedupe (16 replays, 1 conflict excluded)".
 * Returns the note even when nothing was dropped, so consumers can choose
 * always-on (rollup markdown) vs only-when-lossy (the one-line signal).
 * Conflicts are reported as EXCLUDED — they are out of the aggregate, not a
 * kept row.
 */
export function formatDedupeNote(stats) {
  if (!stats) return null;
  const parts = [];
  if (stats.replays_dropped) parts.push(`${stats.replays_dropped} replay${stats.replays_dropped === 1 ? '' : 's'}`);
  if (stats.superseded_dropped) parts.push(`${stats.superseded_dropped} superseded`);
  if (stats.conflicts) parts.push(`${stats.conflicts} conflict${stats.conflicts === 1 ? '' : 's'} excluded`);
  if (stats.unkeyed_kept) parts.push(`${stats.unkeyed_kept} unkeyed kept`);
  const detail = parts.length ? ` (${parts.join(', ')})` : '';
  return `${stats.rows_read} rows read, ${stats.rows_kept} after replay-dedupe${detail}`;
}
