/**
 * metrics-rollup.mjs — Layer 3 aggregation + the one-line startup readiness signal.
 *
 * Reads the operational-meta `classified/<date>.jsonl` records (written by
 * classify-turns.mjs) and produces:
 *   - a daily rollup markdown (state distribution + the headline rec-fail-tier-0 rate)
 *   - a one-line `orient-signal.txt` the startup readiness pass reads, comparing today's
 *     rec-fail-tier-0 rate against the trailing 7-day average (spec §17.8).
 *
 * HONESTY GATE: classify-turns output is PROVISIONAL until Phase-3 calibration
 * proves >0.7 precision. This rollup therefore tags every surface `[PROVISIONAL]`
 * and the startup readiness signal says so out loud. No state distribution renders as
 * evidence-grade until calibration clears (spec §17.12; self-measuring
 * guard — CORE measuring itself must not launder its own confidence).
 *
 * Ships with the plugin as prescriptive code; .mjs only. Fail-open: never throws.
 *
 * CLI:  node metrics-rollup.mjs <project> [--json] [--today YYYY-MM-DD]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { todayUTC, operationalMetricsDir, trustedMetricsDir, metricsEnabled } from './log-event.mjs';
import { CLASSIFIER_VERSION, PROXY_VERSION, CLASSIFIED_SCHEMA_VERSION } from './classify-turns.mjs';
import { cohortClassifiedByDay, formatDedupeNote, formatCoverageGapNote } from './metrics-dedupe.mjs';
import { isCliEntry } from './cli-entry.mjs';
import { aggregateCalibration } from './calibrate-classifier.mjs';
import { coreHome } from './trusted-home.mjs';

const HEADLINE = 'rec-fail-tier-0';

// Cross-date attribution — EXPLICIT POLICY:
// IMMUTABLE OBSERVATION DAY. A replayed session keeps its EARLIEST/original
// observation day; replay never moves history forward. A turn first observed on
// day X and re-classified on day Y counts once, under day X — the day the user
// need actually occurred, not the day a classification was re-produced. So
// "turns today" means user turns first observed today, never processing
// activity. Stated in the rollup JSON and the daily markdown.
const DAY_ATTRIBUTION = 'observation-day';
const DAY_ATTRIBUTION_NOTE = 'replayed sessions keep their earliest/original observation day; "turns today" means user turns first observed that day, never re-processing activity';


function readClassified(dir, date) {
  const file = join(dir, `${date}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Read EVERY daily classified file (ascending date order) and return the
 * replay-deduped, COHORT-GATED per-day view plus store-wide dedupe stats and
 * the coverage gap. Store-wide, not per-file, because a session re-processed
 * on a later date appends the same turns under a new date — only a
 * whole-store pass keeps totals stable under that replay (the
 * replay-identity review falsifier). The cohort gate
 * then keeps only rows produced by the CURRENT instrument — the same
 * (schema, classifier, proxy) triple calibration is validated against;
 * everything else is reported, never counted. The store is small (daily
 * JSONL, one row per classified turn), so the full read is cheap.
 */
function readClassifiedCohort(dir) {
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch { files = []; }
  const daysInput = files.map((f) => ({ day: f.slice(0, 10), rows: readClassified(dir, f.slice(0, 10)) }));
  return cohortClassifiedByDay(daysInput, {
    schema_version: CLASSIFIED_SCHEMA_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    proxy_version: PROXY_VERSION,
  });
}

function rate(records, state) {
  if (!records.length) return null;
  const n = records.filter((r) => r.state === state).length;
  return { n, total: records.length, pct: n / records.length };
}

/** Trailing 7-day average rate of `state`, excluding `today`, over the deduped per-day view. */
function trailingAvg(dedupedDays, today, state, days = 7) {
  const dates = [];
  const base = new Date(today + 'T00:00:00Z');
  for (let i = 1; i <= days; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const rates = [];
  for (const date of dates) {
    const r = rate(dedupedDays[date] || [], state);
    if (r) rates.push(r.pct);
  }
  if (!rates.length) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}

export function buildRollup({ project, today, home = coreHome(), env }) {
  if (!metricsEnabled({ project, env, home })) {
    return { date: today || todayUTC(), disabled: true, distribution: {}, headline: null, trailing_avg: null, provisional: true, signal: 'metrics disabled (opt-in not set)' };
  }
  const date = today || todayUTC();
  let metaDir;
  try { metaDir = operationalMetricsDir(project, { home, env }); }
  catch (e) {
    if (e.code !== 'STATE_NO_PROJECT_PLACE') throw e;
    return { date, status: 'NOT_STORED', written: false, reason: e.reason,
      error_code: e.code, distribution: {}, headline: null, trailing_avg: null,
      provisional: true, signal: `metrics not stored: ${e.reason}` };
  }
  const classifiedDir = join(metaDir, 'classified');

  // Read-side replay dedupe + instrument-cohort gate (metrics-dedupe.mjs):
  // the classified store is append-only, so re-processed sessions appear more
  // than once, and old-instrument rows survive when never re-classified.
  // Aggregate ONLY the deduped current-cohort view; surface the dedupe stats
  // and the coverage gap, never bury either.
  const { days: dedupedDays, stats: dedupe, cohort, coverage_gap: coverageGap } = readClassifiedCohort(classifiedDir);
  const todayRecs = dedupedDays[date] || [];
  const dist = {};
  for (const r of todayRecs) dist[r.state] = (dist[r.state] || 0) + 1;
  const headline = rate(todayRecs, HEADLINE);
  const avg = trailingAvg(dedupedDays, date, HEADLINE);

  // Phase 3: read calibration state to determine whether to drop PROVISIONAL tag.
  // The gate across harnesses, each from its own state; this harness's file alone can't clear it.
  const calState = aggregateCalibration(project, { home, env });
  const provisional = !calState.is_calibrated;
  const provisionalTag = provisional ? ' [PROVISIONAL — classifier uncalibrated]' : '';

  // Visible in the one-line signal whenever the dedupe actually changed the
  // numbers (dropped rows or conflicts); always present in JSON + daily md.
  const lossy = dedupe.rows_read !== dedupe.rows_kept || dedupe.conflicts > 0;
  const dedupeTag = lossy
    ? ` [replay-dedupe: ${dedupe.rows_read}→${dedupe.rows_kept} store-wide${dedupe.conflicts ? `, ${dedupe.conflicts} conflict${dedupe.conflicts === 1 ? '' : 's'}` : ''}]`
    : '';
  // Coverage gap is a correctness signal, not a footnote: whenever any row
  // was excluded for being outside the current instrument cohort, say so in
  // the one-liner too (always present in JSON + daily md).
  const gapTag = coverageGap.rows_excluded ? ` [${formatCoverageGapNote({ cohort, coverage_gap: coverageGap })}]` : '';

  let signal;
  if (!todayRecs.length) {
    // provisionalTag is '' when calibrated; a `|| ' [PROVISIONAL]'` fallback here
    // would re-add the tag on a calibrated workspace, mislabeling honest metrics.
    signal = `metrics: no classified turns for ${date} yet${dedupeTag}${gapTag}${provisionalTag}`;
  } else {
    const todayPct = Math.round(headline.pct * 100);
    const avgStr = avg == null ? 'n/a (no prior 7d)' : `${Math.round(avg * 100)}%`;
    const arrow = avg == null ? '' : headline.pct > avg + 0.02 ? ' ↑' : headline.pct < avg - 0.02 ? ' ↓' : ' ≈';
    signal = `${HEADLINE}: ${headline.n}/${headline.total} turns today (${todayPct}%) vs 7-day avg ${avgStr}${arrow}${dedupeTag}${gapTag}${provisionalTag}`;
  }

  return {
    date, distribution: dist, headline, trailing_avg: avg,
    provisional, calibrated: calState.is_calibrated, dedupe,
    cohort, coverage_gap: coverageGap,
    day_attribution: DAY_ATTRIBUTION, day_attribution_note: DAY_ATTRIBUTION_NOTE,
    signal, metaDir,
  };
}

export function writeRollup(r) {
  if (r.disabled || r.status === 'NOT_STORED') return r;
  try {
    mkdirSync(join(r.metaDir, 'rollups', 'daily'), { recursive: true });
    const headerTag = r.provisional ? '  [PROVISIONAL — classifier uncalibrated]' : '  [calibrated]';
    const footer = r.provisional
      ? ['', '> Provisional: these heuristics are not yet calibrated to >0.7 precision (Phase 3).', '> Capture (the transcript) is ground truth; this interpretation is replayable.']
      : ['', '> Calibrated: precision cleared 0.7 bar. Capture is ground truth; interpretation remains replayable.'];
    const lines = [
      `# Metrics rollup — ${r.date}${headerTag}`,
      '',
      `Headline ${HEADLINE} rate: ${r.headline ? `${r.headline.n}/${r.headline.total} (${Math.round(r.headline.pct * 100)}%)` : 'n/a'}`,
      `Trailing 7-day avg: ${r.trailing_avg == null ? 'n/a' : `${Math.round(r.trailing_avg * 100)}%`}`,
      ...(r.dedupe ? [`Replay-dedupe (store-wide): ${formatDedupeNote(r.dedupe)}`] : []),
      ...(r.cohort ? [(() => { const n = formatCoverageGapNote(r); return n.charAt(0).toUpperCase() + n.slice(1); })()] : []),
      ...(r.day_attribution_note ? [`Day attribution: ${r.day_attribution_note}.`] : []),
      '',
      '## State distribution (today)',
      ...Object.entries(r.distribution).sort((a, b) => b[1] - a[1]).map(([s, n]) => `- ${s}: ${n}`),
      ...footer,
    ];
    writeFileSync(join(r.metaDir, 'rollups', 'daily', `${r.date}.md`), lines.join('\n') + '\n');
    // The one-line signal the startup readiness pass reads.
    writeFileSync(join(r.metaDir, 'orient-signal.txt'), r.signal + '\n');
  } catch { /* best-effort */ }
  return r;
}

/** What the startup readiness pass reads — the pre-computed one-line signal. */
export function readOrientSignal(project, { home = coreHome(), env = process.env } = {}) {
  const meta = trustedMetricsDir(project, { home, env });
  if (!meta) return null;
  const f = join(meta, 'orient-signal.txt');
  try { return readFileSync(f, 'utf8').trim(); } catch { return null; }
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const r = writeRollup(buildRollup({ project, today: opt('today') }));
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(r.signal + '\n');
  process.exit(0);
}
