#!/usr/bin/env node
/**
 * scorecard.mjs — pinned, immutable conclusions.
 *
 * Why this exists: a number recomputed on the fly with whatever code
 * is currently installed is not trend-comparable — a trend today and a trend
 * next month diverge if any scoring code changed in between. A scorecard pins one
 * period's conclusions — hindsight grade counts, the self-test headline,
 * volumes, capture health — stamped with {data window, producer identity,
 * judge version, thresholds}, appended to an immutable log. Trends are
 * computed ONLY from stored scorecards; live numbers may render but are
 * labeled `live`, never mixed into history.
 *
 * Deliberately reads LOGS, never sibling modules: judgment rows
 * (`<base>/judgment-log.jsonl`, written by hindsight-judge.mjs), self-test
 * rows (`_sessions/<date>/self-test-log.jsonl`), retrieval-log volumes,
 * turn-capture volumes + health. Absent inputs degrade to honest nulls/zeros
 * — a scorecard from a young project says "nothing judged yet", it never
 * throws and never fabricates.
 *
 * Rows are numbers/ids/short strings ONLY (exportable under the same
 * whitelist discipline as every metrics surface). Append-only under its own
 * sibling lock.
 *
 * Ships with the plugin by design; .mjs only, zero dependencies.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withFileLock } from './file-lock.mjs';
import { resolveStoragePath, resolveWorkspaceId } from './log-event.mjs';
import { producerIdentity } from './producer-identity.mjs';
import { readCaptureHealth, listTurnCaptureFiles } from './turn-capture.mjs';

export const SCORECARD_SCHEMA_VERSION = '1.0.0';

export function scorecardLogPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), 'scorecard-log.jsonl');
}

function scorecardLockPath(projectDir, { workspaceId } = {}) {
  return join(resolveStoragePath(projectDir, { workspaceId }), '.scorecard.lock');
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* malformed row skipped, never fatal */ }
    }
  } catch { /* unreadable file contributes nothing */ }
  return out;
}

/** All rows of a per-session log filename across every _sessions/<date>/ dir. */
function readSessionLog(projectDir, filename) {
  const sessions = join(projectDir, '_sessions');
  if (!existsSync(sessions)) return [];
  let dates = [];
  try { dates = readdirSync(sessions).sort(); } catch { return []; }
  const out = [];
  for (const d of dates) out.push(...readJsonl(join(sessions, d, filename)));
  return out;
}

function readJudgments(projectDir, { workspaceId } = {}) {
  return readJsonl(join(resolveStoragePath(projectDir, { workspaceId }), 'judgment-log.jsonl'));
}

function newestTs(rows) {
  let max = null;
  for (const r of rows) if (typeof r.ts === 'string' && (!max || r.ts > max)) max = r.ts;
  return max;
}

/**
 * Compute one scorecard from stored rows. Pure read + aggregate; does not
 * write (appendScorecard does). `thresholds` is stamped through verbatim so a
 * threshold change is visible in history (Link 5 wires the real values).
 */
export function computeScorecard(projectDir, { now, thresholds = null, workspaceId } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const ts = now || new Date().toISOString();

  const judgments = readJudgments(projectDir, { workspaceId: wsId });
  const hindsight = { judged_turns: 0, hit_right: 0, noise: 0, hindsight_miss: 0, storage_gap: 0 };
  let judgeVersion = null;
  for (const j of judgments) {
    const key = String(j.verdict || '').replace(/-/g, '_');
    if (key in hindsight) {
      hindsight[key] += 1;
      hindsight.judged_turns += 1;
      if (typeof j.judge_version === 'string') judgeVersion = j.judge_version;
    }
  }

  const selfTests = readSessionLog(projectDir, 'self-test-log.jsonl')
    .filter((r) => r.kind === 'self-test-run');
  const newestSelfTest = selfTests.reduce((best, r) =>
    (!best || String(r.ts || '') > String(best.ts || '')) ? r : best, null);

  const prior = latestScorecards(projectDir, 1, { workspaceId: wsId });
  // Window start: the previous card's timestamp. Cumulative totals alone can't
  // show a stream that stopped — any historical volume masks present silence —
  // so every volume is also counted over the window this card actually covers.
  const windowFrom = prior.length ? String(prior[0].ts || '') : '';
  const inWindow = (row) => !windowFrom || String(row.ts || '') > windowFrom;

  let turnsCaptured = 0;
  let turnsCapturedWindow = 0;
  for (const { file } of listTurnCaptureFiles(projectDir, { workspaceId: wsId })) {
    const rows = readJsonl(file);
    turnsCaptured += rows.length;
    turnsCapturedWindow += rows.filter(inWindow).length;
  }
  const retrievals = readSessionLog(projectDir, 'retrieval-log.jsonl')
    .filter((r) => r.kind === 'retrieval' || r.kind === undefined);
  const retrievalRows = retrievals.length;
  const retrievalRowsWindow = retrievals.filter(inWindow).length;
  // Coverage compares like with like: only hook-triggered retrievals have a
  // capture counterpart. Agent-logged Tier-1/2/3 events have no hook to fire.
  const hookRetrievalRowsWindow = retrievals
    .filter((r) => inWindow(r) && r.trigger === 'per-turn-hook').length;

  return {
    kind: 'scorecard',
    schema_version: SCORECARD_SCHEMA_VERSION,
    ts,
    data_window: { from: prior.length ? prior[0].ts : null, to: ts },
    ...producerIdentity(),
    judge_version: judgeVersion,
    thresholds,
    hindsight,
    self_test: {
      headline: newestSelfTest && typeof newestSelfTest.headline === 'number' ? newestSelfTest.headline : null,
      round_id: newestSelfTest && newestSelfTest.round !== undefined ? newestSelfTest.round : null,
    },
    volumes: {
      turns_captured: turnsCaptured,
      retrieval_rows: retrievalRows,
      turns_captured_window: turnsCapturedWindow,
      retrieval_rows_window: retrievalRowsWindow,
      hook_retrieval_rows_window: hookRetrievalRowsWindow,
    },
    capture_health: readCaptureHealth(projectDir, { workspaceId: wsId }),
  };
}

/** Append one scorecard row — append-only, under the stream's own lock. */
export function appendScorecard(projectDir, card, { workspaceId } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const file = scorecardLogPath(projectDir, { workspaceId: wsId });
  const base = resolveStoragePath(projectDir, { workspaceId: wsId });
  try {
    withFileLock(scorecardLockPath(projectDir, { workspaceId: wsId }), () => {
      mkdirSync(base, { recursive: true });
      appendFileSync(file, JSON.stringify(card) + '\n');
    });
    return { written: true, path: file };
  } catch (e) {
    return { written: false, reason: String(e && e.message).slice(0, 120) };
  }
}

/** Newest-first stored scorecards, up to n. */
export function latestScorecards(projectDir, n = 5, { workspaceId } = {}) {
  const rows = readJsonl(scorecardLogPath(projectDir, { workspaceId }))
    .filter((r) => r.kind === 'scorecard');
  rows.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return rows.slice(0, n);
}

/**
 * Cadence gate for the maintenance op: compute only when a judgment or
 * self-test row postdates the last pinned scorecard (or exists unpinned).
 */
export function shouldComputeScorecard(projectDir, { workspaceId } = {}) {
  const wsId = workspaceId || resolveWorkspaceId(projectDir);
  const newestInput = [
    newestTs(readJudgments(projectDir, { workspaceId: wsId })),
    newestTs(readSessionLog(projectDir, 'self-test-log.jsonl').filter((r) => r.kind === 'self-test-run')),
  ].filter(Boolean).sort().pop() || null;
  if (!newestInput) return false; // nothing to pin
  const prior = latestScorecards(projectDir, 1, { workspaceId: wsId });
  if (!prior.length) return true;
  return newestInput > String(prior[0].ts || '');
}

// ---------- CLI (status / compute-and-append for the maintenance cadence) ----------

export function main(argv) {
  const projectDir = argv.find((a) => !a.startsWith('--'));
  if (!projectDir) {
    process.stderr.write('usage: scorecard.mjs <project-dir> [--pin | --latest N]\n');
    return 1;
  }
  if (argv.includes('--pin')) {
    if (!shouldComputeScorecard(projectDir)) {
      process.stdout.write(JSON.stringify({ pinned: false, reason: 'nothing-new' }) + '\n');
      return 0;
    }
    const card = computeScorecard(projectDir);
    const res = appendScorecard(projectDir, card);
    process.stdout.write(JSON.stringify({ pinned: res.written, ...(res.written ? { ts: card.ts } : { reason: res.reason }) }) + '\n');
    return res.written ? 0 : 2;
  }
  const idx = argv.indexOf('--latest');
  const n = idx !== -1 ? Number(argv[idx + 1]) || 5 : 5;
  process.stdout.write(JSON.stringify(latestScorecards(projectDir, n)) + '\n');
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
