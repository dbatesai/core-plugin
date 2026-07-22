import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dedupeClassifiedRows, dedupeClassifiedByDay,
  dedupeDetectorRows, formatDedupeNote,
} from '../../plugins/core/skills/core/scripts/metrics-dedupe.mjs';

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

test('same full key with different state keeps last-written and counts the conflict visibly', () => {
  const first = row({ state: 'tier-1-3-win' });
  const second = row({ state: 'rec-fail-tier-0' });
  const { rows, stats } = dedupeClassifiedRows([first, second]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'rec-fail-tier-0', 'last-written wins (the later run saw the fuller transcript)');
  assert.equal(stats.replays_dropped, 1);
  assert.equal(stats.conflicts, 1, 'the disagreement is counted, never silent');
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
