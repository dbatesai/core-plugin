import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderBar, computeRows, buildNarrative, renderReport, parseRecognitionSignal,
  checkCalibrationPool, BAR_WIDTH, FILLED_CHAR, EMPTY_CHAR, FAILED_CHAR, TRUST,
} from '../../plugins/core/skills/core/scripts/metrics-check.mjs';

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

test('renderBar: boundary — just under 5% stays at 0 filled blocks', () => {
  assert.equal(renderBar(4.9), EMPTY_CHAR.repeat(10));
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
// computeRows — the five rows, one per check.
// ---------------------------------------------------------------------------

function baseOut(overrides = {}) {
  return {
    project: '/tmp/demo',
    probe: { round_trip: true },
    store: {
      present: true,
      schema: { exit: 0 },
      integrity: { fail: 0 },
      warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] },
      census: { total: 10 },
      retrieval_log: { files: 10, rows: 10 },
    },
    calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false },
    verdict: 'WORKING',
    caveats: [],
    ...overrides,
  };
}

test('computeRows: round-trip PASS renders 100% proven-live', () => {
  const rows = computeRows(baseOut());
  const rt = rows.find((r) => r.label === 'Round-trip proof');
  assert.equal(rt.pct, 100);
  assert.equal(rt.failed, false);
  assert.equal(rt.trust, TRUST.PROVEN_LIVE);
  assert.equal(rt.value, 'PASS');
});

test('computeRows: round-trip FAIL is marked failed and shows FAIL', () => {
  const rows = computeRows(baseOut({ probe: { round_trip: false } }));
  const rt = rows.find((r) => r.label === 'Round-trip proof');
  assert.equal(rt.failed, true);
  assert.equal(rt.value, 'FAIL');
});

test('computeRows: unit integrity is (clean/total) with 1 attention warning out of 293', () => {
  const out = baseOut({
    store: {
      present: true, schema: { exit: 0 }, integrity: { fail: 0 },
      warning_triage: { informational: 0, routine_upkeep: 0, attention: 1, attention_items: ['x'] },
      census: { total: 293 }, retrieval_log: { files: 1, rows: 1 },
    },
  });
  const rows = computeRows(out);
  const ui = rows.find((r) => r.label === 'Unit integrity (293)');
  assert.equal(ui.value, '1 warning');
  const expectedPct = (292 / 293) * 100;
  assert.ok(Math.abs(ui.pct - expectedPct) < 1e-9);
});

test('computeRows: retrieval-log coverage caps at 100% when rows exceed files', () => {
  const out = baseOut({
    store: {
      present: true, schema: { exit: 0 }, integrity: { fail: 0 },
      warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] },
      census: { total: 5 }, retrieval_log: { files: 5, rows: 40 },
    },
  });
  const rows = computeRows(out);
  const cov = rows.find((r) => r.label === 'Retrieval-log coverage');
  assert.equal(cov.pct, 100);
});

test('computeRows: recognition signal bar is INVERTED (100 - rec-fail rate)', () => {
  const out = baseOut({
    store: {
      ...baseOut().store,
      recognition_signal: { text: 'rec-fail-tier-0: 3/6 turns today (50%) vs 7-day avg 21% ↑ [PROVISIONAL]' },
    },
  });
  const rows = computeRows(out);
  const rec = rows.find((r) => r.label === 'Recognition signal');
  assert.equal(rec.pct, 50); // 100 - 50
  assert.equal(rec.trust, TRUST.PROVISIONAL);
  assert.match(rec.value, /50% rec-fail/);
});

test('computeRows: calibration pool is labeled_count/min_needed, direct trust', () => {
  const rows = computeRows(baseOut({ calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } }));
  const cal = rows.find((r) => r.label === 'Calibration pool');
  assert.equal(cal.pct, 22);
  assert.equal(cal.trust, TRUST.DIRECT);
  assert.equal(cal.value, '22/100 labeled');
});

test('computeRows: calibration unavailable falls back to 0/100 without crashing', () => {
  const rows = computeRows(baseOut({ calibration: {} }));
  const cal = rows.find((r) => r.label === 'Calibration pool');
  assert.equal(cal.value, '0/100 labeled');
  assert.equal(cal.pct, 0);
});

test('computeRows: no store present renders "no store" and zero pct for store-dependent rows', () => {
  const rows = computeRows(baseOut({ store: { present: false } }));
  const ui = rows.find((r) => r.label === 'Unit integrity (0)');
  assert.equal(ui.value, 'no store');
  assert.equal(ui.pct, 0);
});

// ---------------------------------------------------------------------------
// buildNarrative — 1-3 sentences, leads with failure on DEGRADED.
// ---------------------------------------------------------------------------

function sentenceCount(text) {
  // Rough split: count '. ' boundaries plus a trailing period, good enough to
  // enforce the 1-3 sentence cap without a full NLP sentence splitter.
  return text.trim().split(/(?<=[.!?])\s+/).filter(Boolean).length;
}

test('buildNarrative: WORKING with no caveats stays within 1-3 sentences', () => {
  const n = buildNarrative(baseOut());
  assert.ok(sentenceCount(n) <= 3, `expected <=3 sentences, got: ${n}`);
  assert.ok(sentenceCount(n) >= 1);
});

test('buildNarrative: DEGRADED leads with what failed', () => {
  const out = baseOut({
    probe: { round_trip: false },
    store: { present: true, schema: { exit: 1 }, integrity: { fail: 2 }, warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] } },
    verdict: 'DEGRADED',
  });
  const n = buildNarrative(out);
  assert.ok(n.startsWith('DEGRADED —'), `expected DEGRADED lead, got: ${n}`);
  assert.match(n, /round-trip probe failed/);
  assert.match(n, /2 integrity failure/);
});

test('buildNarrative: MACHINERY-WORKING-NO-STORE names the gap plainly', () => {
  const out = baseOut({ store: { present: false }, verdict: 'MACHINERY-WORKING-NO-STORE' });
  const n = buildNarrative(out);
  assert.match(n, /no _memories\/ store yet/);
});

test('buildNarrative: names the calibration pool count and gate', () => {
  const n = buildNarrative(baseOut({ calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } }));
  assert.match(n, /currently 22/);
  assert.match(n, /clears 100 labeled turns/);
});

// ---------------------------------------------------------------------------
// renderReport — full assembled text: verdict heading + 5 rows + narrative.
// ---------------------------------------------------------------------------

test('renderReport: has the verdict heading, title line, 5 rows, and a quoted narrative', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'WORKING');
  assert.equal(lines[2], 'CORE Memory Health — demo-project');
  const rowLines = lines.filter((l) => l.includes('[') && l.includes(']'));
  assert.equal(rowLines.length, 5);
  assert.ok(text.trim().endsWith('"'), 'narrative is quoted');
});

test('renderReport: WORKING-WITH-CAVEATS displays the caveats verdict phrase', () => {
  const out = baseOut({
    store: { ...baseOut().store, warning_triage: { informational: 0, routine_upkeep: 0, attention: 1, attention_items: ['x'] } },
    verdict: 'WORKING-WITH-CAVEATS',
  });
  const text = renderReport(out);
  assert.equal(text.split('\n')[0], 'WORKING — with caveats');
});

// ---------------------------------------------------------------------------
// checkCalibrationPool — the new integration point with calibrate-classifier.mjs.
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
