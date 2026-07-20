#!/usr/bin/env node
// trial-window-join-checker.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 3, 2026-07-20,
// hale--6132d7a-runner-primitives-pass-join-next).
//
// Proves ONE trial (one arm-tagged retrieval + its immediate Stop-hook
// outcome) is real, uncontaminated, and correctly identified -- scoped to an
// explicit before/after cursor window into the SAME log files the real
// product writes, never a global scan or a count comparison.
//
// Real substrate, not invented (verified against the shipped code this
// pilot runs against, not assumed):
//   - record-retrieval-event.mjs writes retrieval rows (kind:'retrieval') to
//     _sessions/<date>/retrieval-log.jsonl via log-event.mjs's logEvent().
//     These rows carry NO session_id/harness field. retrieve-context-hook.mjs
//     adds `requested_arm` (and `directive_fired`) ONLY when CORE_REASONING_ARM
//     was explicitly set for that turn -- the pilot's real per-trial signal.
//   - answer-close-hook.mjs (registered on the harness's Stop event) is the
//     ONLY writer of the "immediate" outcome: usefulness_outcome:'unknown',
//     evidence_authority:'unobservable', plus REQUIRED harness/session_id/
//     answer_turn_id/producer_version/producer_sha, written to
//     _sessions/<date>/outcome-log.jsonl via recordRetrievalOutcome(). Both
//     rows join on retrieval_id.
//   - A later STRONGER outcome (e.g. usefulness_outcome:'useful',
//     evidence_authority:'user-confirmed') for the same retrieval_id is a
//     legitimate, separate, LATER row -- record-retrieval-outcome.mjs's own
//     contract explicitly allows appending a second outcome row per
//     retrieval_id. This checker's window scoping must not treat that as a
//     spoil when it lands outside the window it was asked to check.
//
// Scope, stated honestly (Hale's point 7): this proves the LOG-LEVEL join is
// real and singular -- it does NOT prove the retrieved content was actually
// delivered to or seen by the model. That is a separate, still-required
// receipt (delivered-pack / host-exposure proof) and must never be inferred
// from this checker's ok:true.
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { existsSync, statSync, openSync, closeSync, readSync } from 'node:fs';
import { join } from 'node:path';

/**
 * captureCursor — the byte offset at the END of a log file right now (0 if
 * the file doesn't exist yet). Callers take one before the trial starts and
 * one right after the point they expect the Stop hook to have fired; both
 * are passed to checkTrialWindow() as the window's before/after bounds. A
 * cursor is a plain integer -- there is no live file handle or path for a
 * caller to accidentally re-derive a different window from later.
 */
export function captureCursor(storeDir, date, filename) {
  const path = join(storeDir, '_sessions', date, filename);
  try { return statSync(path).size; } catch { return 0; }
}

function readRowsInWindow(storeDir, date, filename, before, after) {
  const path = join(storeDir, '_sessions', date, filename);
  if (!existsSync(path)) return [];
  const start = Math.max(0, before);
  const end = Math.max(start, after);
  const length = end - start;
  if (length <= 0) return [];
  const fd = openSync(path, 'r');
  let buf;
  try {
    buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buf.toString('utf8').split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

/**
 * checkTrialWindow — the join oracle. Returns { ok:true, retrieval, outcome }
 * only when every one of Hale's six spoil conditions is ruled out; otherwise
 * { ok:false, reason:<CODE>, ...detail } naming exactly which one fired.
 *
 * @param {string} storeDir
 * @param {object} opts
 * @param {string} opts.date                  YYYY-MM-DD session-log date
 * @param {{before:number, after:number}} opts.retrievalWindow
 *   cursors into retrieval-log.jsonl (from captureCursor)
 * @param {{before:number, after:number}} opts.outcomeWindow
 *   cursors into outcome-log.jsonl (from captureCursor)
 * @param {string} opts.expectedArm            required requested_arm value
 * @param {string} [opts.expectedHarness]
 * @param {string} [opts.expectedSessionId]
 * @param {string} [opts.expectedProducerVersion]
 * @param {string} [opts.expectedProducerSha]
 */
export function checkTrialWindow(storeDir, opts) {
  const { date, retrievalWindow, outcomeWindow, expectedArm } = opts || {};
  if (!date) throw new Error('checkTrialWindow requires date');
  if (!retrievalWindow || !outcomeWindow) throw new Error('checkTrialWindow requires retrievalWindow and outcomeWindow cursors — never scans the whole log');
  if (!expectedArm) throw new Error('checkTrialWindow requires expectedArm — an untagged join proves nothing about which arm ran');

  // Point 1: cursor/before-after-window scoped, never global-log counting —
  // only the bytes between the caller's own before/after cursors are ever
  // read, on both files.
  const newRetrievals = readRowsInWindow(storeDir, date, 'retrieval-log.jsonl', retrievalWindow.before, retrievalWindow.after)
    .filter((r) => r.kind === 'retrieval');

  // Point 2 + point 5 (duplicate retrievals spoil closed): exactly one
  // arm-tagged retrieval row in the window.
  const armMatches = newRetrievals.filter((r) => r.requested_arm === expectedArm);
  if (armMatches.length === 0) {
    return { ok: false, reason: 'NO_ARM_TAGGED_RETRIEVAL_IN_WINDOW', expectedArm, newRetrievalCount: newRetrievals.length };
  }
  if (armMatches.length > 1) {
    return { ok: false, reason: 'DUPLICATE_ARM_TAGGED_RETRIEVALS_IN_WINDOW', expectedArm, count: armMatches.length };
  }
  const retrieval = armMatches[0];
  if (!retrieval.retrieval_id) {
    return { ok: false, reason: 'RETRIEVAL_MISSING_ID' };
  }

  // Point 3 + point 5 (ambiguous outcomes / missing rows spoil closed):
  // exactly one outcome row for THIS retrieval_id in the outcome window.
  const outcomesForRetrieval = readRowsInWindow(storeDir, date, 'outcome-log.jsonl', outcomeWindow.before, outcomeWindow.after)
    .filter((r) => r.kind === 'retrieval-outcome' && r.retrieval_id === retrieval.retrieval_id);
  if (outcomesForRetrieval.length === 0) {
    return { ok: false, reason: 'NO_OUTCOME_IN_WINDOW', retrieval_id: retrieval.retrieval_id };
  }
  if (outcomesForRetrieval.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_OUTCOME_IN_WINDOW', retrieval_id: retrieval.retrieval_id, count: outcomesForRetrieval.length };
  }
  const outcome = outcomesForRetrieval[0];

  // The "immediate Stop outcome" shape specifically — answer-close-hook.mjs
  // always writes unknown/unobservable at Stop time; a stronger outcome row
  // is legitimate but is a DIFFERENT, later event, not what point 3 asks for.
  if (outcome.usefulness_outcome !== 'unknown' || outcome.evidence_authority !== 'unobservable') {
    return { ok: false, reason: 'NOT_THE_IMMEDIATE_STOP_OUTCOME_SHAPE', retrieval_id: retrieval.retrieval_id, found: { usefulness_outcome: outcome.usefulness_outcome, evidence_authority: outcome.evidence_authority } };
  }

  // Point 4 + point 5 (wrong identity / a second producer spoil closed).
  const identityChecks = [
    ['expectedHarness', 'harness', 'HARNESS_MISMATCH'],
    ['expectedSessionId', 'session_id', 'SESSION_MISMATCH'],
    ['expectedProducerVersion', 'producer_version', 'PRODUCER_VERSION_MISMATCH'],
    ['expectedProducerSha', 'producer_sha', 'PRODUCER_SHA_MISMATCH'],
  ];
  for (const [optKey, field, reason] of identityChecks) {
    if (opts[optKey] !== undefined && outcome[field] !== opts[optKey]) {
      return { ok: false, reason, expected: opts[optKey], found: outcome[field], retrieval_id: retrieval.retrieval_id };
    }
  }

  // Point 7: this ok:true proves the join, nothing about delivery — callers
  // must not present it as a delivered-pack/host-exposure receipt.
  return { ok: true, retrieval, outcome };
}
