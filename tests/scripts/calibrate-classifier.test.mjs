import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computePrecision, emptyCalibrationState, readCalibrationState, writeCalibrationState,
  collectClassifiedTurns, stratifiedSample, exportWorksheet, importLabels,
  PRECISION_THRESHOLD, MIN_LABELED,
} from '../../plugins/core/skills/core/scripts/calibrate-classifier.mjs';

// --- M7: per-class coverage gate ---

test('M7: computePrecision flags a gold state the heuristic never predicted as unmeasured', () => {
  const turns = [
    { heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
    { heuristic_state: 'tier-0-win', gold_state: 'capture-miss' }, // capture-miss in gold, never predicted
  ];
  const p = computePrecision(turns);
  assert.equal(p.coverage_complete, false, 'a never-predicted gold state leaves coverage incomplete');
  assert.deepEqual(p.unmeasured_gold_states, ['capture-miss']);
});

test('M7: computePrecision reports complete coverage when every gold state is predicted', () => {
  const turns = [
    { heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
    { heuristic_state: 'capture-miss', gold_state: 'capture-miss' },
  ];
  const p = computePrecision(turns);
  assert.equal(p.coverage_complete, true);
  assert.deepEqual(p.unmeasured_gold_states, []);
});

test('M7: the gate does NOT clear at high precision while a gold state sits unmeasured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calib-cov-'));
  try {
    // 100 labeled turns: 95 correct tier-0-win (precision 0.95) + 5 where gold=capture-miss
    // but the heuristic always said tier-0-win. capture-miss is a gold state never predicted.
    const rows = [];
    for (let i = 0; i < 95; i++) rows.push({ heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' });
    for (let i = 0; i < 5; i++) rows.push({ heuristic_state: 'tier-0-win', gold_state: 'capture-miss' });
    const wf = join(dir, 'worksheet.jsonl');
    writeFileSync(wf, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const res = importLabels({ worksheetFile: wf, metaDir: dir });
    assert.equal(res.labeled_count, 100, 'enough labels');
    assert.ok(res.overall_precision >= PRECISION_THRESHOLD, 'precision clears the bar on predicted classes');
    assert.equal(res.is_calibrated, false, 'gate must hold while capture-miss is unmeasured');
    assert.ok(res.unmeasured_gold_states.includes('capture-miss'));
    assert.match(res.notes, /unmeasured/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- helpers ---

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function makeClassifiedJSONL(turns) {
  return turns.map((t) => JSON.stringify({
    schema_version: '1.0.0', classifier_version: '0.1.0', provisional: true,
    session_id: t.session_id || 'sess-1', turn_idx: t.turn_idx ?? 0,
    state: t.state, evidence: t.evidence || {},
  })).join('\n') + '\n';
}

// ============================================================
// computePrecision
// ============================================================

test('computePrecision: all correct → precision 1.0', () => {
  const turns = [
    { heuristic_state: 'rec-fail-tier-0', gold_state: 'rec-fail-tier-0' },
    { heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
  ];
  const p = computePrecision(turns);
  assert.equal(p.overall, 1.0);
  assert.equal(p.labeled_count, 2);
});

test('computePrecision: all wrong → precision 0', () => {
  const turns = [
    { heuristic_state: 'rec-fail-tier-0', gold_state: 'tier-0-win' },
    { heuristic_state: 'tier-0-win', gold_state: 'rec-fail-tier-0' },
  ];
  const p = computePrecision(turns);
  assert.equal(p.overall, 0);
});

test('computePrecision: mixed → correct macro average', () => {
  // state A: 2 TP, 0 FP → precision 1.0
  // state B: 1 TP, 1 FP → precision 0.5
  // macro avg = (1.0 + 0.5) / 2 = 0.75
  const turns = [
    { heuristic_state: 'A', gold_state: 'A' },
    { heuristic_state: 'A', gold_state: 'A' },
    { heuristic_state: 'B', gold_state: 'B' },
    { heuristic_state: 'B', gold_state: 'X' }, // FP for B
  ];
  const p = computePrecision(turns);
  assert.ok(Math.abs(p.overall - 0.75) < 0.001, `expected 0.75, got ${p.overall}`);
});

test('computePrecision: skips unlabeled turns (null gold_state)', () => {
  const turns = [
    { heuristic_state: 'rec-fail-tier-0', gold_state: null },
    { heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
  ];
  const p = computePrecision(turns);
  assert.equal(p.labeled_count, 1);
});

test('computePrecision: empty input → null overall', () => {
  assert.equal(computePrecision([]).overall, null);
});

// ============================================================
// Calibration state persistence
// ============================================================

test('emptyCalibrationState returns provisional=true, is_calibrated=false', () => {
  const s = emptyCalibrationState();
  assert.equal(s.is_calibrated, false);
  assert.equal(s.provisional, true);
  assert.equal(s.labeled_count, 0);
});

test('readCalibrationState returns empty state when file missing', () => {
  withTmp((dir) => {
    const s = readCalibrationState(dir);
    assert.equal(s.is_calibrated, false);
  });
});

test('writeCalibrationState + readCalibrationState round-trip', () => {
  withTmp((dir) => {
    const state = { schema_version: '1.0.0', is_calibrated: true, provisional: false, labeled_count: 150, overall_precision: 0.82 };
    writeCalibrationState(dir, state);
    const back = readCalibrationState(dir);
    assert.equal(back.is_calibrated, true);
    assert.equal(back.overall_precision, 0.82);
  });
});

// ============================================================
// collectClassifiedTurns + stratifiedSample
// ============================================================

test('collectClassifiedTurns reads JSONL files from classifiedDir', () => {
  withTmp((dir) => {
    const cd = join(dir, 'classified');
    mkdirSync(cd);
    writeFileSync(join(cd, '2026-06-01.jsonl'), makeClassifiedJSONL([
      { state: 'rec-fail-tier-0' }, { state: 'tier-0-win' },
    ]));
    const turns = collectClassifiedTurns(cd);
    assert.equal(turns.length, 2);
  });
});

test('collectClassifiedTurns returns empty when dir missing', () => {
  assert.equal(collectClassifiedTurns('/nonexistent/path').length, 0);
});

test('stratifiedSample: respects count limit', () => {
  const turns = Array.from({ length: 50 }, (_, i) => ({ state: i % 2 === 0 ? 'A' : 'B' }));
  const s = stratifiedSample(turns, 10);
  assert.ok(s.length <= 10);
});

test('stratifiedSample: returns all when count >= pool', () => {
  const turns = [{ state: 'A' }, { state: 'B' }];
  assert.equal(stratifiedSample(turns, 100).length, 2);
});

test('stratifiedSample: includes multiple states', () => {
  const turns = [
    ...Array.from({ length: 20 }, () => ({ state: 'A' })),
    ...Array.from({ length: 20 }, () => ({ state: 'B' })),
  ];
  const s = stratifiedSample(turns, 10);
  const states = new Set(s.map((t) => t.state));
  assert.ok(states.has('A') && states.has('B'), 'both states represented');
});

// ============================================================
// exportWorksheet
// ============================================================

test('exportWorksheet returns EMPTY when no classified turns', () => {
  withTmp((dir) => {
    const cd = join(dir, 'classified');
    mkdirSync(cd);
    const r = exportWorksheet({ project: dir, classifiedDir: cd, calibrationDir: join(dir, 'cal') });
    assert.equal(r.status, 'EMPTY');
  });
});

test('exportWorksheet writes JSONL + markdown when turns exist', () => {
  withTmp((dir) => {
    const cd = join(dir, 'classified');
    mkdirSync(cd);
    writeFileSync(join(cd, '2026-06-01.jsonl'), makeClassifiedJSONL(
      Array.from({ length: 5 }, (_, i) => ({ state: 'rec-fail-tier-0', turn_idx: i })),
    ));
    const calDir = join(dir, 'calibration');
    const r = exportWorksheet({ project: dir, classifiedDir: cd, calibrationDir: calDir, count: 3 });
    assert.equal(r.status, 'OK');
    assert.ok(existsSync(r.jsonl_path), 'JSONL written');
    assert.ok(existsSync(r.md_path), 'markdown written');
    assert.ok(r.sample_count <= 3);
    // Each JSONL line should have gold_state: null (not yet labeled).
    const lines = readFileSync(r.jsonl_path, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length > 0);
    const first = JSON.parse(lines[0]);
    assert.equal(first.gold_state, null, 'worksheet starts unlabeled');
    assert.ok(first.turn_id, 'turn_id present');
  });
});

test('M7: re-running exportWorksheet the same day overwrites, never accumulates duplicate rows', () => {
  withTmp((dir) => {
    const cd = join(dir, 'classified');
    mkdirSync(cd);
    writeFileSync(join(cd, '2026-06-01.jsonl'), makeClassifiedJSONL(
      Array.from({ length: 5 }, (_, i) => ({ state: 'rec-fail-tier-0', turn_idx: i })),
    ));
    const opts = { project: dir, classifiedDir: cd, calibrationDir: join(dir, 'calibration'), count: 5, today: '2026-06-01' };
    const r1 = exportWorksheet(opts);
    const r2 = exportWorksheet(opts); // same day = same file; the old appendFileSync loop doubled it
    assert.equal(r1.jsonl_path, r2.jsonl_path, 'same date → same worksheet file');
    const lines = readFileSync(r2.jsonl_path, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, r2.sample_count, 'row count == sample size, not doubled across re-runs');
    const ids = lines.map((l) => JSON.parse(l).turn_id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate turn_ids to corrupt the precision count');
  });
});

// ============================================================
// importLabels
// ============================================================

test('importLabels returns ERROR when worksheet missing', () => {
  withTmp((dir) => {
    const r = importLabels({ worksheetFile: join(dir, 'nonexistent.jsonl'), metaDir: dir });
    assert.equal(r.status, 'ERROR');
  });
});

test('importLabels returns EMPTY when all gold_state are null', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    writeFileSync(f, JSON.stringify({ heuristic_state: 'rec-fail-tier-0', gold_state: null }) + '\n');
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.status, 'EMPTY');
  });
});

test('importLabels computes precision and writes calibration-state.json', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    // Write MIN_LABELED perfectly-labeled turns to clear both gates.
    const lines = Array.from({ length: MIN_LABELED }, (_, _i) =>
      JSON.stringify({ heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' }),
    ).join('\n') + '\n';
    writeFileSync(f, lines);
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, true);
    assert.equal(r.provisional, false);
    assert.ok(r.overall_precision >= PRECISION_THRESHOLD);
    assert.ok(existsSync(join(dir, 'calibration-state.json')), 'state file written');
  });
});

test('importLabels stays provisional when labeled_count < MIN_LABELED', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    // Only 10 labeled turns — below the 100 minimum.
    const lines = Array.from({ length: 10 }, () =>
      JSON.stringify({ heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' }),
    ).join('\n') + '\n';
    writeFileSync(f, lines);
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, false, 'not calibrated: too few labels');
    assert.equal(r.provisional, true);
  });
});

test('importLabels stays provisional when precision < threshold despite enough labels', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    // MIN_LABELED turns, all wrong → precision 0.
    const lines = Array.from({ length: MIN_LABELED }, () =>
      JSON.stringify({ heuristic_state: 'rec-fail-tier-0', gold_state: 'tier-0-win' }),
    ).join('\n') + '\n';
    writeFileSync(f, lines);
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, false, 'not calibrated: precision below threshold');
  });
});
