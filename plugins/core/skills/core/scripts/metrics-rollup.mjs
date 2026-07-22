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
 * evidence-grade until calibration clears (spec §17.12, Anvil A4; R-1 self-measuring
 * guard — CORE measuring itself must not launder its own confidence).
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Fail-open: never throws.
 *
 * CLI:  node metrics-rollup.mjs <project> [--json] [--today YYYY-MM-DD]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { todayUTC, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';
import { CLASSIFIER_VERSION, PROXY_VERSION } from './classify-turns.mjs';
import { dedupeClassifiedByDay, formatDedupeNote } from './metrics-dedupe.mjs';

const HEADLINE = 'rec-fail-tier-0';

/**
 * Read calibration state and decide whether the rollup may drop the PROVISIONAL
 * tag. A calibration only counts if it was run against the CURRENT classifier
 * version — calibrate at v0.1.0, then improve the classifier, and the old
 * precision number no longer describes what's running. Version mismatch ⇒ treat
 * as uncalibrated (the R-1 honesty spine: never launder stale confidence).
 */
function readCalibrationState(metaDir) {
  const f = join(metaDir, 'calibration-state.json');
  if (!existsSync(f)) return { is_calibrated: false, provisional: true };
  let s;
  try { s = JSON.parse(readFileSync(f, 'utf8')); } catch { return { is_calibrated: false, provisional: true }; }
  if (s.is_calibrated
      && (s.classifier_version !== CLASSIFIER_VERSION || s.proxy_version !== PROXY_VERSION)) {
    return { ...s, is_calibrated: false, provisional: true, version_mismatch: true };
  }
  return s;
}

function readClassified(dir, date) {
  const file = join(dir, `${date}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Read EVERY daily classified file (ascending date order) and return the
 * replay-deduped per-day view plus store-wide dedupe stats. Store-wide, not
 * per-file, because a session re-processed on a later date appends the same
 * turns under a new date — only a whole-store pass keeps totals stable under
 * that replay (Hale's replay-identity falsifier). The store is small (daily
 * JSONL, one row per classified turn), so the full read is cheap.
 */
function readClassifiedDeduped(dir) {
  let files = [];
  try {
    files = readdirSync(dir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
  } catch { files = []; }
  const daysInput = files.map((f) => ({ day: f.slice(0, 10), rows: readClassified(dir, f.slice(0, 10)) }));
  return dedupeClassifiedByDay(daysInput);
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

export function buildRollup({ project, today, home = homedir(), workspaceId, env }) {
  if (!metricsEnabled({ project, env })) {
    return { date: today || todayUTC(), disabled: true, distribution: {}, headline: null, trailing_avg: null, provisional: true, signal: 'metrics disabled (opt-in not set)' };
  }
  const date = today || todayUTC();
  const wid = workspaceId || resolveWorkspaceId(project);
  const metaDir = operationalMetricsDir(wid, { home });
  const classifiedDir = join(metaDir, 'classified');

  // Read-side replay dedupe (metrics-dedupe.mjs): the classified store is
  // append-only, so re-processed sessions appear more than once. Aggregate
  // over the deduped view; surface the dedupe stats, never bury them.
  const { days: dedupedDays, stats: dedupe } = readClassifiedDeduped(classifiedDir);
  const todayRecs = dedupedDays[date] || [];
  const dist = {};
  for (const r of todayRecs) dist[r.state] = (dist[r.state] || 0) + 1;
  const headline = rate(todayRecs, HEADLINE);
  const avg = trailingAvg(dedupedDays, date, HEADLINE);

  // Phase 3: read calibration state to determine whether to drop PROVISIONAL tag.
  const calState = readCalibrationState(metaDir);
  const provisional = !calState.is_calibrated;
  const provisionalTag = provisional ? ' [PROVISIONAL — classifier uncalibrated]' : '';

  // Visible in the one-line signal whenever the dedupe actually changed the
  // numbers (dropped rows or conflicts); always present in JSON + daily md.
  const lossy = dedupe.rows_read !== dedupe.rows_kept || dedupe.conflicts > 0;
  const dedupeTag = lossy
    ? ` [replay-dedupe: ${dedupe.rows_read}→${dedupe.rows_kept} store-wide${dedupe.conflicts ? `, ${dedupe.conflicts} conflict${dedupe.conflicts === 1 ? '' : 's'}` : ''}]`
    : '';

  let signal;
  if (!todayRecs.length) {
    // provisionalTag is '' when calibrated; the old `|| ' [PROVISIONAL]'` fallback
    // re-added the tag on a calibrated workspace, mislabeling honest metrics (M5).
    signal = `metrics: no classified turns for ${date} yet${dedupeTag}${provisionalTag}`;
  } else {
    const todayPct = Math.round(headline.pct * 100);
    const avgStr = avg == null ? 'n/a (no prior 7d)' : `${Math.round(avg * 100)}%`;
    const arrow = avg == null ? '' : headline.pct > avg + 0.02 ? ' ↑' : headline.pct < avg - 0.02 ? ' ↓' : ' ≈';
    signal = `${HEADLINE}: ${headline.n}/${headline.total} turns today (${todayPct}%) vs 7-day avg ${avgStr}${arrow}${dedupeTag}${provisionalTag}`;
  }

  return { date, workspace_id: wid, distribution: dist, headline, trailing_avg: avg, provisional, calibrated: calState.is_calibrated, dedupe, signal, metaDir };
}

export function writeRollup(r) {
  if (r.disabled) return r; // privacy-gated: write no metrics artifacts
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
export function readOrientSignal(project, { home = homedir(), workspaceId } = {}) {
  const wid = workspaceId || resolveWorkspaceId(project);
  const f = join(operationalMetricsDir(wid, { home }), 'orient-signal.txt');
  try { return readFileSync(f, 'utf8').trim(); } catch { return null; }
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const r = writeRollup(buildRollup({ project, today: opt('today') }));
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else process.stdout.write(r.signal + '\n');
  process.exit(0);
}
