#!/usr/bin/env node
/**
 * metrics-check.mjs — evidence-first memory health check for a CORE project.
 *
 * Ported from the personal `~/.claude/skills/metrics/` skill into the plugin
 * proper. Script resolution follows the metrics-package.mjs pattern exactly:
 * this file lives beside check-units.mjs / retrieve-context.mjs / calibrate-
 * classifier.mjs in the shared `skills/core/scripts/` directory, so it calls
 * them by co-location (`scriptDir`-relative) instead of hunting for an
 * installed plugin cache the way the old standalone version had to.
 *
 * Three things, all real:
 *  1. LIVE PROBE (the proof): builds a throwaway scratch store, writes synthetic
 *     units through the plugin's own scripts, and proves the full
 *     write → validate → index → retrieve → suppress round trip END TO END,
 *     fresh, on every run. Nothing cached, nothing self-reported.
 *  2. THIS-STORE HEALTH (read-only): validator counts, unit census, retrieval-log
 *     coverage, recognition-signal state.
 *  3. CALIBRATION POOL (read-only): the classifier's labeled-turn count against
 *     the 100-turn gate, via calibrate-classifier.mjs's own readinessReport().
 *
 * Output (default): the rendered report — verdict heading, a 10-char bar gauge
 * per row, a 1-3 sentence narrative. Pass --json to also dump the full data
 * object (probe/store/calibration/verdict + the same `report` string) so other
 * tooling can consume it without re-parsing text.
 *
 * Exit 0 always (report, don't block); the verdict lives in the data.
 *
 * CLI: node metrics-check.mjs [project-dir] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readinessReport } from './calibrate-classifier.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Bar rendering — the 10-character gauge every row uses.
// ============================================================

export const BAR_WIDTH = 10;
export const FILLED_CHAR = '█';
export const EMPTY_CHAR = '░';
// Distinct glyph for a hard FAIL on the (binary) round-trip row — chosen so a
// broken round trip can never be visually mistaken for "just a low bar"; it
// reads as its own failure shape at a glance, not a partially-full gauge.
export const FAILED_CHAR = '✗';

/**
 * Render a 0-100 percentage into a BAR_WIDTH-character gauge of filled vs
 * empty blocks. `failed: true` overrides pct entirely and renders the whole
 * bar in FAILED_CHAR (used only by the binary round-trip row on FAIL).
 *
 * Rounding rule (deterministic, tested at the boundary): filled block count =
 * Math.round(pct / (100 / BAR_WIDTH)), clamped to [0, BAR_WIDTH]. Each block
 * represents a 10%-wide bin; Math.round rounds a bin at its own midpoint, and
 * JS's Math.round rounds positive .5 up — so 5% -> 1 filled block (rounds up
 * from the 0/1 boundary), 15% -> 2 filled blocks (rounds up from the 1/2
 * boundary), 73% -> 7 filled blocks (7.3 rounds down), 0% -> 0, 100% -> 10.
 */
export function renderBar(pct, { failed = false } = {}) {
  if (failed) return FAILED_CHAR.repeat(BAR_WIDTH);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(clamped / (100 / BAR_WIDTH))));
  return FILLED_CHAR.repeat(filled) + EMPTY_CHAR.repeat(BAR_WIDTH - filled);
}

// ============================================================
// Trust vocabulary (same meaning as the original skill's table)
// ============================================================

export const TRUST = { PROVEN_LIVE: 'proven-live', DIRECT: 'direct', PROVISIONAL: 'provisional' };

// ============================================================
// Recognition-signal parsing
// ============================================================

/**
 * Parses the one-line signal metrics-rollup.mjs writes to orient-signal.txt,
 * e.g. "rec-fail-tier-0: 3/6 turns today (50%) vs 7-day avg 21% ↑ [PROVISIONAL...]".
 * Returns { available: false, reason } when there's nothing to parse yet, or
 * { available: true, todayPct, avgPct, arrow, raw } when it is.
 */
export function parseRecognitionSignal(text) {
  if (!text || !text.trim()) return { available: false, reason: 'no recognition signal recorded yet' };
  if (/^metrics: no classified turns/.test(text)) return { available: false, reason: 'no classified turns yet this period' };
  const m = text.match(/rec-fail-tier-0:\s*\d+\/\d+\s*turns today\s*\((\d+)%\)\s*vs 7-day avg\s*(n\/a[^[\n]*|(\d+)%)\s*(↑|↓|≈)?/);
  if (!m) return { available: false, reason: 'signal present but unparseable', raw: text.trim() };
  const todayPct = Number(m[1]);
  const avgPct = m[3] != null ? Number(m[3]) : null;
  const arrow = m[4] || null;
  return { available: true, todayPct, avgPct, arrow, raw: text.trim() };
}

// ============================================================
// Locate the co-located plugin scripts (metrics-package.mjs pattern)
// ============================================================

const run = (script, args) => {
  try { return { code: 0, out: execFileSync('node', [join(scriptDir, script), ...args], { encoding: 'utf8', timeout: 60000 }) }; }
  catch (e) { return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }; }
};

// ============================================================
// Calibration-pool check — the new row. Reuses calibrate-classifier.mjs's own
// readinessReport() (imported, not shelled out to) so this never re-derives
// the gate logic; it just reads the same answer /calibrate-classifier --check
// would report. Fails open: any error here means "no calibration data", never
// a crash of the whole health check.
// ============================================================

export function checkCalibrationPool(project, { home = homedir() } = {}) {
  try {
    const r = readinessReport({ project, home });
    return {
      available: true,
      labeled_count: r.labeled_count,
      min_needed: r.min_needed,
      is_calibrated: r.is_calibrated,
      overall_precision: r.overall_precision,
      notes: r.notes,
    };
  } catch (e) {
    return { available: false, reason: `calibration readiness check failed: ${String(e).slice(0, 120)}` };
  }
}

// ============================================================
// Row computation — turns the gathered data into the five render rows.
// ============================================================

export function computeRows(out) {
  const rows = [];

  // 1. Round-trip proof — binary.
  const roundTrip = !!out.probe?.round_trip;
  rows.push({
    label: 'Round-trip proof',
    pct: roundTrip ? 100 : 0,
    failed: !roundTrip,
    trust: TRUST.PROVEN_LIVE,
    value: roundTrip ? 'PASS' : 'FAIL',
  });

  // 2. Unit integrity — % of units with no attention-tier warning.
  const total = out.store?.present ? (out.store.census?.total ?? 0) : 0;
  const attention = out.store?.warning_triage?.attention ?? 0;
  const clean = Math.max(0, total - attention);
  const integrityPct = total > 0 ? (clean / total) * 100 : 0;
  rows.push({
    label: `Unit integrity (${total})`,
    pct: out.store?.present ? integrityPct : 0,
    trust: TRUST.DIRECT,
    value: !out.store?.present ? 'no store' : `${attention} warning${attention === 1 ? '' : 's'}`,
  });

  // 3. Retrieval-log coverage — rows/files as a direct percentage, capped at
  // 100% (a session can log more than one retrieval row per file, which is
  // healthy, not "over-covered" — the cap keeps the bar meaningful).
  const files = out.store?.retrieval_log?.files ?? 0;
  const logRows = out.store?.retrieval_log?.rows ?? 0;
  const coveragePct = files > 0 ? Math.min(100, (logRows / files) * 100) : 0;
  rows.push({
    label: 'Retrieval-log coverage',
    pct: coveragePct,
    trust: TRUST.DIRECT,
    value: files > 0 ? `${Math.round(coveragePct)}%` : 'no session logs yet',
  });

  // 4. Recognition signal — INVERTED on purpose: the underlying number is a
  // FAILURE rate (rec-fail-tier-0), so a bigger number is worse. The bar shows
  // (100 - rate) so a fuller bar always reads as "healthier" like every other
  // row here, even though the raw metric it's built from is a failure rate.
  const recognition = parseRecognitionSignal(out.store?.recognition_signal?.text);
  let recPct = 0;
  let recValue = 'no data yet';
  if (recognition.available) {
    recPct = 100 - recognition.todayPct;
    const avgText = recognition.avgPct != null ? `${recognition.avgPct}% avg` : 'no 7-day avg yet';
    const arrowText = recognition.arrow ? `${recognition.arrow} vs ${avgText}` : avgText;
    recValue = `${recognition.todayPct}% rec-fail (${arrowText})`;
  } else if (recognition.reason) {
    recValue = recognition.reason;
  }
  rows.push({ label: 'Recognition signal', pct: recPct, trust: TRUST.PROVISIONAL, value: recValue });

  // 5. Calibration pool — labeled turns / 100, straightforward.
  const cal = out.calibration || {};
  const labeled = cal.available ? (cal.labeled_count ?? 0) : 0;
  const minNeeded = cal.available ? (cal.min_needed ?? 100) : 100;
  const calPct = minNeeded > 0 ? Math.min(100, (labeled / minNeeded) * 100) : 0;
  rows.push({
    label: 'Calibration pool',
    pct: calPct,
    trust: TRUST.DIRECT,
    value: `${labeled}/${minNeeded} labeled`,
  });

  return rows;
}

// ============================================================
// Narrative — 1-3 sentences. Every number/label explained in the sentence it
// appears in; leads with the failure first when DEGRADED; names what's
// provisional vs proven otherwise.
// ============================================================

export function buildNarrative(out) {
  const attention = out.store?.warning_triage?.attention ?? 0;
  const cal = out.calibration || {};
  const labeled = cal.available ? (cal.labeled_count ?? 0) : 0;
  const minNeeded = cal.available ? (cal.min_needed ?? 100) : 100;
  const recognition = parseRecognitionSignal(out.store?.recognition_signal?.text);

  if (out.verdict === 'DEGRADED') {
    const failures = [];
    if (!out.probe?.round_trip) failures.push('the live round-trip probe failed');
    if (out.store?.present && out.store.schema?.exit !== 0) failures.push('the schema validator did not exit clean');
    if ((out.store?.integrity?.fail ?? 0) > 0) failures.push(`the validator found ${out.store.integrity.fail} integrity failure(s)`);
    const lead = failures.length ? failures.join(', and ') : 'a hard check failed';
    return `DEGRADED — ${lead}; fix that before trusting anything else here.`;
  }

  if (out.verdict === 'MACHINERY-WORKING-NO-STORE') {
    return 'The plugin machinery round-trips clean on a scratch store, but this project has no _memories/ store yet — there is nothing here to measure.';
  }

  let s1 = 'Core mechanics are proven and working';
  s1 += attention > 0 ? `, though ${attention} warning${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} a look.` : '.';

  const parts = [];
  if (recognition.available) {
    const trend = recognition.arrow === '↑' ? 'down' : recognition.arrow === '↓' ? 'up' : 'steady';
    const worthLook = recognition.arrow === '↑' ? ' (worth a look)' : '';
    parts.push(`recognition is trending ${trend} this session${worthLook}`);
  } else {
    parts.push('recognition has no signal yet this session');
  }
  parts.push(`the classifier stays unofficial until the calibration pool clears ${minNeeded} labeled turns — currently ${labeled}`);
  const s2 = parts.join(', and ') + '.';

  return `${s1} ${s2.charAt(0).toUpperCase()}${s2.slice(1)}`;
}

// ============================================================
// Full report render — verdict heading, visual block, narrative.
// ============================================================

const VERDICT_DISPLAY = {
  'WORKING': 'WORKING',
  'WORKING-WITH-CAVEATS': 'WORKING — with caveats',
  'DEGRADED': 'DEGRADED',
  'MACHINERY-WORKING-NO-STORE': 'MACHINERY WORKING, NO STORE',
};

const LABEL_WIDTH = 24;
const TRUST_WIDTH = 12;

export function renderReport(out, { workspaceName } = {}) {
  const name = workspaceName || basename(out.project || process.cwd());
  const rows = computeRows(out);
  const lines = [];
  lines.push(VERDICT_DISPLAY[out.verdict] || out.verdict || 'UNKNOWN');
  lines.push('');
  lines.push(`CORE Memory Health — ${name}`);
  lines.push('');
  for (const row of rows) {
    const bar = renderBar(row.pct, { failed: row.failed });
    lines.push(`${row.label.padEnd(LABEL_WIDTH)}[${bar}] ${row.trust.padEnd(TRUST_WIDTH)} ${row.value}`);
  }
  lines.push('');
  lines.push(`"${buildNarrative(out)}"`);
  return lines.join('\n');
}

// ============================================================
// Main data-gathering (only runs when this file is the CLI entry, but the
// gathering itself is a plain function so it stays testable/importable).
// ============================================================

export function gatherMetrics(cwd, { home = homedir() } = {}) {
  const out = { generated_at: new Date().toISOString(), project: cwd, probe: {}, store: {}, calibration: {}, verdict: null, caveats: [] };

  // ---- 1. LIVE PROBE on a scratch store ----
  const scratch = join(tmpdir(), `core-metrics-probe-${process.pid}`);
  const mem = join(scratch, '_memories');
  const TOKEN = 'zephyrine-cobalt-ledger';       // unique: must be retrieved
  const RETIRED_TOKEN = 'halcyon-probe-retired'; // unique: must be suppressed
  try {
    mkdirSync(mem, { recursive: true });
    const unit = (id, status, body, topics) => writeFileSync(join(mem, `${id}.md`),
`---
id: ${id}
type: observation
status: ${status}
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
    unit('probe-live-fact', 'active', `The ${TOKEN} reconciles nightly.`, 'probe, ledger');
    unit('probe-second-fact', 'active', 'A second synthetic fact for ranking context.', 'probe, context');
    unit('probe-retired-fact', 'retired', `The ${RETIRED_TOKEN} was decommissioned.`, 'probe, retired');

    const validate = run('check-units.mjs', ['--store', scratch, '--schema']);
    out.probe.validate = { pass: validate.code === 0, exit: validate.code };

    const hit = run('retrieve-context.mjs', [scratch, TOKEN, '--pack']);
    out.probe.retrieve = { pass: hit.out.includes('probe-live-fact'), evidence: hit.out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 200) };

    const suppressed = run('retrieve-context.mjs', [scratch, RETIRED_TOKEN]);
    out.probe.suppress_retired = { pass: !suppressed.out.includes('probe-retired-fact'), evidence: suppressed.out.trim() ? 'substitutes only' : 'zero output (retired never indexed)' };

    out.probe.round_trip = out.probe.validate.pass && out.probe.retrieve.pass && out.probe.suppress_retired.pass;
  } catch (e) {
    out.probe.round_trip = false; out.caveats.push(`probe crashed: ${String(e).slice(0, 120)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // ---- 2. THIS-STORE HEALTH (read-only) ----
  const store = join(cwd, '_memories');
  if (!existsSync(store)) {
    out.store.present = false; out.caveats.push('no _memories/ store in this project');
  } else {
    out.store.present = true;
    const parseCounts = (s) => {
      const m = s.match(/PASS:\s*(\d+)\s+WARN:\s*(\d+)\s+FAIL:\s*(\d+)/);
      return m ? { pass: +m[1], warn: +m[2], fail: +m[3] } : null;
    };
    const schema = run('check-units.mjs', ['--store', cwd, '--schema']);
    out.store.schema = { exit: schema.code, ...parseCounts(schema.out) };
    const integ = run('check-units.mjs', ['--store', cwd, '--integrity']);
    out.store.integrity = { exit: integ.code, ...parseCounts(integ.out) };

    // Triage the WARN rows so the verdict only escalates what a human should act on.
    const INFO_CATS = new Set(['external-ref']);
    const UPKEEP_CATS = new Set(['link-density', 'sources-missing', 'orphan']);
    const triage = { informational: 0, routine_upkeep: 0, attention: 0, attention_items: [] };
    for (const line of integ.out.split('\n')) {
      const m = line.match(/^\s{2}([a-z-]+):\s+\[([^\]]+)\]/);
      if (!m) continue;
      if (INFO_CATS.has(m[1])) triage.informational++;
      else if (UPKEEP_CATS.has(m[1])) triage.routine_upkeep++;
      else { triage.attention++; if (triage.attention_items.length < 5) triage.attention_items.push(`${m[1]}: ${m[2]}`); }
    }
    out.store.warning_triage = triage;

    // unit census by status
    const census = { active: 0, retired: 0, archived: 0, superseded: 0, other: 0, total: 0 };
    for (const f of readdirSync(store)) {
      if (!f.endsWith('.md') || f.startsWith('INDEX') || f.startsWith('_')) continue;
      census.total++;
      try {
        const head = readFileSync(join(store, f), 'utf8').slice(0, 600);
        const st = (head.match(/^status:\s*(\S+)/m) || [])[1] || 'other';
        census[st] !== undefined ? census[st]++ : census.other++;
      } catch { census.other++; }
    }
    out.store.census = census;

    // retrieval-log coverage (the honesty number)
    let rows = 0, retrievalShaped = 0, files = 0;
    const sessions = join(cwd, '_sessions');
    if (existsSync(sessions)) {
      for (const d of readdirSync(sessions)) {
        const log = join(sessions, d, 'retrieval-log.jsonl');
        if (!existsSync(log)) continue;
        files++;
        for (const line of readFileSync(log, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          rows++;
          try { if (JSON.parse(line).units_retrieved) retrievalShaped++; } catch { /* unparseable counts as row only */ }
        }
      }
    }
    out.store.retrieval_log = { files, rows, retrieval_shaped: retrievalShaped,
      note: 'retrieval rows are LLM self-reports until the typed-hook-events batch ships; per-turn hook emits nothing yet' };

    // recognition / trend signal state
    try {
      const wsId = JSON.parse(readFileSync(join(cwd, 'workspace.json'), 'utf8')).workspace_id;
      const sig = join(home, '.core/workspaces', wsId, 'metrics/orient-signal.txt');
      if (existsSync(sig)) {
        out.store.recognition_signal = { text: readFileSync(sig, 'utf8').trim(), age_hours: Math.round((Date.now() - statSync(sig).mtimeMs) / 3.6e6) };
      }
    } catch { /* no workspace pointer — skip */ }

    // memory-processing recency
    try {
      const pm = JSON.parse(readFileSync(join(store, '_pm-state.json'), 'utf8'));
      out.store.last_memory_processing = pm.last_run || null;
    } catch { /* absent is fine */ }
  }

  // ---- 3. CALIBRATION POOL (read-only) ----
  out.calibration = checkCalibrationPool(cwd, { home });

  // ---- verdict: hard evidence only; routine upkeep never demotes it ----
  const attention = out.store.warning_triage?.attention ?? 0;
  if (out.probe.round_trip && out.store.present && out.store.schema?.exit === 0 && (out.store.integrity?.fail ?? 1) === 0) {
    out.verdict = attention > 0 ? 'WORKING-WITH-CAVEATS' : 'WORKING';
  } else if (out.probe.round_trip && !out.store.present) {
    out.verdict = 'MACHINERY-WORKING-NO-STORE';
  } else {
    out.verdict = 'DEGRADED';
  }
  if (attention > 0) out.caveats.push(`${attention} warning(s) need a look: ${out.store.warning_triage.attention_items.join('; ')}`);
  if (out.store.warning_triage && (out.store.warning_triage.informational + out.store.warning_triage.routine_upkeep) > 0) {
    out.store.upkeep_note = `${out.store.warning_triage.routine_upkeep} routine-upkeep warns (agent fixes at next hygiene pass) + ${out.store.warning_triage.informational} informational (by design) — nothing for the user`;
  }

  out.report = renderReport(out);
  return out;
}

// ============================================================
// CLI entry
// ============================================================

const isCliEntry = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isCliEntry) {
  const args = process.argv.slice(2);
  const wantsJson = args.includes('--json');
  const positional = args.find((a) => !a.startsWith('--'));
  const cwd = positional ? join(positional) : process.cwd();
  const out = gatherMetrics(cwd);
  process.stdout.write(out.report + '\n');
  if (wantsJson) process.stdout.write('\n' + JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}
