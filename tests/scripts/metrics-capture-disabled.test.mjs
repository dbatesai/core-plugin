import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeScorecard, appendScorecard } from '../../plugins/core/skills/core/scripts/scorecard.mjs';
import { evaluateTripwires } from '../../plugins/core/skills/core/scripts/metrics-tripwires.mjs';

function makeProject(root, { captureOff = false } = {}) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  const pointer = { workspace_id: 'capture-disabled-fixture' };
  if (captureOff) pointer.turn_capture = false;
  writeFileSync(join(project, 'workspace.json'), JSON.stringify(pointer));
  return project;
}

/** A pinned card whose window saw retrieval happen and nothing captured. */
function pinSilentCard(project, { captureEnabled, failures = 0 }) {
  const card = {
    ...computeScorecard(project, { now: '2026-07-28T00:00:00.000Z' }),
    volumes: {
      turns_captured: 0, retrieval_rows: 12,
      turns_captured_window: 0, retrieval_rows_window: 12,
      hook_retrieval_rows_window: 12,
    },
    capture_health: { attempts: failures, failures, consecutive_failures: failures, last_failure_reason: null, last_failure_ts: null },
    capture_enabled: captureEnabled,
  };
  appendScorecard(project, card);
  return card;
}

test('a scorecard records whether capture was on, so a silent window is attributable later', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-card-'));
  try {
    assert.equal(computeScorecard(makeProject(join(root, 'a'))).capture_enabled, true);
    mkdirSync(join(root, 'b'), { recursive: true });
    assert.equal(computeScorecard(makeProject(join(root, 'b'), { captureOff: true })).capture_enabled, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture turned OFF reports a disabled marker, never "the recorder is silently broken"', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-off-'));
  try {
    const project = makeProject(root, { captureOff: true });
    pinSilentCard(project, { captureEnabled: false });
    const res = evaluateTripwires(project, { now: new Date('2026-07-28T01:00:00Z') });
    const kinds = res.tripped.map((t) => t.kind);
    assert.ok(kinds.includes('capture-disabled'), `disabled marker present (${kinds.join(', ')})`);
    assert.ok(!kinds.includes('capture-dead'), 'an opt-out is not a dead recorder');
    assert.ok(!kinds.includes('capture-coverage'), 'an opt-out is not partial coverage');
    const marker = res.tripped.find((t) => t.kind === 'capture-disabled');
    assert.match(marker.message, /off for this project/);
    assert.ok(!/silently broken/.test(marker.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture left ON with the same silence still reports a dead recorder', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-on-'));
  try {
    const project = makeProject(root);
    pinSilentCard(project, { captureEnabled: true });
    const res = evaluateTripwires(project, { now: new Date('2026-07-28T01:00:00Z') });
    const kinds = res.tripped.map((t) => t.kind);
    assert.ok(kinds.includes('capture-dead'), `dead recorder still reported (${kinds.join(', ')})`);
    assert.ok(!kinds.includes('capture-disabled'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the disabled marker still names write failures recorded before the opt-out', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-off-fail-'));
  try {
    const project = makeProject(root, { captureOff: true });
    pinSilentCard(project, { captureEnabled: false, failures: 4 });
    const res = evaluateTripwires(project, { now: new Date('2026-07-28T01:00:00Z') });
    const marker = res.tripped.find((t) => t.kind === 'capture-disabled');
    assert.ok(marker, 'disabled marker present');
    assert.match(marker.message, /4 recorded write failure/);
    assert.ok(!res.tripped.some((t) => t.kind === 'capture-failure'), 'a failure count is reported, not alarmed, once capture is off');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture off with no retrieval volume stays silent — nothing is being misread', () => {
  const root = mkdtempSync(join(tmpdir(), 'cap-off-quiet-'));
  try {
    const project = makeProject(root, { captureOff: true });
    const card = {
      ...computeScorecard(project, { now: '2026-07-28T00:00:00.000Z' }),
      volumes: { turns_captured: 0, retrieval_rows: 0, turns_captured_window: 0, retrieval_rows_window: 0, hook_retrieval_rows_window: 0 },
      capture_enabled: false,
    };
    appendScorecard(project, card);
    const res = evaluateTripwires(project, { now: new Date('2026-07-28T01:00:00Z') });
    assert.ok(!res.tripped.some((t) => t.kind === 'capture-disabled'), 'no absence is being read as data, so nothing to say');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
