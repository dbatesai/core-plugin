import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computePrecision, emptyCalibrationState, readCalibrationState, writeCalibrationState,
  collectClassifiedTurns, stratifiedSample, exportWorksheet, importLabels,
  PRECISION_THRESHOLD, MIN_LABELED, resolveMinLabeled, MIN_LABELED_FLOOR,
  CANONICAL_STATES,
} from '../../plugins/core/skills/core/scripts/calibrate-classifier.mjs';

// --- M7: per-class coverage gate ---

test('M7: computePrecision flags a gold state the heuristic never predicted as unmeasured', () => {
  const turns = [
    { heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
    { heuristic_state: 'tier-0-win', gold_state: 'capture-miss' }, // capture-miss in gold, never predicted
  ];
  const p = computePrecision(turns);
  assert.equal(p.coverage_complete, false, 'a never-predicted gold state leaves coverage incomplete');
  assert.ok(p.unmeasured_gold_states.includes('capture-miss'));
});

test('M7: computePrecision reports complete coverage when every gold state is predicted', () => {
  const turns = CANONICAL_STATES.map((state) => ({ heuristic_state: state, gold_state: state }));
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
    for (let i = 0; i < 95; i++) rows.push({
      turn_id: `win-${i}`, harness: 'codex', classifier_version: '0.3.0', proxy_version: 2,
      heuristic_state: 'tier-0-win', gold_state: 'tier-0-win',
    });
    for (let i = 0; i < 5; i++) rows.push({
      turn_id: `miss-${i}`, harness: 'codex', classifier_version: '0.3.0', proxy_version: 2,
      heuristic_state: 'tier-0-win', gold_state: 'capture-miss',
    });
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

test('terminal gate requires every canonical state and exposes recall plus uncertainty', () => {
  const turns = CANONICAL_STATES.flatMap((state) => Array.from({ length: 12 }, (_, i) => ({
    turn_id: `${state}-${i}`,
    heuristic_state: state,
    gold_state: state,
  })));
  const p = computePrecision(turns);
  assert.equal(p.coverage_complete, true);
  assert.deepEqual(p.unmeasured_gold_states, []);
  assert.equal(p.recall_by_state['capture-miss'], 1);
  assert.ok(p.uncertainty_by_state['capture-miss'].precision.lower < 1);
  assert.ok(p.uncertainty_by_state['capture-miss'].precision.lower > 0);
});

// ---------------------------------------------------------------- helpers ---

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function makeClassifiedJSONL(turns) {
  return turns.map((t) => JSON.stringify({
    schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
    harness: t.harness || 'codex', provisional: true,
    session_id: t.session_id || 'sess-1', turn_idx: t.turn_idx ?? 0,
    state: t.state, evidence: t.evidence || {},
    turn_evidence: t.turn_evidence || { user_text: 'user turn', assistant_text: 'assistant answer', tool_events: [] },
  })).join('\n') + '\n';
}

function writeBlindLabels(dir, { harness = 'codex', perState = 17, goldFor } = {}) {
  const classifiedDir = join(dir, 'classified');
  mkdirSync(classifiedDir);
  const turns = CANONICAL_STATES.flatMap((state) => Array.from({ length: perState }, (_, i) => ({
    state, session_id: `${state}-${i}`, turn_idx: 0, harness,
  })));
  writeFileSync(join(classifiedDir, '2026-06-01.jsonl'), makeClassifiedJSONL(turns));
  const result = exportWorksheet({
    project: dir, harness, classifiedDir, calibrationDir: join(dir, 'calibration'), count: turns.length,
    today: '2026-06-01',
  });
  const envelope = JSON.parse(readFileSync(result.predictions_path, 'utf8'));
  const rows = readFileSync(result.jsonl_path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  for (const row of rows) {
    const predicted = envelope.predictions[row.turn_id];
    row.gold_state = goldFor ? goldFor(predicted) : predicted;
    row.labelers = ['labeler-a', 'labeler-b'];
    row.adjudicated_by = 'adjudicator-c';
    row.confidence = 'high';
  }
  writeFileSync(result.jsonl_path, rows.map(JSON.stringify).join('\n') + '\n');
  return result;
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
    const state = {
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
      is_calibrated: true, provisional: false, labeled_count: 150, overall_precision: 0.82,
    };
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

test('worksheet is self-contained for labeling but keeps predictions blind', () => {
  withTmp((dir) => {
    const cd = join(dir, 'classified');
    mkdirSync(cd);
    writeFileSync(join(cd, '2026-06-01.jsonl'), `${JSON.stringify({
      schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
      harness: 'codex', session_id: 's', turn_idx: 1, state: 'tier-0-win',
      evidence: { ladder_walk: false },
      turn_evidence: { user_text: 'What changed?', assistant_text: 'The decision changed.', tool_events: [] },
    })}\n`);
    const r = exportWorksheet({ project: dir, harness: 'codex', classifiedDir: cd, calibrationDir: join(dir, 'cal') });
    const row = JSON.parse(readFileSync(r.jsonl_path, 'utf8').trim());
    const guide = readFileSync(r.md_path, 'utf8');
    assert.equal(row.heuristic_state, undefined, 'prediction is absent from the labeling surface');
    assert.equal(row.user_text, 'What changed?');
    assert.equal(row.assistant_text, 'The decision changed.');
    assert.ok(existsSync(r.predictions_path), 'sealed prediction companion exists for post-label import');
    // Windows: chmod cannot express owner-only (it only toggles the read-only
    // attribute), so mode stays 0o666 there regardless -- structurally
    // unsatisfiable, not a regression (Meridian, 2026-07-21). Every other
    // 0o600 write path in this codebase already treats mode as advisory on
    // Windows with a try/catch; this assertion is the one place that still
    // hard-required the POSIX bits, so it's platform-guarded here instead.
    if (process.platform !== 'win32') {
      assert.equal(statSync(r.jsonl_path).mode & 0o777, 0o600, 'raw turn worksheet is owner-only');
      assert.equal(statSync(r.predictions_path).mode & 0o777, 0o600, 'sealed predictions are owner-only');
    }
    assert.doesNotMatch(guide, /read `heuristic_state`.*set `gold_state`/is);
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
    const exported = writeBlindLabels(dir);
    const r = importLabels({ worksheetFile: exported.jsonl_path, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, true);
    assert.equal(r.provisional, false);
    assert.ok(r.overall_precision >= PRECISION_THRESHOLD);
    assert.ok(existsSync(join(dir, 'calibration-state.json')), 'state file written');
  });
});

test('importLabels stays provisional when labeled_count < MIN_LABELED', () => {
  withTmp((dir) => {
    const exported = writeBlindLabels(dir, { perState: 1 });
    const r = importLabels({ worksheetFile: exported.jsonl_path, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, false, 'not calibrated: too few labels');
    assert.equal(r.provisional, true);
  });
});

test('importLabels stays provisional when precision < threshold despite enough labels', () => {
  withTmp((dir) => {
    const rotate = (state) => CANONICAL_STATES[(CANONICAL_STATES.indexOf(state) + 1) % CANONICAL_STATES.length];
    const exported = writeBlindLabels(dir, { goldFor: rotate });
    const r = importLabels({ worksheetFile: exported.jsonl_path, metaDir: dir });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, false, 'not calibrated: precision below threshold');
  });
});

test('duplicate turn ids never count toward the evidence floor', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    const rows = Array.from({ length: MIN_LABELED }, () => ({
      turn_id: 'same-turn', harness: 'codex', classifier_version: '0.3.0', proxy_version: 2,
      heuristic_state: 'tier-0-win', gold_state: 'tier-0-win',
    }));
    writeFileSync(f, rows.map(JSON.stringify).join('\n') + '\n');
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.labeled_count, 1);
    assert.equal(r.is_calibrated, false);
    assert.equal(r.duplicate_turn_ids, MIN_LABELED - 1);
  });
});

test('mixed harness labels are refused instead of pooled', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    writeFileSync(f, [
      { turn_id: 'c', harness: 'codex', heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
      { turn_id: 'a', harness: 'claude-code', heuristic_state: 'tier-0-win', gold_state: 'tier-0-win' },
    ].map(JSON.stringify).join('\n') + '\n');
    const r = importLabels({ worksheetFile: f, metaDir: dir });
    assert.equal(r.status, 'ERROR');
    assert.match(r.message, /one harness/i);
  });
});

test('state write failure cannot return OK', () => {
  withTmp((dir) => {
    const f = join(dir, 'worksheet.jsonl');
    writeFileSync(f, `${JSON.stringify({
      turn_id: 'x', harness: 'codex', classifier_version: '0.3.0', proxy_version: 2,
      heuristic_state: 'tier-0-win', gold_state: 'tier-0-win',
    })}\n`);
    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'file');
    const r = importLabels({ worksheetFile: f, metaDir: blocked, minLabeled: 1 });
    assert.equal(r.status, 'ERROR');
    assert.match(r.message, /state write/i);
  });
});

// ============================================================
// MET-002: workspace-configurable calibration gate
// ============================================================

test('MET-002: resolveMinLabeled defaults to 100 with no workspace.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-min-'));
  try { assert.equal(resolveMinLabeled(dir), 100); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workspace calibration_min_labeled cannot lower the terminal floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-min2-'));
  try {
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ workspace_id: 'w', calibration_min_labeled: 40 }));
    assert.equal(resolveMinLabeled(dir), MIN_LABELED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('terminal evidence floor cannot be lowered by workspace configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-floor-'));
  try {
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ calibration_min_labeled: 30 }));
    assert.equal(resolveMinLabeled(dir), MIN_LABELED);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MET-002: resolveMinLabeled rejects values below the floor and non-integers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-min3-'));
  try {
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ calibration_min_labeled: 5 }));
    assert.equal(resolveMinLabeled(dir), 100, 'below MIN_LABELED_FLOOR → default');
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ calibration_min_labeled: '50' }));
    assert.equal(resolveMinLabeled(dir), 100, 'string → default');
    assert.ok(MIN_LABELED_FLOOR >= 100, 'floor cannot undercut the terminal evidence contract');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('importLabels refuses to clear at a caller-supplied lower threshold', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cal-imp-'));
  try {
    const ws = join(dir, 'worksheet.jsonl');
    const rows = CANONICAL_STATES.flatMap((state) => Array.from({ length: 5 }, (_, i) => ({
      turn_id: `${state}-${i}`, harness: 'codex', classifier_version: '0.3.0', proxy_version: 2,
      heuristic_state: state, gold_state: state,
    })));
    writeFileSync(ws, rows.map(JSON.stringify).join('\n') + '\n');
    const metaDir = join(dir, 'meta');
    const r = importLabels({ worksheetFile: ws, metaDir, minLabeled: 30 });
    assert.equal(r.status, 'OK');
    assert.equal(r.is_calibrated, false, '30 labels cannot clear the 100-turn terminal gate');
    assert.equal(r.min_labeled, MIN_LABELED, 'the enforced floor is recorded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
