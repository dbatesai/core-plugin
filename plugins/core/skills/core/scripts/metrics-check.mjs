#!/usr/bin/env node
/**
 * metrics-check.mjs — evidence-first memory health check for a CORE project.
 *
 * Script resolution follows the metrics-package.mjs pattern exactly: this
 * file lives beside check-units.mjs / retrieve-context.mjs / calibrate-
 * classifier.mjs in the shared `skills/core/scripts/` directory, so it calls
 * them by co-location (`scriptDir`-relative).
 *
 * Reports THREE SEPARATE, HONESTLY-LABELED EVIDENCE CLASSES (never blended
 * into one umbrella verdict; see the "Evidence-class contract" comment below
 * for the full rationale):
 *
 *  1. MECHANICS (proven-live + direct): the live round-trip PROOF — builds a
 *     throwaway scratch store, writes synthetic units through the plugin's
 *     own scripts, and proves the full write → validate → index → retrieve →
 *     suppress round trip END TO END, fresh, on every run — plus this
 *     project's real validator counts, unit census, and plain-count telemetry
 *     capture (from analyze-retrieval-quality.mjs's real retrieval-log rows).
 *     Real, proven evidence that the STORE MECHANICS work. Says nothing about
 *     retrieval quality.
 *  2. RETRIEVAL REGRESSION (provisional / not-evaluated): does retrieval
 *     itself work well against a reference answer key? Exactly one signal —
 *     a LIVE gold-set Recall@K run via retrieval-harness.mjs against this
 *     project's own pre-registered gold set when one exists (genuinely
 *     exercised this run, on the real product functions — not a simulator);
 *     an honest absence otherwise.
 *  3. MEASUREMENT READINESS (provisional / direct): is the instrumentation
 *     itself ready to be trusted? The recognition signal and the calibration
 *     pool that gates it.
 *
 * Output (default): the rendered report — a MECHANICS-scoped verdict heading,
 * sectioned blocks of 10-char bar gauges (one gauge per row, one section per
 * evidence class), and a 1-3 sentence narrative that speaks to all the
 * classes, never just the first. Pass --json to emit EXACTLY the canonical data
 * object as a single JSON document instead of the report (nothing else on the
 * stream, so the output is valid JSON that render-metrics-artifact --json-in can
 * consume directly). Its top-level structure IS the three-evidence-class
 * taxonomy — the machine consumer receives the SAME taxonomy the human report
 * renders, never a different one:
 *
 *   schema_version  — METRICS_REPORT_SCHEMA_VERSION, stamped by this script
 *   producer        — { script, plugin, plugin_version, source_sha } from the
 *                     plugin manifest (the same identity convention the
 *                     manifest itself carries)
 *   mechanics       — { status, probe, store, telemetry }: the mechanics-
 *                     scoped machine verdict plus everything mechanics-class
 *   regression      — { gold }: the gold-set snapshot ONLY
 *   readiness       — { recognition_signal, calibration }
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
import { newestRegisteredRound, measureRound } from './self-test-round.mjs';
import { loadEvents as loadRetrievalEvents, buildReport as buildRetrievalQualityReport } from './analyze-retrieval-quality.mjs';
import { turnCaptureStats } from './turn-capture.mjs';
import { latestScorecards } from './scorecard.mjs';
import { evaluateTripwires } from './metrics-tripwires.mjs';

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
 * Non-zero floor: plain rounding sends anything below the first
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
// Trust vocabulary
// ============================================================

export const TRUST = {
  PROVEN_LIVE: 'proven-live', DIRECT: 'direct', PROXY: 'proxy',
  PROVISIONAL: 'provisional', NOT_EVALUATED: 'not-evaluated',
};

// ============================================================
// Evidence-class contract — three honest classes, never blended into one
// verdict:
//   mechanics   — proven store mechanics + instrumentation health: round-trip
//                 proof, unit integrity, and telemetry capture counts (never
//                 a percentage — there is no valid eligible-hook denominator
//                 to divide by).
//   regression  — does retrieval itself work well against a reference
//                 answer key? Exactly one signal: a live gold-set
//                 snapshot run, honestly labeled provisional (the execution
//                 is live/proven, but the answer key is a small, agent-
//                 authored, directional set with no preregistered pass
//                 threshold — a regression SNAPSHOT, not a passing GATE).
//   readiness   — is the measurement instrumentation itself ready to be
//                 trusted? Recognition signal + the calibration pool that
//                 gates it. Neither is retrieval regression.

// ============================================================
export const SECTION = { MECHANICS: 'mechanics', REGRESSION: 'regression', READINESS: 'readiness' };

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
// Calibration-pool check. Reuses calibrate-classifier.mjs's own
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
  // Prefer a frozen blind self-test round when one exists — it is the honest
  // instrument: pre-registered, includes the unanswerable/false-premise classes,
  // and carries the old-vs-new overfitting detector. The static legacy gold set
  // is the fallback only when no round has been registered.
  const round = newestRegisteredRound(project);
  if (round) {
    try {
      // measureRound is read-only — /metrics must not litter the round dir.
      const { record } = await measureRound(project, round.round);
      const byKind = {};
      for (const [k, v] of Object.entries(record.breakdown.byKind || {})) byKind[k] = v.r10;
      return {
        available: true,
        source: `self-test round ${record.round}`,
        n: record.n_queries,
        storeUnits: record.store_units,
        // The self-test headline is the ranking-arm R@10; keep the same field
        // names the render already consumes so the row renders unchanged.
        context3_r3: record.breakdown.context3_r3,
        ranking_r10: record.headline,
        bm25_r10: record.results?.bm25?.recall?.[10] ?? null,
        forbidden_rate: record.breakdown.forbiddenRate,
        by_kind: byKind,
        old_vs_new_delta: record.old_vs_new?.delta ?? null,
        prior_mean: record.old_vs_new?.prior_mean ?? null,
        stale_gold: record.stale_gold || [],
      };
    } catch (e) {
      return { available: false, reason: `self-test round ${round.round} run failed: ${String(e && e.message || e).slice(0, 160)}` };
    }
  }
  if (!existsSync(goldPath)) {
    return { available: false, reason: 'no self-test round and no _tests/retrieval-gold-set.json in this project — nothing exercises Recall@K here yet' };
  }
  try {
    const out = await runHarness(project, goldPath);
    const context3R3 = out.results.context3?.recall?.[3] ?? null;
    const rankingR10 = out.results.ranking?.recall?.[10] ?? null;
    const bm25R10 = out.results.bm25?.recall?.[10] ?? null;
    return {
      available: true,
      source: 'legacy static gold set',
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
// PASS/FAIL. Read-only, no new capture.
// ============================================================

// Renders a {count, by_code} bucket as a short CLOSED-vocabulary summary —
// e.g. "invalid-tier: 1, missing-tier: 2". Codes are safe to interpolate
// anywhere (rendered report, --json, a future package surface); the raw
// values that failed validation never are.
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
    // ever ran".
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
  // Every read below comes off the SAME canonical three-class object --json
  // emits — mechanics/regression/readiness — so the render and the
  // machine output can never carry different taxonomies.
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

  // 3. Telemetry capture — COUNTS ONLY: rows÷days is an invalid denominator
  // (there is no eligible-hook receipt to divide by), so noGauge:true skips
  // the bar entirely rather than render a bracket that would silently imply a
  // valid percentage. Tier mix folds in here too: it is a mechanism/
  // instrumentation diagnostic, not a regression claim. Malformed-row
  // rejection counts (closed codes only) live here as well — capture health
  // is a mechanics concern, and the data lives at mechanics.telemetry in
  // the canonical object.
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

  // 3b. Rich-context capture — VISIBLE ACTIVE STATE. The default-ON stream
  // saves literal query + delivered-context text locally, so its state must
  // always render in one plain-language line (visible-active-state +
  // independent disable).
  const tc = mech.turn_capture || {};
  {
    // Because the stream IS on unless the user acted, the ON state and
    // its off-switches must always render, and the OFF state renders too so an
    // opted-out user sees their choice took effect.
    const health = tc.health || {};
    rows.push({
      section: SECTION.MECHANICS,
      label: 'Turn capture (evidence)',
      pct: 0,
      trust: TRUST.DIRECT,
      noGauge: true,
      value: tc.enabled
        ? `ON — each turn's prompt and the delivered memory context are saved locally so retrieval quality can be graded later (never exported, auto-deleted after 30 days): ${tc.rows || 0} row(s) / ${tc.days || 0} day(s), ${health.failures || 0} of ${health.attempts || 0} writes failed. Turn off with CORE_TURN_CAPTURE=0 or "turn_capture": false in this project's workspace.json (CORE_METRICS_ENABLED=0 turns off all local capture).`
        : 'OFF — turn capture is disabled for this project, so hindsight grading of retrieval quality has no evidence to work from.',
    });
  }

  // ---- RETRIEVAL REGRESSION: does retrieval work well against a reference
  // answer key? Exactly one signal exists — a live gold-set
  // snapshot — and it is labeled `provisional`, never `proven-live`: the
  // EXECUTION is genuinely live (retrieveContext + buildFinalContextPack run
  // for real, this run), but the reference set is a small, agent-authored,
  // directional answer key with no preregistered pass/fail threshold. A live
  // run does not independently validate its own expected answers — this is a
  // regression SNAPSHOT, not a passing GATE. ----

  // 4. Gold-set snapshot — real regression evidence when a project has a
  // pre-registered gold set; an honest absence otherwise.
  const gold = out.regression?.gold || {};
  if (gold.available) {
    const r3Pct = Math.round((gold.context3_r3 ?? 0) * 100);
    const rankingPct = gold.ranking_r10 != null ? Math.round(gold.ranking_r10 * 100) : null;
    const bm25Pct = gold.bm25_r10 != null ? Math.round(gold.bm25_r10 * 100) : null;
    const fromRound = gold.source && gold.source.startsWith('self-test');
    const extra = [
      rankingPct != null ? `ranking R@10 ${rankingPct}%` : null,
      bm25Pct != null ? `bm25 R@10 ${bm25Pct}%` : null,
    ].filter(Boolean).join(', ');
    // A frozen self-test round earns the richer, more honest line: the per-kind
    // breakdown (including the "nothing stored about that" trap-leak rate) and
    // the old-vs-new delta that watches for overfitting. Still provisional —
    // the answer key is self-authored.
    let selfTestBits = '';
    if (fromRound) {
      const kinds = Object.entries(gold.by_kind || {})
        .map(([k, v]) => `${k} ${v == null ? '—' : Math.round(v * 100) + '%'}`).join(', ');
      const trap = gold.forbidden_rate != null ? `; unanswerable trap-leak ${Math.round(gold.forbidden_rate * 100)}% (lower better)` : '';
      const delta = gold.old_vs_new_delta != null
        ? `; old-vs-new delta ${gold.old_vs_new_delta >= 0 ? '+' : ''}${Math.round(gold.old_vs_new_delta * 100)}pts (overfitting detector)`
        : '; old-vs-new delta not available yet (needs a prior round)';
      selfTestBits = `${kinds ? `; by kind: ${kinds}` : ''}${trap}${delta}`;
    }
    const provenance = fromRound
      ? `blind pre-registered self-test round (${gold.source.replace('self-test round ', 'round ')}), directional, n=${gold.n}, no preregistered pass threshold`
      : `static legacy set, directional, n=${gold.n}, no preregistered pass threshold`;
    rows.push({
      section: SECTION.REGRESSION,
      label: `Gold-set snapshot (n=${gold.n})`,
      pct: r3Pct,
      trust: TRUST.PROVISIONAL,
      value: `execution proven-live (retrieveContext + buildFinalContextPack, this run); reference authority provisional (${provenance}); delivered top-3 R@3 ${r3Pct}%${extra ? `; ${extra}` : ''}${selfTestBits}`,
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
  // calibration is the readiness gate that governs it. ----

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

  return rows;
}

// ============================================================
// Narrative — 1-3 sentences. Every number/label explained in the sentence it
// appears in; leads with the failure first when DEGRADED; names what's
// provisional vs proven otherwise.
// ============================================================

export function buildNarrative(out) {
  // Same canonical three-class object the renderer and --json use — never a
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
  // regression evidence; the data lives at mechanics.telemetry in the
  // canonical object).
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
    const src = gold.source && gold.source.startsWith('self-test')
      ? `blind pre-registered ${gold.source}` : 'directional static gold set';
    const deltaBit = (gold.source && gold.source.startsWith('self-test') && gold.old_vs_new_delta != null)
      ? `, and the old-vs-new delta (the overfitting watch) sits at ${gold.old_vs_new_delta >= 0 ? '+' : ''}${Math.round(gold.old_vs_new_delta * 100)} points`
      : '';
    parts.push(`a provisional gold-set snapshot (n=${gold.n}, ${src}, directional, no pass threshold) puts delivered top-3 recall at ${Math.round((gold.context3_r3 ?? 0) * 100)}% — a regression snapshot, not a passing gate${deltaBit}`);
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

  return `${s1} ${s2}`;
}

// ============================================================
// Full report render — verdict heading, visual block, narrative.
// ============================================================

// Display text for the MECHANICS heading only — maps the internal status
// KEYS ('WORKING'/'WORKING-WITH-CAVEATS'/...) to their display wording. The
// field lives at mechanics.status in the canonical object — scoped to
// mechanics exactly like this heading, never an umbrella top-level `verdict`.
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
// misread as covering evidence three sections down.
const SECTION_HEADER = {
  [SECTION.REGRESSION]: 'RETRIEVAL REGRESSION: PROVISIONAL',
  [SECTION.READINESS]: 'MEASUREMENT READINESS',
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
    // stays blank rather than imply one.
    const gauge = row.noGauge ? ' '.repeat(GAUGE_WIDTH) : `[${renderBar(row.pct, { failed: row.failed })}] `;
    return `${row.label.padEnd(LABEL_WIDTH)}${gauge}${row.trust.padEnd(TRUST_WIDTH)} ${row.value}`;
  };

  const bySection = { [SECTION.MECHANICS]: [], [SECTION.REGRESSION]: [], [SECTION.READINESS]: [] };
  for (const row of rows) (bySection[row.section] ||= []).push(row);

  for (const row of bySection[SECTION.MECHANICS]) lines.push(renderRow(row));

  for (const section of [SECTION.REGRESSION, SECTION.READINESS]) {
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
  // THE canonical object. Its top-level structure IS the three-evidence-class
  // taxonomy (mechanics/regression/readiness) plus identity and run
  // metadata — the renderer consumes this exact object and --json emits it
  // verbatim, so machine and human views share one taxonomy by construction.
  // No umbrella top-level verdict: the
  // machine verdict is mechanics.status, scoped like the rendered heading.
  const out = {
    schema_version: METRICS_REPORT_SCHEMA_VERSION, // always OUR stamp (record-retrieval-event.mjs convention)
    producer: producerIdentity(),
    generated_at: new Date().toISOString(),
    project: cwd,
    mechanics: { status: null, probe: {}, store: {}, telemetry: {}, turn_capture: {} },
    regression: { gold: {} },
    readiness: { recognition_signal: null, calibration: {} },
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
    // A second, independent per-row validity check here would be a weaker
    // parallel schema; this scan deliberately attempts none.
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
    // lives in the readiness class, matching the render's classification.
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
  // mechanics.telemetry, matching the render's classification.
  out.regression.gold = await checkGoldRegression(cwd);
  mech.telemetry = checkLiveRetrievalProxy(cwd);
  // Turn-capture evidence-stream state (default-ON) — a
  // mechanics/instrumentation fact. Always rendered: ON shows the disclosure +
  // off-switches; OFF confirms the user's opt-out took effect.
  mech.turn_capture = turnCaptureStats(cwd);

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
// Answer-shaped default view
// ============================================================
//
// The `/metrics` DEFAULT: three outcome questions, one sentence each,
// the single number that matters per line, a trend word — sourced from the
// latest PINNED scorecard and the tripwire state. Presentation only: no fresh
// computation, no live re-scoring (that's exactly the determinism split — the
// user-facing view reads stored conclusions). The full instrument panel stays
// behind `/metrics full`.

/** Everything the answer view reads, gathered from stored surfaces only. */
export function gatherAnswers(projectDir) {
  let cards = [];
  try { cards = latestScorecards(projectDir, 2); } catch { cards = []; }
  let tripwires = { healthy: true, tripped: [] };
  try { tripwires = evaluateTripwires(projectDir); } catch { /* silence is honest here */ }
  let capture = { enabled: true };
  try { capture = turnCaptureStats(projectDir); } catch { /* default shape above */ }
  return { project: projectDir, cards, tripwires, capture };
}

function pct(x) { return `${Math.round(x * 100)}%`; }

/** Render the three-question view. Pure; takes gatherAnswers() output. */
export function renderAnswerView({ project, cards, tripwires, capture }) {
  const newest = cards[0] || null;
  const prev = cards[1] || null;
  const name = String(project || '').split(/[\\/]/).filter(Boolean).pop() || 'this project';
  const checked = newest ? newest.ts.slice(0, 16).replace('T', ' ') + ' UTC' : 'never';
  const L = [];
  L.push(`Memory health — ${name}`.padEnd(50) + `checked ${checked}`);
  L.push('');

  const h = newest && newest.hindsight;
  const judged = h ? h.judged_turns : 0;
  const captureOff = capture && capture.enabled === false;
  // Below this many graded turns the rates are noise, not a verdict. A handful
  // of turns can read 100% and mean nothing, so the answer states the thinness
  // instead of a bare YES.
  const MIN_JUDGED = 20;
  const thin = judged > 0 && judged < MIN_JUDGED;
  const thinNote = `too little evidence yet — only ${judged} graded turn${judged === 1 ? '' : 's'} so far`;

  // Q1 — storing the right memories (storage-gap rate, mechanical grade).
  let storing;
  if (captureOff) {
    storing = 'not measured — turn capture is off for this project, so nothing records what each conversation needed.';
  } else if (!judged) {
    storing = 'not yet measured — evidence is being captured; grading runs with regular maintenance.';
  } else if (thin) {
    const gaps = h.storage_gap;
    storing = `${thinNote}${gaps ? ` (${gaps} of them needed something no stored memory contains)` : ''}`;
  } else {
    const gaps = h.storage_gap;
    const verdict = gaps === 0 ? 'YES' : gaps / judged <= 0.10 ? 'MOSTLY' : 'NO';
    storing = `${verdict} — ${gaps === 0 ? `no gaps found in ${judged} graded turns` : `${gaps} of ${judged} graded turns needed something no stored memory contains`}`;
  }
  L.push(`Is it storing the right memories?    ${storing}`);

  // Q2 — loading them when needed (hit rate, mechanical grade).
  let loading;
  if (captureOff) {
    loading = 'not measured — turn capture is off (see above).';
  } else if (!judged) {
    loading = 'not yet measured — grading needs captured evidence first.';
  } else if (thin) {
    loading = `${thinNote} — ${h.hindsight_miss} missed, ${h.noise} noisy across those turns`;
  } else {
    const rate = h.hit_right / judged;
    const verdict = rate >= 0.95 ? 'YES' : rate >= 0.75 ? 'MOSTLY' : 'NO';
    loading = `${verdict} (mechanical grade) — right memories ${pct(rate)} of turns; ${h.hindsight_miss} missed, ${h.noise} noisy`;
  }
  L.push(`Is it loading them when you need?    ${loading}`);

  // Q3 — the blind self-test, with a trend word vs the previous pinned card.
  let blind;
  const head = newest && newest.self_test && newest.self_test.headline;
  if (typeof head !== 'number') {
    blind = 'not yet run — a blind test round has not been graded for this project.';
  } else {
    const prevHead = prev && prev.self_test && prev.self_test.headline;
    let trend = '';
    if (typeof prevHead === 'number') {
      const delta = Math.round((head - prevHead) * 100);
      trend = delta > 0 ? ` (up ${delta} from last check)`
        : delta < 0 ? ` (down ${-delta} from last check — watching, not alarming)`
        : ' (steady)';
    }
    blind = `${pct(head)}${trend}`;
  }
  L.push(`Does it pass its own blind test?     ${blind}`);
  L.push('');

  // What's being recorded, stated on the door itself. The numbers above are
  // produced by storing each turn's prompt and delivered memory context, so a
  // reader who never opens `full` still learns that, and how to stop it.
  if (captureOff) {
    L.push('Turn recording is OFF for this project — nothing about your conversations is being saved.');
  } else {
    L.push('To produce these numbers, each turn\'s prompt and the memory context CORE gave you are saved locally on this machine — never sent anywhere, deleted after 30 days. Turn it off with CORE_TURN_CAPTURE=0, or "turn_capture": false in this project\'s workspace.json.');
  }
  L.push('');

  // The attention surface: tripwires, or earned quiet.
  if (tripwires && tripwires.tripped && tripwires.tripped.length) {
    for (const t of tripwires.tripped) L.push(`Needs your attention: ${t.message}`);
  } else {
    L.push('Nothing needs your attention right now.');
  }
  return L.join('\n');
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
  // --answers: the /metrics DEFAULT view — pinned conclusions only, no live
  // gather (fast, deterministic, plain-language). Everything else below is
  // the `/metrics full` instrument panel.
  if (args.includes('--answers')) {
    process.stdout.write(renderAnswerView(gatherAnswers(cwd)) + '\n');
    process.exit(0);
  }
  const out = await gatherMetrics(cwd);
  // --json emits EXACTLY ONE JSON document and nothing else: mixing the human
  // report and the JSON on one stream would make saved stdout invalid JSON,
  // and `render-metrics-artifact --json-in` could not consume the real
  // product output. Default (no flag) prints the human report.
  if (wantsJson) process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  else process.stdout.write(out.report + '\n');
  process.exit(0);
}
