import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderBar, computeRows, buildNarrative, renderReport, parseRecognitionSignal,
  checkCalibrationPool, checkGoldRegression, checkLiveRetrievalProxy, gatherMetrics,
  producerIdentity, METRICS_REPORT_SCHEMA_VERSION,
  BAR_WIDTH, FILLED_CHAR, EMPTY_CHAR, FAILED_CHAR, TRUST, SECTION,
} from '../../plugins/core/skills/core/scripts/metrics-check.mjs';

const SCRIPT = join(import.meta.dirname, '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'metrics-check.mjs');
const MANIFEST = join(import.meta.dirname, '..', '..', 'plugins', 'core', '.claude-plugin', 'plugin.json');

// ---------------------------------------------------------------------------
// renderBar — the 10-char gauge. Deterministic rounding, tested at boundaries.
// ---------------------------------------------------------------------------

test('renderBar: 100% is fully filled', () => {
  assert.equal(renderBar(100), FILLED_CHAR.repeat(BAR_WIDTH));
});

test('renderBar: 0% is fully empty', () => {
  assert.equal(renderBar(0), EMPTY_CHAR.repeat(BAR_WIDTH));
});

test('renderBar: 73% renders 7 filled + 3 empty (floor of the 10%-bin midpoint rule)', () => {
  assert.equal(renderBar(73), FILLED_CHAR.repeat(7) + EMPTY_CHAR.repeat(3));
});

test('renderBar: boundary — exactly 5% rounds UP to 1 filled block, not 0', () => {
  // 5 / (100/10) = 0.5 -> Math.round(0.5) = 1 (JS rounds positive .5 up).
  assert.equal(renderBar(5), FILLED_CHAR.repeat(1) + EMPTY_CHAR.repeat(9));
});

test('renderBar: boundary — just under 5% floors to 1 filled block, not 0 (low-but-present, not masked as absent)', () => {
  assert.equal(renderBar(4.9), FILLED_CHAR.repeat(1) + EMPTY_CHAR.repeat(9));
});

test('renderBar: a genuinely non-zero low percentage (3%) renders 1 filled block minimum, never 0 (the zero-masking bug)', () => {
  assert.equal(renderBar(3), FILLED_CHAR.repeat(1) + EMPTY_CHAR.repeat(9));
});

test('renderBar: a tiny fractional percentage (0.4%) still floors to 1 filled block, not 0', () => {
  assert.equal(renderBar(0.4), FILLED_CHAR.repeat(1) + EMPTY_CHAR.repeat(9));
});

test('renderBar: exact 0% still renders fully empty — zero and low-but-present must stay visually distinct', () => {
  assert.equal(renderBar(0), EMPTY_CHAR.repeat(10));
});

test('renderBar: boundary — exactly 15% rounds UP to 2 filled blocks, not 1', () => {
  assert.equal(renderBar(15), FILLED_CHAR.repeat(2) + EMPTY_CHAR.repeat(8));
});

test('renderBar: boundary — just under 15% stays at 1 filled block', () => {
  assert.equal(renderBar(14.9), FILLED_CHAR.repeat(1) + EMPTY_CHAR.repeat(9));
});

test('renderBar: negative and >100 values clamp into range', () => {
  assert.equal(renderBar(-20), EMPTY_CHAR.repeat(10));
  assert.equal(renderBar(150), FILLED_CHAR.repeat(10));
});

test('renderBar: failed:true renders the distinct FAILED_CHAR, ignoring pct', () => {
  assert.equal(renderBar(100, { failed: true }), FAILED_CHAR.repeat(BAR_WIDTH));
  assert.equal(renderBar(0, { failed: true }), FAILED_CHAR.repeat(BAR_WIDTH));
});

// ---------------------------------------------------------------------------
// parseRecognitionSignal — the metrics-rollup.mjs one-liner format.
// ---------------------------------------------------------------------------

test('parseRecognitionSignal: parses today pct, avg pct, and arrow', () => {
  const r = parseRecognitionSignal('rec-fail-tier-0: 3/6 turns today (50%) vs 7-day avg 21% ↑ [PROVISIONAL — classifier uncalibrated]');
  assert.equal(r.available, true);
  assert.equal(r.todayPct, 50);
  assert.equal(r.avgPct, 21);
  assert.equal(r.arrow, '↑');
});

test('parseRecognitionSignal: no prior 7-day average parses with avgPct null', () => {
  const r = parseRecognitionSignal('rec-fail-tier-0: 1/4 turns today (25%) vs 7-day avg n/a (no prior 7d)');
  assert.equal(r.available, true);
  assert.equal(r.todayPct, 25);
  assert.equal(r.avgPct, null);
});

test('parseRecognitionSignal: "no classified turns" signal is unavailable, not a parse failure', () => {
  const r = parseRecognitionSignal('metrics: no classified turns for 2026-07-22 yet [PROVISIONAL]');
  assert.equal(r.available, false);
});

test('parseRecognitionSignal: empty/missing text is unavailable', () => {
  assert.equal(parseRecognitionSignal(undefined).available, false);
  assert.equal(parseRecognitionSignal('').available, false);
});

// ---------------------------------------------------------------------------
// computeRows — seven rows across FOUR evidence-class sections (2026-07-22,
// Hale's slice-1 revise: mechanics / retrieval-regression / measurement-
// readiness / user-benefit; retrieval-log coverage and tier-distribution
// moved OUT of regression into mechanics as plain-count instrumentation;
// recognition + calibration moved into their own readiness section).
// ---------------------------------------------------------------------------

// The canonical four-class object (2026-07-22, Hale's acceptance revise):
// mechanics/regression/readiness/benefit at the top level, machine verdict
// scoped at mechanics.status, identity stamped — the SAME object --json
// emits and the renderer consumes.
function baseOut(overrides = {}) {
  return {
    schema_version: METRICS_REPORT_SCHEMA_VERSION,
    producer: { script: 'metrics-check.mjs', plugin: 'core', plugin_version: '0.0.0-test', source_sha: null },
    project: '/tmp/demo',
    mechanics: {
      status: 'WORKING',
      probe: { round_trip: true },
      store: {
        present: true,
        schema: { exit: 0 },
        integrity: { fail: 0 },
        warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] },
        census: { total: 10 },
        retrieval_log: { files: 10, rows: 10 },
      },
      telemetry: {},
    },
    regression: { gold: {} },
    readiness: {
      recognition_signal: null,
      calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false },
    },
    benefit: {
      status: TRUST.NOT_EVALUATED,
      reason: 'no matched memory-on/off comparison exists — nothing currently measures whether this helps',
    },
    caveats: [],
    ...overrides,
  };
}

test('computeRows: returns eight rows across mechanics/regression/readiness/benefit sections', () => {
  // Eight as of v3.14.0: the turn-capture state line ALWAYS renders (default-ON
  // stream — ON shows the disclosure, OFF confirms the opt-out took effect).
  const rows = computeRows(baseOut());
  assert.equal(rows.length, 8);
  const bySection = { mechanics: 0, regression: 0, readiness: 0, benefit: 0 };
  for (const r of rows) bySection[r.section]++;
  assert.equal(bySection.mechanics, 4);
  assert.equal(bySection.regression, 1);
  assert.equal(bySection.readiness, 2);
  assert.equal(bySection.benefit, 1);
});

test('computeRows: round-trip PASS renders 100% proven-live, tagged mechanics', () => {
  const rows = computeRows(baseOut());
  const rt = rows.find((r) => r.label === 'Round-trip proof');
  assert.equal(rt.pct, 100);
  assert.equal(rt.failed, false);
  assert.equal(rt.trust, TRUST.PROVEN_LIVE);
  assert.equal(rt.value, 'PASS');
  assert.equal(rt.section, SECTION.MECHANICS);
});

test('computeRows: round-trip FAIL is marked failed and shows FAIL', () => {
  const rows = computeRows(baseOut({ mechanics: { ...baseOut().mechanics, probe: { round_trip: false } } }));
  const rt = rows.find((r) => r.label === 'Round-trip proof');
  assert.equal(rt.failed, true);
  assert.equal(rt.value, 'FAIL');
});

test('computeRows: unit integrity is (clean/total) with 1 attention warning out of 293, tagged mechanics', () => {
  const out = baseOut({
    mechanics: {
      ...baseOut().mechanics,
      store: {
        present: true, schema: { exit: 0 }, integrity: { fail: 0 },
        warning_triage: { informational: 0, routine_upkeep: 0, attention: 1, attention_items: ['x'] },
        census: { total: 293 }, retrieval_log: { files: 1, rows: 1 },
      },
    },
  });
  const rows = computeRows(out);
  const ui = rows.find((r) => r.label === 'Unit integrity (293)');
  assert.equal(ui.value, '1 warning');
  assert.equal(ui.section, SECTION.MECHANICS);
  const expectedPct = (292 / 293) * 100;
  assert.ok(Math.abs(ui.pct - expectedPct) < 1e-9);
});

test('computeRows: calibration pool is labeled_count/min_needed, direct trust, tagged readiness', () => {
  const rows = computeRows(baseOut({ readiness: { recognition_signal: null, calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } } }));
  const cal = rows.find((r) => r.label === 'Calibration pool');
  assert.equal(cal.pct, 22);
  assert.equal(cal.trust, TRUST.DIRECT);
  assert.equal(cal.value, '22/100 labeled');
  assert.equal(cal.section, SECTION.READINESS);
});

test('computeRows: calibration unavailable falls back to 0/100 without crashing', () => {
  const rows = computeRows(baseOut({ readiness: { recognition_signal: null, calibration: {} } }));
  const cal = rows.find((r) => r.label === 'Calibration pool');
  assert.equal(cal.value, '0/100 labeled');
  assert.equal(cal.pct, 0);
});

test('computeRows: recognition signal bar is INVERTED (100 - rec-fail rate), tagged readiness', () => {
  const out = baseOut({
    readiness: {
      ...baseOut().readiness,
      recognition_signal: { text: 'rec-fail-tier-0: 3/6 turns today (50%) vs 7-day avg 21% ↑ [PROVISIONAL]' },
    },
  });
  const rows = computeRows(out);
  const rec = rows.find((r) => r.label === 'Recognition signal');
  assert.equal(rec.pct, 50); // 100 - 50
  assert.equal(rec.trust, TRUST.PROVISIONAL);
  assert.equal(rec.section, SECTION.READINESS);
  assert.match(rec.value, /50% rec-fail/);
});

test('computeRows: no store present renders "no store" and zero pct for store-dependent rows', () => {
  const rows = computeRows(baseOut({ mechanics: { ...baseOut().mechanics, store: { present: false } } }));
  const ui = rows.find((r) => r.label === 'Unit integrity (0)');
  assert.equal(ui.value, 'no store');
  assert.equal(ui.pct, 0);
});

// --- Telemetry capture row (MECHANICS): replaces the old percentage-based
// "Retrieval-log coverage" + "Live retrieval proxy" regression rows with a
// single COUNTS-ONLY, no-gauge mechanics/instrumentation row (Hale, 2026-07-22
// slice-1 revise: "rows÷days is an invalid denominator... show counts"). ---

test('computeRows: Telemetry capture is a no-gauge MECHANICS row with plain counts, no percentage claim', () => {
  const rows = computeRows(baseOut({
    mechanics: {
      ...baseOut().mechanics,
      telemetry: {
        available: true, days: 36, retrievalEvents: 266,
        t1Pct: 99, t2Pct: 1, t3Pct: 0,
        topEscalationTopic: 'agents-md', topEscalationRate: 100,
        rejected: { current: { count: 0, by_code: {} }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 0 },
      },
    },
  }));
  const tel = rows.find((r) => r.label === 'Telemetry capture');
  assert.ok(tel, 'the row must exist');
  assert.equal(tel.section, SECTION.MECHANICS);
  assert.equal(tel.noGauge, true);
  assert.match(tel.value, /266 typed events \/ 36 days/);
  assert.match(tel.value, /closure denominator unavailable/);
  assert.match(tel.value, /T1 99%\/T2 1%\/T3 0% mix/);
  assert.match(tel.value, /'agents-md' needed Tier 2\+ 100%/);
});

test('computeRows: Telemetry capture names rejected-row counts by schema tier when present', () => {
  const rows = computeRows(baseOut({
    mechanics: {
      ...baseOut().mechanics,
      telemetry: {
        available: true, days: 1, retrievalEvents: 1,
        t1Pct: 100, t2Pct: 0, t3Pct: 0, topEscalationTopic: null, topEscalationRate: null,
        rejected: { current: { count: 2, by_code: { 'invalid-tier': 2 } }, legacy: { count: 1, by_code: { 'legacy-missing-tier': 1 } }, other: { count: 0, by_code: {} }, total: 3 },
      },
    },
  }));
  const tel = rows.find((r) => r.label === 'Telemetry capture');
  assert.match(tel.value, /3 row\(s\) rejected/);
  assert.match(tel.value, /2 current-schema/);
  assert.match(tel.value, /1 legacy/);
});

test('computeRows: Telemetry capture shows "0 rejected" plainly when nothing was rejected', () => {
  const rows = computeRows(baseOut());
  const tel = rows.find((r) => r.label === 'Telemetry capture');
  assert.match(tel.value, /0 rejected/);
});

test('computeRows: Telemetry capture absent still renders an honest absence, no-gauge', () => {
  const rows = computeRows(baseOut());
  const tel = rows.find((r) => r.label === 'Telemetry capture');
  assert.match(tel.value, /no retrieval events recorded/);
  assert.equal(tel.noGauge, true);
});

// --- Gold-set snapshot row (REGRESSION): present-with-evidence vs honestly-
// absent. Trust is `provisional` — a live run does not validate its own
// reference answers (Hale, 2026-07-22 slice-1 revise, item 5). ---

test('computeRows: gold-set snapshot absent renders NOT_EVALUATED with a plain reason, never silently omitted', () => {
  const rows = computeRows(baseOut());
  const gold = rows.find((r) => r.label === 'Gold-set snapshot');
  assert.ok(gold, 'the row must exist even with zero evidence');
  assert.equal(gold.trust, TRUST.NOT_EVALUATED);
  assert.equal(gold.pct, 0);
  assert.match(gold.value, /no gold-set regression evidence recorded/);
  assert.equal(gold.section, SECTION.REGRESSION);
});

test('computeRows: gold-set snapshot present renders PROVISIONAL trust (execution live, reference authority provisional)', () => {
  const rows = computeRows(baseOut({
    regression: { gold: { available: true, n: 22, storeUnits: 300, context3_r3: 0.6818, ranking_r10: 0.8182, bm25_r10: 0.8182 } },
  }));
  const gold = rows.find((r) => r.label === 'Gold-set snapshot (n=22)');
  assert.ok(gold, 'label must include n= when evidence is present');
  assert.equal(gold.trust, TRUST.PROVISIONAL, 'never proven-live — a live run does not validate its own answer key');
  assert.equal(gold.pct, 68);
  assert.match(gold.value, /execution proven-live/);
  assert.match(gold.value, /reference authority provisional/);
  assert.match(gold.value, /no preregistered pass threshold/);
  assert.match(gold.value, /R@3 68%/);
  assert.match(gold.value, /ranking R@10 82%/);
});

test('computeRows: gold-set harness failure surfaces its reason as NOT_EVALUATED, not a crash', () => {
  const rows = computeRows(baseOut({
    regression: { gold: { available: false, reason: 'gold-set harness run failed: missing authority tier on unit x' } },
  }));
  const gold = rows.find((r) => r.label === 'Gold-set snapshot');
  assert.equal(gold.trust, TRUST.NOT_EVALUATED);
  assert.match(gold.value, /harness run failed/);
});

// --- Matched-comparison row (BENEFIT): always present, always honestly
// "not evaluated". Renamed from "User-benefit evidence" per Hale's exact
// target shape. ---

test('computeRows: Matched comparison row is always present and always says plainly nothing measures it', () => {
  const rows = computeRows(baseOut());
  const benefit = rows.find((r) => r.label === 'Matched comparison');
  assert.ok(benefit, 'benefit row must never be silently omitted');
  assert.equal(benefit.section, SECTION.BENEFIT);
  assert.equal(benefit.trust, TRUST.NOT_EVALUATED);
  assert.equal(benefit.pct, 0);
  assert.equal(benefit.failed, undefined, 'absence is not a FAIL glyph — it is an empty bar');
  assert.match(benefit.value, /nothing currently measures whether this helps/);
});

// ---------------------------------------------------------------------------
// buildNarrative — 1-3 sentences, leads with failure on DEGRADED, speaks to
// all three evidence classes on WORKING.
// ---------------------------------------------------------------------------

function sentenceCount(text) {
  // Rough split: count '. ' boundaries plus a trailing period, good enough to
  // enforce the 1-3 sentence cap without a full NLP sentence splitter.
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

test('buildNarrative: WORKING with no caveats stays within 1-3 sentences and names all evidence classes', () => {
  const n = buildNarrative(baseOut());
  assert.ok(sentenceCount(n) <= 3, `expected <=3 sentences, got: ${n}`);
  assert.ok(sentenceCount(n) >= 1);
  assert.match(n, /Mechanics are proven and working/);
  assert.match(n, /Retrieval regression:/);
  assert.match(n, /hasn't been measured yet/);
});

test('buildNarrative: DEGRADED leads with what failed and does not pad with regression/benefit sentences', () => {
  const out = baseOut({
    mechanics: {
      status: 'DEGRADED',
      probe: { round_trip: false },
      store: { present: true, schema: { exit: 1 }, integrity: { fail: 2 }, warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] } },
      telemetry: {},
    },
  });
  const n = buildNarrative(out);
  assert.ok(n.startsWith('DEGRADED —'), `expected DEGRADED lead, got: ${n}`);
  assert.match(n, /round-trip probe failed/);
  assert.match(n, /2 integrity failure/);
  assert.equal(sentenceCount(n), 1, 'DEGRADED must not be padded with the other evidence classes');
});

test('buildNarrative: MACHINERY-WORKING-NO-STORE names the gap plainly, single sentence', () => {
  const out = baseOut({ mechanics: { ...baseOut().mechanics, store: { present: false }, status: 'MACHINERY-WORKING-NO-STORE' } });
  const n = buildNarrative(out);
  assert.match(n, /no _memories\/ store yet/);
});

test('buildNarrative: names the calibration pool count and gate', () => {
  const n = buildNarrative(baseOut({ readiness: { recognition_signal: null, calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } } }));
  assert.match(n, /currently 22/);
  assert.match(n, /clears 100 labeled turns/);
});

test('buildNarrative: mentions the telemetry-capture and gold-set-snapshot numbers when present, never as a passing gate', () => {
  const n = buildNarrative(baseOut({
    regression: { gold: { available: true, n: 22, context3_r3: 0.68 } },
    mechanics: {
      ...baseOut().mechanics,
      telemetry: { available: true, retrievalEvents: 260, days: 36, t1Pct: 99, t2Pct: 1, t3Pct: 0 },
    },
  }));
  assert.match(n, /telemetry capture shows 260 typed events across 36 days/);
  assert.match(n, /delivered top-3 recall at 68%/);
  assert.match(n, /not a passing gate/);
});

test('buildNarrative: always states user benefit is unmeasured, never implies the other classes cover it', () => {
  const n = buildNarrative(baseOut());
  assert.match(n, /no matched memory-on\/off comparison exists/);
});

// ---------------------------------------------------------------------------
// renderReport — full assembled text: MECHANICS-scoped verdict heading, four
// labeled evidence-class sections (2026-07-22, Hale's slice-1 revise), a
// no-gauge Telemetry-capture row, and a quoted narrative.
// ---------------------------------------------------------------------------

test('renderReport: verdict heading is scoped to MECHANICS and reads HEALTHY, not the whole system', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'MECHANICS: HEALTHY');
  assert.equal(lines[2], 'CORE Memory Health — demo-project');
});

test('renderReport: renders six gauged rows (Telemetry capture has no gauge) across four labeled sections', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const rowLines = text.split('\n').filter((l) => l.includes('[') && l.includes(']'));
  assert.equal(rowLines.length, 6, 'seven total rows minus the one no-gauge Telemetry-capture row');
  assert.match(text, /^RETRIEVAL REGRESSION: PROVISIONAL$/m);
  assert.match(text, /^MEASUREMENT READINESS$/m);
  assert.match(text, /^USER BENEFIT: NOT EVALUATED$/m);
  assert.match(text, /Telemetry capture/);
  assert.ok(text.trim().endsWith('"'), 'narrative is quoted');
});

test('renderReport: the Telemetry capture row renders with no bracket/bar, unlike every other row', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const telemetryLine = text.split('\n').find((l) => l.startsWith('Telemetry capture'));
  assert.ok(telemetryLine, 'the row must render');
  assert.doesNotMatch(telemetryLine, /[█░✗]/, 'no gauge glyph of any kind');
  assert.doesNotMatch(telemetryLine, /\[.*\]/, 'no bracket pair either');
});

test('renderReport: WORKING-WITH-CAVEATS displays as HEALTHY — with caveats, still MECHANICS-scoped', () => {
  const out = baseOut({
    mechanics: {
      ...baseOut().mechanics,
      store: { ...baseOut().mechanics.store, warning_triage: { informational: 0, routine_upkeep: 0, attention: 1, attention_items: ['x'] } },
      status: 'WORKING-WITH-CAVEATS',
    },
  });
  const text = renderReport(out);
  assert.equal(text.split('\n')[0], 'MECHANICS: HEALTHY — with caveats');
});

test('renderReport: never claims retrieval regression or user benefit inside the mechanics verdict heading', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const heading = text.split('\n')[0];
  assert.doesNotMatch(heading, /retrieval|benefit/i);
});

// ---------------------------------------------------------------------------
// checkCalibrationPool — the integration point with calibrate-classifier.mjs.
// ---------------------------------------------------------------------------

test('checkCalibrationPool: a fresh project/home with no calibration state fails open to labeled_count 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-cal-'));
  try {
    const project = join(root, 'proj');
    const home = join(root, 'home');
    mkdirSync(project, { recursive: true });
    mkdirSync(home, { recursive: true });
    const r = checkCalibrationPool(project, { home });
    assert.equal(r.available, true);
    assert.equal(r.labeled_count, 0);
    assert.equal(r.min_needed, 100);
    assert.equal(r.is_calibrated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkCalibrationPool: never throws even with a nonexistent project dir', () => {
  assert.doesNotThrow(() => checkCalibrationPool('/definitely/not/a/real/path/xyz', { home: '/definitely/not/a/real/home/xyz' }));
});

// ---------------------------------------------------------------------------
// checkGoldRegression — real integration with retrieval-harness.mjs. A
// project with no gold set gets an honest absence; a project with a valid
// frozen gold set gets a genuine live product-path Recall@K run.
// ---------------------------------------------------------------------------

test('checkGoldRegression: no _tests/retrieval-gold-set.json is an honest absence, not a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-gold-'));
  try {
    const r = await checkGoldRegression(root);
    assert.equal(r.available, false);
    assert.match(r.reason, /no _tests\/retrieval-gold-set\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkGoldRegression: a tiny real store + a valid gold set produces a genuine live Recall@K result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-gold-live-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    const unit = (id, body, topics) => writeFileSync(join(mem, `${id}.md`),
`---
id: ${id}
type: observation
status: active
tier: canonical
created: 2026-01-01
updated: 2026-01-01
last-reviewed: 2026-01-01
topics: [${topics}]
confidence-level: sourced
edges: []
---

# ${id}

${body}
`);
    unit('gold-target-fact', 'The nightingale-quartz protocol governs release timing.', 'gold, protocol');
    unit('gold-distractor-fact', 'A second unrelated fact for ranking context.', 'gold, other');

    const testsDir = join(root, '_tests');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, 'retrieval-gold-set.json'), JSON.stringify({
      queries: [
        { id: 'q01', rung: 'literal', query: 'nightingale-quartz protocol release timing', expected: ['gold-target-fact'], forbidden: [] },
      ],
    }));

    const r = await checkGoldRegression(root);
    assert.equal(r.available, true, r.reason);
    assert.equal(r.n, 1);
    assert.ok(r.context3_r3 !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkGoldRegression: a malformed gold set fails closed to an honest reason, never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-gold-bad-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    const testsDir = join(root, '_tests');
    mkdirSync(testsDir, { recursive: true });
    // Missing required 'rung' field -> validateGold throws inside runHarness.
    writeFileSync(join(testsDir, 'retrieval-gold-set.json'), JSON.stringify({
      queries: [{ id: 'q01', query: 'whatever', expected: ['x'], forbidden: [] }],
    }));
    const r = await checkGoldRegression(root);
    assert.equal(r.available, false);
    assert.match(r.reason, /gold-set harness run failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// checkLiveRetrievalProxy — real integration with analyze-retrieval-quality.mjs.
// ---------------------------------------------------------------------------

test('checkLiveRetrievalProxy: no _sessions/ directory is an honest absence, not a crash', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-proxy-'));
  try {
    const r = checkLiveRetrievalProxy(root);
    assert.equal(r.available, false);
    assert.match(r.reason, /no retrieval events recorded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkLiveRetrievalProxy: real retrieval-log rows produce a genuine tier-distribution result', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-proxy-live-'));
  try {
    const day = join(root, '_sessions', '2026-07-20');
    mkdirSync(day, { recursive: true });
    const rows = [
      { ts: '2026-07-20T10:00:00Z', tier_reached: 1, intent_topics: ['alpha'], units_retrieved: [{ id: 'u1' }] },
      { ts: '2026-07-20T11:00:00Z', tier_reached: 2, intent_topics: ['alpha'], units_retrieved: [{ id: 'u2' }] },
    ];
    writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const r = checkLiveRetrievalProxy(root);
    assert.equal(r.available, true);
    assert.equal(r.retrievalEvents, 2);
    assert.equal(r.t1Pct, 50);
    assert.equal(r.t2Pct, 50);
    assert.equal(r.topEscalationTopic, 'alpha');
    assert.equal(r.rejected.total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Retrieval-event schema validation surfacing (2026-07-22, evidence-lifecycle
// slice 2, revised per Hale's "use producer schema and isolate legacy": a
// malformed row must be REJECTED and COUNTED with a CLOSED code, split
// current/legacy — never silently dropped, never a raw echoed value.
// ---------------------------------------------------------------------------

test('checkLiveRetrievalProxy: a malformed current-schema row is rejected, counted by code, and excluded from the tier math', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-proxy-malformed-'));
  try {
    const day = join(root, '_sessions', '2026-07-22');
    mkdirSync(day, { recursive: true });
    const rows = [
      { ts: '2026-07-22T10:00:00Z', kind: 'retrieval', schema_version: '1.0.0', trigger: 'session-start', intent_topics: ['alpha'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'u1', tier: 1 }] },
      { ts: '2026-07-22T11:00:00Z', kind: 'retrieval', schema_version: '1.0.0', trigger: 'session-start', intent_topics: ['alpha'], tier_reached: 99, escalation_path: [1, 99], units_retrieved: [] }, // malformed
    ];
    writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const r = checkLiveRetrievalProxy(root);
    assert.equal(r.available, true);
    assert.equal(r.retrievalEvents, 1, 'the malformed row must not inflate the valid count');
    assert.equal(r.rejected.total, 1);
    assert.equal(r.rejected.current.count, 1);
    assert.equal(r.rejected.current.by_code['invalid-tier'], 1);
    assert.equal(r.t1Pct, 100, 'the malformed tier_reached:99 must never get bucketed as a valid tier');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('checkLiveRetrievalProxy: an all-malformed corpus is unavailable but honestly names the rejected count by code (not indistinguishable from truly-empty)', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-proxy-allbad-'));
  try {
    const day = join(root, '_sessions', '2026-07-22');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'retrieval-log.jsonl'), JSON.stringify({ kind: 'retrieval', units_retrieved: [{ id: 'u1' }] }) + '\n'); // versionless, legacy, missing tier

    const r = checkLiveRetrievalProxy(root);
    assert.equal(r.available, false);
    assert.equal(r.rejected.total, 1);
    assert.equal(r.rejected.legacy.by_code['legacy-missing-tier'], 1);
    assert.match(r.reason, /1 row\(s\) rejected/);
    assert.match(r.reason, /legacy-missing-tier/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('computeRows: Telemetry capture row names the rejected-row count by schema tier when present', () => {
  const rows = computeRows(baseOut({
    mechanics: {
      ...baseOut().mechanics,
      telemetry: {
        available: true, days: 1, retrievalEvents: 1,
        t1Pct: 100, t2Pct: 0, t3Pct: 0, topEscalationTopic: null, topEscalationRate: null,
        rejected: { current: { count: 2, by_code: { 'invalid-tier': 2 } }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 2 },
      },
    },
  }));
  const tel = rows.find((r) => r.label === 'Telemetry capture');
  assert.match(tel.value, /2 row\(s\) rejected/);
  assert.match(tel.value, /2 current-schema/);
});

test('gatherMetrics: real end-to-end run surfaces a rejected row in the rendered Telemetry capture row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-gather-rejected-'));
  try {
    mkdirSync(join(root, '_memories'), { recursive: true }); // retrieval_log is only computed when a store is present
    const day = join(root, '_sessions', '2026-07-22');
    mkdirSync(day, { recursive: true });
    const rows = [
      { ts: '2026-07-22T10:00:00Z', kind: 'retrieval', tier_reached: 1, intent_topics: ['alpha'], units_retrieved: [{ id: 'u1' }] },
      { ts: '2026-07-22T11:00:00Z', kind: 'retrieval', units_retrieved: [{ id: 'u2' }] }, // malformed: no tier_reached
    ];
    writeFileSync(join(day, 'retrieval-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const out = await gatherMetrics(root);
    assert.equal(out.mechanics.store.retrieval_log.files, 1, 'the raw capture-presence scan still counts the file');
    assert.equal(out.mechanics.store.retrieval_log.rows, 2, 'and both raw lines, with no schema judgement of its own');
    assert.equal(out.mechanics.telemetry.rejected.total, 1, 'schema validation + rejection counting comes from checkLiveRetrievalProxy');
    assert.equal(out.mechanics.telemetry.rejected.legacy.by_code['legacy-missing-tier'], 1);
    assert.match(out.report, /Telemetry capture/);
    assert.match(out.report, /1 row\(s\) rejected/);
    assert.match(out.report, /1 legacy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI --json contract (2026-07-22, Hale's acceptance revise): the machine
// output must carry the SAME four-evidence-class taxonomy the rendered report
// does — exact class placement, producer/schema identity, and the ABSENCE of
// the old contradictory fields (top-level verdict/probe/store/calibration,
// regression.liveProxy). This locks the CLI boundary itself, not just the
// exported functions.
// ---------------------------------------------------------------------------

test('CLI --json contract: exact four-class placement, identity stamp, old contradictory fields absent, renderer sources the same object', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-metrics-check-cli-contract-'));
  try {
    mkdirSync(join(root, '_memories'), { recursive: true });
    const day = join(root, '_sessions', '2026-07-22');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'retrieval-log.jsonl'),
      JSON.stringify({ ts: '2026-07-22T10:00:00Z', kind: 'retrieval', schema_version: '1.0.0', trigger: 'session-start', intent_topics: ['alpha'], tier_reached: 1, escalation_path: [1], units_retrieved: [{ id: 'u1', tier: 1 }] }) + '\n');

    // Fix 8 (Hale item 8): --json emits EXACTLY ONE JSON document — no human
    // report on the same stream — so the whole stdout parses as JSON.
    const stdout = execFileSync('node', [SCRIPT, root, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.doesNotThrow(() => JSON.parse(stdout), '--json stdout must be a single valid JSON document');
    const out = JSON.parse(stdout);
    // The default (no flag) run prints the human report and nothing else.
    const rendered = execFileSync('node', [SCRIPT, root], { encoding: 'utf8', timeout: 120000 }).replace(/\n$/, '');

    // ---- exact top-level shape: the four classes + identity + run metadata,
    // nothing else — in particular NO umbrella verdict and NO top-level
    // probe/store/calibration.
    assert.deepEqual(Object.keys(out).sort(), [
      'benefit', 'caveats', 'generated_at', 'mechanics', 'producer', 'project',
      'readiness', 'regression', 'report', 'schema_version',
    ]);
    assert.ok(!('verdict' in out), 'the old umbrella verdict field must be absent');
    assert.ok(!('probe' in out) && !('store' in out) && !('calibration' in out), 'old top-level placements must be absent');

    // ---- identity: schema stamped by the script, producer from the plugin
    // manifest (the codebase's existing version/source_sha identity surface).
    assert.equal(out.schema_version, METRICS_REPORT_SCHEMA_VERSION);
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    assert.deepEqual(out.producer, {
      script: 'metrics-check.mjs',
      plugin: manifest.name,
      plugin_version: manifest.version,
      source_sha: manifest.source_sha,
    });
    assert.equal(producerIdentity().plugin_version, manifest.version, 'the exported identity helper reads the same manifest');

    // ---- mechanics: round-trip probe, store integrity, telemetry, and the
    // mechanics-scoped machine status (never an umbrella claim).
    assert.deepEqual(Object.keys(out.mechanics).sort(), ['probe', 'status', 'store', 'telemetry', 'turn_capture']);
    assert.ok(['WORKING', 'WORKING-WITH-CAVEATS', 'DEGRADED', 'MACHINERY-WORKING-NO-STORE'].includes(out.mechanics.status));
    assert.equal(typeof out.mechanics.probe.round_trip, 'boolean');
    assert.equal(out.mechanics.store.present, true);
    assert.equal(out.mechanics.telemetry.available, true, 'telemetry/tier data lives under mechanics');
    assert.equal(out.mechanics.telemetry.retrievalEvents, 1);

    // ---- regression: the gold-set snapshot ONLY — liveProxy must be gone.
    assert.deepEqual(Object.keys(out.regression), ['gold']);
    assert.ok(!('liveProxy' in out.regression), 'the old regression.liveProxy placement must be absent');
    assert.equal(out.regression.gold.available, false, 'no gold set in this scratch project — honest absence');

    // ---- readiness: recognition + calibration, together, as their own class.
    assert.deepEqual(Object.keys(out.readiness).sort(), ['calibration', 'recognition_signal']);

    // ---- benefit: structured not-evaluated status, not just report prose.
    assert.equal(out.benefit.status, 'not-evaluated');
    assert.match(out.benefit.reason, /no matched memory-on\/off comparison exists/);

    // ---- single source of truth: the report string in the JSON is exactly
    // what the CLI rendered, and re-rendering FROM the emitted object
    // reproduces it byte-for-byte — the renderer consumes this same object,
    // so machine and human views cannot diverge.
    assert.equal(out.report, rendered);
    assert.equal(renderReport(out), out.report);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Turn-capture evidence — the ALWAYS-VISIBLE state line (v3.14.0, default-ON
// per DC-129). Because the stream is on unless the user acted, BOTH states
// render: ON carries the disclosure + off-switches; OFF confirms the opt-out.
// ---------------------------------------------------------------------------

test('turn-capture: the ON line carries the disclosure, volumes, health, and every off-switch', () => {
  const out = baseOut({
    mechanics: { ...baseOut().mechanics, turn_capture: { enabled: true, rows: 7, days: 2, health: { attempts: 9, failures: 1 } } },
  });
  const rows = computeRows(out);
  const row = rows.find((r) => r.label === 'Turn capture (evidence)');
  assert.ok(row, 'enabled ⇒ exactly one visible-active-state row');
  assert.equal(row.section, SECTION.MECHANICS);
  assert.equal(row.noGauge, true, 'no bar/percentage — a state line, not a metric');
  assert.match(row.value, /^ON — /);
  assert.match(row.value, /saved locally/);
  assert.match(row.value, /never exported/);
  assert.match(row.value, /auto-deleted after 30 days/);
  assert.match(row.value, /7 row\(s\) \/ 2 day\(s\)/);
  assert.match(row.value, /1 of 9 writes failed/);
  assert.match(row.value, /CORE_TURN_CAPTURE=0/);
  assert.match(row.value, /"turn_capture": false/);
  assert.match(row.value, /CORE_METRICS_ENABLED=0/);
  assert.match(renderReport(out), /Turn capture \(evidence\)/);
});

test('turn-capture: the OFF line confirms the opt-out took effect and names the consequence', () => {
  const out = baseOut({
    mechanics: { ...baseOut().mechanics, turn_capture: { enabled: false, rows: 0, days: 0, health: { attempts: 0, failures: 0 } } },
  });
  const row = computeRows(out).find((r) => r.label === 'Turn capture (evidence)');
  assert.ok(row, 'disabled ⇒ still a visible line — the user sees their choice held');
  assert.match(row.value, /^OFF — /);
  assert.match(row.value, /hindsight grading/);
  assert.doesNotMatch(row.value, /^ON/, 'must NOT claim ON when capture is off');
  assert.match(renderReport(out), /OFF — turn capture is disabled/);
});
