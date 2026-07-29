import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordRetrievalEvent, normalizeRetrievalEvent, RETRIEVAL_EVENT_SCHEMA_VERSION } from '../../plugins/core/skills/core/scripts/record-retrieval-event.mjs';
import { buildReport, loadEvents } from '../../plugins/core/skills/core/scripts/analyze-retrieval-quality.mjs';
import { sanitizeAttributeValue, MAX_ATTRIBUTE_STRING } from '../../plugins/core/skills/core/scripts/log-event.mjs';

const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RECORD_RETRIEVAL_EVENT_SCRIPT = join(PLUGIN_ROOT, 'plugins', 'core', 'skills', 'core', 'scripts', 'record-retrieval-event.mjs');

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

test('recordRetrievalEvent writes retrieval proof visible to the analyzer', () => {
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
      { unit_id: 'dc-retrieval-path', retrievals: 1, dipback_observed: 1, rate: 1 },
    ]);

    // OTel dual-write retired 2026-07-24 (docs/specs/2026-07-23-metrics-holistic-redesign.md
    // §3a) — the JSONL log above is the sole substrate now, so no _metrics/traces/ file
    // gets written at all.
    assert.equal(existsSync(join(root, '_metrics', 'traces')), false, 'no trace dir is written');
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
    RECORD_RETRIEVAL_EVENT_SCRIPT,
    root,
    '--event-json', event,
    '--today', '2026-05-30',
    '--now', '2026-05-30T16:45:00.000Z',
    '--session-id', 'cli-session',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(buildReport(loadEvents(root, { allTime: true })).retrieval_events, 1);
}));

test('sanitizeAttributeValue caps string length with an explicit truncation marker', () => {
  const long = 'x'.repeat(MAX_ATTRIBUTE_STRING + 4000);
  const out = sanitizeAttributeValue(long);
  assert.ok(out.length <= MAX_ATTRIBUTE_STRING + 40, 'bounded');
  assert.match(out, /truncated 4000 chars/, 'truncation is visible, not silent');
});

test('sanitizeAttributeValue strips control chars but keeps newlines/tabs', () => {
  assert.equal(sanitizeAttributeValue('a\u0000b\u001bc\nd\te'), 'abc\nd\te');
});

test('sanitizeAttributeValue sanitizes nested objects recursively, depth-capped', () => {
  const out = sanitizeAttributeValue({
    note: 'y'.repeat(5000),
    evil: 'a\u0000b\u001bc',
    deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
  });
  assert.ok(out.note.length <= 1100);
  assert.equal(out.evil, 'abc');
  assert.match(JSON.stringify(out.deep), /depth-capped/);
});

test('normalizeRetrievalEvent sanitizes unit ids and topics', () => {
  const r = normalizeRetrievalEvent({
    trigger: 'session-start',
    intent_topics: ['memory\u0000-arch'],
    tier_reached: 1,
    escalation_path: [1],
    units_retrieved: [{ id: 'dc-1-e\u001bvil', tier: 1 }],
  });
  assert.equal(r.intent_topics[0], 'memory-arch');
  assert.equal(r.units_retrieved[0].id, 'dc-1-evil');
});

// ---------------------------------------------------------------------------
// schema_version stamping: every row this producer writes must carry the CURRENT
// schema version so a reader can tell "written under the fully-enforced
// current contract" apart from pre-versioning history — and the producer's
// own stamp must always win over anything a caller tries to supply.
// ---------------------------------------------------------------------------

test('normalizeRetrievalEvent always stamps the current schema_version', () => {
  const r = normalizeRetrievalEvent(validEvent());
  assert.equal(r.schema_version, RETRIEVAL_EVENT_SCHEMA_VERSION);
});

test('normalizeRetrievalEvent overrides any caller-supplied schema_version — it is never a passthrough field', () => {
  const r = normalizeRetrievalEvent(validEvent({ schema_version: '99.9.9' }));
  assert.equal(r.schema_version, RETRIEVAL_EVENT_SCHEMA_VERSION);
});

test('recordRetrievalEvent writes a row on disk carrying schema_version, visible to the analyzer as current-schema', () => withTempProject((root) => {
  recordRetrievalEvent(root, validEvent(), { today: '2026-07-22', sessionId: 'schema-version-check' });
  const events = loadEvents(root, { allTime: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].schema_version, RETRIEVAL_EVENT_SCHEMA_VERSION);
}));
