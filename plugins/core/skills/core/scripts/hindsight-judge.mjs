#!/usr/bin/env node
/**
 * hindsight-judge.mjs — the mechanical-grade hindsight pass (evidence chain, Link 2).
 *
 * What it measures, honestly: TRUNCATION IMPACT. The live retrieval hook saw a
 * byte-capped view (≤8 keyword tokens) of the user's prompt; this judge, later
 * and never in the retrieving process (the self-graded-homework rule,
 * obs-20260710, is settled law), re-runs the SAME lexical substrate over the
 * SAME store using the FULL prompt text the evidence layer preserved, and asks:
 * with hindsight, was the delivered set right?
 *
 * That is a `mechanical grade`, and every surface that shows these verdicts
 * says so. The information asymmetry that makes it non-circular (from the
 * design review): the judge sees full text + hindsight; the retriever saw a
 * truncated live prompt. It is NOT a measure of semantic rightness — the
 * LLM-judge tier remains a possible later escalation, deliberately unscoped.
 *
 * Verdicts, one per judged turn, priority order:
 *   storage-gap      — nothing in the store scores at or above the gap floor
 *                      for the full prompt: the direct "storing the right
 *                      memories" measure; feeds observation capture.
 *   hindsight-miss   — an eligible full-text match was not delivered: the
 *                      direct "proactively loading the right memories" measure.
 *   noise            — a delivered unit scores below the floor on the full
 *                      text: topical-but-irrelevant injection.
 *   hit-right        — delivered set matches the full-text expectation.
 *   drift-invalidated — the store changed between capture and judgment
 *                      (store_signature mismatch): flag and drop the sample —
 *                      a turn is judged only against the store state at the
 *                      time of the event, never guessed across drift.
 *                      Scorecards exclude these from grade counts.
 *
 * GAP FLOOR: deliberately conservative — a LOW bar, so a turn is called
 * `storage-gap` only when the store truly has essentially no lexical match
 * (under-report gaps rather than mislabel weak matches as gaps). Configurable
 * (opts.gapFloor / CORE_JUDGE_GAP_FLOOR) so the value can be derived from real
 * baseline data later instead of hardcoding a magic BM25 number (a
 * design-review requirement).
 *
 * Bounded + idempotent: at most `limit` (default 50) unjudged evidence rows
 * per pass, judged set tracked via the judgment log itself. Runs on the
 * maintenance cadence. Failure never blocks the pass.
 *
 * Ships with the plugin by convention; .mjs (Node.js) only.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withFileLock } from './file-lock.mjs';
import { resolveStoragePath, resolveWorkspaceId } from './log-event.mjs';
import { producerIdentity } from './producer-identity.mjs';
import { listTurnCaptureFiles, computeStoreSignature, JUDGMENT_LOG_FILENAME } from './turn-capture.mjs';
import { buildRetrievalTrace } from './retrieve-context.mjs';
import { isCliEntry } from './cli-entry.mjs';

// Bump when verdict semantics change — scorecards stamp this so a rate shift
// is attributable to judge-change vs store-change from the record alone.
export const JUDGE_VERSION = '1.0.0';

// Conservative-LOW bar (see header): essentially "no lexical signal at all".
export const DEFAULT_GAP_FLOOR = 0.5;

export function judgmentLogPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), JUDGMENT_LOG_FILENAME);
}

function judgmentLockPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), '.judgment.lock');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line — not this reader's problem */ }
    }
  } catch { /* unreadable file contributes nothing */ }
  return out;
}

/**
 * Grade one evidence row against the full-text ranking. Pure — exported for
 * direct testing. `ranking` is [{id, score}] in rank order (the substrate's
 * own ordering over the full prompt).
 */
export function gradeTurn({ deliveredIds, ranking, gapFloor }) {
  const eligible = ranking.filter((r) => typeof r.score === 'number' && r.score >= gapFloor);
  if (eligible.length === 0) return 'storage-gap';
  const delivered = new Set(deliveredIds);
  const expected = eligible.slice(0, Math.max(1, deliveredIds.length));
  if (expected.some((e) => !delivered.has(e.id))) return 'hindsight-miss';
  const eligibleIds = new Set(eligible.map((e) => e.id));
  if (deliveredIds.some((d) => !eligibleIds.has(d))) return 'noise';
  return 'hit-right';
}

/**
 * Judge up to `limit` unjudged evidence rows. Returns
 * { judged, skipped, verdicts: {<verdict>: count} }.
 */
export function judgeUnjudgedTurns(projectDir, { limit = 50, gapFloor, workspaceId, now, env = process.env } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const floor = typeof gapFloor === 'number' ? gapFloor
    : Number.isFinite(Number(env.CORE_JUDGE_GAP_FLOOR)) && env.CORE_JUDGE_GAP_FLOOR !== undefined && env.CORE_JUDGE_GAP_FLOOR !== ''
      ? Number(env.CORE_JUDGE_GAP_FLOOR) : DEFAULT_GAP_FLOOR;

  const logFile = judgmentLogPath(projectDir, { workspaceId: wsId });
  const judgedIds = new Set(readJsonl(logFile).map((r) => r.retrieval_id).filter(Boolean));

  // Oldest-first so history fills forward deterministically.
  const evidence = [];
  for (const { file } of listTurnCaptureFiles(projectDir, { workspaceId: wsId })) {
    evidence.push(...readJsonl(file));
  }

  const sigNow = computeStoreSignature(projectDir);
  const result = { judged: 0, skipped: 0, verdicts: {} };
  const rows = [];

  for (const ev of evidence) {
    if (result.judged >= limit) break;
    if (!ev || ev.kind !== 'turn-evidence' || !ev.retrieval_id) { result.skipped += 1; continue; }
    if (judgedIds.has(ev.retrieval_id)) continue;
    if (typeof ev.prompt_text !== 'string' || !ev.prompt_text.trim()) { result.skipped += 1; continue; }

    const deliveredIds = (Array.isArray(ev.delivered) ? ev.delivered : [])
      .map((d) => d && d.id).filter(Boolean);

    let verdict;
    let fullTop = [];
    const drifted = typeof ev.store_signature === 'string'
      && ev.store_signature !== 'unknown'
      && ev.store_signature !== sigNow;
    if (drifted) {
      verdict = 'drift-invalidated'; // flag and drop, never guess across drift
    } else {
      let trace = null;
      try { trace = buildRetrievalTrace(ev.prompt_text, projectDir, { topN: Math.max(3, deliveredIds.length) }); }
      catch { result.skipped += 1; continue; }
      const substrate = trace && trace.stages && Array.isArray(trace.stages.substrate) ? trace.stages.substrate : [];
      const ranking = substrate.map((h) => ({ id: String(h.id), score: h.score }));
      fullTop = ranking.slice(0, 5);
      verdict = gradeTurn({ deliveredIds, ranking, gapFloor: floor });
    }

    rows.push({
      kind: 'hindsight-judgment',
      retrieval_id: ev.retrieval_id,
      ts: now || new Date().toISOString(),
      verdict,
      grade: 'mechanical', // never presented as semantic rightness
      full_text_top: fullTop.map((r) => ({ id: r.id, score: typeof r.score === 'number' ? Number(r.score.toFixed(4)) : null })),
      delivered_ids: deliveredIds,
      judge_version: JUDGE_VERSION,
      ...producerIdentity(),
      thresholds: { gap_floor: floor },
      store_signature_at_capture: typeof ev.store_signature === 'string' ? ev.store_signature : null,
      store_signature_at_judge: sigNow,
      store_drifted: Boolean(drifted),
    });
    judgedIds.add(ev.retrieval_id);
    result.judged += 1;
    result.verdicts[verdict] = (result.verdicts[verdict] || 0) + 1;
  }

  if (rows.length) {
    try {
      withFileLock(judgmentLockPath(projectDir, { workspaceId: wsId }), () => {
        mkdirSync(resolveStoragePath(projectDir, { workspaceId: wsId }), { recursive: true });
        appendFileSync(logFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        // Judgments name the units a real conversation retrieved: owner-only,
        // re-asserted every append. Best-effort — not every filesystem chmods.
        try { chmodSync(logFile, 0o600); } catch { /* mode is advisory here */ }
      });
    } catch (e) {
      return { judged: 0, skipped: result.skipped, verdicts: {}, error: String(e && e.message).slice(0, 120) };
    }
  }
  return result;
}

// ---------- CLI (maintenance cadence entry + status) ----------

export function main(argv) {
  const projectDir = argv.find((a) => !a.startsWith('--'));
  if (!projectDir) {
    process.stderr.write('usage: hindsight-judge.mjs <project-dir> [--limit N]\n');
    return 1;
  }
  const idx = argv.indexOf('--limit');
  const limit = idx !== -1 ? Number(argv[idx + 1]) || 50 : 50;
  const res = judgeUnjudgedTurns(projectDir, { limit });
  process.stdout.write(JSON.stringify(res) + '\n');
  return res.error ? 2 : 0;
}

if (isCliEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
