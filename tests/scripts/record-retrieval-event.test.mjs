import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRetrievalEvent } from '../../skills/core/scripts/record-retrieval-event.mjs';
import { buildReport, loadEvents } from '../../skills/core/scripts/analyze-retrieval-quality.mjs';

function validEvent(overrides = {}) {
  return {
    trigger: 'session-start',
    intent_topics: ['core-plugin', 'retrieval'],
    tier_reached: 2,
    escalation_path: [1, 2],
    units_retrieved: [{ id: 'dc-retrieval-path', tier: 1, score: 0.91 }],
    dip_back_count: 1,
    ...overrides,
  };
}

function withTempProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-event-'));
  try {
    return fn(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('recordRetrievalEvent writes retrieval proof visible to analyzer and OTel', () => {
  const root = mkdtempSync(join(tmpdir(), 'retrieval-event-'));
  try {
    recordRetrievalEvent(root, {
      trigger: 'session-start',
      intent_topics: ['core-plugin', 'retrieval'],
      tier_reached: 2,
      escalation_path: [1, 2],
      units_retrieved: [{ id: 'dc-retrieval-path', tier: 1, score: 0.91 }],
      dip_back_count: 1,
      candidate_count: 6,
      selected_count: 1,
      edge_count: 2,
      retired_suppressed_count: 1,
      stale_suppressed_count: 0,
      native_memory_suppressed_count: 3,
      context_pack_token_estimate: 410,
      usefulness_outcome: 'useful',
    }, {
      today: '2026-05-30',
      now: '2026-05-30T16:30:00.000Z',
      sessionId: 'session-1',
    });

    const events = loadEvents(root, { allTime: true });
    const report = buildReport(events);
    assert.equal(report.total_events, 1);
    assert.equal(report.retrieval_events, 1);
    assert.equal(report.telemetry_only_events, 0);
    assert.equal(report.tier_distribution.t2.count, 1);
    assert.deepEqual(report.dip_back_rates, [
      { unit_id: 'dc-retrieval-path', retrievals: 1, rate: 1 },
    ]);

    const trace = readFileSync(join(root, '_metrics', 'traces', 'session-1.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))[0];
    assert.equal(trace.span_name, 'core.retrieval');
    assert.equal(trace.attributes['core.trigger'], 'session-start');
    assert.equal(trace.attributes['core.tier_reached'], 2);
    assert.deepEqual(trace.attributes['core.units_retrieved'], [{ id: 'dc-retrieval-path', tier: 1, score: 0.91 }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordRetrievalEvent rejects malformed retrieval rows before write', () => withTempProject((root) => {
  const cases = [
    ['missing trigger', { trigger: undefined }, /trigger/],
    ['empty topics', { intent_topics: [] }, /intent_topics/],
    ['invalid tier', { tier_reached: 4 }, /tier_reached/],
    ['empty escalation path', { escalation_path: [] }, /escalation_path/],
    ['path does not end at tier', { tier_reached: 2, escalation_path: [1] }, /tier_reached/],
    ['negative dip-back count', { dip_back_count: -1 }, /dip_back_count/],
    ['missing unit id', { units_retrieved: [{ tier: 1 }] }, /units_retrieved/],
  ];

  for (const [name, overrides, pattern] of cases) {
    assert.throws(
      () => recordRetrievalEvent(root, validEvent(overrides), { today: '2026-05-30', sessionId: name }),
      pattern,
      name
    );
  }
  assert.equal(loadEvents(root, { allTime: true }).length, 0, 'invalid rows are never written');
}));

test('recordRetrievalEvent treats empty Tier 3 retrievals as misses only when explicit', () => withTempProject((root) => {
  assert.throws(
    () => recordRetrievalEvent(root, validEvent({
      tier_reached: 3,
      escalation_path: [1, 2, 3],
      units_retrieved: [],
    }), { today: '2026-05-30', sessionId: 'bad-tier3' }),
    /result/
  );

  recordRetrievalEvent(root, validEvent({
    tier_reached: 3,
    escalation_path: [1, 2, 3],
    units_retrieved: [],
    result: 'miss',
  }), { today: '2026-05-30', now: '2026-05-30T16:40:00.000Z', sessionId: 'tier3-miss' });
  assert.equal(buildReport(loadEvents(root, { allTime: true })).tier_distribution.t3.count, 1);
}));

test('record-retrieval-event CLI writes an analyzer-visible row', () => withTempProject((root) => {
  const event = JSON.stringify(validEvent({
    tier_reached: 1,
    escalation_path: [1],
    dip_back_count: 0,
  }));
  const result = spawnSync(process.execPath, [
    'skills/core/scripts/record-retrieval-event.mjs',
    root,
    '--event-json', event,
    '--today', '2026-05-30',
    '--now', '2026-05-30T16:45:00.000Z',
    '--session-id', 'cli-session',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(buildReport(loadEvents(root, { allTime: true })).retrieval_events, 1);
}));
