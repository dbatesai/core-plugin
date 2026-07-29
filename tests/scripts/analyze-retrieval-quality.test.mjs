import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildReport, formatReport, loadEvents, validateRetrievalLogRow, utcDayStart,
} from '../../plugins/core/skills/core/scripts/analyze-retrieval-quality.mjs';

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
  assert.deepEqual(report.receipt, {
    checked: '0 retrieval events in analyzed window',
    safe: null,
    impact: 'effectiveness unknown: no retrieval evidence',
    action: 'collect-retrieval-evidence',
    user_action: 'Use CORE normally, then run this analyzer again after retrieval events exist.',
  });
  assert.match(formatReport(report), /No retrieval events found/);
});

test('five-field receipt stays unknown without answer outcomes and asks for evidence', () => {
  const report = buildReport([
    { ts: '2026-07-17T03:00:00Z', kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1, units_retrieved: [{ id: 'dc-x' }] },
  ]);
  assert.deepEqual(Object.keys(report.receipt), ['checked', 'safe', 'impact', 'action', 'user_action']);
  assert.equal(report.receipt.safe, null, 'telemetry alone cannot prove answer safety');
  assert.match(report.receipt.checked, /1 retrieval event/);
  assert.match(report.receipt.impact, /outcome unknown/i);
  assert.equal(report.receipt.action, 'collect-answer-outcomes');
  assert.match(report.receipt.user_action, /record.*outcome/i);
  assert.match(formatReport(report), /Safe: unknown/i);
});

test('five-field receipt reports observed outcome problems without claiming global safety', () => {
  const report = buildReport([
    { ts: '2026-07-17T03:00:00Z', kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1, units_retrieved: [{ id: 'dc-x' }] },
    { ts: '2026-07-17T03:01:00Z', kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'noisy', evidence_authority: 'user-confirmed' },
  ]);
  assert.equal(report.receipt.safe, false);
  assert.match(report.receipt.checked, /1 of 1 answer outcome/);
  assert.match(report.receipt.impact, /noisy/i);
  assert.equal(report.receipt.action, 'inspect-harmful-outcomes');
  assert.match(report.receipt.user_action, /retrieval r-1/i);
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

test('multiple outcome rows for one retrieval resolve by authority, not first-wins (shared resolver, Hale audit 2026-07-17)', () => {
  // An automatic low-authority 'unknown' close lands first, then a real
  // user-confirmed 'noisy' arrives later. Keeping "first" would report
  // safe:null forever; the shared resolver used here is the same one
  // metrics-package.mjs uses, so the two consumers can never disagree.
  const report = buildReport([
    { ts: '2026-07-17T03:00:00Z', kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1, units_retrieved: [{ id: 'dc-x' }] },
    { ts: '2026-07-17T03:01:00Z', kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'unknown', evidence_authority: 'unobservable' },
    { ts: '2026-07-17T03:05:00Z', kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'noisy', evidence_authority: 'user-confirmed' },
  ]);
  assert.equal(report.receipt.safe, false, 'the later, stronger-authority outcome is the one that resolves — never the first row');
  assert.equal(report.receipt.action, 'inspect-harmful-outcomes');
});

test('equal-authority disagreeing outcomes resolve to unknown, not first-wins', () => {
  const report = buildReport([
    { ts: '2026-07-17T03:00:00Z', kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1, units_retrieved: [{ id: 'dc-x' }] },
    { ts: '2026-07-17T03:01:00Z', kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_authority: 'agent-attribution' },
    { ts: '2026-07-17T03:02:00Z', kind: 'retrieval-outcome', retrieval_id: 'r-1', usefulness_outcome: 'miss', evidence_authority: 'agent-attribution' },
  ]);
  assert.equal(report.receipt.safe, null, 'a resolved unknown asks for more evidence rather than claiming either side');
  assert.equal(report.receipt.action, 'collect-answer-outcomes');
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

// ---------------------------------------------------------------------------
// validateRetrievalLogRow — schema validation, slice 2 of the metrics
// evidence-lifecycle contract (2026-07-22, Hale's synthesis, item 2, revised
// per his early review "use producer schema and isolate legacy"): current-
// schema rows reuse record-retrieval-event.mjs's own normalizeRetrievalEvent()
// as the single canonical contract; versionless rows get a narrow legacy
// check and are tagged 'legacy', never implying full current conformance;
// an unrecognized schema_version is rejected outright. All rejections carry
// a CLOSED code only.
// ---------------------------------------------------------------------------

const CURRENT_SCHEMA_VERSION = '1.0.0'; // mirrors RETRIEVAL_EVENT_SCHEMA_VERSION in record-retrieval-event.mjs

function currentRow(overrides = {}) {
  return {
    kind: 'retrieval', schema_version: CURRENT_SCHEMA_VERSION,
    trigger: 'session-start', intent_topics: ['a'], tier_reached: 2,
    escalation_path: [1, 2], units_retrieved: [{ id: 'u1', tier: 1 }],
    ...overrides,
  };
}

test('validateRetrievalLogRow: a current-schema, fully-formed retrieval row is valid under schema:current', () => {
  const r = validateRetrievalLogRow(currentRow());
  assert.equal(r.status, 'valid');
  assert.equal(r.schema, 'current');
});

test('validateRetrievalLogRow: current-schema — missing tier_reached is rejected as missing-tier', () => {
  const r = validateRetrievalLogRow(currentRow({ tier_reached: undefined }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.schema, 'current');
  assert.equal(r.code, 'missing-tier');
});

test('validateRetrievalLogRow: current-schema — out-of-range tier_reached is rejected as invalid-tier', () => {
  const r = validateRetrievalLogRow(currentRow({ tier_reached: 99, escalation_path: [1, 99] }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-tier');
});

// --- Hale's requested cross-field falsifiers (2026-07-22, slice-2 review) ---

test('falsifier: tier_reached / escalation_path mismatch is rejected as invalid-escalation-path', () => {
  const r = validateRetrievalLogRow(currentRow({ tier_reached: 2, escalation_path: [1] })); // path ends at 1, not 2
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-escalation-path');
});

test('falsifier: empty units_retrieved with an invalid/missing result code is rejected as invalid-result', () => {
  const r = validateRetrievalLogRow(currentRow({ tier_reached: 3, escalation_path: [1, 2, 3], units_retrieved: [] })); // no result: 'miss'
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-result');
});

test('falsifier: empty units_retrieved with an explicit miss result is valid (the honest empty shape)', () => {
  const r = validateRetrievalLogRow(currentRow({ tier_reached: 3, escalation_path: [1, 2, 3], units_retrieved: [], result: 'miss' }));
  assert.equal(r.status, 'valid');
});

test('falsifier: an invalid trigger value is rejected as invalid-trigger', () => {
  const r = validateRetrievalLogRow(currentRow({ trigger: 'not-a-real-trigger' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-trigger');
});

test('falsifier: an out-of-range unit tier is rejected as invalid-units', () => {
  const r = validateRetrievalLogRow(currentRow({ units_retrieved: [{ id: 'u1', tier: 9 }] }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-units');
});

test('falsifier: an invalid unit source_stage is rejected as invalid-units', () => {
  const r = validateRetrievalLogRow(currentRow({ units_retrieved: [{ id: 'u1', tier: 1, source_stage: 'not-a-real-stage' }] }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-units');
});

test('falsifier: an unrecognized schema_version is rejected outright, never treated as legacy or current', () => {
  const r = validateRetrievalLogRow(currentRow({ schema_version: '99.0.0' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.schema, 'unknown-version');
  assert.equal(r.code, 'unknown-schema-version');
});

test('falsifier: a secret-shaped invalid tier_reached value never reappears anywhere in the validation result', () => {
  const secret = 'sk-live-does-not-exist-abcdef1234567890';
  const r = validateRetrievalLogRow(currentRow({ tier_reached: secret }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-tier');
  assert.doesNotMatch(JSON.stringify(r), new RegExp(secret));
});

test('validateRetrievalLogRow: units_retrieved must be an array (current schema)', () => {
  const r = validateRetrievalLogRow(currentRow({ units_retrieved: 'not-an-array' }));
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'invalid-units');
});

test('validateRetrievalLogRow: a non-object row is rejected as invalid-row-shape', () => {
  assert.equal(validateRetrievalLogRow(null).code, 'invalid-row-shape');
  assert.equal(validateRetrievalLogRow('nope').code, 'invalid-row-shape');
  assert.equal(validateRetrievalLogRow([1, 2]).code, 'invalid-row-shape');
});

test('validateRetrievalLogRow: a different explicit kind (outcome/telemetry) is not-applicable, never rejected', () => {
  assert.equal(validateRetrievalLogRow({ kind: 'retrieval-outcome', retrieval_id: 'r-1' }).status, 'not-applicable');
  assert.equal(validateRetrievalLogRow({ kind: 'hot-section-synthesis', tokens: 320 }).status, 'not-applicable');
});

test('validateRetrievalLogRow: a row with no kind and no retrieval shape at all is not-applicable', () => {
  assert.equal(validateRetrievalLogRow({ foo: 'bar' }).status, 'not-applicable');
});

// --- Legacy path: versionless rows, narrow check, always tagged 'legacy' ---

test('validateRetrievalLogRow: a versionless row with no kind field but retrieval-shaped is legacy-valid', () => {
  const good = validateRetrievalLogRow({ tier_reached: 1, units_retrieved: [{ id: 'u1' }] });
  assert.equal(good.status, 'valid');
  assert.equal(good.schema, 'legacy');
});

test('validateRetrievalLogRow: a versionless row missing tier_reached is legacy-rejected, not defaulted to Tier 1', () => {
  const r = validateRetrievalLogRow({ kind: 'retrieval', units_retrieved: [{ id: 'u1' }] });
  assert.equal(r.status, 'rejected');
  assert.equal(r.schema, 'legacy');
  assert.equal(r.code, 'legacy-missing-tier');
});

test('validateRetrievalLogRow: a versionless row is never validated against the full current-producer contract (no trigger required)', () => {
  // No trigger, no escalation_path -- the FULL contract would reject this, but
  // legacy narrow-compatibility only checks tier_reached/units_retrieved/intent_topics.
  const r = validateRetrievalLogRow({ kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1, units_retrieved: [{ id: 'u1' }] });
  assert.equal(r.status, 'valid');
  assert.equal(r.schema, 'legacy');
});

test('validateRetrievalLogRow: a versionless row with a malformed unit is legacy-rejected', () => {
  const r = validateRetrievalLogRow({ kind: 'retrieval', tier_reached: 1, units_retrieved: [{ tier: 1 }] }); // no id
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'legacy-invalid-units');
});

test('validateRetrievalLogRow: a versionless row with malformed intent_topics is legacy-rejected', () => {
  const r = validateRetrievalLogRow({ kind: 'retrieval', tier_reached: 1, units_retrieved: [], intent_topics: ['ok', 5] });
  assert.equal(r.status, 'rejected');
  assert.equal(r.code, 'legacy-invalid-topics');
});

// ---------------------------------------------------------------------------
// loadEvents — real file-reading integration: malformed rows are rejected and
// counted (never silently dropped) with a closed code, telemetry-only rows
// pass through untouched, and valid retrieval rows still load normally.
// ---------------------------------------------------------------------------

function withTempProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'analyze-retrieval-quality-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('loadEvents: rejects a JSON-unparseable line and counts it with the invalid-json code, rather than silently skipping', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  const validRow = JSON.stringify(currentRow());
  writeFileSync(join(day, 'retrieval-log.jsonl'), `${validRow}\n{not valid json\n`);

  const events = loadEvents(root, { allTime: true });
  assert.equal(events.length, 1, 'only the valid row loads');
  assert.equal(events.rejected.length, 1);
  assert.equal(events.rejected[0].code, 'invalid-json');
  assert.ok(events.rejected[0].file, 'the file path is kept for LOCAL diagnostics only');
}));

test('loadEvents: rejects a current-schema row with an invalid tier and counts it under schema:current', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  const rows = [
    currentRow(),                                                    // valid
    currentRow({ tier_reached: undefined, escalation_path: undefined }), // malformed: no tier_reached
  ];
  writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const events = loadEvents(root, { allTime: true });
  assert.equal(events.length, 1);
  assert.equal(events.rejected.length, 1);
  assert.equal(events.rejected[0].schema, 'current');
  assert.equal(events.rejected[0].code, 'missing-tier');
}));

test('loadEvents: a versionless legacy row that fails the narrow check is rejected and tagged schema:legacy', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  const rows = [
    { kind: 'retrieval', tier_reached: 1, units_retrieved: [{ id: 'u1' }] },   // legacy-valid
    { kind: 'retrieval', units_retrieved: [{ id: 'u2' }] },                    // legacy-rejected
  ];
  writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const events = loadEvents(root, { allTime: true });
  assert.equal(events.length, 1);
  assert.equal(events.rejected.length, 1);
  assert.equal(events.rejected[0].schema, 'legacy');
  assert.equal(events.rejected[0].code, 'legacy-missing-tier');
}));

test('loadEvents: non-retrieval telemetry rows pass through untouched, never counted as rejected', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  const rows = [
    { kind: 'hot-section-synthesis', tokens: 320, budget: 500 },
    currentRow(),
  ];
  writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const events = loadEvents(root, { allTime: true });
  assert.equal(events.length, 2, 'the telemetry row loads too — it is a different event kind, not malformed');
  assert.equal(events.rejected.length, 0);
}));

// ---------------------------------------------------------------------------
// buildReport / formatReport — rejection counts surfaced by CLOSED code only,
// split current vs legacy, never silently folded into "valid", and never
// leaking a raw value or file path into the report object itself.
// ---------------------------------------------------------------------------

test('buildReport: a plain hand-built array (no loadEvents .rejected) reports all-zero rejection counts', () => {
  const report = buildReport([currentRow()]);
  assert.equal(report.rejected.total, 0);
  assert.equal(report.rejected.current.count, 0);
  assert.equal(report.rejected.legacy.count, 0);
});

test('buildReport + loadEvents: rejected current-schema rows surface by code, distinct from valid count, no raw value leaked', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  const secretLooking = 'sk-fake-secret-zzz999';
  const rows = [
    currentRow(),
    currentRow({ intent_topics: ['b'] }),
    currentRow({ tier_reached: secretLooking, escalation_path: undefined }), // malformed
  ];
  writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const events = loadEvents(root, { allTime: true });
  const report = buildReport(events);
  assert.equal(report.retrieval_events, 2, 'only the 2 valid rows count as evidence');
  assert.equal(report.rejected.total, 1);
  assert.equal(report.rejected.current.count, 1);
  assert.equal(report.rejected.current.by_code['invalid-tier'], 1);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secretLooking), 'the raw malformed value must never reach the report object');

  const text = formatReport(report);
  assert.match(text, /Rejected malformed rows: 1/);
  assert.match(text, /invalid-tier: 1/);
  assert.doesNotMatch(text, new RegExp(secretLooking), 'the raw malformed value must never reach rendered text');
}));

test('formatReport: prints "Rejected malformed rows: 0" plainly when nothing was rejected (checked, not assumed)', () => {
  const report = buildReport([currentRow()]);
  assert.match(formatReport(report), /Rejected malformed rows: 0/);
});

test('formatReport: an all-rejected corpus (zero valid events) still names the rejected count, distinct from a truly empty corpus', () => withTempProject((root) => {
  const day = join(root, '_sessions', '2026-07-22');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, 'retrieval-log.jsonl'), JSON.stringify({ kind: 'retrieval', units_retrieved: [{ id: 'u1' }] }) + '\n');

  const events = loadEvents(root, { allTime: true });
  const report = buildReport(events);
  assert.equal(report.total_events, 0);
  const text = formatReport(report);
  assert.match(text, /Rejected malformed rows: 1/);
  assert.match(text, /NOT zero valid events/);
}));

// --- UTC-labeled day bounds are computed with UTC getters ---

test('the UTC day bound is the UTC calendar day, not the local one', () => {
  // A machine east of UTC late in its local day is already on the NEXT UTC day; a
  // machine west of UTC early in its local day is still on the PREVIOUS one. Feeding
  // local getters into Date.UTC labels either as "UTC" and shifts the whole window.
  const at = new Date('2026-07-28T23:30:00.000Z');
  assert.equal(utcDayStart(at).toISOString(), '2026-07-28T00:00:00.000Z');
  const early = new Date('2026-07-28T00:30:00.000Z');
  assert.equal(utcDayStart(early).toISOString(), '2026-07-28T00:00:00.000Z');
});

// --- Corrupt rows change the verdict; they are never silently elided ---

const okRow = (id) => ({
  kind: 'retrieval', schema_version: '1.0.0', ts: '2026-07-28T00:00:00.000Z',
  retrieval_id: id, tier_reached: 1, units_retrieved: [{ id: 'u-1' }], intent_topics: [],
});

test('a corpus that is mostly unreadable produces UNKNOWN, not a verdict on the survivors', () => {
  const events = Object.assign([okRow('r-1')], {
    rejected: [
      { file: '/x/retrieval-log.jsonl', schema: 'unknown', code: 'invalid-json' },
      { file: '/x/retrieval-log.jsonl', schema: 'unknown', code: 'invalid-json' },
      { file: '/x/retrieval-log.jsonl', schema: 'current', code: 'invalid-tier' },
    ],
  });
  const report = buildReport(events);
  assert.equal(report.receipt.safe, null);
  assert.equal(report.receipt.action, 'repair-corrupt-evidence');
  assert.match(report.receipt.checked, /3/, 'the rejected count is stated, not dropped');
  assert.equal(report.rejected.total, 3);
});

test('the receipt keeps its five-field shape when corruption forces UNKNOWN', () => {
  const events = Object.assign([okRow('r-1')], {
    rejected: [{ file: '/x/retrieval-log.jsonl', schema: 'unknown', code: 'invalid-json' }, { file: '/x/y', schema: 'unknown', code: 'invalid-json' }],
  });
  assert.deepEqual(Object.keys(buildReport(events).receipt), ['checked', 'safe', 'impact', 'action', 'user_action']);
});

test('a corpus with no corrupt rows still reaches its ordinary verdict', () => {
  const events = Object.assign([okRow('r-1')], { rejected: [] });
  assert.notEqual(buildReport(events).receipt.action, 'repair-corrupt-evidence');
});

test('a negligible share of corrupt rows does not suppress the verdict', () => {
  const rows = Array.from({ length: 40 }, (_, i) => okRow(`r-${i}`));
  const events = Object.assign(rows, { rejected: [{ file: '/x/y', schema: 'unknown', code: 'invalid-json' }] });
  const report = buildReport(events);
  assert.notEqual(report.receipt.action, 'repair-corrupt-evidence');
  assert.equal(report.rejected.total, 1, 'still counted and reported');
});
