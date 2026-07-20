import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(PILOT, '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const { captureCursor, checkTrialWindow, REASONING_ARMS } = await import(pathToFileURL(join(PILOT, 'trial-window-join-checker.mjs')).href);
const { recordRetrievalEvent } = await import(pathToFileURL(join(SCRIPTS, 'record-retrieval-event.mjs')).href);
const { recordRetrievalOutcome } = await import(pathToFileURL(join(SCRIPTS, 'record-retrieval-outcome.mjs')).href);

const DATE = '2026-07-20';
const HARNESS = 'claude-code';
const SESSION_ID = 'sess-1';
const PRODUCER_VERSION = '3.12.1-pilot.1';
const PRODUCER_SHA = 'a'.repeat(40);

// Real product vocabulary (retrieve-context-hook.mjs), not invented values.
const ARM = 'always-on';
const OTHER_ARM = 'deterministic-only';
assert.ok(REASONING_ARMS.includes(ARM) && REASONING_ARMS.includes(OTHER_ARM), 'test fixtures must use the real closed vocabulary');

const EXPECTED_IDENTITY = {
  expectedHarness: HARNESS,
  expectedSessionId: SESSION_ID,
  expectedProducerVersion: PRODUCER_VERSION,
  expectedProducerSha: PRODUCER_SHA,
};

function store() {
  const dir = mkdtempSync(join(tmpdir(), 'trial-window-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  return dir;
}

function plantRetrieval(root, { retrievalId, arm = ARM, directiveFired = true, date = DATE }) {
  const out = recordRetrievalEvent(root, {
    trigger: 'per-turn-hook',
    mechanism: 'model-free-substrate',
    retrieval_id: retrievalId,
    intent_topics: ['pilot-trial'],
    tier_reached: 1,
    escalation_path: [1],
    units_retrieved: [{ id: 'u1', tier: 1 }],
    requested_arm: arm,
    directive_fired: directiveFired,
  }, { today: date });
  assert.equal(out.written, true, 'fixture retrieval must actually write');
  return out;
}

function plantImmediateOutcome(root, { retrievalId, harness = HARNESS, sessionId = SESSION_ID, answerTurnId = 'turn-1', producerVersion = PRODUCER_VERSION, producerSha = PRODUCER_SHA, date = DATE }) {
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
    harness: HARNESS, session_id: SESSION_ID, answer_turn_id: 'turn-2',
    producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA,
  }, { today: date });
}

function checkArgs(overrides = {}) {
  return { date: DATE, expectedArm: ARM, expectedDirectiveFired: true, ...EXPECTED_IDENTITY, ...overrides };
}

test('happy path: one arm-tagged retrieval joined to its one immediate Stop outcome inside the window', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.retrieval.retrieval_id, 'r-1');
    assert.equal(result.outcome.retrieval_id, 'r-1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Cursor/before-after-window scoped, never global-log counting. An old,
// fully-matching pair planted BEFORE the window must never be picked up
// just because it exists somewhere earlier in the same file.
test('cursor scoping: an earlier matching pair outside the window is ignored, not counted', () => {
  const root = store();
  try {
    plantRetrieval(root, { retrievalId: 'r-old' });
    plantImmediateOutcome(root, { retrievalId: 'r-old' });

    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-new' });
    plantImmediateOutcome(root, { retrievalId: 'r-new' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.retrieval.retrieval_id, 'r-new', 'the pre-window pair must never be the match');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: two retrievals in the window is ambiguous, not a pick-first', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-a' });
    plantRetrieval(root, { retrievalId: 'r-b' });
    plantImmediateOutcome(root, { retrievalId: 'r-a' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MULTIPLE_RETRIEVAL_ROWS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 falsifier (hale--de3066d-window-design-pass-five-fail-open-hold):
// a second retrieval for a DIFFERENT arm inside the window used to be
// invisible entirely (the old code only counted requested-arm matches).
test('round 1 falsifier: a second retrieval for a DIFFERENT arm inside the window is still contamination, not invisible', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantRetrieval(root, { retrievalId: 'r-2', arm: OTHER_ARM, directiveFired: false }); // different arm — old code ignored this
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MULTIPLE_RETRIEVAL_ROWS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: no outcome in the window fails closed, never reports ok on the retrieval alone', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl'); // nothing written — before === after

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_OUTCOME_ROWS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: two outcome rows for the same retrieval_id inside the window is ambiguous', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', answerTurnId: 'turn-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', answerTurnId: 'turn-1-retry' }); // double-close bug, still inside window

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MULTIPLE_OUTCOME_ROWS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 falsifier: a second outcome for a DIFFERENT retrieval_id inside
// the outcome window used to be invisible (the old code filtered to the
// target retrieval_id before counting).
test('round 1 falsifier: a second outcome for a DIFFERENT retrieval_id inside the window is still contamination, not invisible', () => {
  const root = store();
  try {
    // A real outcome row must reference a real retrieval row. Plant
    // 'r-unrelated's retrieval BEFORE either cursor is captured, so it never
    // enters the retrieval window at all — only its OUTCOME (planted below,
    // inside the outcome window) is under test here.
    plantRetrieval(root, { retrievalId: 'r-unrelated', arm: OTHER_ARM, directiveFired: false });

    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });
    recordRetrievalOutcome(root, {
      retrieval_id: 'r-unrelated', usefulness_outcome: 'unknown', evidence_authority: 'unobservable',
      harness: HARNESS, session_id: SESSION_ID, answer_turn_id: 'turn-unrelated',
      producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA,
    }, { today: DATE }); // old code filtered this away before counting

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MULTIPLE_OUTCOME_ROWS_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 falsifier: every expected-identity argument used to be optional;
// omitting all four still returned ok:true.
test('round 1 falsifier: omitting expected identity throws instead of silently skipping the check', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    assert.throws(
      () => checkTrialWindow(root, {
        date: DATE,
        retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
        outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
        expectedArm: ARM,
        expectedDirectiveFired: true,
        // every expected identity field omitted
      }),
      /expectedHarness/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 falsifier: a malformed/non-object JSON line inside the window
// used to be silently dropped by the parser instead of spoiling the check.
test('round 1 falsifier: a malformed JSON line inside the window is a spoil reason, not a silent drop', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    // Corrupt line landing inside the SAME window (simulates a torn/partial
    // write or a hand-edited log) — real path, appended directly.
    appendFileSync(join(root, '_sessions', DATE, 'retrieval-log.jsonl'), 'not valid json at all\n');
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MALFORMED_ROW_IN_WINDOW');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 1 falsifier: a negative `before` cursor used to be silently clamped
// to zero, silently widening the caller's own declared window.
test('round 1 falsifier: a negative cursor throws instead of being silently clamped to zero', () => {
  const root = store();
  try {
    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });
    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    assert.throws(
      () => checkTrialWindow(root, checkArgs({
        retrievalWindow: { before: -10, after: retrievalAfter }, // would have silently widened the window
        outcomeWindow: { before: 0, after: outcomeAfter },
      })),
      (e) => e.code === 'INVALID_CURSOR',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cursor validation: after exceeding the file\'s current size throws instead of reading past the end', () => {
  const root = store();
  try {
    plantRetrieval(root, { retrievalId: 'r-1' });
    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    plantImmediateOutcome(root, { retrievalId: 'r-1' });
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    assert.throws(
      () => checkTrialWindow(root, checkArgs({
        retrievalWindow: { before: 0, after: retrievalAfter + 10_000 },
        outcomeWindow: { before: 0, after: outcomeAfter },
      })),
      (e) => e.code === 'CURSOR_BEYOND_FILE_END',
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: an outcome row inside the window that is not the immediate Stop shape fails closed', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantStrongerOutcome(root, { retrievalId: 'r-1' }); // 'useful'/'user-confirmed', not the Stop shape

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NOT_THE_IMMEDIATE_STOP_OUTCOME_SHAPE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: wrong producer_sha on the outcome fails closed, does not just warn', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', producerSha: 'b'.repeat(40) });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'PRODUCER_SHA_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: wrong harness or session identity on the outcome fails closed', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1', harness: 'codex', sessionId: 'sess-wrong' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HARNESS_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A later, legitimate, stronger outcome for the SAME retrieval_id, landing
// OUTSIDE the window that was actually checked, must not spoil an
// already-valid trial result. This is the product's real, allowed behavior
// (record-retrieval-outcome.mjs explicitly permits a second outcome row).
test('a stronger outcome landing after the checked window does not retroactively spoil the trial', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    // The window is fixed HERE, right after the immediate close — exactly
    // what a real caller would do right after the Stop hook is expected to
    // have fired.
    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    // A real, later, stronger outcome arrives afterward — outside the window.
    plantStrongerOutcome(root, { retrievalId: 'r-1' });

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
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
    assert.throws(() => checkTrialWindow(root, checkArgs()), /retrievalWindow and outcomeWindow/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 2 falsifier (hale--7e92b7f-five-closed-four-product-match-failures),
// item 1: fixtures using an impossible arm value must never silently "match"
// -- expectedArm is validated against the real closed vocabulary.
test('round 2 falsifier 1: an impossible arm value throws instead of silently matching', () => {
  const root = store();
  try {
    assert.throws(
      () => checkTrialWindow(root, checkArgs({
        expectedArm: 'memory-on', // not in REASONING_ARMS
        retrievalWindow: { before: 0, after: 0 },
        outcomeWindow: { before: 0, after: 0 },
      })),
      /REASONING_ARMS|automatic|deterministic-only|always-on/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 2 falsifier, item 2: requested_arm proves intent, not that the arm's
// behavioral difference actually fired. An always-on row with
// directive_fired:false must not silently pass as if the directive fired.
test('round 2 falsifier 2: requested_arm alone does not prove the directive actually fired', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1', arm: ARM, directiveFired: false }); // always-on but didn't actually fire
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      expectedDirectiveFired: true,
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'DIRECTIVE_FIRED_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('round 2 falsifier 2b: omitting expectedDirectiveFired throws instead of silently skipping the check', () => {
  const root = store();
  try {
    assert.throws(
      () => checkTrialWindow(root, {
        date: DATE, expectedArm: ARM, ...EXPECTED_IDENTITY,
        retrievalWindow: { before: 0, after: 0 },
        outcomeWindow: { before: 0, after: 0 },
      }),
      /expectedDirectiveFired/,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 2 falsifier, item 3: a Stop outcome missing answer_turn_id used to
// pass despite the product's own outcome schema requiring it non-empty.
// The real writer (recordRetrievalOutcome) enforces this itself, so this
// simulates a corrupted/hand-edited row bypassing that writer.
test('round 2 falsifier 3: an outcome row missing answer_turn_id fails closed', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    const badRow = {
      kind: 'retrieval-outcome', retrieval_id: 'r-1',
      usefulness_outcome: 'unknown', evidence_authority: 'unobservable',
      harness: HARNESS, session_id: SESSION_ID,
      // answer_turn_id deliberately absent
      producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA,
    };
    appendFileSync(join(root, '_sessions', DATE, 'outcome-log.jsonl'), JSON.stringify(badRow) + '\n');

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'OUTCOME_MISSING_ANSWER_TURN_ID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Round 2 falsifier, item 4: rows were filtered to the expected kind BEFORE
// exact-one enforcement, so a wrong-kind row inside the window vanished
// instead of counting as contamination.
test('round 2 falsifier 4: a valid JSON row with the wrong kind inside the window is contamination, not filtered away', () => {
  const root = store();
  try {
    const retrievalBefore = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(root, DATE, 'outcome-log.jsonl');

    plantRetrieval(root, { retrievalId: 'r-1' });
    // A structurally valid, well-formed JSON object, but the wrong `kind` —
    // e.g. some other event type sharing the same log file by mistake.
    appendFileSync(join(root, '_sessions', DATE, 'retrieval-log.jsonl'), JSON.stringify({ kind: 'something-else', note: 'not a retrieval row' }) + '\n');
    plantImmediateOutcome(root, { retrievalId: 'r-1' });

    const retrievalAfter = captureCursor(root, DATE, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(root, DATE, 'outcome-log.jsonl');

    const result = checkTrialWindow(root, checkArgs({
      retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
      outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MULTIPLE_RETRIEVAL_ROWS_IN_WINDOW', 'the wrong-kind row must still count toward exact-one, not vanish');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
