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
// Hale re-audit (hale--de3066d-window-design-pass-five-fail-open-hold):
// PASS on the byte-cursor window design, HOLD on the oracle itself -- an
// executable falsifier suite found five false passes. All five closed here:
//   1. A second retrieval row for a DIFFERENT arm inside the retrieval
//      window used to be invisible (only requested-arm matches were
//      counted) -- any contamination in the window now fails closed before
//      arm is even checked.
//   2. Same shape on the outcome side: a second outcome row for a DIFFERENT
//      retrieval_id inside the outcome window used to be invisible (the
//      code filtered to the target retrieval_id before counting) -- any
//      contamination in the outcome window now fails closed first.
//   3. Every expected-identity argument (harness/session/producer version/
//      producer SHA) was optional; omitting all of them still returned
//      ok:true. All four are now required, same tier as expectedArm.
//   4. A malformed or non-object JSON line inside the window was silently
//      dropped by the parser instead of being treated as a data-quality
//      spoil.
//   5. A negative `before` cursor was silently clamped to zero, silently
//      widening the caller's own declared window. Cursors are now validated
//      strictly (integer, 0 <= before <= after <= current file size) and
//      never clamped or widened -- an invalid cursor throws.
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

class MalformedRowError extends Error {
  constructor(detail) { super('malformed row inside the checked window'); this.detail = detail; }
}

// Strict cursor validation (Hale falsifier 5): never clamp, never widen.
// currentSize is the file's real size right now -- `after` may legitimately
// equal it (the common case) but can never exceed it.
function validateWindow(before, after, currentSize, label) {
  if (!Number.isInteger(before) || before < 0) {
    throw Object.assign(new Error(`${label}.before must be a non-negative integer, got ${JSON.stringify(before)}`), { code: 'INVALID_CURSOR' });
  }
  if (!Number.isInteger(after) || after < 0) {
    throw Object.assign(new Error(`${label}.after must be a non-negative integer, got ${JSON.stringify(after)}`), { code: 'INVALID_CURSOR' });
  }
  if (before > after) {
    throw Object.assign(new Error(`${label}.before (${before}) must be <= ${label}.after (${after})`), { code: 'INVALID_CURSOR_ORDER' });
  }
  if (after > currentSize) {
    throw Object.assign(new Error(`${label}.after (${after}) exceeds the file's current size (${currentSize}) — a window can never claim to cover bytes that don't exist yet`), { code: 'CURSOR_BEYOND_FILE_END' });
  }
}

// Malformed/non-object rows are a spoil reason (Hale falsifier 4), not a
// filter -- a corrupt line inside the exact window being relied on as
// evidence must never be silently invisible.
function readRowsInWindow(storeDir, date, filename, before, after, label) {
  const path = join(storeDir, '_sessions', date, filename);
  const currentSize = existsSync(path) ? statSync(path).size : 0;
  validateWindow(before, after, currentSize, label);
  const length = after - before;
  if (length === 0) return [];
  const fd = openSync(path, 'r');
  let buf;
  try {
    buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, before);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      throw new MalformedRowError(line.slice(0, 200));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new MalformedRowError(line.slice(0, 200));
    }
    rows.push(parsed);
  }
  return rows;
}

/**
 * checkTrialWindow — the join oracle. Returns { ok:true, retrieval, outcome }
 * only when every spoil condition is ruled out; otherwise
 * { ok:false, reason:<CODE>, ...detail } naming exactly which one fired.
 *
 * @param {string} storeDir
 * @param {object} opts
 * @param {string} opts.date                  YYYY-MM-DD session-log date
 * @param {{before:number, after:number}} opts.retrievalWindow
 *   cursors into retrieval-log.jsonl (from captureCursor)
 * @param {{before:number, after:number}} opts.outcomeWindow
 *   cursors into outcome-log.jsonl (from captureCursor)
 * @param {string} opts.expectedArm              required requested_arm value
 * @param {string} opts.expectedHarness          required (Hale falsifier 3)
 * @param {string} opts.expectedSessionId        required
 * @param {string} opts.expectedProducerVersion  required
 * @param {string} opts.expectedProducerSha      required
 */
export function checkTrialWindow(storeDir, opts) {
  const { date, retrievalWindow, outcomeWindow, expectedArm, expectedHarness, expectedSessionId, expectedProducerVersion, expectedProducerSha } = opts || {};
  if (!date) throw new Error('checkTrialWindow requires date');
  if (!retrievalWindow || !outcomeWindow) throw new Error('checkTrialWindow requires retrievalWindow and outcomeWindow cursors — never scans the whole log');
  if (!expectedArm) throw new Error('checkTrialWindow requires expectedArm — an untagged join proves nothing about which arm ran');
  for (const [name, value] of [
    ['expectedHarness', expectedHarness], ['expectedSessionId', expectedSessionId],
    ['expectedProducerVersion', expectedProducerVersion], ['expectedProducerSha', expectedProducerSha],
  ]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`checkTrialWindow requires ${name} — proving a join without stating the identity it must carry proves nothing`);
    }
  }

  let newRetrievals, newOutcomes;
  try {
    newRetrievals = readRowsInWindow(storeDir, date, 'retrieval-log.jsonl', retrievalWindow.before, retrievalWindow.after, 'retrievalWindow')
      .filter((r) => r.kind === 'retrieval');
    newOutcomes = readRowsInWindow(storeDir, date, 'outcome-log.jsonl', outcomeWindow.before, outcomeWindow.after, 'outcomeWindow')
      .filter((r) => r.kind === 'retrieval-outcome');
  } catch (e) {
    if (e instanceof MalformedRowError) {
      return { ok: false, reason: 'MALFORMED_ROW_IN_WINDOW', detail: e.detail };
    }
    throw e;
  }

  // Hale falsifier 1: any OTHER retrieval row in the window is contamination,
  // not something to filter past on the way to the arm match. Exactly one
  // retrieval row, period, THEN check its arm.
  if (newRetrievals.length === 0) {
    return { ok: false, reason: 'NO_RETRIEVAL_ROWS_IN_WINDOW' };
  }
  if (newRetrievals.length > 1) {
    return { ok: false, reason: 'MULTIPLE_RETRIEVAL_ROWS_IN_WINDOW', count: newRetrievals.length };
  }
  const retrieval = newRetrievals[0];
  if (retrieval.requested_arm !== expectedArm) {
    return { ok: false, reason: 'ARM_MISMATCH', expected: expectedArm, found: retrieval.requested_arm };
  }
  if (!retrieval.retrieval_id) {
    return { ok: false, reason: 'RETRIEVAL_MISSING_ID' };
  }

  // Hale falsifier 2: same shape on the outcome side. Exactly one outcome
  // row, period, THEN check it joins to this retrieval_id.
  if (newOutcomes.length === 0) {
    return { ok: false, reason: 'NO_OUTCOME_ROWS_IN_WINDOW' };
  }
  if (newOutcomes.length > 1) {
    return { ok: false, reason: 'MULTIPLE_OUTCOME_ROWS_IN_WINDOW', count: newOutcomes.length };
  }
  const outcome = newOutcomes[0];
  if (outcome.retrieval_id !== retrieval.retrieval_id) {
    return { ok: false, reason: 'OUTCOME_RETRIEVAL_ID_MISMATCH', expected: retrieval.retrieval_id, found: outcome.retrieval_id };
  }

  // The "immediate Stop outcome" shape specifically — answer-close-hook.mjs
  // always writes unknown/unobservable at Stop time; a stronger outcome row
  // is legitimate but is a DIFFERENT, later event, not what this checks.
  if (outcome.usefulness_outcome !== 'unknown' || outcome.evidence_authority !== 'unobservable') {
    return { ok: false, reason: 'NOT_THE_IMMEDIATE_STOP_OUTCOME_SHAPE', retrieval_id: retrieval.retrieval_id, found: { usefulness_outcome: outcome.usefulness_outcome, evidence_authority: outcome.evidence_authority } };
  }

  // Identity checks — all four now required above, so this is a pure match,
  // never an optional skip (Hale falsifier 3).
  const identityChecks = [
    ['expectedHarness', 'harness', 'HARNESS_MISMATCH'],
    ['expectedSessionId', 'session_id', 'SESSION_MISMATCH'],
    ['expectedProducerVersion', 'producer_version', 'PRODUCER_VERSION_MISMATCH'],
    ['expectedProducerSha', 'producer_sha', 'PRODUCER_SHA_MISMATCH'],
  ];
  for (const [optKey, field, reason] of identityChecks) {
    if (outcome[field] !== opts[optKey]) {
      return { ok: false, reason, expected: opts[optKey], found: outcome[field], retrieval_id: retrieval.retrieval_id };
    }
  }

  // This ok:true proves the join, nothing about delivery — callers must
  // never present it as a delivered-pack/host-exposure receipt.
  return { ok: true, retrieval, outcome };
}
