import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeClassifiedRows, dedupeClassifiedByDay, cohortClassifiedByDay,
  dedupeDetectorRows, formatDedupeNote, formatCoverageGapNote,
} from '../../plugins/core/skills/core/scripts/metrics-dedupe.mjs';

const COHORT = { schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2 };

const row = (over = {}) => ({
  schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
  harness: 'claude-code', provisional: true,
  session_id: 'sess-a', turn_idx: 0, state: 'tier-0-win',
  ...over,
});

// ---------- classified: pure replays ----------

test('same replay identity twice keeps one row and counts the replay', () => {
  const { rows, stats } = dedupeClassifiedRows([row(), row()]);
  assert.equal(rows.length, 1);
  assert.equal(stats.rows_read, 2);
  assert.equal(stats.rows_kept, 1);
  assert.equal(stats.replays_dropped, 1);
  assert.equal(stats.conflicts, 0);
  assert.equal(stats.superseded_dropped, 0);
});

test('totals are stable under replay: processing a session twice equals once', () => {
  const once = [row({ turn_idx: 0 }), row({ turn_idx: 1, state: 'rec-fail-tier-0' })];
  const twice = [...once, ...once];
  const a = dedupeClassifiedRows(once);
  const b = dedupeClassifiedRows(twice);
  const dist = (rs) => rs.reduce((d, r) => ((d[r.state] = (d[r.state] || 0) + 1), d), {});
  assert.deepEqual(dist(a.rows), dist(b.rows), 'state distribution unchanged by full replay');
  assert.equal(b.stats.replays_dropped, 2);
});

// ---------- classified: version supersede ----------

test('newest classifier_version wins; the older row counts as superseded, not a conflict', () => {
  const older = row({ classifier_version: '0.2.0', state: 'tier-1-3-win' });
  const newer = row({ classifier_version: '0.3.0', state: 'rec-fail-tier-0' });
  for (const order of [[older, newer], [newer, older]]) {
    const { rows, stats } = dedupeClassifiedRows(order);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classifier_version, '0.3.0', 'newest version wins regardless of write order');
    assert.equal(rows[0].state, 'rec-fail-tier-0');
    assert.equal(stats.superseded_dropped, 1);
    assert.equal(stats.conflicts, 0, 'a reclassification under a newer version is a correction, not a conflict');
  }
});

test('semver compares numerically, not lexically (0.10.0 beats 0.9.0)', () => {
  const { rows } = dedupeClassifiedRows([
    row({ classifier_version: '0.9.0', state: 'tier-0-win' }),
    row({ classifier_version: '0.10.0', state: 'capture-miss' }),
  ]);
  assert.equal(rows[0].classifier_version, '0.10.0');
});

test('proxy_version breaks classifier-version ties; missing proxy_version loses to a stamped one', () => {
  const { rows, stats } = dedupeClassifiedRows([
    row({ proxy_version: undefined, state: 'tier-0-win' }),
    row({ proxy_version: 2, state: 'rec-fail-tier-0' }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proxy_version, 2);
  assert.equal(stats.superseded_dropped, 1);
});

// ---------- classified: genuine conflicts ----------

test('same full key with different state resolves deterministically and counts the conflict visibly', () => {
  // Hale item 3 (2026-07-22): the winner must NOT depend on input order.
  // Same day ⇒ lexicographically smaller state wins ('rec-fail-tier-0' <
  // 'tier-1-3-win') — for the current vocabulary that is also the
  // conservative reading (contradictions never resolve toward the win).
  const a = row({ state: 'tier-1-3-win' });
  const b = row({ state: 'rec-fail-tier-0' });
  for (const order of [[a, b], [b, a]]) {
    const { rows, stats } = dedupeClassifiedRows(order);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'rec-fail-tier-0', 'same winner under BOTH input orders');
    assert.equal(stats.replays_dropped, 1);
    assert.equal(stats.conflicts, 1, 'the disagreement is counted, never silent');
  }
});

test('equal-rank conflict across dates: the later-dated file wins regardless of read order', () => {
  // The file date is data; a catch-up replay on a later day is the later
  // observation (and matches replay-day attribution). Feed the days in
  // ascending order but verify the WINNER is date-chosen, not order-chosen,
  // by checking the same winner emerges when the later day holds either state.
  const forward = dedupeClassifiedByDay([
    { day: '2026-07-01', rows: [row({ state: 'tier-0-win' })] },
    { day: '2026-07-08', rows: [row({ state: 'rec-fail-tier-0' })] },
  ]);
  assert.equal(forward.days['2026-07-08'].length, 1);
  assert.equal(forward.days['2026-07-08'][0].state, 'rec-fail-tier-0', 'later-dated row wins');
  assert.equal(forward.stats.conflicts, 1);
  const swappedStates = dedupeClassifiedByDay([
    { day: '2026-07-01', rows: [row({ state: 'rec-fail-tier-0' })] },
    { day: '2026-07-08', rows: [row({ state: 'tier-0-win' })] },
  ]);
  assert.equal(swappedStates.days['2026-07-08'][0].state, 'tier-0-win', 'date decides, not the state tiebreak');
});

// ---------- classified: identity boundaries ----------

test('different sessions, turns, and harnesses never dedupe against each other', () => {
  const { rows, stats } = dedupeClassifiedRows([
    row({ session_id: 'sess-a' }),
    row({ session_id: 'sess-b' }),
    row({ session_id: 'sess-a', turn_idx: 1 }),
    row({ session_id: 'sess-a', harness: 'codex' }),
  ]);
  assert.equal(rows.length, 4);
  assert.equal(stats.replays_dropped + stats.superseded_dropped, 0);
});

test('rows without affirmative identity are kept, never guessed into a dedupe', () => {
  const { rows, stats } = dedupeClassifiedRows([
    row({ session_id: 'no-session-context' }),
    row({ session_id: 'no-session-context' }),
    row({ session_id: undefined }),
    { state: 'tier-0-win' }, // no identity fields at all (old rollup-fixture shape)
  ]);
  assert.equal(rows.length, 4, 'ambiguous identity is refused, not destroyed');
  assert.equal(stats.unkeyed_kept, 4);
  assert.equal(stats.rows_kept, 4);
});

// ---------- classified: cross-day replay ----------

test('a session replayed on a later date counts once, attributed to the winning (later) day', () => {
  const { days, stats } = dedupeClassifiedByDay([
    { day: '2026-07-20', rows: [row({ turn_idx: 0 }), row({ turn_idx: 1 })] },
    { day: '2026-07-21', rows: [row({ turn_idx: 0 }), row({ turn_idx: 1 })] },
  ]);
  assert.equal(days['2026-07-20'].length, 0, 'earlier day loses its replayed rows');
  assert.equal(days['2026-07-21'].length, 2, 'winner day carries the turns once');
  assert.equal(stats.rows_kept, 2);
  assert.equal(stats.replays_dropped, 2);
});

test('every input day key survives in the output, even when emptied by dedupe', () => {
  const { days } = dedupeClassifiedByDay([
    { day: '2026-07-20', rows: [row()] },
    { day: '2026-07-21', rows: [row()] },
  ]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-07-20', '2026-07-21']);
});

// ---------- classified: instrument-cohort gate (Hale 2026-07-22 addendum) ----------

test("Hale's mixed-instrument falsifier: an old-version row with no newer counterpart never crosses into the cohort", () => {
  // One 0.2.0-only row (different turn — no 0.3.0 counterpart to supersede
  // it) plus one 0.3.0 row. Before the cohort gate both survived dedupe and
  // both were aggregated. Now: only the 0.3.0 row is in the cohort; the
  // 0.2.0 row is an explicit coverage gap, never silently counted.
  const { days, stats, cohort, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      row({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' }),
      row({ turn_idx: 1, classifier_version: '0.3.0', state: 'rec-fail-tier-0' }),
    ],
  }], COHORT);
  assert.equal(stats.rows_kept, 2, 'both rows survive dedupe (no supersession without a same-turn newer row)');
  assert.equal(days['2026-07-22'].length, 1, 'only the current-instrument row may aggregate');
  assert.equal(days['2026-07-22'][0].classifier_version, '0.3.0');
  assert.deepEqual(cohort, COHORT);
  assert.equal(coverage_gap.rows_excluded, 1);
  assert.deepEqual(coverage_gap.versions, { 'schema=1.0.0 classifier=0.2.0 proxy=2': 1 });
});

test('cohort gate: cross-version supersession still applies before the gate', () => {
  // Same turn re-classified under the newer instrument: the old row is
  // superseded (dropped by dedupe), the new row aggregates, and the gap is 0.
  const { days, stats, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      row({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' }),
      row({ turn_idx: 0, classifier_version: '0.3.0', state: 'rec-fail-tier-0' }),
    ],
  }], COHORT);
  assert.equal(stats.superseded_dropped, 1);
  assert.equal(days['2026-07-22'].length, 1);
  assert.equal(coverage_gap.rows_excluded, 0, 'a superseded row is corrected, not a gap');
});

test('cohort gate: unkeyed and version-less rows cannot sneak into the aggregate either', () => {
  const { days, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      { state: 'tier-0-win' }, // no identity, no versions — kept by dedupe, outside the cohort
      row({ session_id: 'no-session-context', classifier_version: '0.2.0' }), // unkeyed old instrument
      row({ turn_idx: 5 }), // in-cohort
    ],
  }], COHORT);
  assert.equal(days['2026-07-22'].length, 1, 'only the in-cohort row aggregates');
  assert.equal(coverage_gap.rows_excluded, 2);
  assert.deepEqual(coverage_gap.versions, {
    'schema=1.0.0 classifier=0.2.0 proxy=2': 1,
    'schema=other classifier=other proxy=other': 1,
  }, 'non-version-shaped values fold to other — whitelist-safe labels');
});

test('formatCoverageGapNote reads honestly in the gap and all-clear cases', () => {
  const gap = formatCoverageGapNote({
    cohort: COHORT,
    coverage_gap: { rows_excluded: 2, versions: { 'schema=1.0.0 classifier=0.2.0 proxy=2': 2 } },
  });
  assert.equal(gap, 'instrument cohort 1.0.0/0.3.0/p2: 2 rows outside cohort EXCLUDED from aggregates (2× schema=1.0.0 classifier=0.2.0 proxy=2)');
  const clean = formatCoverageGapNote({ cohort: COHORT, coverage_gap: { rows_excluded: 0, versions: {} } });
  assert.equal(clean, 'instrument cohort 1.0.0/0.3.0/p2: all deduped rows in cohort');
});

// ---------- detectors ----------

const det = (over = {}) => ({
  schema_version: '1.0.0', detector: 'citation-resolver', detector_version: '0.2.0',
  session_id: 'sess-a', severity: 'high', raw: 'DC-999', kind: 'decision', key: 'dc-999',
  ...over,
});

test('detector replays dedupe on (detector, session, finding); distinct findings survive', () => {
  const { rows, stats } = dedupeDetectorRows([
    det(), det(), // same broken citation twice (re-run in the same session)
    det({ raw: 'R-42', key: 'risk-42', kind: 'risk' }),
    det({ detector: 'stale-context', filename: 'dc-1.md', raw: undefined, days_stale: 40 }),
    det({ detector: 'stale-context', filename: 'dc-1.md', raw: undefined, days_stale: 40 }),
    det({ detector: 'anticipation-gap', turn_idx: 3, raw: undefined, terms: ['spine'] }),
    det({ detector: 'absence-with-deadline', filename: 'oq-1.md', raw: undefined, by_when: '2026-07-01' }),
  ]);
  assert.equal(rows.length, 5);
  assert.equal(stats.replays_dropped, 2);
  assert.equal(stats.conflicts, 0);
});

test('newer detector_version supersedes the same finding; content drift at same version is a conflict', () => {
  const versioned = dedupeDetectorRows([
    det({ detector_version: '0.1.0' }),
    det({ detector_version: '0.2.0' }),
  ]);
  assert.equal(versioned.rows.length, 1);
  assert.equal(versioned.rows[0].detector_version, '0.2.0');
  assert.equal(versioned.stats.superseded_dropped, 1);

  const drifted = dedupeDetectorRows([
    det({ detector: 'stale-context', filename: 'dc-1.md', raw: undefined, days_stale: 40 }),
    det({ detector: 'stale-context', filename: 'dc-1.md', raw: undefined, days_stale: 55 }),
  ]);
  assert.equal(drifted.rows.length, 1);
  assert.equal(drifted.rows[0].days_stale, 55, 'last-written wins');
  assert.equal(drifted.stats.conflicts, 1);
});

test('same finding from two different sessions is two observations, not a replay', () => {
  const { rows, stats } = dedupeDetectorRows([
    det({ detector: 'absence-with-deadline', filename: 'oq-1.md', raw: undefined, session_id: 'sess-a' }),
    det({ detector: 'absence-with-deadline', filename: 'oq-1.md', raw: undefined, session_id: 'sess-b' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(stats.replays_dropped, 0);
});

test('unknown detector kinds are kept unkeyed — never guessed into a dedupe', () => {
  const { rows, stats } = dedupeDetectorRows([
    det({ detector: 'future-detector' }),
    det({ detector: 'future-detector' }),
  ]);
  assert.equal(rows.length, 2);
  assert.equal(stats.unkeyed_kept, 2);
});

// ---------- surfacing ----------

test('formatDedupeNote reads honestly in both the lossy and clean cases', () => {
  const lossy = formatDedupeNote({ rows_read: 166, rows_kept: 147, replays_dropped: 16, superseded_dropped: 3, conflicts: 1, unkeyed_kept: 0 });
  assert.equal(lossy, '166 rows read, 147 after replay-dedupe (16 replays, 3 superseded, 1 conflict)');
  const clean = formatDedupeNote({ rows_read: 5, rows_kept: 5, replays_dropped: 0, superseded_dropped: 0, conflicts: 0, unkeyed_kept: 0 });
  assert.equal(clean, '5 rows read, 5 after replay-dedupe');
});
