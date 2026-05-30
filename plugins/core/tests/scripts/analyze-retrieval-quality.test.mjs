import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, formatReport } from '../../skills/core/scripts/analyze-retrieval-quality.mjs';

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
    { unit_id: 'dc-retrieval-path', retrievals: 1, rate: 1 },
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
