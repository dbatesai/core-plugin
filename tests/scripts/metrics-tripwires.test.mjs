import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  evaluateTripwires,
  TRIPWIRE_THRESHOLDS,
} from '../../plugins/core/skills/core/scripts/metrics-tripwires.mjs';
import { appendScorecard } from '../../plugins/core/skills/core/scripts/scorecard.mjs';
import { assessRoundStaleness } from '../../plugins/core/skills/core/scripts/self-test-round.mjs';

const TRIPWIRES_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'metrics-tripwires.mjs');

function makeProject(root) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'tw-fixture' }));
  return project;
}

// Hand-built pinned card with healthy defaults, overridable per test.
function card(ts, over = {}) {
  return {
    kind: 'scorecard', schema_version: '1.0.0', ts,
    data_window: { from: null, to: ts },
    producer_version: 'v', producer_sha: 's', judge_version: '1.0.0', thresholds: null,
    hindsight: { judged_turns: 20, hit_right: 18, noise: 1, hindsight_miss: 1, storage_gap: 0 },
    self_test: { headline: 0.85, round_id: 1 },
    volumes: { turns_captured: 20, retrieval_rows: 20 },
    capture_health: { attempts: 20, failures: 0, consecutive_failures: 0 },
    ...over,
  };
}

function plant(project, cards) {
  for (const c of cards) appendScorecard(project, c);
}

test('healthy history → no trips, CLI prints nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-healthy-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-20T00:00:00Z'), card('2026-07-21T00:00:00Z')]);
    const res = evaluateTripwires(project);
    assert.equal(res.healthy, true);
    assert.deepEqual(res.tripped, []);
    const out = execFileSync('node', [TRIPWIRES_CLI, project], { encoding: 'utf8' });
    assert.equal(out.trim(), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('self-test headline drop beyond the threshold trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-drop-'));
  try {
    const project = makeProject(root);
    plant(project, [
      card('2026-07-20T00:00:00Z', { self_test: { headline: 0.85, round_id: 1 } }),
      card('2026-07-21T00:00:00Z', { self_test: { headline: 0.85 - TRIPWIRE_THRESHOLDS.self_test_drop - 0.01, round_id: 1 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.equal(res.healthy, false);
    assert.ok(res.tripped.some((t) => t.kind === 'self-test-drop'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a blind-test headline that is low and perfectly flat still trips', () => {
  // The drop wire compares against the previous card, so a score that has been
  // bad since the first round reads as "steady". Without a level check the door
  // reports earned quiet over it.
  const root = mkdtempSync(join(tmpdir(), 'tw-low-flat-'));
  try {
    const project = makeProject(root);
    const low = TRIPWIRE_THRESHOLDS.self_test_floor - 0.1;
    plant(project, [
      card('2026-07-20T00:00:00Z', { self_test: { headline: low, round_id: 1 } }),
      card('2026-07-21T00:00:00Z', { self_test: { headline: low, round_id: 1 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.equal(res.healthy, false);
    assert.ok(res.tripped.some((t) => t.kind === 'self-test-low'), JSON.stringify(res.tripped));
    assert.ok(!res.tripped.some((t) => t.kind === 'self-test-drop'), 'flat score must not read as a drop');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a headline at or above the floor and flat does not trip the level wire', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-at-floor-'));
  try {
    const project = makeProject(root);
    const atFloor = TRIPWIRE_THRESHOLDS.self_test_floor;
    plant(project, [
      card('2026-07-20T00:00:00Z', { self_test: { headline: atFloor, round_id: 1 } }),
      card('2026-07-21T00:00:00Z', { self_test: { headline: atFloor, round_id: 1 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(!res.tripped.some((t) => t.kind === 'self-test-low'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a headline that is both low and dropping reports the drop only', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-low-drop-'));
  try {
    const project = makeProject(root);
    plant(project, [
      card('2026-07-20T00:00:00Z', { self_test: { headline: 0.45, round_id: 1 } }),
      card('2026-07-21T00:00:00Z', { self_test: { headline: 0.20, round_id: 1 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'self-test-drop'), JSON.stringify(res.tripped));
    assert.ok(!res.tripped.some((t) => t.kind === 'self-test-low'), 'the drop message is the specific one; do not double-report');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('hindsight-miss rate strictly rising across the trend window trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-trend-'));
  try {
    const project = makeProject(root);
    plant(project, [
      card('2026-07-19T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 18, noise: 0, hindsight_miss: 2, storage_gap: 0 } }),
      card('2026-07-20T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 16, noise: 0, hindsight_miss: 4, storage_gap: 0 } }),
      card('2026-07-21T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 14, noise: 0, hindsight_miss: 6, storage_gap: 0 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'miss-trend'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('storage-gap recurrence across cards trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-gap-'));
  try {
    const project = makeProject(root);
    plant(project, [
      card('2026-07-20T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 18, noise: 0, hindsight_miss: 0, storage_gap: 2 } }),
      card('2026-07-21T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 18, noise: 0, hindsight_miss: 0, storage_gap: 1 } }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'storage-gap-recurrence'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture-failure floors (Gate A): rate needs ≥20 attempts; 3 consecutive always trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-capture-'));
  try {
    const project = makeProject(root);
    // 2 failures in 10 attempts = 20% but UNDER the attempt floor → no trip
    plant(project, [card('2026-07-21T00:00:00Z', {
      capture_health: { attempts: 10, failures: 2, consecutive_failures: 1 },
    })]);
    assert.equal(evaluateTripwires(project).tripped.some((t) => t.kind === 'capture-failure'), false,
      'rate floor requires minimum attempts');
    // 3 consecutive failures trips even in a short session
    const root2 = mkdtempSync(join(tmpdir(), 'tw-capture2-'));
    const project2 = makeProject(root2);
    plant(project2, [card('2026-07-21T00:00:00Z', {
      capture_health: { attempts: 5, failures: 3, consecutive_failures: 3 },
    })]);
    assert.equal(evaluateTripwires(project2).tripped.some((t) => t.kind === 'capture-failure'), true,
      'consecutive-failure streak trips regardless of attempts');
    rmSync(root2, { recursive: true, force: true });
    // 25% over 40 attempts trips on rate
    const root3 = mkdtempSync(join(tmpdir(), 'tw-capture3-'));
    const project3 = makeProject(root3);
    plant(project3, [card('2026-07-21T00:00:00Z', {
      capture_health: { attempts: 40, failures: 10, consecutive_failures: 0 },
    })]);
    assert.equal(evaluateTripwires(project3).tripped.some((t) => t.kind === 'capture-failure'), true);
    rmSync(root3, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('flight recorder dead: retrieval rows without evidence rows trips', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-dead-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-21T00:00:00Z', {
      volumes: { turns_captured: 0, retrieval_rows: 15 },
    })]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'capture-dead'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('flight recorder dead AFTER prior volume: a cumulative-zero check would miss this, a window check catches it', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-dead-after-'));
  try {
    const project = makeProject(root);
    // The real shape: a handful of rows exist from an earlier run, then capture
    // stops while retrieval keeps going. All-time turns_captured is nonzero
    // forever, so only a per-window count can see the silence.
    plant(project, [
      card('2026-07-20T00:00:00Z', { volumes: { turns_captured: 5, retrieval_rows: 5 } }),
      card('2026-07-21T00:00:00Z', {
        volumes: {
          turns_captured: 5, retrieval_rows: 200,
          turns_captured_window: 0, retrieval_rows_window: 195,
        },
      }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'capture-dead'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture covering only a fraction of hook retrievals trips the coverage wire', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-cov-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-21T00:00:00Z', {
      volumes: {
        turns_captured: 30, retrieval_rows: 300,
        turns_captured_window: 12, hook_retrieval_rows_window: 100,
      },
    })]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.some((t) => t.kind === 'capture-coverage'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('healthy coverage does NOT trip the coverage wire', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-cov-ok-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-21T00:00:00Z', {
      volumes: {
        turns_captured: 95, retrieval_rows: 300,
        turns_captured_window: 95, hook_retrieval_rows_window: 100,
      },
    })]);
    assert.equal(evaluateTripwires(project).tripped.some((t) => t.kind === 'capture-coverage'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a low-volume window never trips the coverage wire (no false alarm on a short session)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-cov-low-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-21T00:00:00Z', {
      volumes: {
        turns_captured: 1, retrieval_rows: 8,
        turns_captured_window: 1, hook_retrieval_rows_window: 8,
      },
    })]);
    assert.equal(evaluateTripwires(project).tripped.some((t) => t.kind === 'capture-coverage'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a frozen chain trips the staleness wire — the one signal that survives total chain death', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-stale-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-06-01T00:00:00Z', { volumes: { turns_captured: 5, retrieval_rows: 5 } })]);
    const res = evaluateTripwires(project, { now: new Date('2026-07-21T00:00:00Z') });
    assert.ok(res.tripped.some((t) => t.kind === 'scorecard-stale'), JSON.stringify(res.tripped));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a recent scorecard does NOT trip the staleness wire', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-stale-ok-'));
  try {
    const project = makeProject(root);
    plant(project, [card('2026-07-20T00:00:00Z', { volumes: { turns_captured: 5, retrieval_rows: 5 } })]);
    const res = evaluateTripwires(project, { now: new Date('2026-07-21T00:00:00Z') });
    assert.equal(res.tripped.some((t) => t.kind === 'scorecard-stale'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no scorecards at all → healthy silence (nothing to alarm about yet)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-none-'));
  try {
    const project = makeProject(root);
    const res = evaluateTripwires(project);
    assert.equal(res.healthy, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('trip messages are plain language — no internals jargon', () => {
  const root = mkdtempSync(join(tmpdir(), 'tw-voice-'));
  try {
    const project = makeProject(root);
    plant(project, [
      card('2026-07-19T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 18, noise: 0, hindsight_miss: 2, storage_gap: 2 } }),
      card('2026-07-20T00:00:00Z', { hindsight: { judged_turns: 20, hit_right: 16, noise: 0, hindsight_miss: 4, storage_gap: 2 }, self_test: { headline: 0.6, round_id: 1 } }),
      card('2026-07-21T00:00:00Z', {
        hindsight: { judged_turns: 20, hit_right: 14, noise: 0, hindsight_miss: 6, storage_gap: 2 },
        self_test: { headline: 0.5, round_id: 1 },
        capture_health: { attempts: 40, failures: 10, consecutive_failures: 4 },
        volumes: { turns_captured: 0, retrieval_rows: 15 },
      }),
    ]);
    const res = evaluateTripwires(project);
    assert.ok(res.tripped.length >= 4, 'the loaded fixture trips multiple wires');
    for (const t of res.tripped) {
      assert.equal(typeof t.message, 'string');
      for (const jargon of ['BM25', 'jsonl', 'JSONL', 'tier ', 'Tier 1', 'substrate']) {
        assert.ok(!t.message.includes(jargon), `jargon "${jargon}" in: ${t.message}`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---------------- Link 4b: self-test round staleness (pure logic) ----------------

test('assessRoundStaleness: fresh finished round → not due', () => {
  const res = assessRoundStaleness({
    registeredAt: '2026-07-20T00:00:00Z',
    hasResult: true,
    sessionDatesAfter: 3,
    currentUnits: 100,
    frozenUnits: 95,
    lastTriggerTs: null,
    now: '2026-07-24T00:00:00Z',
  });
  assert.equal(res.due, false);
});

test('assessRoundStaleness: corpus grew past the growth threshold → due', () => {
  const res = assessRoundStaleness({
    registeredAt: '2026-07-20T00:00:00Z', hasResult: true, sessionDatesAfter: 3,
    currentUnits: 130, frozenUnits: 100, lastTriggerTs: null, now: '2026-07-24T00:00:00Z',
  });
  assert.equal(res.due, true);
  assert.match(res.reason, /grew/);
});

test('assessRoundStaleness: too many sessions since registration → due', () => {
  const res = assessRoundStaleness({
    registeredAt: '2026-06-01T00:00:00Z', hasResult: true, sessionDatesAfter: 11,
    currentUnits: 100, frozenUnits: 100, lastTriggerTs: null, now: '2026-07-24T00:00:00Z',
  });
  assert.equal(res.due, true);
  assert.match(res.reason, /session/);
});

test('assessRoundStaleness: weekly hard cap suppresses even a due trigger', () => {
  const res = assessRoundStaleness({
    registeredAt: '2026-06-01T00:00:00Z', hasResult: true, sessionDatesAfter: 11,
    currentUnits: 130, frozenUnits: 100,
    lastTriggerTs: '2026-07-20T00:00:00Z', // 4 days ago — inside the cap
    now: '2026-07-24T00:00:00Z',
  });
  assert.equal(res.due, false);
  assert.match(res.reason, /cap/);
});

test('assessRoundStaleness: unfinished round (registered, never run) → not due (cost guard)', () => {
  const res = assessRoundStaleness({
    registeredAt: '2026-06-01T00:00:00Z', hasResult: false, sessionDatesAfter: 11,
    currentUnits: 130, frozenUnits: 100, lastTriggerTs: null, now: '2026-07-24T00:00:00Z',
  });
  assert.equal(res.due, false);
  assert.match(res.reason, /unfinished|not.*run/i);
});

test('assessRoundStaleness: no round at all → due (cold start), still capped', () => {
  assert.equal(assessRoundStaleness({
    registeredAt: null, hasResult: false, sessionDatesAfter: 0,
    currentUnits: 50, frozenUnits: null, lastTriggerTs: null, now: '2026-07-24T00:00:00Z',
  }).due, true);
  assert.equal(assessRoundStaleness({
    registeredAt: null, hasResult: false, sessionDatesAfter: 0,
    currentUnits: 50, frozenUnits: null,
    lastTriggerTs: '2026-07-23T00:00:00Z', now: '2026-07-24T00:00:00Z',
  }).due, false);
});
