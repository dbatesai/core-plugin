#!/usr/bin/env node
/**
 * metrics-tripwires.mjs — proactive degradation surfacing (v3.14.0 Link 5).
 *
 * A cheap session-start check over PINNED scorecards + capture health — never
 * live recomputation. Healthy → total silence (the readiness-only-escalations
 * rule applied to metrics). Tripped → one plain-language line per wire with
 * the likely locus, written for a user who has never heard of the internals.
 *
 * ALL thresholds live in this ONE module (TRIPWIRE_THRESHOLDS) and are
 * stamped into every scorecard row by the maintenance pass, so a threshold
 * change is visible in history rather than silently moving the goalposts.
 *
 * The four wires (spec Component 4 + Antigravity's Gate-A floors):
 *   self-test-drop         — headline fell > threshold vs the previous card.
 *   miss-trend             — hindsight-miss rate strictly rising across the
 *                            trend window of consecutive cards.
 *   storage-gap-recurrence — storage gaps in ≥ N recent cards.
 *   capture-failure        — >10% write failures WITH ≥20 attempts, OR ≥3
 *                            consecutive failures (the streak catches a
 *                            hard-dead recorder in a short session).
 *   capture-dead           — retrieval rows exist but zero evidence rows were
 *                            captured: the flight recorder itself is down.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestScorecards } from './scorecard.mjs';
import { readCaptureHealth } from './turn-capture.mjs';

// The single source of truth for every threshold. Stamped into scorecards.
export const TRIPWIRE_THRESHOLDS = Object.freeze({
  self_test_drop: 0.05,            // headline points (0–1 scale)
  miss_trend_scorecards: 3,        // consecutive cards with strictly rising miss rate
  storage_gap_recurrence: 2,       // cards (of the recent window) with any storage gap
  capture_failure_rate: 0.10,      // failures/attempts …
  capture_failure_min_attempts: 20, // … only meaningful at or above this volume (Agy)
  capture_consecutive_failures: 3, // … or this streak, regardless of volume (Agy)
});

function missRate(cardRow) {
  const h = cardRow && cardRow.hindsight;
  if (!h || !h.judged_turns) return null;
  return h.hindsight_miss / h.judged_turns;
}

/**
 * Evaluate all wires from stored conclusions. Returns
 * { healthy, tripped: [{kind, message}] }. Never throws; an unreadable
 * history is healthy silence (nothing trustworthy to alarm about).
 */
export function evaluateTripwires(projectDir, { workspaceId, thresholds = TRIPWIRE_THRESHOLDS } = {}) {
  const tripped = [];
  let cards = [];
  try { cards = latestScorecards(projectDir, 5, { workspaceId }); } catch { cards = []; }
  if (cards.length === 0) return { healthy: true, tripped: [] };
  const newest = cards[0];

  // 1. Self-test drop vs the previous pinned card.
  if (cards.length >= 2) {
    const cur = newest.self_test && newest.self_test.headline;
    const prev = cards[1].self_test && cards[1].self_test.headline;
    if (typeof cur === 'number' && typeof prev === 'number' && prev - cur > thresholds.self_test_drop) {
      tripped.push({
        kind: 'self-test-drop',
        message: `The memory system's own blind test scored ${(cur * 100).toFixed(0)}%, down ${((prev - cur) * 100).toFixed(0)} points since the last check — worth a look before trusting recall on older topics.`,
      });
    }
  }

  // 2. Hindsight-miss rate strictly rising across the trend window.
  const window = cards.slice(0, thresholds.miss_trend_scorecards);
  if (window.length === thresholds.miss_trend_scorecards) {
    const rates = window.map(missRate);
    if (rates.every((r) => typeof r === 'number')) {
      // cards are newest-first; strictly rising over time = strictly falling here
      const rising = rates.every((r, i) => i === rates.length - 1 || r > rates[i + 1]);
      if (rising && rates[0] > 0) {
        tripped.push({
          kind: 'miss-trend',
          message: `The share of turns where a better-matching memory existed but wasn't loaded has risen ${thresholds.miss_trend_scorecards} checks in a row (now ${(rates[0] * 100).toFixed(0)}% of graded turns, mechanical grade) — retrieval may be slipping as the store grows.`,
        });
      }
    }
  }

  // 3. Storage-gap recurrence.
  const gapCards = cards.filter((c) => c.hindsight && c.hindsight.storage_gap > 0).length;
  if (gapCards >= thresholds.storage_gap_recurrence) {
    tripped.push({
      kind: 'storage-gap-recurrence',
      message: `In ${gapCards} recent checks, some questions needed information no stored memory contains — the capture side may be missing things worth remembering.`,
    });
  }

  // 4. Capture failures — Agy's floors: rate needs volume; a streak never does.
  const health = newest.capture_health || readCaptureHealth(projectDir, { workspaceId });
  if (health && typeof health.attempts === 'number') {
    const streak = (health.consecutive_failures || 0) >= thresholds.capture_consecutive_failures;
    const rate = health.attempts >= thresholds.capture_failure_min_attempts
      && health.failures / health.attempts > thresholds.capture_failure_rate;
    if (streak || rate) {
      tripped.push({
        kind: 'capture-failure',
        message: `The evidence recorder is failing to save turns (${health.failures} of ${health.attempts} writes failed${streak ? `, ${health.consecutive_failures} in a row` : ''}) — quality grading is losing its raw material. Check disk space and permissions for the metrics folder.`,
      });
    }
  }

  // 5. Flight recorder dead: retrieval happening, nothing being captured.
  const vol = newest.volumes || {};
  if ((vol.retrieval_rows || 0) > 0 && (vol.turns_captured || 0) === 0) {
    tripped.push({
      kind: 'capture-dead',
      message: 'Memory retrieval is running but no turn evidence is being recorded at all — if you did not turn capture off yourself, the recorder is silently broken.',
    });
  }

  return { healthy: tripped.length === 0, tripped };
}

// ---------- CLI (startup protocol consumes stdout: one line per trip, or nothing) ----------

export function main(argv) {
  const projectDir = argv.find((a) => !a.startsWith('--'));
  if (!projectDir) {
    process.stderr.write('usage: metrics-tripwires.mjs <project-dir>\n');
    return 1;
  }
  const res = evaluateTripwires(projectDir);
  for (const t of res.tripped) process.stdout.write(`${t.message}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
