import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  renderBar, computeRows, buildNarrative, renderReport, parseRecognitionSignal,
  checkCalibrationPool, checkGoldRegression, checkLiveRetrievalProxy,
  BAR_WIDTH, FILLED_CHAR, EMPTY_CHAR, FAILED_CHAR, TRUST, SECTION,
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
// computeRows — eight rows across three evidence-class sections.
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
    regression: {},
    verdict: 'WORKING',
    caveats: [],
    ...overrides,
  };
}

test('computeRows: returns eight rows across mechanics/regression/benefit sections', () => {
  const rows = computeRows(baseOut());
  assert.equal(rows.length, 8);
  const bySection = { mechanics: 0, regression: 0, benefit: 0 };
  for (const r of rows) bySection[r.section]++;
  assert.equal(bySection.mechanics, 2);
  assert.equal(bySection.regression, 5);
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
  const rows = computeRows(baseOut({ probe: { round_trip: false } }));
  const rt = rows.find((r) => r.label === 'Round-trip proof');
  assert.equal(rt.failed, true);
  assert.equal(rt.value, 'FAIL');
});

test('computeRows: unit integrity is (clean/total) with 1 attention warning out of 293, tagged mechanics', () => {
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
  assert.equal(ui.section, SECTION.MECHANICS);
  const expectedPct = (292 / 293) * 100;
  assert.ok(Math.abs(ui.pct - expectedPct) < 1e-9);
});

test('computeRows: retrieval-log coverage caps at 100%, tagged regression, labeled capture volume', () => {
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
  assert.equal(cov.section, SECTION.REGRESSION);
  assert.match(cov.value, /capture volume, not correctness/);
});

test('computeRows: recognition signal bar is INVERTED (100 - rec-fail rate), tagged regression', () => {
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
  assert.equal(rec.section, SECTION.REGRESSION);
  assert.match(rec.value, /50% rec-fail/);
});

test('computeRows: calibration pool is labeled_count/min_needed, direct trust, tagged regression', () => {
  const rows = computeRows(baseOut({ calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } }));
  const cal = rows.find((r) => r.label === 'Calibration pool');
  assert.equal(cal.pct, 22);
  assert.equal(cal.trust, TRUST.DIRECT);
  assert.equal(cal.value, '22/100 labeled');
  assert.equal(cal.section, SECTION.REGRESSION);
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

// --- Gold-set Recall@K row: present-with-evidence vs honestly-absent. ---

test('computeRows: gold-set Recall@K absent renders NOT_EVALUATED with a plain reason, never silently omitted', () => {
  const rows = computeRows(baseOut());
  const gold = rows.find((r) => r.label === 'Gold-set Recall@K');
  assert.ok(gold, 'the row must exist even with zero evidence');
  assert.equal(gold.trust, TRUST.NOT_EVALUATED);
  assert.equal(gold.pct, 0);
  assert.match(gold.value, /no gold-set regression evidence recorded/);
  assert.equal(gold.section, SECTION.REGRESSION);
});

test('computeRows: gold-set Recall@K present renders proven-live with real numbers', () => {
  const rows = computeRows(baseOut({
    regression: { gold: { available: true, n: 22, storeUnits: 300, context3_r3: 0.6818, ranking_r10: 0.8182, bm25_r10: 0.8182 } },
  }));
  const gold = rows.find((r) => r.label === 'Gold-set Recall@K (n=22)');
  assert.ok(gold, 'label must include n= when evidence is present');
  assert.equal(gold.trust, TRUST.PROVEN_LIVE);
  assert.equal(gold.pct, 68);
  assert.match(gold.value, /R@3 68%/);
  assert.match(gold.value, /ranking R@10 82%/);
  assert.match(gold.value, /directional, small gold set/);
});

test('computeRows: gold-set harness failure surfaces its reason as NOT_EVALUATED, not a crash', () => {
  const rows = computeRows(baseOut({
    regression: { gold: { available: false, reason: 'gold-set harness run failed: missing authority tier on unit x' } },
  }));
  const gold = rows.find((r) => r.label === 'Gold-set Recall@K');
  assert.equal(gold.trust, TRUST.NOT_EVALUATED);
  assert.match(gold.value, /harness run failed/);
});

// --- Live retrieval proxy row: present-with-evidence vs honestly-absent. ---

test('computeRows: live retrieval proxy absent renders NOT_EVALUATED with a plain reason', () => {
  const rows = computeRows(baseOut());
  const proxy = rows.find((r) => r.label === 'Live retrieval proxy');
  assert.ok(proxy);
  assert.equal(proxy.trust, TRUST.NOT_EVALUATED);
  assert.equal(proxy.pct, 0);
  assert.match(proxy.value, /no live retrieval events recorded/);
});

test('computeRows: live retrieval proxy present renders proxy trust with tier distribution and top escalation topic', () => {
  const rows = computeRows(baseOut({
    regression: {
      liveProxy: {
        available: true, days: 19, retrievalEvents: 241,
        t1Pct: 99, t2Pct: 1, t3Pct: 0,
        topEscalationTopic: 'metrics', topEscalationRate: 20,
      },
    },
  }));
  const proxy = rows.find((r) => r.label === 'Live retrieval proxy');
  assert.equal(proxy.trust, TRUST.PROXY);
  assert.equal(proxy.pct, 99);
  assert.match(proxy.value, /T1 99%/);
  assert.match(proxy.value, /'metrics' needed Tier 2\+ 20%/);
});

// --- User-benefit row: always present, always honestly "not evaluated". ---

test('computeRows: user-benefit row is always present and always says plainly nothing measures it', () => {
  const rows = computeRows(baseOut());
  const benefit = rows.find((r) => r.label === 'User-benefit evidence');
  assert.ok(benefit, 'user-benefit row must never be silently omitted');
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

test('buildNarrative: WORKING with no caveats stays within 1-3 sentences and names all three evidence classes', () => {
  const n = buildNarrative(baseOut());
  assert.ok(sentenceCount(n) <= 3, `expected <=3 sentences, got: ${n}`);
  assert.ok(sentenceCount(n) >= 1);
  assert.match(n, /Mechanics are proven and working/);
  assert.match(n, /Retrieval regression:/);
  assert.match(n, /hasn't been measured yet/);
});

test('buildNarrative: DEGRADED leads with what failed and does not pad with regression/benefit sentences', () => {
  const out = baseOut({
    probe: { round_trip: false },
    store: { present: true, schema: { exit: 1 }, integrity: { fail: 2 }, warning_triage: { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] } },
    verdict: 'DEGRADED',
  });
  const n = buildNarrative(out);
  assert.ok(n.startsWith('DEGRADED —'), `expected DEGRADED lead, got: ${n}`);
  assert.match(n, /round-trip probe failed/);
  assert.match(n, /2 integrity failure/);
  assert.equal(sentenceCount(n), 1, 'DEGRADED must not be padded with the other evidence classes');
});

test('buildNarrative: MACHINERY-WORKING-NO-STORE names the gap plainly, single sentence', () => {
  const out = baseOut({ store: { present: false }, verdict: 'MACHINERY-WORKING-NO-STORE' });
  const n = buildNarrative(out);
  assert.match(n, /no _memories\/ store yet/);
});

test('buildNarrative: names the calibration pool count and gate', () => {
  const n = buildNarrative(baseOut({ calibration: { available: true, labeled_count: 22, min_needed: 100, is_calibrated: false } }));
  assert.match(n, /currently 22/);
  assert.match(n, /clears 100 labeled turns/);
});

test('buildNarrative: mentions the gold-set and live-proxy numbers when present', () => {
  const n = buildNarrative(baseOut({
    regression: {
      gold: { available: true, n: 22, context3_r3: 0.68 },
      liveProxy: { available: true, retrievalEvents: 260, t1Pct: 99 },
    },
  }));
  assert.match(n, /delivered top-3 recall at 68%/);
  assert.match(n, /260 events shows 99% resolving at Tier 1/);
});

test('buildNarrative: always states user benefit is unmeasured, never implies the other classes cover it', () => {
  const n = buildNarrative(baseOut());
  assert.match(n, /no matched memory-on\/off comparison exists/);
});

// ---------------------------------------------------------------------------
// renderReport — full assembled text: MECHANICS-scoped verdict heading,
// three sectioned blocks (8 rows total), and a quoted narrative.
// ---------------------------------------------------------------------------

test('renderReport: verdict heading is scoped to MECHANICS, not the whole system', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const lines = text.split('\n');
  assert.equal(lines[0], 'MECHANICS: WORKING');
  assert.equal(lines[2], 'CORE Memory Health — demo-project');
});

test('renderReport: renders eight bar-gauge rows total, across three labeled sections', () => {
  const text = renderReport(baseOut(), { workspaceName: 'demo-project' });
  const rowLines = text.split('\n').filter((l) => l.includes('[') && l.includes(']'));
  assert.equal(rowLines.length, 8);
  assert.match(text, /Retrieval regression — separate evidence class, NOT covered by the verdict above:/);
  assert.match(text, /User benefit — separate evidence class, NOT covered by the verdict above:/);
  assert.ok(text.trim().endsWith('"'), 'narrative is quoted');
});

test('renderReport: WORKING-WITH-CAVEATS displays the caveats verdict phrase, still MECHANICS-scoped', () => {
  const out = baseOut({
    store: { ...baseOut().store, warning_triage: { informational: 0, routine_upkeep: 0, attention: 1, attention_items: ['x'] } },
    verdict: 'WORKING-WITH-CAVEATS',
  });
  const text = renderReport(out);
  assert.equal(text.split('\n')[0], 'MECHANICS: WORKING — with caveats');
});

test('renderReport: never claims retrieval regression or user benefit inside the verdict heading', () => {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
