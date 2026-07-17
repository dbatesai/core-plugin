import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatReport } from '../../plugins/core/skills/core/scripts/analyze-retrieval-quality.mjs';

test('telemetry-only rows do not count as retrieval proof', () => {
  const report = buildReport([
    {
      ts: '2026-05-30T13:17:07.230Z',
      kind: 'hot-section-synthesis',
      tokens: 318,
      budget: 500,
      over_budget: false,
      applied: true,
    },
  ]);

  assert.equal(report.total_events, 1);
  assert.equal(report.retrieval_events, 0);
  assert.equal(report.telemetry_only_events, 1);
  assert.equal(report.tier_distribution.total, 0);
  assert.equal(report.tier_distribution.t1.count, 0);
});

test('retrieval-shaped rows still drive tier distribution and dip-back rates', () => {
  const report = buildReport([
    {
      ts: '2026-05-30T15:00:00.000Z',
      kind: 'retrieval',
      intent_topics: ['retrieval'],
      tier_reached: 2,
      units_retrieved: [{ id: 'dc-retrieval-path', tier: 1, score: 0.9 }],
      dip_back_count: 1,
      escalation_path: [1, 2],
    },
  ]);

  assert.equal(report.total_events, 1);
  assert.equal(report.retrieval_events, 1);
  assert.equal(report.telemetry_only_events, 0);
  assert.equal(report.tier_distribution.total, 1);
  assert.equal(report.tier_distribution.t2.count, 1);
  assert.deepEqual(report.dip_back_rates, [
    { unit_id: 'dc-retrieval-path', retrievals: 1, dipback_observed: 1, rate: 1 },
  ]);
});

test('dip-back unknown-aware: rows omitting the field leave numerator AND denominator', () => {
  // Two hook rows (no dip_back_count — the per-turn hook cannot observe it) and
  // one agent row that observed a dip-back. Missing is not "no dip-back": the
  // rate divides by the ONE observed row, and coverage is reported (2026-07-17).
  const rows = [
    { ts: '2026-07-17T01:00:00Z', kind: 'retrieval', trigger: 'per-turn-hook', intent_topics: ['a'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'dc-x', tier: 1 }] },
    { ts: '2026-07-17T02:00:00Z', kind: 'retrieval', trigger: 'per-turn-hook', intent_topics: ['b'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'dc-x', tier: 1 }] },
    { ts: '2026-07-17T03:00:00Z', kind: 'retrieval', intent_topics: ['c'], tier_reached: 2, escalation_path: [1, 2], units_retrieved: [{ id: 'dc-x', tier: 1 }], dip_back_count: 1 },
  ];
  const report = buildReport(rows);
  assert.deepEqual(report.dip_back_rates, [
    { unit_id: 'dc-x', retrievals: 3, dipback_observed: 1, rate: 1 },
  ]);
});

test('formatReport surfaces telemetry-only evidence gaps plainly', () => {
  const report = buildReport([
    { ts: '2026-05-30T13:17:07.230Z', kind: 'hot-section-synthesis', tokens: 318 },
  ]);

  const formatted = formatReport(report);
  assert.match(formatted, /Retrieval-shaped events: 0/);
  assert.match(formatted, /telemetry-only rows: 1/);
  assert.match(formatted, /not retrieval proof/i);
});

test('empty events array yields a zero report and the no-events message', () => {
  const report = buildReport([]);
  assert.equal(report.total_events, 0);
  assert.equal(report.retrieval_events, 0);
  assert.match(formatReport(report), /No retrieval events found/);
});

// Characterization: `units_retrieved` makes the row retrieval-shaped even with no
// tier_reached; computeTierDistribution coerces the missing tier (NaN || 1) into
// the T1 bucket — the row lands IN tier_distribution.total, not outside it.
test('a retrieval row missing tier_reached does not crash the tier distribution (characterized: bucketed as T1)', () => {
  const report = buildReport([
    { ts: '2026-06-09T00:00:00.000Z', kind: 'retrieval', units_retrieved: [] },
  ]);
  assert.equal(report.retrieval_events, 1);
  assert.equal(report.tier_distribution.total, 1, 'tier-less row is counted in the distribution');
  assert.equal(report.tier_distribution.t1.count, 1, 'missing tier defaults to the T1 bucket');
});

test('MET-015: report header says calendar days and names the T1 exclusion rule', () => {
  const report = buildReport([
    { ts: '2026-06-09T10:00:00Z', tier_reached: 1, units_retrieved: [{ id: 'u1' }], intent_topics: ['x'], escalation_path: [1] },
  ]);
  const text = formatReport(report);
  assert.match(text, /Calendar days with events/, 'no longer implies a session count');
  assert.doesNotMatch(text, /Session dates in window/);
  assert.match(text, /days with no retrieval events are excluded, not counted as perfect T1/i);
});
