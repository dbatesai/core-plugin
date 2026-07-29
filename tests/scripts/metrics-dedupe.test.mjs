import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dedupeModule from '../../plugins/core/skills/core/scripts/metrics-dedupe.mjs';
import {
  dedupeClassifiedRows, dedupeClassifiedByDay, cohortClassifiedByDay,
  formatDedupeNote, formatCoverageGapNote,
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

// ---------- classified: different instruments are NOT ranked (corrected policy) ----------

test('two instrument versions for one turn are two instruments, never a supersession', () => {
  // Policy: the deduper keys ON the instrument
  // version, so different-version rows for the same turn never collide, never
  // supersede, never conflict. The cohort gate — not the deduper — decides
  // which instrument counts.
  const older = row({ classifier_version: '0.2.0', state: 'tier-1-3-win' });
  const newer = row({ classifier_version: '0.3.0', state: 'rec-fail-tier-0' });
  for (const order of [[older, newer], [newer, older]]) {
    const { rows, stats } = dedupeClassifiedRows(order);
    assert.equal(rows.length, 2, 'both instruments survive — no cross-instrument supersession');
    assert.equal(stats.superseded_dropped, 0);
    assert.equal(stats.conflicts, 0, 'different instruments cannot contradict each other');
  }
});

// ---------- ACCEPTANCE: cohort-first ordering ----------

test("ACCEPTANCE (cohort-first): current 0.3.0 row + same-turn future 0.4.0 row yields a NON-empty 0.3.0 cohort containing the 0.3.0 row", () => {
  // The falsifier: before cohort-first, cross-instrument dedupe let the future
  // 0.4.0 row supersede the current 0.3.0 row, which was then excluded by the
  // cohort filter — an EMPTY 0.3.0 cohort. Cohort-first partitions raw rows to
  // the 0.3.0 cohort BEFORE any dedupe, so the future row lands in the coverage
  // gap and the current row survives.
  const { days, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-23',
    rows: [
      row({ turn_idx: 0, classifier_version: '0.3.0', state: 'rec-fail-tier-0' }),
      row({ turn_idx: 0, classifier_version: '0.4.0', state: 'tier-0-win' }),
    ],
  }], COHORT);
  assert.equal(days['2026-07-23'].length, 1, 'the 0.3.0 cohort is NON-empty');
  assert.equal(days['2026-07-23'][0].classifier_version, '0.3.0');
  assert.equal(days['2026-07-23'][0].state, 'rec-fail-tier-0');
  assert.equal(coverage_gap.rows_excluded, 1, 'the future 0.4.0 row is a coverage gap, not a winner');
  assert.deepEqual(coverage_gap.versions, { 'schema=1.0.0 classifier=0.4.0 proxy=2': 1 });
});

// ---------- ACCEPTANCE: conflicts leave the denominators ----------

test("ACCEPTANCE (conflicts excluded): a same-instrument tier-1-3-win vs rec-fail-tier-0 contradiction returns NO aggregate row and is counted as a conflict", () => {
  // The falsifier: the old lexicographic tiebreak returned rec-fail-tier-0 as a
  // COUNTED aggregate row. Corrected: neither state is chosen; the whole group
  // is excluded from numerator AND denominator, counted once as a conflict.
  for (const order of [
    [row({ state: 'tier-1-3-win' }), row({ state: 'rec-fail-tier-0' })],
    [row({ state: 'rec-fail-tier-0' }), row({ state: 'tier-1-3-win' })],
  ]) {
    const { rows, stats } = dedupeClassifiedRows(order);
    assert.equal(rows.length, 0, 'no invented winner — the contradiction is excluded from the aggregate');
    assert.equal(stats.rows_kept, 0, 'excluded from the denominator');
    assert.equal(stats.conflicts, 1, 'the contradiction is counted, never silent');
    assert.equal(stats.conflict_rows_excluded, 2);
    assert.equal(stats.replays_dropped, 0);
  }
});

// ---------- ACCEPTANCE: immutable observation day ----------

test("ACCEPTANCE (immutable observation day): an unchanged row replayed on a later date stays on its EARLIEST observation day", () => {
  const { days, stats } = dedupeClassifiedByDay([
    { day: '2026-07-01', rows: [row({ turn_idx: 0 }), row({ turn_idx: 1 })] },
    { day: '2026-07-22', rows: [row({ turn_idx: 0 }), row({ turn_idx: 1 })] },
  ]);
  assert.equal(days['2026-07-01'].length, 2, 'the turns count under their earliest observation day');
  assert.equal(days['2026-07-22'].length, 0, 'replay never moves history forward to the replay day');
  assert.equal(stats.rows_kept, 2);
  assert.equal(stats.replays_dropped, 2);
});

// ---------- ACCEPTANCE: detector dedupe deleted ----------

test('ACCEPTANCE (YAGNI): the unused detector dedupe API is gone', () => {
  assert.equal(dedupeModule.dedupeDetectorsByDay, undefined, 'dedupeDetectorsByDay removed — no production reader');
  assert.equal(dedupeModule.dedupeDetectorRows, undefined, 'dedupeDetectorRows removed — no production reader');
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

test('every input day key survives in the output, even when emptied by dedupe', () => {
  const { days } = dedupeClassifiedByDay([
    { day: '2026-07-20', rows: [row()] },
    { day: '2026-07-21', rows: [row()] },
  ]);
  assert.deepEqual(Object.keys(days).sort(), ['2026-07-20', '2026-07-21']);
});

// ---------- classified: instrument-cohort gate ----------

test("mixed-instrument falsifier: an old-version row with no newer counterpart never crosses into the cohort", () => {
  // One 0.2.0-only row plus one 0.3.0 row. Cohort-first partitions the 0.2.0
  // row into the coverage gap BEFORE dedupe; only the 0.3.0 row aggregates.
  const { days, stats, cohort, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      row({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' }),
      row({ turn_idx: 1, classifier_version: '0.3.0', state: 'rec-fail-tier-0' }),
    ],
  }], COHORT);
  assert.equal(stats.rows_read, 1, 'only the in-cohort row reaches the deduper');
  assert.equal(stats.rows_kept, 1);
  assert.equal(days['2026-07-22'].length, 1, 'only the current-instrument row may aggregate');
  assert.equal(days['2026-07-22'][0].classifier_version, '0.3.0');
  assert.deepEqual(cohort, COHORT);
  assert.equal(coverage_gap.rows_excluded, 1);
  assert.deepEqual(coverage_gap.versions, { 'schema=1.0.0 classifier=0.2.0 proxy=2': 1 });
});

test('cohort gate: an old-instrument same-turn row goes to the gap, never supersedes the current row', () => {
  // Corrected policy: the current row is NOT superseded by an older instrument;
  // the old row is simply out of cohort → coverage gap.
  const { days, stats, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      row({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' }),
      row({ turn_idx: 0, classifier_version: '0.3.0', state: 'rec-fail-tier-0' }),
    ],
  }], COHORT);
  assert.equal(stats.superseded_dropped, 0);
  assert.equal(days['2026-07-22'].length, 1);
  assert.equal(days['2026-07-22'][0].classifier_version, '0.3.0');
  assert.equal(coverage_gap.rows_excluded, 1, 'the older-instrument row is a gap, not a supersession');
});

test('cohort gate: unkeyed and version-less rows cannot sneak into the aggregate either', () => {
  const { days, coverage_gap } = cohortClassifiedByDay([{
    day: '2026-07-22',
    rows: [
      { state: 'tier-0-win' }, // no identity, no versions — outside the cohort
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
  assert.equal(clean, 'instrument cohort 1.0.0/0.3.0/p2: all in-cohort rows aggregated');
});

// ---------- surfacing ----------

test('formatDedupeNote reads honestly in both the lossy and clean cases', () => {
  const lossy = formatDedupeNote({ rows_read: 166, rows_kept: 147, replays_dropped: 16, superseded_dropped: 0, conflicts: 1, conflict_rows_excluded: 2, unkeyed_kept: 0 });
  assert.equal(lossy, '166 rows read, 147 after replay-dedupe (16 replays, 1 conflict excluded)');
  const clean = formatDedupeNote({ rows_read: 5, rows_kept: 5, replays_dropped: 0, superseded_dropped: 0, conflicts: 0, conflict_rows_excluded: 0, unkeyed_kept: 0 });
  assert.equal(clean, '5 rows read, 5 after replay-dedupe');
});
