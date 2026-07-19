/**
 * calibrate-classifier.mjs — Phase 3 calibration harness for classify-turns.mjs.
 *
 * The heuristic classifier is PROVISIONAL until precision clears 0.7 on a
 * 100–200 hand-labeled turn set (spec §17.12, Anvil A4; R-1 self-measuring guard).
 * This script provides the three-command pipeline:
 *
 *   --check              Print current calibration state. Exit 0 if calibrated, 1 if not.
 *   --export-worksheet   Extract N turns for labeling; write to _metrics/calibration/.
 *   --import-labels <f>  Read labeled worksheet, compute precision, update state.
 *
 * Labeling strategy: labels-by-disagreement. Dispatch N independent labeling agents
 * (via analysis.md), adjudicate disagreements, use agreed turns as the gold set.
 * The script provides the mechanics; the agent orchestrates labeling when enough turns
 * accumulate. Until then, the machinery exists and the state is honestly PROVISIONAL.
 *
 * HONESTY GATE: precision is computed from imported labels only — never from the
 * heuristic output itself (that would be circular, the R-1 self-confirming failure).
 *
 * Privacy-gated. Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI:
 *   node calibrate-classifier.mjs <project> --check
 *   node calibrate-classifier.mjs <project> --export-worksheet [--count N]
 *   node calibrate-classifier.mjs <project> --import-labels <labeled.jsonl>
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, realpathSync, chmodSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { todayUTC, resolveWorkspaceId, operationalMetricsDir } from './log-event.mjs';
import { atomicWriteFileSync } from './fs-atomic.mjs';
import { CLASSIFIER_VERSION, PROXY_VERSION } from './classify-turns.mjs';

export const CALIBRATION_VERSION = '1.0.0';
export const PRECISION_THRESHOLD = 0.7;
export const MIN_LABELED = 100;
export const MIN_LABELED_FLOOR = MIN_LABELED;
export const MIN_PER_STATE = 10;
export const INTERVAL_LOWER_THRESHOLD = 0.5;
export const CALIBRATION_HARNESSES = ['claude-code', 'codex'];

/**
 * MET-002 honesty fix: the 100-turn gate is structurally slow on a single-user
 * install (the CORE-on-CORE pool sat at 57/100 after months), so PROVISIONAL is
 * the EXPECTED steady state at that scale — not a failure to nag about. A
 * workspace that wants a reachable gate sets `calibration_min_labeled` in
 * <project>/workspace.json (floor 30: below that, per-class precision across six
 * states is noise, and lowering further would launder confidence — the R-1 guard).
 * REOPEN CONDITION for revisiting the 100 default: the pool clears 100 labeled
 * turns anyway, or the install grows beyond a single user.
 */
export function resolveMinLabeled(project) {
  void project;
  return MIN_LABELED;
}

// The six recognition states classify-turns can emit. M7: the gate must measure per-class
// coverage against this canonical set so it can't clear while whole states sit unmeasured.
export const CANONICAL_STATES = [
  'tier-0-win', 'tier-1-3-win', 'rec-fail-tier-0',
  'rec-fail-tier-1-3-trigger', 'mechanics-failure', 'capture-miss',
];

// ============================================================
// Calibration state (persisted to ~/.core/workspaces/<id>/metrics/)
// ============================================================

export function emptyCalibrationState() {
  return {
    schema_version: CALIBRATION_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    proxy_version: PROXY_VERSION,
    is_calibrated: false,
    provisional: true,
    labeled_count: 0,
    overall_precision: null,
    precision_by_state: {},
    recall_by_state: {},
    uncertainty_by_state: {},
    by_harness: {},
    updated_at: null,
    notes: `No labels yet — need ${MIN_LABELED}+ labeled turns to clear the provisional gate.`,
  };
}

export function readCalibrationState(metaDir) {
  const f = join(metaDir, 'calibration-state.json');
  if (!existsSync(f)) return emptyCalibrationState();
  try {
    const state = JSON.parse(readFileSync(f, 'utf8'));
    if (state.classifier_version !== CLASSIFIER_VERSION || state.proxy_version !== PROXY_VERSION) {
      return { ...emptyCalibrationState(), invalidated_stale_state: true };
    }
    return state;
  } catch { return emptyCalibrationState(); }
}

export function writeCalibrationState(metaDir, state) {
  try {
    mkdirSync(metaDir, { recursive: true });
    const path = join(metaDir, 'calibration-state.json');
    const text = JSON.stringify(state, null, 2) + '\n';
    atomicWriteFileSync(path, text);
    if (readFileSync(path, 'utf8') !== text) return { written: false, error_code: 'readback-mismatch' };
    return { written: true, path };
  } catch (error) {
    return { written: false, error_code: typeof error?.code === 'string' ? error.code : 'state-write-failed' };
  }
}

// ============================================================
// Precision computation
// ============================================================

/**
 * Compute precision per state and overall from an array of labeled turns.
 * Each item: { heuristic_state, gold_state } (gold_state = null means unlabeled — skip).
 *
 * For multi-class precision: precision_per_class = TP / (TP + FP) where
 *   TP = heuristic said X AND gold is X
 *   FP = heuristic said X AND gold is not X
 * Overall = macro average across classes present in gold labels.
 */
function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { lower: null, upper: null };
  const p = successes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denom;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export function computePrecision(labeledTurns) {
  const valid = labeledTurns.filter((t) => t.gold_state && t.heuristic_state);
  if (valid.length < 1) return {
    overall: null, by_state: {}, recall_by_state: {}, uncertainty_by_state: {},
    labeled_count: 0, unmeasured_gold_states: [...CANONICAL_STATES], coverage_complete: false,
  };

  const tp = {}; const fp = {}; const fn = {};
  for (const t of valid) {
    const h = t.heuristic_state;
    if (t.gold_state === h) tp[h] = (tp[h] || 0) + 1;
    else {
      fp[h] = (fp[h] || 0) + 1;
      fn[t.gold_state] = (fn[t.gold_state] || 0) + 1;
    }
  }
  const states = new Set([...CANONICAL_STATES, ...Object.keys(tp), ...Object.keys(fp), ...Object.keys(fn)]);
  const by_state = {}; const recall_by_state = {}; const uncertainty_by_state = {}; const support_by_state = {};
  for (const s of states) {
    const t = tp[s] || 0; const f = fp[s] || 0; const missed = fn[s] || 0;
    const predicted = t + f; const actual = t + missed;
    by_state[s] = predicted > 0 ? t / predicted : null;
    recall_by_state[s] = actual > 0 ? t / actual : null;
    support_by_state[s] = { predicted, gold: actual };
    uncertainty_by_state[s] = {
      precision: wilsonInterval(t, predicted),
      recall: wilsonInterval(t, actual),
    };
  }
  // Macro average: mean of per-class precisions, ignoring null.
  const vals = Object.values(by_state).filter((v) => v !== null);
  const overall = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

  // M7 coverage: the macro average above only spans classes the heuristic PREDICTED, so a
  // classifier that emits 2 of 6 states can clear 0.7 with the other 4 unmeasured. A gold
  // state the heuristic never predicts is an unmeasured class — surface it so the gate can
  // refuse to clear until every state present in the gold labels has at least one prediction.
  const goldStates = new Set(valid.map((t) => t.gold_state));
  const predictedStates = new Set(valid.map((t) => t.heuristic_state));
  const unmeasured_gold_states = CANONICAL_STATES.filter((s) => !goldStates.has(s) || !predictedStates.has(s));
  const coverage_complete = CANONICAL_STATES.every((s) => goldStates.has(s) && predictedStates.has(s));
  return {
    overall, by_state, recall_by_state, uncertainty_by_state, support_by_state,
    labeled_count: valid.length, unmeasured_gold_states, coverage_complete,
  };
}

// ============================================================
// Worksheet: export + import
// ============================================================

/**
 * Collect classified turn records from all daily files under classifiedDir.
 * Returns an array of records, newest-first up to maxCount.
 */
export function collectClassifiedTurns(classifiedDir, maxCount = 500) {
  if (!existsSync(classifiedDir)) return [];
  const files = readdirSync(classifiedDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse(); // newest first
  const out = [];
  for (const f of files) {
    if (out.length >= maxCount) break;
    const lines = safeRead(join(classifiedDir, f)).split('\n').filter(Boolean);
    for (const l of lines) {
      if (out.length >= maxCount) break;
      try { out.push(JSON.parse(l)); } catch { /* skip malformed */ }
    }
  }
  return out;
}

/**
 * Stratified sample: pick up to `count` turns, proportional to state distribution
 * in the pool. Ensures all states get representation if possible.
 */
export function stratifiedSample(turns, count) {
  if (turns.length <= count) return [...turns];
  const byState = {};
  for (const t of turns) {
    (byState[t.state] = byState[t.state] || []).push(t);
  }
  const states = Object.keys(byState);
  const perState = Math.max(1, Math.floor(count / states.length));
  const out = [];
  for (const s of states) {
    const pool = byState[s];
    for (let i = 0; i < Math.min(perState, pool.length); i++) out.push(pool[i]);
  }
  // Top off from any state if we're under target.
  for (const t of turns) {
    if (out.length >= count) break;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, count);
}

/** Write a labeling worksheet for a set of classified turns. Returns the file path. */
export function exportWorksheet({ project: _project, harness, classifiedDir, calibrationDir, today, count = 200, minLabeled = MIN_LABELED }) {
  const pool = collectClassifiedTurns(classifiedDir);
  if (!pool.length) return { status: 'EMPTY', message: 'No classified turns yet — accumulate real sessions first.' };
  const availableHarnesses = [...new Set(pool.map((t) => t.harness).filter(Boolean))];
  const selectedHarness = harness || (availableHarnesses.length === 1 ? availableHarnesses[0] : null);
  if (!CALIBRATION_HARNESSES.includes(selectedHarness)) {
    return { status: 'ERROR', message: 'Select exactly one calibration harness: claude-code or codex.' };
  }
  const uniqueTurns = new Map();
  for (const turn of pool) {
    const turnId = `${turn.session_id}-${turn.turn_idx}`;
    if (turn.harness === selectedHarness
        && turn.classifier_version === CLASSIFIER_VERSION
        && turn.proxy_version === PROXY_VERSION
        && !uniqueTurns.has(turnId)) uniqueTurns.set(turnId, turn);
  }
  const all = [...uniqueTurns.values()];
  if (!all.length) return { status: 'EMPTY', message: `No current ${selectedHarness} classified turns yet — accumulate real sessions first.` };

  const sample = stratifiedSample(all, count);
  const date = today || todayUTC();
  mkdirSync(calibrationDir, { recursive: true });

  const base = `worksheet-${selectedHarness}-${date}`;
  const jsonlPath = join(calibrationDir, `${base}.jsonl`);
  const mdPath = join(calibrationDir, `${base}.md`);
  const predictionsPath = join(calibrationDir, `${base}.predictions.json`);
  const nonce = randomBytes(32).toString('hex');

  // Write JSONL (machine-readable, for import-labels). Build the whole file and
  // write ONCE — appending in a loop into a date-stamped file meant a same-day
  // re-run (a retry, or a different --count) accumulated duplicate/mixed turn_ids,
  // which importLabels then double-counts toward MIN_LABELED and the precision
  // average — corrupting the gate that decides whether the classifier is trusted (M7).
  const predictions = {};
  const jsonlRows = sample.map((t) => {
    const turnId = `${t.session_id}-${t.turn_idx}`;
    predictions[turnId] = t.state;
    const commitment = createHash('sha256').update(`${nonce}\0${turnId}\0${t.state}`).digest('hex');
    return JSON.stringify({
      turn_id: turnId,
      session_id: t.session_id,
      turn_idx: t.turn_idx,
      harness: selectedHarness,
      classifier_version: CLASSIFIER_VERSION,
      proxy_version: PROXY_VERSION,
      user_text: t.turn_evidence?.user_text || '',
      assistant_text: t.turn_evidence?.assistant_text || '',
      tool_events: Array.isArray(t.turn_evidence?.tool_events) ? t.turn_evidence.tool_events : [],
      context_evidence: t.evidence || {},
      prediction_commitment: commitment,
      gold_state: null,
      labelers: [],
      adjudicated_by: null,
      confidence: null,
    });
  });
  writeFileSync(jsonlPath, jsonlRows.join('\n') + '\n', { mode: 0o600 });
  chmodSync(jsonlPath, 0o600);
  writeFileSync(predictionsPath, JSON.stringify({
    schema_version: CALIBRATION_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    proxy_version: PROXY_VERSION,
    harness: selectedHarness,
    nonce,
    predictions,
  }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(predictionsPath, 0o600);

  // Write Markdown companion (human-readable labeling guide).
  const guide = [
    `# Calibration labeling worksheet — ${date}`,
    '',
    `Generated: ${date} | Harness: ${selectedHarness} | Pool size: ${all.length} | Sample: ${sample.length} | Min needed: ${Math.max(MIN_LABELED, minLabeled)}`,
    '',
    '## Valid gold_state values',
    '- `tier-0-win` — agent had the answer at hand, no ladder walk needed',
    '- `tier-1-3-win` — agent walked the ladder and surfaced the answer',
    '- `rec-fail-tier-0` — agent asked; term WAS in baseline context (the failure case)',
    '- `rec-fail-tier-1-3-trigger` — agent asked; term on disk but no ladder walk fired',
    '- `mechanics-failure` — agent walked the ladder; it came back empty anyway',
    '- `capture-miss` — agent asked; term genuinely nowhere in the store',
    '',
    '## Labeling instructions',
    `1. Open \`${base}.jsonl\` (one turn per line). Do not open the sealed predictions companion until labels are final.`,
    '2. For each line: read user_text, assistant_text, tool_events, and context_evidence, then set gold_state independently',
    '3. Set `labeler` to your agent name, `confidence` to high/medium/low',
    `4. Save, then import: \`node calibrate-classifier.mjs <project> --harness ${selectedHarness} --import-labels ${base}.jsonl\``,
    '',
    '## Anti-circular labeling discipline',
    'The prediction is intentionally absent from the worksheet. Label from the actual turn evidence,',
    'use multiple independent labeling agents, record adjudication, and open the sealed prediction',
    'companion only after labels are frozen. Import verifies every prediction commitment.',
    '',
    '> LOCAL SENSITIVE EVIDENCE: this worksheet contains real turn text and tool evidence. Never include it in the shareable metrics package or commit it to source control.',
  ];
  writeFileSync(mdPath, guide.join('\n') + '\n');

  return {
    status: 'OK', harness: selectedHarness, jsonl_path: jsonlPath, md_path: mdPath,
    predictions_path: predictionsPath, sample_count: sample.length, pool_count: all.length,
  };
}

/** Read a labeled worksheet file, compute precision, write updated calibration state. */
export function importLabels({ worksheetFile, metaDir, minLabeled = MIN_LABELED }) {
  if (!existsSync(worksheetFile)) {
    return { status: 'ERROR', message: `Worksheet not found: ${worksheetFile}` };
  }
  const lines = safeRead(worksheetFile).split('\n').filter(Boolean);
  const turns = [];
  for (const l of lines) {
    try { turns.push(JSON.parse(l)); } catch { /* skip */ }
  }
  const labeledRows = turns.filter((t) => t.gold_state);
  if (!labeledRows.length) {
    return { status: 'EMPTY', message: 'No labeled turns found in worksheet (gold_state is null on all rows).' };
  }

  const byTurnId = new Map();
  let duplicateTurnIds = 0;
  let missingTurnIds = 0;
  for (const row of labeledRows) {
    if (typeof row.turn_id !== 'string' || !row.turn_id.trim()) { missingTurnIds += 1; continue; }
    if (byTurnId.has(row.turn_id)) { duplicateTurnIds += 1; continue; }
    byTurnId.set(row.turn_id, row);
  }
  const unique = [...byTurnId.values()];
  if (!unique.length) return { status: 'ERROR', message: 'No uniquely identified labeled turns; turn_id is required.' };
  const harnesses = [...new Set(unique.map((row) => row.harness).filter(Boolean))];
  if (harnesses.length !== 1 || !CALIBRATION_HARNESSES.includes(harnesses[0])) {
    return { status: 'ERROR', message: 'Labels must contain exactly one harness: claude-code or codex.' };
  }
  const harness = harnesses[0];
  if (unique.some((row) => row.classifier_version !== CLASSIFIER_VERSION || row.proxy_version !== PROXY_VERSION)) {
    return { status: 'ERROR', message: 'Labels were not captured with the current classifier and proxy versions.' };
  }
  if (unique.some((row) => !CANONICAL_STATES.includes(row.gold_state))) {
    return { status: 'ERROR', message: 'One or more gold_state values are outside the canonical state vocabulary.' };
  }

  const predictionsFile = worksheetFile.replace(/\.jsonl$/, '.predictions.json');
  let predictionEnvelope = null;
  if (existsSync(predictionsFile)) {
    try { predictionEnvelope = JSON.parse(readFileSync(predictionsFile, 'utf8')); } catch { predictionEnvelope = null; }
  }
  const blinded = !!predictionEnvelope;
  if (predictionEnvelope
      && (predictionEnvelope.harness !== harness
        || predictionEnvelope.classifier_version !== CLASSIFIER_VERSION
        || predictionEnvelope.proxy_version !== PROXY_VERSION)) {
    return { status: 'ERROR', message: 'Sealed predictions do not match the worksheet harness or versions.' };
  }
  const labeled = [];
  for (const row of unique) {
    const heuristicState = predictionEnvelope?.predictions?.[row.turn_id] || row.heuristic_state;
    if (!CANONICAL_STATES.includes(heuristicState)) {
      return { status: 'ERROR', message: `Missing canonical sealed prediction for ${row.turn_id}.` };
    }
    if (predictionEnvelope) {
      const expected = createHash('sha256')
        .update(`${predictionEnvelope.nonce}\0${row.turn_id}\0${heuristicState}`).digest('hex');
      if (row.prediction_commitment !== expected) {
        return { status: 'ERROR', message: `Prediction commitment mismatch for ${row.turn_id}.` };
      }
    }
    labeled.push({ ...row, heuristic_state: heuristicState });
  }

  const p = computePrecision(labeled);
  const evidenceFloor = Math.max(MIN_LABELED, minLabeled);
  const provenanceComplete = labeled.every((row) => Array.isArray(row.labelers)
    && row.labelers.length >= 2
    && typeof row.adjudicated_by === 'string' && row.adjudicated_by.length > 0
    && ['high', 'medium', 'low'].includes(row.confidence));
  const perClassPass = CANONICAL_STATES.every((stateName) => {
    const support = p.support_by_state[stateName];
    const interval = p.uncertainty_by_state[stateName];
    return support.gold >= MIN_PER_STATE
      && support.predicted >= MIN_PER_STATE
      && p.by_state[stateName] >= PRECISION_THRESHOLD
      && p.recall_by_state[stateName] >= PRECISION_THRESHOLD
      && interval.precision.lower >= INTERVAL_LOWER_THRESHOLD
      && interval.recall.lower >= INTERVAL_LOWER_THRESHOLD;
  });
  const is_calibrated = p.labeled_count >= evidenceFloor && p.overall !== null
    && p.overall >= PRECISION_THRESHOLD && p.coverage_complete
    && perClassPass && blinded && provenanceComplete;
  const today = todayUTC();
  const harnessState = {
    harness,
    is_calibrated,
    provisional: !is_calibrated,
    labeled_count: p.labeled_count,
    duplicate_turn_ids: duplicateTurnIds,
    missing_turn_ids: missingTurnIds,
    min_labeled: evidenceFloor,
    min_per_state: MIN_PER_STATE,
    overall_precision: p.overall !== null ? Math.round(p.overall * 1000) / 1000 : null,
    precision_by_state: Object.fromEntries(
      Object.entries(p.by_state).map(([s, v]) => [s, v !== null ? Math.round(v * 1000) / 1000 : null]),
    ),
    recall_by_state: Object.fromEntries(
      Object.entries(p.recall_by_state).map(([s, v]) => [s, v !== null ? Math.round(v * 1000) / 1000 : null]),
    ),
    uncertainty_by_state: p.uncertainty_by_state,
    support_by_state: p.support_by_state,
    coverage_complete: p.coverage_complete,
    unmeasured_gold_states: p.unmeasured_gold_states,
    per_class_pass: perClassPass,
    blinded,
    provenance_complete: provenanceComplete,
    data_hashes: {
      labeled_worksheet_sha256: createHash('sha256').update(readFileSync(worksheetFile)).digest('hex'),
      predictions_sha256: predictionEnvelope
        ? createHash('sha256').update(readFileSync(predictionsFile)).digest('hex') : null,
    },
    updated_at: today,
    notes: is_calibrated
      ? `Calibrated ${harness} ${today}. Overall precision: ${p.overall !== null ? Math.round(p.overall * 100) : '?'}%; every class cleared precision, recall, support, and interval gates.`
      : p.labeled_count < evidenceFloor
        ? `${p.labeled_count} unique labeled turns (need ${evidenceFloor}+). Precision: ${p.overall !== null ? Math.round(p.overall * 100) + '%' : 'n/a'}.`
        : !p.coverage_complete
          ? `${p.labeled_count} labeled turns, precision ${p.overall !== null ? Math.round(p.overall * 100) : '?'}%, but ${p.unmeasured_gold_states.length} gold state(s) unmeasured (${p.unmeasured_gold_states.join(', ')}) — gate held until the heuristic predicts them.`
          : !blinded ? 'Calibration held: labels were not joined to a sealed blind prediction companion.'
            : !provenanceComplete ? 'Calibration held: independent labeler and adjudication provenance is incomplete.'
              : `${p.labeled_count} labeled turns. One or more per-class precision, recall, support, or interval gates did not clear.`,
  };
  const previous = readCalibrationState(metaDir);
  const previousByHarness = previous.classifier_version === CLASSIFIER_VERSION
    && previous.proxy_version === PROXY_VERSION ? previous.by_harness || {} : {};
  const byHarness = { ...previousByHarness, [harness]: harnessState };
  const allHarnessesCalibrated = CALIBRATION_HARNESSES.every((name) => byHarness[name]?.is_calibrated === true);
  const state = {
    schema_version: CALIBRATION_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    proxy_version: PROXY_VERSION,
    is_calibrated: allHarnessesCalibrated,
    provisional: !allHarnessesCalibrated,
    labeled_count: Object.values(byHarness).reduce((sum, item) => sum + (item.labeled_count || 0), 0),
    overall_precision: allHarnessesCalibrated
      ? Math.min(...CALIBRATION_HARNESSES.map((name) => byHarness[name].overall_precision)) : null,
    by_harness: byHarness,
    updated_at: today,
    notes: allHarnessesCalibrated ? 'Claude Code and Codex calibration gates both cleared.' : 'Calibration remains provisional until Claude Code and Codex each clear independently.',
  };
  const write = writeCalibrationState(metaDir, state);
  if (!write.written) return { status: 'ERROR', message: `Calibration state write failed: ${write.error_code}` };
  return {
    status: 'OK', ...harnessState, all_harnesses_calibrated: allHarnessesCalibrated,
    by_harness: byHarness,
  };
}

// ============================================================
// Readiness summary
// ============================================================

/**
 * How close is the calibration pool to the minimum? Useful for the agent to know
 * when to launch the labeling pass.
 */
export function readinessReport({ project, home = homedir(), workspaceId }) {
  const minLabeled = resolveMinLabeled(project);
  const wid = workspaceId || resolveWorkspaceId(project);
  const metaDir = operationalMetricsDir(wid, { home });
  const classifiedDir = join(metaDir, 'classified');
  const state = readCalibrationState(metaDir);
  const turns = collectClassifiedTurns(classifiedDir, minLabeled + 50);
  return {
    is_calibrated: state.is_calibrated,
    provisional: state.provisional,
    pool_size: turns.length,
    min_needed: minLabeled,
    ready_to_label: turns.length >= minLabeled,
    overall_precision: state.overall_precision,
    labeled_count: state.labeled_count,
    notes: state.notes,
    metaDir,
    classifiedDir,
  };
}

// ============================================================
// Helpers
// ============================================================

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

// ============================================================
// CLI
// ============================================================

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(`--${f}`);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const harness = opt('harness');

  if (has('check')) {
    const r = readinessReport({ project });
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r.is_calibrated ? 0 : 1); }
    process.stdout.write(`calibrate-classifier: ${r.is_calibrated ? '✔ CALIBRATED' : '○ PROVISIONAL'}\n`);
    process.stdout.write(`  pool: ${r.pool_size} turns | labeled: ${r.labeled_count} | precision: ${r.overall_precision !== null ? (r.overall_precision * 100).toFixed(0) + '%' : 'n/a'}\n`);
    process.stdout.write(`  ${r.notes}\n`);
    if (!r.is_calibrated && r.ready_to_label) process.stdout.write(`  Ready to label — run --export-worksheet to create the worksheet.\n`);
    process.exit(r.is_calibrated ? 0 : 1);
  }

  if (has('export-worksheet')) {
    const wid = resolveWorkspaceId(project);
    const metaDir = operationalMetricsDir(wid);
    const classifiedDir = join(metaDir, 'classified');
    const calibrationDir = join(project, '_metrics', 'calibration');
    const count = parseInt(opt('count') || '200', 10);
    const r = exportWorksheet({ project, harness, classifiedDir, calibrationDir, count, minLabeled: resolveMinLabeled(project) });
    if (r.status !== 'OK') { process.stdout.write(`calibrate-classifier: ${r.message}\n`); process.exit(1); }
    process.stdout.write(`calibrate-classifier: worksheet written — ${r.sample_count} turns from pool of ${r.pool_count}\n`);
    process.stdout.write(`  JSONL: ${r.jsonl_path}\n`);
    process.stdout.write(`  Guide: ${r.md_path}\n`);
    process.exit(0);
  }

  if (has('import-labels')) {
    const worksheetFile = opt('import-labels');
    if (!worksheetFile) { process.stdout.write('calibrate-classifier: --import-labels requires a file path\n'); process.exit(1); }
    const wid = resolveWorkspaceId(project);
    const metaDir = operationalMetricsDir(wid);
    const r = importLabels({ worksheetFile, metaDir, minLabeled: resolveMinLabeled(project) });
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r.status === 'OK' ? 0 : 1); }
    if (r.status !== 'OK') { process.stdout.write(`calibrate-classifier: ${r.message}\n`); process.exit(1); }
    process.stdout.write(`calibrate-classifier: ${r.is_calibrated ? '✔ CALIBRATED' : '○ still provisional'} — ${r.notes}\n`);
    process.exit(0);
  }

  process.stdout.write('calibrate-classifier: --check | --export-worksheet [--count N] | --import-labels <file>\n');
  process.exit(1);
}
