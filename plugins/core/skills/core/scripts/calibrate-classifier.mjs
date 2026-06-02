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
 * The script provides the mechanics; the DM orchestrates labeling when enough turns
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
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
  readdirSync, realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { todayUTC, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';
import { CLASSIFIER_VERSION } from './classify-turns.mjs';

export const CALIBRATION_VERSION = '1.0.0';
export const PRECISION_THRESHOLD = 0.7;
export const MIN_LABELED = 100;

// ============================================================
// Calibration state (persisted to ~/.core/workspaces/<id>/metrics/)
// ============================================================

export function emptyCalibrationState() {
  return {
    schema_version: CALIBRATION_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    is_calibrated: false,
    provisional: true,
    labeled_count: 0,
    overall_precision: null,
    precision_by_state: {},
    updated_at: null,
    notes: `No labels yet — need ${MIN_LABELED}+ labeled turns to clear the provisional gate.`,
  };
}

export function readCalibrationState(metaDir) {
  const f = join(metaDir, 'calibration-state.json');
  if (!existsSync(f)) return emptyCalibrationState();
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return emptyCalibrationState(); }
}

export function writeCalibrationState(metaDir, state) {
  try {
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, 'calibration-state.json'), JSON.stringify(state, null, 2) + '\n');
  } catch { /* best-effort */ }
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
export function computePrecision(labeledTurns) {
  const valid = labeledTurns.filter((t) => t.gold_state && t.heuristic_state);
  if (valid.length < 1) return { overall: null, by_state: {}, labeled_count: 0 };

  // Per-class: TP and FP counts.
  const tp = {}; const fp = {};
  for (const t of valid) {
    const h = t.heuristic_state;
    if (t.gold_state === h) tp[h] = (tp[h] || 0) + 1;
    else fp[h] = (fp[h] || 0) + 1;
  }
  const states = new Set([...Object.keys(tp), ...Object.keys(fp)]);
  const by_state = {};
  for (const s of states) {
    const t = tp[s] || 0; const f = fp[s] || 0;
    by_state[s] = (t + f) > 0 ? t / (t + f) : null;
  }
  // Macro average: mean of per-class precisions, ignoring null.
  const vals = Object.values(by_state).filter((v) => v !== null);
  const overall = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return { overall, by_state, labeled_count: valid.length };
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
export function exportWorksheet({ project, classifiedDir, calibrationDir, today, count = 200 }) {
  const all = collectClassifiedTurns(classifiedDir);
  if (!all.length) return { status: 'EMPTY', message: 'No classified turns yet — accumulate real sessions first.' };

  const sample = stratifiedSample(all, count);
  const date = today || todayUTC();
  mkdirSync(calibrationDir, { recursive: true });

  const jsonlPath = join(calibrationDir, `worksheet-${date}.jsonl`);
  const mdPath = join(calibrationDir, `worksheet-${date}.md`);

  // Write JSONL (machine-readable, for import-labels).
  for (const t of sample) {
    const row = {
      turn_id: `${t.session_id}-${t.turn_idx}`,
      session_id: t.session_id,
      turn_idx: t.turn_idx,
      heuristic_state: t.state,
      evidence: t.evidence || {},
      gold_state: null,   // to be filled by the labeler
      labeler: null,
      confidence: null,
    };
    appendFileSync(jsonlPath, JSON.stringify(row) + '\n');
  }

  // Write Markdown companion (human-readable labeling guide).
  const stateDist = {};
  for (const t of sample) stateDist[t.state] = (stateDist[t.state] || 0) + 1;
  const guide = [
    `# Calibration labeling worksheet — ${date}`,
    '',
    `Generated: ${date} | Pool size: ${all.length} | Sample: ${sample.length} | Min needed: ${MIN_LABELED}`,
    '',
    '## Valid gold_state values',
    '- `tier-0-win` — agent had the answer at hand, no ladder walk needed',
    '- `tier-1-3-win` — agent walked the ladder and surfaced the answer',
    '- `rec-fail-tier-0` — agent asked; term WAS in baseline context (the failure case)',
    '- `rec-fail-tier-1-3-trigger` — agent asked; term on disk but no ladder walk fired',
    '- `mechanics-failure` — agent walked the ladder; it came back empty anyway',
    '- `capture-miss` — agent asked; term genuinely nowhere in the store',
    '',
    '## Sample state distribution (heuristic)',
    ...Object.entries(stateDist).map(([s, n]) => `- ${s}: ${n}`),
    '',
    '## Labeling instructions',
    '1. Open `worksheet-' + date + '.jsonl` (one turn per line)',
    '2. For each line: read `heuristic_state` and `evidence`, then set `gold_state`',
    '3. Set `labeler` to your agent name, `confidence` to high/medium/low',
    '4. Save, then import: `node calibrate-classifier.mjs <project> --import-labels worksheet-' + date + '.jsonl`',
    '',
    '## Anti-circular labeling discipline',
    'Do NOT anchor on `heuristic_state` when assigning `gold_state`. The point is to',
    'find where the heuristic is wrong. If you find yourself agreeing with every heuristic',
    'label, apply the R-1 guard: you may be anchoring. Re-examine disagreement candidates',
    'independently. Use multiple labeling agents and adjudicate disagreements.',
  ];
  writeFileSync(mdPath, guide.join('\n') + '\n');

  return { status: 'OK', jsonl_path: jsonlPath, md_path: mdPath, sample_count: sample.length, pool_count: all.length };
}

/** Read a labeled worksheet file, compute precision, write updated calibration state. */
export function importLabels({ worksheetFile, metaDir }) {
  if (!existsSync(worksheetFile)) {
    return { status: 'ERROR', message: `Worksheet not found: ${worksheetFile}` };
  }
  const lines = safeRead(worksheetFile).split('\n').filter(Boolean);
  const turns = [];
  for (const l of lines) {
    try { turns.push(JSON.parse(l)); } catch { /* skip */ }
  }
  const labeled = turns.filter((t) => t.gold_state);
  if (!labeled.length) {
    return { status: 'EMPTY', message: 'No labeled turns found in worksheet (gold_state is null on all rows).' };
  }

  const p = computePrecision(labeled);
  const is_calibrated = p.labeled_count >= MIN_LABELED && p.overall !== null && p.overall >= PRECISION_THRESHOLD;
  const today = todayUTC();
  const state = {
    schema_version: CALIBRATION_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    is_calibrated,
    provisional: !is_calibrated,
    labeled_count: p.labeled_count,
    overall_precision: p.overall !== null ? Math.round(p.overall * 1000) / 1000 : null,
    precision_by_state: Object.fromEntries(
      Object.entries(p.by_state).map(([s, v]) => [s, v !== null ? Math.round(v * 1000) / 1000 : null]),
    ),
    updated_at: today,
    notes: is_calibrated
      ? `Calibrated ${today}. Overall precision: ${p.overall !== null ? Math.round(p.overall * 100) : '?'}% (cleared ${PRECISION_THRESHOLD} bar).`
      : p.labeled_count < MIN_LABELED
        ? `${p.labeled_count} labeled turns (need ${MIN_LABELED}+). Precision: ${p.overall !== null ? Math.round(p.overall * 100) + '%' : 'n/a'}.`
        : `${p.labeled_count} labeled turns. Precision ${p.overall !== null ? Math.round(p.overall * 100) : '?'}% did not clear ${PRECISION_THRESHOLD} bar.`,
  };
  writeCalibrationState(metaDir, state);
  return { status: 'OK', ...state };
}

// ============================================================
// Readiness summary
// ============================================================

/**
 * How close is the calibration pool to the minimum? Useful for the DM to know
 * when to launch the labeling pass.
 */
export function readinessReport({ project, home = homedir(), workspaceId }) {
  const wid = workspaceId || resolveWorkspaceId(project);
  const metaDir = operationalMetricsDir(wid, { home });
  const classifiedDir = join(metaDir, 'classified');
  const state = readCalibrationState(metaDir);
  const turns = collectClassifiedTurns(classifiedDir, MIN_LABELED + 50);
  return {
    is_calibrated: state.is_calibrated,
    provisional: state.provisional,
    pool_size: turns.length,
    min_needed: MIN_LABELED,
    ready_to_label: turns.length >= MIN_LABELED,
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
    const r = exportWorksheet({ project, classifiedDir, calibrationDir, count });
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
    const r = importLabels({ worksheetFile, metaDir });
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(r.status === 'OK' ? 0 : 1); }
    if (r.status !== 'OK') { process.stdout.write(`calibrate-classifier: ${r.message}\n`); process.exit(1); }
    process.stdout.write(`calibrate-classifier: ${r.is_calibrated ? '✔ CALIBRATED' : '○ still provisional'} — ${r.notes}\n`);
    process.exit(0);
  }

  process.stdout.write('calibrate-classifier: --check | --export-worksheet [--count N] | --import-labels <file>\n');
  process.exit(1);
}
