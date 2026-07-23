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
 * Reports FOUR SEPARATE, HONESTLY-LABELED EVIDENCE CLASSES (2026-07-22 —
 * never blend them into one umbrella verdict again; see the "Evidence-class
 * contract" comment below for the full rationale):
 *
 *  1. MECHANICS (proven-live + direct): the live round-trip PROOF — builds a
 *     throwaway scratch store, writes synthetic units through the plugin's
 *     own scripts, and proves the full write → validate → index → retrieve →
 *     suppress round trip END TO END, fresh, on every run — plus this
 *     project's real validator counts, unit census, and plain-count telemetry
 *     capture (from analyze-retrieval-quality.mjs's real retrieval-log rows).
 *     Real, proven evidence that the STORE MECHANICS work. Says nothing about
 *     retrieval quality or user benefit.
 *  2. RETRIEVAL REGRESSION (provisional / not-evaluated): does retrieval
 *     itself work well against a reference answer key? Exactly one signal —
 *     a LIVE gold-set Recall@K run via retrieval-harness.mjs against this
 *     project's own pre-registered gold set when one exists (genuinely
 *     exercised this run, on the real product functions — not a simulator);
 *     an honest absence otherwise.
 *  3. MEASUREMENT READINESS (provisional / direct): is the instrumentation
 *     itself ready to be trusted? The recognition signal and the calibration
 *     pool that gates it.
 *  4. USER BENEFIT (not-evaluated): does any of this measurably help the
 *     user get better answers? Nothing in this codebase measures that yet —
 *     no matched memory-on/off comparison exists — so the row says so
 *     plainly instead of being silently folded into the other classes.
 *
 * Output (default): the rendered report — a MECHANICS-scoped verdict heading,
 * sectioned blocks of 10-char bar gauges (one gauge per row, one section per
 * evidence class), and a 1-3 sentence narrative that speaks to all the
 * classes, never just the first. Pass --json to emit EXACTLY the canonical data
 * object as a single JSON document instead of the report (nothing else on the
 * stream, so the output is valid JSON that render-metrics-artifact --json-in can
 * consume directly). Its top-level structure IS the four-evidence-class taxonomy
 * (2026-07-22, Hale's slice acceptance revise — the machine consumer must
 * receive the SAME taxonomy the human report renders, never a different one):
 *
 *   schema_version  — METRICS_REPORT_SCHEMA_VERSION, stamped by this script
 *   producer        — { script, plugin, plugin_version, source_sha } from the
 *                     plugin manifest (the same identity convention the
 *                     manifest itself carries)
 *   mechanics       — { status, probe, store, telemetry }: the mechanics-
 *                     scoped machine verdict plus everything mechanics-class
 *   regression      — { gold }: the gold-set snapshot ONLY
 *   readiness       — { recognition_signal, calibration }
 *   benefit         — { status: 'not-evaluated', reason }
 *   generated_at / project / caveats / report — run metadata + the rendered
 *                     report string
 *
 * There is exactly ONE such object: gatherMetrics() builds it, the renderer
 * (computeRows/buildNarrative/renderReport) consumes it field-for-field, and
 * --json emits it verbatim — no adapter schema beside it, so the machine and
 * human views can never diverge again. There is deliberately NO umbrella
 * top-level verdict: the machine verdict lives at mechanics.status, scoped
 * exactly like the human 'MECHANICS: …' heading.
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
import { richContextStats } from './rich-context-capture.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Report identity — who produced this object and under which schema.
// ============================================================

// Version of the canonical four-class report object below. Same stamping
// convention as RETRIEVAL_EVENT_SCHEMA_VERSION in record-retrieval-event.mjs:
// always OUR stamp, never a caller-supplied value.
export const METRICS_REPORT_SCHEMA_VERSION = '1.0.0';

/**
 * Producer identity for the emitted object, sourced from the plugin manifest
 * (plugins/core/.claude-plugin/plugin.json) — the codebase's existing identity
 * surface, which already carries `version` and `source_sha`. Fails open: a
 * missing/unreadable manifest yields null identity fields, never a crash of
 * the health check.
 */
export function producerIdentity() {
  const identity = { script: 'metrics-check.mjs', plugin: null, plugin_version: null, source_sha: null };
  try {
    const manifest = JSON.parse(readFileSync(join(scriptDir, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    identity.plugin = manifest.name ?? null;
    identity.plugin_version = manifest.version ?? null;
    identity.source_sha = manifest.source_sha ?? null;
  } catch { /* fail open — identity stays null rather than blocking the report */ }
  return identity;
}

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
 *
 * Non-zero floor (2026-07-22): plain rounding sends anything below the first
 * bin's midpoint (0% < pct < 5%) to 0 filled blocks — a real-but-low signal
 * like 3% then renders identically to a hard 0%/absent state, with no visual
 * difference between "present but weak" and "nothing at all". No half-block
 * glyph exists anywhere else in this codebase to borrow (checked), so instead
 * of introducing a new one, any pct that is genuinely > 0 floors to at least
 * 1 filled block; only an exact 0% still renders fully empty.
 */
export function renderBar(pct, { failed = false } = {}) {
  if (failed) return FAILED_CHAR.repeat(BAR_WIDTH);
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  let filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(clamped / (100 / BAR_WIDTH))));
  if (filled === 0 && clamped > 0) filled = 1; // low-but-present must be visually distinct from zero/absent
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
// "accept-metrics-evidence-contract-first-slice"; REVISED the same day per
// Hale's slice-1 follow-up review "evidence classes still mixed" — capture
// volume/tier-mix is a mechanics/instrumentation fact, not regression
// evidence, and recognition/calibration are a measurement-READINESS gate,
// not regression either). Four honest classes, never blended into one
// verdict:
//   mechanics   — proven store mechanics + instrumentation health: round-trip
//                 proof, unit integrity, and telemetry capture counts (never
//                 a percentage — there is no valid eligible-hook denominator
//                 to divide by).
//   regression  — does retrieval itself work well against a reference
//                 answer key? Currently exactly one signal: a live gold-set
//                 snapshot run, honestly labeled provisional (the execution
//                 is live/proven, but the answer key is a small, Keel-
//                 authored, directional set with no preregistered pass
//                 threshold — a regression SNAPSHOT, not a passing GATE).
//   readiness   — is the measurement instrumentation itself ready to be
//                 trusted? Recognition signal + the calibration pool that
//                 gates it. Neither is retrieval regression or user benefit.
//   benefit     — does any of this measurably help the user? Nothing in this
//                 codebase answers that yet; the row says so plainly.
// ============================================================
export const SECTION = { MECHANICS: 'mechanics', REGRESSION: 'regression', READINESS: 'readiness', BENEFIT: 'benefit' };

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

// Renders a {count, by_code} bucket as a short CLOSED-vocabulary summary —
// e.g. "invalid-tier: 1, missing-tier: 2". Codes are safe to interpolate
// anywhere (rendered report, --json, a future package surface); the raw
// values that failed validation never are (Hale, 2026-07-22).
function formatRejectionCodes(bucket) {
  return Object.entries(bucket?.by_code || {}).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code}: ${n}`).join(', ');
}

export function checkLiveRetrievalProxy(project) {
  let events;
  try { events = loadRetrievalEvents(project, { allTime: true }); }
  catch (e) { return { available: false, reason: `could not read retrieval logs: ${String(e).slice(0, 120)}` }; }

  const report = buildRetrievalQualityReport(events);
  const rejected = report.rejected || { current: { count: 0, by_code: {} }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 0 };
  if (!report.total_events || !report.retrieval_events) {
    // Even with zero valid events, a nonzero rejected count is real evidence —
    // say so instead of reporting an absence indistinguishable from "nothing
    // ever ran" (2026-07-22, evidence-lifecycle slice 2).
    const reason = rejected.total > 0
      ? `no VALID retrieval events recorded — ${rejected.total} row(s) rejected (${[
          rejected.current.count > 0 ? `current-schema: ${formatRejectionCodes(rejected.current)}` : null,
          rejected.legacy.count > 0 ? `legacy: ${formatRejectionCodes(rejected.legacy)}` : null,
          rejected.other.count > 0 ? `unreadable: ${formatRejectionCodes(rejected.other)}` : null,
        ].filter(Boolean).join('; ')})`
      : 'no retrieval events recorded for this project yet';
    return { available: false, reason, rejected };
  }
  const td = report.tier_distribution;
  const topEscalation = (report.tier_escalation || [])[0] || null;
  return {
    available: true,
    days: report.sessions,
    retrievalEvents: report.retrieval_events,
    rejected,
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
  // Every read below comes off the SAME canonical four-class object --json
  // emits — mechanics/regression/readiness/benefit — so the render and the
  // machine output can never carry different taxonomies (Hale, 2026-07-22).
  const mech = out.mechanics || {};
  const store = mech.store || {};
  const readiness = out.readiness || {};

  // ---- MECHANICS: proven store mechanics only ----

  // 1. Round-trip proof — binary.
  const roundTrip = !!mech.probe?.round_trip;
  rows.push({
    section: SECTION.MECHANICS,
    label: 'Round-trip proof',
    pct: roundTrip ? 100 : 0,
    failed: !roundTrip,
    trust: TRUST.PROVEN_LIVE,
    value: roundTrip ? 'PASS' : 'FAIL',
  });

  // 2. Unit integrity — % of units with no attention-tier warning.
  const total = store.present ? (store.census?.total ?? 0) : 0;
  const attention = store.warning_triage?.attention ?? 0;
  const clean = Math.max(0, total - attention);
  const integrityPct = total > 0 ? (clean / total) * 100 : 0;
  rows.push({
    section: SECTION.MECHANICS,
    label: `Unit integrity (${total})`,
    pct: store.present ? integrityPct : 0,
    trust: TRUST.DIRECT,
    value: !store.present ? 'no store' : `${attention} warning${attention === 1 ? '' : 's'}`,
  });

  // 3. Telemetry capture — REPLACES the old "Retrieval-log coverage" percentage
  // (Hale, 2026-07-22 slice-1 revise: "rows÷days is an invalid denominator...
  // remove the gauge/percentage... show counts"). There is no eligible-hook
  // receipt to divide by, so this row is COUNTS ONLY — noGauge:true skips the
  // bar entirely rather than render a bracket that would silently imply a
  // valid percentage. Tier mix (previously its own "Live retrieval proxy"
  // regression row) folds in here too: it is a mechanism/instrumentation
  // diagnostic, not a regression claim, per Hale's item 3. Malformed-row
  // rejection counts (closed codes only) live here as well — capture health
  // is a mechanics concern, and the data now LIVES at mechanics.telemetry in
  // the canonical object (not regression.liveProxy — the old placement that
  // contradicted this very classification; Hale, 2026-07-22 acceptance
  // revise, item 1).
  const proxy = mech.telemetry || {};
  const rejected = proxy.rejected || { current: { count: 0, by_code: {} }, legacy: { count: 0, by_code: {} }, other: { count: 0, by_code: {} }, total: 0 };
  const rejectedNote = rejected.total > 0
    ? `; ${rejected.total} row(s) rejected (${[
        rejected.current.count > 0 ? `${rejected.current.count} current-schema` : null,
        rejected.legacy.count > 0 ? `${rejected.legacy.count} legacy` : null,
        rejected.other.count > 0 ? `${rejected.other.count} unreadable` : null,
      ].filter(Boolean).join(', ')})`
    : '; 0 rejected';
  let telemetryValue;
  if (proxy.available) {
    const worst = proxy.topEscalationTopic
      ? `; '${proxy.topEscalationTopic}' needed Tier 2+ ${proxy.topEscalationRate}% of the time`
      : '';
    telemetryValue = `${proxy.retrievalEvents} typed events / ${proxy.days} days; closure denominator unavailable; T1 ${proxy.t1Pct}%/T2 ${proxy.t2Pct}%/T3 ${proxy.t3Pct}% mix${worst}${rejectedNote}`;
  } else {
    telemetryValue = `${proxy.reason || 'no retrieval events recorded for this project yet'}${rejectedNote}`;
  }
  rows.push({
    section: SECTION.MECHANICS,
    label: 'Telemetry capture',
    pct: 0,
    trust: TRUST.DIRECT,
    noGauge: true,
    value: telemetryValue,
  });

  // 3b. Rich-context capture — VISIBLE ACTIVE STATE. The opt-in stream saves
  // literal query + delivered-context text locally, so when it is ON the user
  // must see one plain-language line saying so and how to turn it off. When
  // OFF (the default) NOTHING renders here (Hale metrics-evidence contract,
  // item 4; visible-active-state + independent disable).
  const rc = mech.rich_context || {};
  if (rc.enabled) {
    rows.push({
      section: SECTION.MECHANICS,
      label: 'Rich-context capture',
      pct: 0,
      trust: TRUST.DIRECT,
      noGauge: true,
      value: `ON for this project — full query and delivered-context text is being saved locally (${rc.rows} row(s) / ${rc.days} day(s)); turn off by removing "rich_context_capture": true from this project's workspace.json`,
    });
  }

  // ---- RETRIEVAL REGRESSION: does retrieval work well against a reference
  // answer key? Currently exactly one signal exists — a live gold-set
  // snapshot — and it is labeled `provisional`, never `proven-live`: the
  // EXECUTION is genuinely live (retrieveContext + buildFinalContextPack run
  // for real, this run), but the reference set is a small, Keel-authored,
  // directional answer key with no preregistered pass/fail threshold. A live
  // run does not independently validate its own expected answers (Hale,
  // 2026-07-22 slice-1 revise, item 5) — this is a regression SNAPSHOT, not a
  // passing GATE. ----

  // 4. Gold-set snapshot — real regression evidence when a project has a
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
      label: `Gold-set snapshot (n=${gold.n})`,
      pct: r3Pct,
      trust: TRUST.PROVISIONAL,
      value: `execution proven-live (retrieveContext + buildFinalContextPack, this run); reference authority provisional (Keel-authored, directional, n=${gold.n}, no preregistered pass threshold); delivered top-3 R@3 ${r3Pct}%${extra ? `; ${extra}` : ''}`,
    });
  } else {
    rows.push({
      section: SECTION.REGRESSION,
      label: 'Gold-set snapshot',
      pct: 0,
      trust: TRUST.NOT_EVALUATED,
      value: gold.reason || 'no gold-set regression evidence recorded for this project',
    });
  }

  // ---- MEASUREMENT READINESS: is the instrumentation itself ready to be
  // trusted? Neither of these two rows is retrieval regression or user
  // benefit — recognition is a provisional need/failure classifier, and
  // calibration is the readiness gate that governs it (Hale, 2026-07-22
  // slice-1 revise, item 4). ----

  // 5. Recognition signal — INVERTED on purpose: the underlying number is a
  // FAILURE rate (rec-fail-tier-0), so a bigger number is worse. The bar shows
  // (100 - rate) so a fuller bar always reads as "healthier" like every other
  // row here, even though the raw metric it's built from is a failure rate.
  const recognition = parseRecognitionSignal(readiness.recognition_signal?.text);
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
  rows.push({ section: SECTION.READINESS, label: 'Recognition signal', pct: recPct, trust: TRUST.PROVISIONAL, value: recValue });

  // 6. Calibration pool — labeled turns / 100, straightforward. This is the
  // classifier's own readiness gate for the recognition signal above.
  const cal = readiness.calibration || {};
  const labeled = cal.available ? (cal.labeled_count ?? 0) : 0;
  const minNeeded = cal.available ? (cal.min_needed ?? 100) : 100;
  const calPct = minNeeded > 0 ? Math.min(100, (labeled / minNeeded) * 100) : 0;
  rows.push({
    section: SECTION.READINESS,
    label: 'Calibration pool',
    pct: calPct,
    trust: TRUST.DIRECT,
    value: `${labeled}/${minNeeded} labeled`,
  });

  // ---- USER BENEFIT: does any of this measurably help the user? Nothing in
  // this codebase answers that yet — no matched memory-on/off comparison, no
  // independent outcome labels. Say so plainly; never imply the other
  // classes cover it. The row sources the canonical benefit class directly
  // (same status word, same reason string) — never a parallel copy. ----
  const benefit = out.benefit || {};
  rows.push({
    section: SECTION.BENEFIT,
    label: 'Matched comparison',
    pct: 0,
    trust: benefit.status || TRUST.NOT_EVALUATED,
    value: benefit.reason || 'no matched memory-on/off comparison exists — nothing currently measures whether this helps',
  });

  return rows;
}

// ============================================================
// Narrative — 1-3 sentences. Every number/label explained in the sentence it
// appears in; leads with the failure first when DEGRADED; names what's
// provisional vs proven otherwise.
// ============================================================

export function buildNarrative(out) {
  // Same canonical four-class object the renderer and --json use — never a
  // parallel view of the data.
  const mech = out.mechanics || {};
  const store = mech.store || {};
  const attention = store.warning_triage?.attention ?? 0;
  const cal = out.readiness?.calibration || {};
  const labeled = cal.available ? (cal.labeled_count ?? 0) : 0;
  const minNeeded = cal.available ? (cal.min_needed ?? 100) : 100;
  const recognition = parseRecognitionSignal(out.readiness?.recognition_signal?.text);

  // A mechanics hard-fail leads with the failure and the single next action —
  // "instead of anything else" (SKILL.md §Step 3) — so it does NOT get padded
  // with the regression/benefit sentences below; those evidence classes don't
  // matter until mechanics itself is trustworthy again.
  if (mech.status === 'DEGRADED') {
    const failures = [];
    if (!mech.probe?.round_trip) failures.push('the live round-trip probe failed');
    if (store.present && store.schema?.exit !== 0) failures.push('the schema validator did not exit clean');
    if ((store.integrity?.fail ?? 0) > 0) failures.push(`the validator found ${store.integrity.fail} integrity failure(s)`);
    const lead = failures.length ? failures.join(', and ') : 'a hard check failed';
    return `DEGRADED — ${lead}; fix that before trusting anything else here.`;
  }

  if (mech.status === 'MACHINERY-WORKING-NO-STORE') {
    return 'The plugin machinery round-trips clean on a scratch store, but this project has no _memories/ store yet — there is nothing here to measure.';
  }

  // s1 — mechanics + telemetry capture (an instrumentation fact, not
  // regression evidence — Hale, 2026-07-22 slice-1 revise; the data lives at
  // mechanics.telemetry in the canonical object).
  const proxy = mech.telemetry || {};
  let s1 = 'Mechanics are proven and working';
  if (proxy.available) {
    s1 += `; telemetry capture shows ${proxy.retrievalEvents} typed events across ${proxy.days} days (${proxy.t1Pct}%/${proxy.t2Pct}%/${proxy.t3Pct}% T1/T2/T3 mix)`;
  }
  s1 += attention > 0 ? `, though ${attention} warning${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} a look.` : '.';

  // s2 — retrieval regression (a provisional SNAPSHOT, never a passing gate)
  // plus measurement readiness (recognition + calibration): related but
  // distinct evidence classes, both honestly bounded, combined into one
  // sentence to stay within the 1-3 sentence cap.
  const gold = out.regression?.gold || {};
  const parts = [];
  if (gold.available) {
    parts.push(`a provisional gold-set snapshot (n=${gold.n}, Keel-authored, directional, no pass threshold) puts delivered top-3 recall at ${Math.round((gold.context3_r3 ?? 0) * 100)}% — a regression snapshot, not a passing gate`);
  } else {
    parts.push('no gold-set regression snapshot exists for this project yet');
  }
  if (recognition.available) {
    const trend = recognition.arrow === '↑' ? 'down' : recognition.arrow === '↓' ? 'up' : 'steady';
    const worthLook = recognition.arrow === '↑' ? ' (worth a look)' : '';
    parts.push(`measurement readiness: recognition is trending ${trend} this session${worthLook}, and the classifier stays unofficial until the calibration pool clears ${minNeeded} labeled turns — currently ${labeled}`);
  } else {
    parts.push(`measurement readiness: recognition has no signal yet this session, and the classifier stays unofficial until the calibration pool clears ${minNeeded} labeled turns — currently ${labeled}`);
  }
  const s2Body = parts.join('; ') + '.';
  const s2 = `Retrieval regression: ${s2Body.charAt(0).toUpperCase()}${s2Body.slice(1)}`;

  const s3 = "Whether any of this actually helps you get better answers hasn't been measured yet — no matched memory-on/off comparison exists.";

  return `${s1} ${s2} ${s3}`;
}

// ============================================================
// Full report render — verdict heading, visual block, narrative.
// ============================================================

// Display text for the MECHANICS heading only — 'HEALTHY' replaces the old
// 'WORKING' wording per Hale's slice-1 revise (matching his exact target
// shape: "MECHANICS: HEALTHY"). The internal status KEYS are unchanged
// ('WORKING'/'WORKING-WITH-CAVEATS'/...), but the field now lives at
// mechanics.status in the canonical object — scoped to mechanics exactly like
// this heading, never an umbrella top-level `verdict` (Hale, 2026-07-22
// acceptance revise, item 4).
const VERDICT_DISPLAY = {
  'WORKING': 'HEALTHY',
  'WORKING-WITH-CAVEATS': 'HEALTHY — with caveats',
  'DEGRADED': 'DEGRADED',
  'MACHINERY-WORKING-NO-STORE': 'MACHINERY WORKING, NO STORE',
};

const LABEL_WIDTH = 26;
const TRUST_WIDTH = 14;
// Width of the "[bar] " segment every gauged row renders ('[' + BAR_WIDTH + ']' + ' ').
const GAUGE_WIDTH = BAR_WIDTH + 3;

// Section headers below the mechanics heading — each names its OWN evidence
// class and its OWN honest status word, so no single word at the top can be
// misread as covering evidence three sections down (Hale, 2026-07-22
// slice-1 revise: match this shape exactly).
const SECTION_HEADER = {
  [SECTION.REGRESSION]: 'RETRIEVAL REGRESSION: PROVISIONAL',
  [SECTION.READINESS]: 'MEASUREMENT READINESS',
  [SECTION.BENEFIT]: 'USER BENEFIT: NOT EVALUATED',
};

export function renderReport(out, { workspaceName } = {}) {
  const name = workspaceName || basename(out.project || process.cwd());
  const rows = computeRows(out);
  const lines = [];
  lines.push(`MECHANICS: ${VERDICT_DISPLAY[out.mechanics?.status] || out.mechanics?.status || 'UNKNOWN'}`);
  lines.push('');
  lines.push(`CORE Memory Health — ${name}`);
  lines.push('');

  const renderRow = (row) => {
    // noGauge rows (e.g. Telemetry capture) render NO bracket/bar at all —
    // there is no valid denominator to turn into a percentage, so the space
    // stays blank rather than imply one (Hale, 2026-07-22: "remove the
    // gauge/percentage... show counts").
    const gauge = row.noGauge ? ' '.repeat(GAUGE_WIDTH) : `[${renderBar(row.pct, { failed: row.failed })}] `;
    return `${row.label.padEnd(LABEL_WIDTH)}${gauge}${row.trust.padEnd(TRUST_WIDTH)} ${row.value}`;
  };

  const bySection = { [SECTION.MECHANICS]: [], [SECTION.REGRESSION]: [], [SECTION.READINESS]: [], [SECTION.BENEFIT]: [] };
  for (const row of rows) (bySection[row.section] ||= []).push(row);

  for (const row of bySection[SECTION.MECHANICS]) lines.push(renderRow(row));

  for (const section of [SECTION.REGRESSION, SECTION.READINESS, SECTION.BENEFIT]) {
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
  // THE canonical object. Its top-level structure IS the four-evidence-class
  // taxonomy (mechanics/regression/readiness/benefit) plus identity and run
  // metadata — the renderer consumes this exact object and --json emits it
  // verbatim, so machine and human views share one taxonomy by construction
  // (Hale, 2026-07-22 acceptance revise). No umbrella top-level verdict: the
  // machine verdict is mechanics.status, scoped like the rendered heading.
  const out = {
    schema_version: METRICS_REPORT_SCHEMA_VERSION, // always OUR stamp (record-retrieval-event.mjs convention)
    producer: producerIdentity(),
    generated_at: new Date().toISOString(),
    project: cwd,
    mechanics: { status: null, probe: {}, store: {}, telemetry: {}, rich_context: {} },
    regression: { gold: {} },
    readiness: { recognition_signal: null, calibration: {} },
    benefit: {
      status: TRUST.NOT_EVALUATED,
      reason: 'no matched memory-on/off comparison exists — nothing currently measures whether this helps',
    },
    caveats: [],
  };
  const mech = out.mechanics;

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
    mech.probe.validate = { pass: validate.code === 0, exit: validate.code };

    const hit = run('retrieve-context.mjs', [scratch, TOKEN, '--pack']);
    mech.probe.retrieve = { pass: hit.out.includes('probe-live-fact'), evidence: hit.out.trim().split('\n').slice(0, 3).join(' | ').slice(0, 200) };

    const suppressed = run('retrieve-context.mjs', [scratch, RETIRED_TOKEN]);
    mech.probe.suppress_retired = { pass: !suppressed.out.includes('probe-retired-fact'), evidence: suppressed.out.trim() ? 'substitutes only' : 'zero output (retired never indexed)' };

    mech.probe.round_trip = mech.probe.validate.pass && mech.probe.retrieve.pass && mech.probe.suppress_retired.pass;
  } catch (e) {
    mech.probe.round_trip = false; out.caveats.push(`probe crashed: ${String(e).slice(0, 120)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // ---- 2. THIS-STORE HEALTH (read-only) ----
  const store = join(cwd, '_memories');
  if (!existsSync(store)) {
    mech.store.present = false; out.caveats.push('no _memories/ store in this project');
  } else {
    mech.store.present = true;
    const parseCounts = (s) => {
      const m = s.match(/PASS:\s*(\d+)\s+WARN:\s*(\d+)\s+FAIL:\s*(\d+)/);
      return m ? { pass: +m[1], warn: +m[2], fail: +m[3] } : null;
    };
    const schema = run('check-units.mjs', ['--store', cwd, '--schema']);
    mech.store.schema = { exit: schema.code, ...parseCounts(schema.out) };
    const integ = run('check-units.mjs', ['--store', cwd, '--integrity']);
    mech.store.integrity = { exit: integ.code, ...parseCounts(integ.out) };

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
    mech.store.warning_triage = triage;

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
    mech.store.census = census;

    // retrieval-log RAW capture presence — a simple "is anything being
    // written at all" count (files/rows), deliberately with NO schema
    // judgement of its own. Schema validation, rejection counting, and the
    // rendered Telemetry-capture row all source from checkLiveRetrievalProxy()
    // below instead, which reuses analyze-retrieval-quality.mjs's loadEvents()
    // /buildReport() — the ONE canonical validator and rejection-counter.
    // Keeping a second, independent per-row validity check here (as an
    // earlier version of this code did) is exactly the "weaker parallel
    // schema" anti-pattern Hale's slice-2 review flagged; this scan no longer
    // attempts one (2026-07-22).
    let rows = 0, files = 0;
    const sessions = join(cwd, '_sessions');
    if (existsSync(sessions)) {
      for (const d of readdirSync(sessions)) {
        const log = join(sessions, d, 'retrieval-log.jsonl');
        if (!existsSync(log)) continue;
        files++;
        for (const line of readFileSync(log, 'utf8').split('\n')) {
          if (line.trim()) rows++;
        }
      }
    }
    mech.store.retrieval_log = { files, rows,
      note: 'raw line/file count only — capture presence, not schema validity or retrieval correctness (see the Telemetry capture row for the validated, rejection-counted breakdown)' };

    // recognition / trend signal state — a MEASUREMENT-READINESS fact, so it
    // lives in the readiness class (not under the mechanics store — the old
    // placement that contradicted the render's classification; Hale,
    // 2026-07-22 acceptance revise, item 2).
    try {
      const wsId = JSON.parse(readFileSync(join(cwd, 'workspace.json'), 'utf8')).workspace_id;
      const sig = join(home, '.core/workspaces', wsId, 'metrics/orient-signal.txt');
      if (existsSync(sig)) {
        out.readiness.recognition_signal = { text: readFileSync(sig, 'utf8').trim(), age_hours: Math.round((Date.now() - statSync(sig).mtimeMs) / 3.6e6) };
      }
    } catch { /* no workspace pointer — skip */ }

    // memory-processing recency
    try {
      const pm = JSON.parse(readFileSync(join(store, '_pm-state.json'), 'utf8'));
      mech.store.last_memory_processing = pm.last_run || null;
    } catch { /* absent is fine */ }
  }

  // ---- 3. CALIBRATION POOL (read-only) — measurement-readiness class ----
  out.readiness.calibration = checkCalibrationPool(cwd, { home });

  // ---- 4. RETRIEVAL REGRESSION (read-only + one live product-path run) ----
  // The regression class carries the gold-set snapshot ONLY. The live
  // telemetry/tier-mix data is a mechanics/instrumentation fact and lives at
  // mechanics.telemetry (Hale, 2026-07-22 acceptance revise, item 1 — the old
  // regression.liveProxy placement contradicted the render's classification).
  out.regression.gold = await checkGoldRegression(cwd);
  mech.telemetry = checkLiveRetrievalProxy(cwd);
  // Opt-in rich-context capture state — a mechanics/instrumentation fact. Only
  // rendered when the stream is ON (the visible-active-state line); silent when
  // off, which is the default (Hale metrics-evidence contract, item 4).
  mech.rich_context = richContextStats(cwd);

  // ---- mechanics status: hard evidence only; routine upkeep never demotes
  // it. Scoped to mechanics (mech.status), never an umbrella claim. ----
  const attention = mech.store.warning_triage?.attention ?? 0;
  if (mech.probe.round_trip && mech.store.present && mech.store.schema?.exit === 0 && (mech.store.integrity?.fail ?? 1) === 0) {
    mech.status = attention > 0 ? 'WORKING-WITH-CAVEATS' : 'WORKING';
  } else if (mech.probe.round_trip && !mech.store.present) {
    mech.status = 'MACHINERY-WORKING-NO-STORE';
  } else {
    mech.status = 'DEGRADED';
  }
  if (attention > 0) out.caveats.push(`${attention} warning(s) need a look: ${mech.store.warning_triage.attention_items.join('; ')}`);
  if (mech.store.warning_triage && (mech.store.warning_triage.informational + mech.store.warning_triage.routine_upkeep) > 0) {
    mech.store.upkeep_note = `${mech.store.warning_triage.routine_upkeep} routine-upkeep warns (agent fixes at next hygiene pass) + ${mech.store.warning_triage.informational} informational (by design) — nothing for the user`;
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
  // --json emits EXACTLY ONE JSON document and nothing else (Hale item 8,
  // 2026-07-23): the human report and the JSON on one stream made saved stdout
  // invalid JSON, so `render-metrics-artifact --json-in` could not consume the
  // real product output. Default (no flag) prints the human report.
  if (wantsJson) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else process.stdout.write(out.report + '\n');
  process.exit(0);
}
