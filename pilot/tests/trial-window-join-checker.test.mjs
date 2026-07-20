import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(PILOT, '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const { captureCursor, checkTrialWindow } = await import(pathToFileURL(join(PILOT, 'trial-window-join-checker.mjs')).href);
const { recordRetrievalEvent } = await import(pathToFileURL(join(SCRIPTS, 'record-retrieval-event.mjs')).href);
const { recordRetrievalOutcome } = await import(pathToFileURL(join(SCRIPTS, 'record-retrieval-outcome.mjs')).href);

const DATE = '2026-07-20';

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'trial-window-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  return dir;
}

function plantRetrieval(root, { retrievalId, arm, date = DATE }) {
  const out = recordRetrievalEvent(root, {
    trigger: 'per-turn-hook',
    mechanism: 'model-free-substrate',
    retrieval_id: retrievalId,
    intent_topics: ['pilot-trial'],
    tier_reached: 1,
    escalation_path: [1],
    units_retrieved: [{ id: 'u1', tier: 1 }],
    requested_arm: arm,
    directive_fired: false,
  }, { today: date });
  assert.equal(out.written, true, 'fixture retrieval must actually write');
  return out;
}

function plantImmediateOutcome(root, { retrievalId, harness = 'claude-code', sessionId = 'sess-1', answerTurnId = 'turn-1', producerVersion = '3.12.1-pilot.1', producerSha = 'a'.repeat(40), date = DATE }) {
  const out = recordRetrievalOutcome(root, {
    retrieval_id: retrievalId,
    usefulness_outcome: 'unknown',
    evidence_authority: 'unobservable',
    harness, session_id: sessionId, answer_turn_id: answerTurnId,
    producer_version: producerVersion, producer_sha: producerSha,
  }, { today: date });
  assert.equal(out.written, true, 'fixture outcome must actually write');
  return out;
}

function plantStrongerOutcome(root, { retrievalId, date = DATE }) {
  return recordRetrievalOutcome(root, {
    retrieval_id: retrievalId,
    usefulness_outcome: 'useful',
    evidence_authority: 'user-confirmed',
    harness: 'claude-code', session_id: 'sess-1', answer_turn_id: 'turn-2',
    producer_version: '3.12.1-pilot.1', producer_sha: 'a'.repeat(40),
  }, { today: date });
}

test('happy path: one arm-tagged retrieval joined to its one immediate Stop outcome inside the window', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', harness: 'claude-code', sessionId: 'sess-1', producerVersion: '3.12.1-pilot.1', producerSha: 'a'.repeat(40) });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
      expectedHarness: 'claude-code',
      expectedSessionId: 'sess-1',
      expectedProducerVersion: '3.12.1-pilot.1',
      expectedProducerSha: 'a'.repeat(40),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.retrieval.retrieval_id, 'r-1');
    assert.equal(result.outcome.retrieval_id, 'r-1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 1: cursor/before-after-window scoped, never global-log counting. An
// old, fully-matching pair planted BEFORE the window must never be picked up
// just because it exists somewhere earlier in the same file.
test('cursor scoping: an earlier matching pair outside the window is ignored, not counted', () => {
  const root = store();
  try {
    plantRetrieval(root, { retrievalId: 'r-old', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-old' });

    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-new', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-new' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.retrieval.retrieval_id, 'r-new', 'the pre-window pair must never be the match');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 5: duplicate retrievals spoil closed.
test('spoil: two arm-tagged retrievals inside the window is ambiguous, not a pick-first', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-a', arm: 'memory-on' });
    plantRetrieval(root, { retrievalId: 'r-b', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-a' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'DUPLICATE_ARM_TAGGED_RETRIEVALS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 5: missing rows spoil closed (no outcome ever arrived in the window).
test('spoil: no outcome in the window fails closed, never reports ok on the retrieval alone', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl'); // nothing written — before === after

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_OUTCOME_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 5: ambiguous outcomes spoil closed — two rows for the SAME
// retrieval_id both landing inside the window (e.g. a double-close bug)
// must not be silently resolved by picking either one.
test('spoil: two outcome rows for the same retrieval_id inside the window is ambiguous', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', answerTurnId: 'turn-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', answerTurnId: 'turn-1-retry' }); // double-close bug, still inside window

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AMBIGUOUS_OUTCOME_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The only row inside the window is NOT the immediate unknown/unobservable
// Stop shape — must not be accepted as if it were.
test('spoil: an outcome row inside the window that is not the immediate Stop shape fails closed', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantStrongerOutcome(root, { retrievalId: 'r-1' }); // 'useful'/'user-confirmed', not the Stop shape

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_THE_IMMEDIATE_STOP_OUTCOME_SHAPE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 4 + 5: a second producer (wrong producer_sha) spoils closed.
test('spoil: wrong producer_sha on the outcome fails closed, does not just warn', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', producerSha: 'b'.repeat(40) });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
      expectedProducerSha: 'a'.repeat(40),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRODUCER_SHA_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 4 + 5: wrong harness/session identity spoils closed.
test('spoil: wrong harness or session identity on the outcome fails closed', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', harness: 'codex', sessionId: 'sess-wrong' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
      expectedHarness: 'claude-code',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HARNESS_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Point 6: a later, legitimate, stronger outcome for the SAME retrieval_id,
// landing OUTSIDE the window that was actually checked, must not spoil an
// already-valid trial result. This is the product's real, allowed behavior
// (record-retrieval-outcome.mjs explicitly permits a second outcome row).
test('a stronger outcome landing after the checked window does not retroactively spoil the trial', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: 'memory-on' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    // The window is fixed HERE, right after the immediate close — exactly
    // what a real caller would do right after the Stop hook is expected to
    // have fired.
    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    // A real, later, stronger outcome arrives afterward — outside the window.
    plantStrongerOutcome(root, { retrievalId: 'r-1' });

    const result = checkTrialWindow(root, {
      date: DATE,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
      expectedArm: 'memory-on',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('captureCursor returns 0 for a log file that does not exist yet', () => {
  const root = store();
  try {
    assert.equal(captureCursor(root, DATE, 'retrieval-log.jsonl'), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkTrialWindow requires explicit cursors — refuses to fall back to a global scan', () => {
  const root = store();
  try {
    assert.throws(() => checkTrialWindow(root, { date: DATE, expectedArm: 'memory-on' }), /retrievalWindow and outcomeWindow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
