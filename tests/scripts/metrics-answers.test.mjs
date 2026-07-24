// The answer-shaped /metrics default view (v3.14.0 Component 6): three
// outcome questions in sentences, sourced from PINNED scorecards + tripwire
// state only — presentation, no fresh computation. Honest degradation states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gatherAnswers, renderAnswerView } from '../../plugins/core/skills/core/scripts/metrics-check.mjs';
import { appendScorecard } from '../../plugins/core/skills/core/scripts/scorecard.mjs';

const CHECK_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'metrics-check.mjs');

function makeProject(root) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'ans-fixture' }));
  return project;
}

function card(ts, over = {}) {
  return {
    kind: 'scorecard', schema_version: '1.0.0', ts,
    data_window: { from: null, to: ts },
    producer_version: 'v', producer_sha: 's', judge_version: '1.0.0', thresholds: null,
    hindsight: { judged_turns: 100, hit_right: 89, noise: 4, hindsight_miss: 6, storage_gap: 0 },
    self_test: { headline: 0.82, round_id: 2 },
    volumes: { turns_captured: 100, retrieval_rows: 100 },
    capture_health: { attempts: 100, failures: 0, consecutive_failures: 0 },
    ...over,
  };
}

test('healthy pinned history renders three answer lines + the nothing-needs-attention line', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-healthy-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, card('2026-07-20T00:00:00Z', { self_test: { headline: 0.80, round_id: 1 } }));
    appendScorecard(project, card('2026-07-21T00:00:00Z'));
    const view = renderAnswerView(gatherAnswers(project));
    assert.match(view, /Is it storing the right memories\?/);
    assert.match(view, /Is it loading them when you need\?/);
    assert.match(view, /Does it pass its own blind test\?/);
    assert.match(view, /Nothing needs your attention right now\./);
    assert.match(view, /mechanical grade/, 'the loading verdict carries its trust label inline');
    assert.match(view, /82%/, 'self-test headline rendered as a percentage');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no pinned scorecards → all three lines honestly not-yet-measured', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-none-'));
  try {
    const project = makeProject(root);
    const view = renderAnswerView(gatherAnswers(project));
    assert.match(view, /not yet measured/i);
    assert.doesNotMatch(view, /\bYES\b|\bMOSTLY\b|\bNO\b —/, 'no verdict words without pinned evidence');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('capture opted out → storing/loading lines say so instead of pretending', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-off-'));
  try {
    const project = join(root, 'proj');
    mkdirSync(join(project, '_memories'), { recursive: true });
    writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'ans-off', turn_capture: false }));
    const view = renderAnswerView(gatherAnswers(project));
    assert.match(view, /turn capture is off/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a tripped wire replaces the nothing-line with the escalation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-trip-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, card('2026-07-21T00:00:00Z', {
      volumes: { turns_captured: 0, retrieval_rows: 15 },
    }));
    const view = renderAnswerView(gatherAnswers(project));
    assert.doesNotMatch(view, /Nothing needs your attention/);
    assert.match(view, /recorder|evidence/i, 'the capture-dead escalation surfaces');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verdict grading: gaps drive the storing line; hit rate drives the loading line', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-verdicts-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, card('2026-07-21T00:00:00Z', {
      hindsight: { judged_turns: 100, hit_right: 60, noise: 20, hindsight_miss: 20, storage_gap: 30 },
    }));
    const view = renderAnswerView(gatherAnswers(project));
    assert.match(view, /storing[\s\S]*?NO/i, '30% gaps is a NO on storing');
    assert.match(view, /60%/, 'the loading line carries the real hit rate');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the default view is jargon-free (the David test)', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-voice-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, card('2026-07-21T00:00:00Z'));
    const view = renderAnswerView(gatherAnswers(project));
    for (const jargon of ['BM25', 'jsonl', 'JSONL', 'substrate', 'Tier 1', 'tier_reached', 'scorecard-log', 'retrieval_id']) {
      assert.ok(!view.includes(jargon), `jargon "${jargon}" in default view`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI --answers prints the answer view and exits 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'ans-cli-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, card('2026-07-21T00:00:00Z'));
    const out = execFileSync('node', [CHECK_CLI, project, '--answers'], { encoding: 'utf8' });
    assert.match(out, /Memory health/);
    assert.match(out, /Is it storing the right memories\?/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
