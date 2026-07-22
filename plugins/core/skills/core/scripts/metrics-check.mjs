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
 * Reports THREE SEPARATE, HONESTLY-LABELED EVIDENCE CLASSES (2026-07-22 —
 * never blend them into one umbrella verdict again; see the "Evidence-class
 * contract" comment below for the full rationale):
 *
 *  1. MECHANICS (proven-live + direct): the live round-trip PROOF — builds a
 *     throwaway scratch store, writes synthetic units through the plugin's
 *     own scripts, and proves the full write → validate → index → retrieve →
 *     suppress round trip END TO END, fresh, on every run — plus this
 *     project's real validator counts and unit census. Real, proven evidence
 *     that the STORE MECHANICS work. Says nothing about retrieval quality or
 *     user benefit.
 *  2. RETRIEVAL REGRESSION (proven-live / proxy / provisional / direct,
 *     row-by-row): does retrieval itself work well? Retrieval-log coverage
 *     (capture volume, not correctness), a LIVE gold-set Recall@K run via
 *     retrieval-harness.mjs against this project's own pre-registered gold
 *     set when one exists (genuinely exercised this run, on the real product
 *     functions — not a simulator), the live retrieval-quality proxy from
 *     analyze-retrieval-quality.mjs's real retrieval-log rows, the
 *     recognition signal, and the calibration pool that gates it. Every row
 *     here says plainly when the underlying evidence doesn't exist yet.
 *  3. USER BENEFIT (not-evaluated): does any of this measurably help the
 *     user get better answers? Nothing in this codebase measures that yet —
 *     no matched memory-on/off comparison exists — so the row says so
 *     plainly instead of being silently folded into the other two classes.
 *
 * Output (default): the rendered report — a MECHANICS-scoped verdict heading,
 * three sectioned blocks of 10-char bar gauges (one gauge per row, one
 * section per evidence class), and a 1-3 sentence narrative that speaks to
 * all three classes, never just the first. Pass --json to also dump the full
 * data object (probe/store/calibration/regression/verdict + the same
 * `report` string) so other tooling can consume it without re-parsing text.
 *
 * Exit 0 always (report, don't block); the verdict lives in the data.
 *
 * CLI: node metrics-check.mjs [project-dir] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readinessReport } from './calibrate-classifier.mjs';
import { runHarness } from './retrieval-harness.mjs';
import { loadEvents as loadRetrievalEvents, buildReport as buildRetrievalQualityReport } from './analyze-retrieval-quality.mjs';

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

export const TRUST = {
  PROVEN_LIVE: 'proven-live', DIRECT: 'direct', PROXY: 'proxy',
  PROVISIONAL: 'provisional', NOT_EVALUATED: 'not-evaluated',
};

// ============================================================
// Evidence-class contract (2026-07-22, Hale's metrics-evidence-lifecycle
// synthesis, accepted by Keel — see the mailbox thread
// "accept-metrics-evidence-contract-first-slice"). Three honest classes,
// never blended into one verdict:
//   mechanics   — proven store mechanics: round-trip proof + unit integrity.
//   regression  — does retrieval itself work well, over real or gold-set
//                 queries? Everything here is a proxy or a small directional
//                 gold-set measurement, NEVER user-benefit evidence.
//   benefit     — does any of this measurably help the user? Nothing in this
//                 codebase answers that yet; the row says so plainly.
// ============================================================
export const SECTION = { MECHANICS: 'mechanics', REGRESSION: 'regression', BENEFIT: 'benefit' };

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
// Gold-set Recall@K regression — REAL retrieval-regression evidence when it
// exists. Runs retrieval-harness.mjs's runHarness() LIVE, this run, against
// the project's OWN store and its OWN pre-registered gold set at the
// harness's own default path (<project>/_tests/retrieval-gold-set.json —
// the exact convention retrieval-harness.mjs's CLI itself defaults to).
// This is not a simulator: the harness calls the shipped product functions
// (productRankedIds / retrieveContext / bm25Rank) directly, so a project that
// has an admissible frozen gold set gets genuine proven-live regression
// evidence, not a proxy. A project with no gold set gets an honest absence,
// never a silently-skipped row. Read-only: runHarness takes no write path.
// ============================================================

export async function checkGoldRegression(project, { goldPath = join(resolve(project), '_tests', 'retrieval-gold-set.json') } = {}) {
  if (!existsSync(goldPath)) {
    return { available: false, reason: 'no _tests/retrieval-gold-set.json in this project — nothing exercises Recall@K here yet' };
  }
  try {
    const out = await runHarness(project, goldPath);
    const context3R3 = out.results.context3?.recall?.[3] ?? null;
    const rankingR10 = out.results.ranking?.recall?.[10] ?? null;
    const bm25R10 = out.results.bm25?.recall?.[10] ?? null;
    return {
      available: true,
      n: out.nQueries,
      storeUnits: out.total,
      context3_r3: context3R3,
      ranking_r10: rankingR10,
      bm25_r10: bm25R10,
    };
  } catch (e) {
    return { available: false, reason: `gold-set harness run failed: ${String(e && e.message || e).slice(0, 160)}` };
  }
}

// ============================================================
// Live retrieval-quality proxy — wraps analyze-retrieval-quality.mjs's own
// buildReport() over this project's real retrieval-log/outcome-log rows (the
// live per-turn hook's product output, not a simulator). Its own docstring
// calls these numbers "precision proxy" / "recall proxy" — never regression
// PASS/FAIL, never user benefit. Read-only, no new capture.
// ============================================================

export function checkLiveRetrievalProxy(project) {
  let events;
  try { events = loadRetrievalEvents(project, { allTime: true }); }
  catch (e) { return { available: false, reason: `could not read retrieval logs: ${String(e).slice(0, 120)}` }; }

  const report = buildRetrievalQualityReport(events);
  if (!report.total_events || !report.retrieval_events) {
    return { available: false, reason: 'no retrieval events recorded for this project yet' };
  }
  const td = report.tier_distribution;
  const topEscalation = (report.tier_escalation || [])[0] || null;
  return {
    available: true,
    days: report.sessions,
    retrievalEvents: report.retrieval_events,
    t1Pct: Math.round((td.t1?.pct ?? 0) * 100),
    t2Pct: Math.round((td.t2?.pct ?? 0) * 100),
    t3Pct: Math.round((td.t3?.pct ?? 0) * 100),
    topEscalationTopic: topEscalation ? topEscalation.topic : null,
    topEscalationRate: topEscalation ? Math.round(topEscalation.rate_t2_plus * 100) : null,
  };
}

// ============================================================
// Row computation — turns the gathered data into the render rows, each
// tagged with the evidence-class section it belongs to.
// ============================================================

export function computeRows(out) {
  const rows = [];

  // ---- MECHANICS: proven store mechanics only ----

  // 1. Round-trip proof — binary.
  const roundTrip = !!out.probe?.round_trip;
  rows.push({
    section: SECTION.MECHANICS,
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
    section: SECTION.MECHANICS,
    label: `Unit integrity (${total})`,
    pct: out.store?.present ? integrityPct : 0,
    trust: TRUST.DIRECT,
    value: !out.store?.present ? 'no store' : `${attention} warning${attention === 1 ? '' : 's'}`,
  });

  // ---- RETRIEVAL REGRESSION: does retrieval itself work well, over real or
  // gold-set queries? Every row here is a proxy or a small directional
  // gold-set number — never mechanics, never user benefit. ----

  // 3. Retrieval-log coverage — rows/files as a direct percentage, capped at
  // 100% (a session can log more than one retrieval row per file, which is
  // healthy, not "over-covered" — the cap keeps the bar meaningful). This
  // counts capture volume, not retrieval correctness — the value string says
  // so, so the number can't be misread as a quality score.
  const files = out.store?.retrieval_log?.files ?? 0;
  const logRows = out.store?.retrieval_log?.rows ?? 0;
  const coveragePct = files > 0 ? Math.min(100, (logRows / files) * 100) : 0;
  rows.push({
    section: SECTION.REGRESSION,
    label: 'Retrieval-log coverage',
    pct: coveragePct,
    trust: TRUST.DIRECT,
    value: files > 0 ? `${Math.round(coveragePct)}% (capture volume, not correctness)` : 'no session logs yet',
  });

  // 4. Gold-set Recall@K — real regression evidence when a project has a
  // pre-registered gold set; an honest absence otherwise.
  const gold = out.regression?.gold || {};
  if (gold.available) {
    const r3Pct = Math.round((gold.context3_r3 ?? 0) * 100);
    const rankingPct = gold.ranking_r10 != null ? Math.round(gold.ranking_r10 * 100) : null;
    const bm25Pct = gold.bm25_r10 != null ? Math.round(gold.bm25_r10 * 100) : null;
    const extra = [
      rankingPct != null ? `ranking R@10 ${rankingPct}%` : null,
      bm25Pct != null ? `bm25 R@10 ${bm25Pct}%` : null,
    ].filter(Boolean).join(', ');
    rows.push({
      section: SECTION.REGRESSION,
      label: `Gold-set Recall@K (n=${gold.n})`,
      pct: r3Pct,
      trust: TRUST.PROVEN_LIVE,
      value: `delivered top-3 R@3 ${r3Pct}%${extra ? `; ${extra}` : ''} — directional, small gold set`,
    });
  } else {
    rows.push({
      section: SECTION.REGRESSION,
      label: 'Gold-set Recall@K',
      pct: 0,
      trust: TRUST.NOT_EVALUATED,
      value: gold.reason || 'no gold-set regression evidence recorded for this project',
    });
  }

  // 5. Live retrieval-quality proxy — tier-escalation/dip-back signal from
  // real retrieval-log rows, when any exist.
  const proxy = out.regression?.liveProxy || {};
  if (proxy.available) {
    const worst = proxy.topEscalationTopic
      ? `; '${proxy.topEscalationTopic}' needed Tier 2+ ${proxy.topEscalationRate}% of the time`
      : '';
    rows.push({
      section: SECTION.REGRESSION,
      label: 'Live retrieval proxy',
      pct: proxy.t1Pct,
      trust: TRUST.PROXY,
      value: `T1 ${proxy.t1Pct}% / T2 ${proxy.t2Pct}% / T3 ${proxy.t3Pct}% over ${proxy.retrievalEvents} events / ${proxy.days}d${worst}`,
    });
  } else {
    rows.push({
      section: SECTION.REGRESSION,
      label: 'Live retrieval proxy',
      pct: 0,
      trust: TRUST.NOT_EVALUATED,
      value: proxy.reason || 'no live retrieval events recorded for this project',
    });
  }

  // 6. Recognition signal — INVERTED on purpose: the underlying number is a
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
  rows.push({ section: SECTION.REGRESSION, label: 'Recognition signal', pct: recPct, trust: TRUST.PROVISIONAL, value: recValue });

  // 7. Calibration pool — labeled turns / 100, straightforward. This is the
  // classifier's own readiness gate for the recognition signal above, so it
  // lives in the same evidence class, not under mechanics.
  const cal = out.calibration || {};
  const labeled = cal.available ? (cal.labeled_count ?? 0) : 0;
  const minNeeded = cal.available ? (cal.min_needed ?? 100) : 100;
  const calPct = minNeeded > 0 ? Math.min(100, (labeled / minNeeded) * 100) : 0;
  rows.push({
    section: SECTION.REGRESSION,
    label: 'Calibration pool',
    pct: calPct,
    trust: TRUST.DIRECT,
    value: `${labeled}/${minNeeded} labeled`,
  });

  // ---- USER BENEFIT: does any of this measurably help the user? Nothing in
  // this codebase answers that yet — no matched memory-on/off comparison, no
  // independent outcome labels. Say so plainly; never imply the other two
  // classes cover it. ----
  rows.push({
    section: SECTION.BENEFIT,
    label: 'User-benefit evidence',
    pct: 0,
    trust: TRUST.NOT_EVALUATED,
    value: 'no matched memory-on/off comparison exists — nothing currently measures whether this helps',
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

  // A mechanics hard-fail leads with the failure and the single next action —
  // "instead of anything else" (SKILL.md §Step 3) — so it does NOT get padded
  // with the regression/benefit sentences below; those evidence classes don't
  // matter until mechanics itself is trustworthy again.
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

  let s1 = 'Mechanics are proven and working';
  s1 += attention > 0 ? `, though ${attention} warning${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} a look.` : '.';

  // Retrieval regression — combine whatever real evidence exists (gold-set
  // Recall@K, the live retrieval-log proxy, the recognition signal, the
  // calibration gate); never claim more than what actually ran.
  const gold = out.regression?.gold || {};
  const proxy = out.regression?.liveProxy || {};
  const parts = [];
  if (gold.available) {
    parts.push(`a gold-set Recall@K check (n=${gold.n}, directional) puts delivered top-3 recall at ${Math.round((gold.context3_r3 ?? 0) * 100)}%`);
  }
  if (proxy.available) {
    parts.push(`live retrieval-log analysis over ${proxy.retrievalEvents} events shows ${proxy.t1Pct}% resolving at Tier 1`);
  }
  if (recognition.available) {
    const trend = recognition.arrow === '↑' ? 'down' : recognition.arrow === '↓' ? 'up' : 'steady';
    const worthLook = recognition.arrow === '↑' ? ' (worth a look)' : '';
    parts.push(`recognition is trending ${trend} this session${worthLook}`);
  } else if (!gold.available && !proxy.available) {
    parts.push('recognition has no signal yet this session');
  }
  parts.push(`the classifier stays unofficial until the calibration pool clears ${minNeeded} labeled turns — currently ${labeled}`);
  const s2Body = parts.join(', and ') + '.';
  const s2 = `Retrieval regression: ${s2Body.charAt(0).toUpperCase()}${s2Body.slice(1)}`;

  const s3 = "Whether any of this actually helps you get better answers hasn't been measured yet — no matched memory-on/off comparison exists.";

  return `${s1} ${s2} ${s3}`;
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

const LABEL_WIDTH = 26;
const TRUST_WIDTH = 14;

// Section headers for the two evidence classes that sit BELOW the verdict
// heading and are explicitly not covered by it (item 5 of the metrics-
// evidence contract: no word up top may imply proof this deep).
const SECTION_HEADER = {
  [SECTION.REGRESSION]: 'Retrieval regression — separate evidence class, NOT covered by the verdict above:',
  [SECTION.BENEFIT]: 'User benefit — separate evidence class, NOT covered by the verdict above:',
};

export function renderReport(out, { workspaceName } = {}) {
  const name = workspaceName || basename(out.project || process.cwd());
  const rows = computeRows(out);
  const lines = [];
  lines.push(`MECHANICS: ${VERDICT_DISPLAY[out.verdict] || out.verdict || 'UNKNOWN'}`);
  lines.push('');
  lines.push(`CORE Memory Health — ${name}`);
  lines.push('');

  const renderRow = (row) => {
    const bar = renderBar(row.pct, { failed: row.failed });
    return `${row.label.padEnd(LABEL_WIDTH)}[${bar}] ${row.trust.padEnd(TRUST_WIDTH)} ${row.value}`;
  };

  const bySection = { [SECTION.MECHANICS]: [], [SECTION.REGRESSION]: [], [SECTION.BENEFIT]: [] };
  for (const row of rows) (bySection[row.section] ||= []).push(row);

  for (const row of bySection[SECTION.MECHANICS]) lines.push(renderRow(row));

  for (const section of [SECTION.REGRESSION, SECTION.BENEFIT]) {
    lines.push('');
    lines.push(SECTION_HEADER[section]);
    for (const row of bySection[section]) lines.push(renderRow(row));
  }

  lines.push('');
  lines.push(`"${buildNarrative(out)}"`);
  return lines.join('\n');
}

// ============================================================
// Main data-gathering (only runs when this file is the CLI entry, but the
// gathering itself is a plain function so it stays testable/importable).
// ============================================================

export async function gatherMetrics(cwd, { home = homedir() } = {}) {
  const out = { generated_at: new Date().toISOString(), project: cwd, probe: {}, store: {}, calibration: {}, regression: {}, verdict: null, caveats: [] };

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
      note: 'rows/files is capture volume, not retrieval correctness — the per-turn hook does emit real typed events (see the retrieval-regression rows below for what those events actually show)' };

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

  // ---- 4. RETRIEVAL REGRESSION (read-only + one live product-path run) ----
  out.regression.gold = await checkGoldRegression(cwd);
  out.regression.liveProxy = checkLiveRetrievalProxy(cwd);

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
  const out = await gatherMetrics(cwd);
  process.stdout.write(out.report + '\n');
  if (wantsJson) process.stdout.write('\n' + JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}
