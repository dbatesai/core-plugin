import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeScorecard,
  appendScorecard,
  latestScorecards,
  shouldComputeScorecard,
  scorecardLogPath,
  SCORECARD_SCHEMA_VERSION,
} from '../../plugins/core/skills/core/scripts/scorecard.mjs';

const WS_ID = 'sc-fixture';

function makeProject(root) {
  const project = join(root, 'proj');
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: WS_ID }));
  return project;
}

function plantJudgments(project, rows) {
  const base = join(project, '_metrics');
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'judgment-log.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function plantSelfTest(project, rows, date = '2026-07-20') {
  const dir = join(project, '_sessions', date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'self-test-log.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function plantRetrievalRows(project, n, date = '2026-07-20') {
  const dir = join(project, '_sessions', date);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'retrieval-log.jsonl'),
    Array.from({ length: n }, (_, i) => JSON.stringify({ kind: 'retrieval', ts: `2026-07-20T10:0${i}:00Z` })).join('\n') + '\n');
}

function plantTurnCapture(project, n, date = '2026-07-20') {
  const dir = join(project, '_metrics', 'turn-capture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${date}.jsonl`),
    Array.from({ length: n }, (_, i) => JSON.stringify({ kind: 'turn-evidence', retrieval_id: `r-${i}` })).join('\n') + '\n');
}

const J = (verdict, ts, extra = {}) => ({
  kind: 'hindsight-judgment', retrieval_id: `rid-${ts}`, ts, verdict,
  judge_version: '1.0.0', producer_sha: 'abc', ...extra,
});

test('computeScorecard aggregates judgments, newest self-test, volumes, and capture health', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-agg-'));
  try {
    const project = makeProject(root);
    plantJudgments(project, [
      J('hit-right', '2026-07-20T10:00:00Z'),
      J('hit-right', '2026-07-20T10:01:00Z'),
      J('noise', '2026-07-20T10:02:00Z'),
      J('hindsight-miss', '2026-07-20T10:03:00Z'),
      J('storage-gap', '2026-07-20T10:04:00Z'),
    ]);
    plantSelfTest(project, [
      { kind: 'self-test-run', ts: '2026-07-19T10:00:00Z', round: 1, headline: 0.7 },
      { kind: 'self-test-run', ts: '2026-07-20T10:00:00Z', round: 2, headline: 0.82 },
    ]);
    plantRetrievalRows(project, 4);
    plantTurnCapture(project, 5);
    const card = computeScorecard(project, { now: '2026-07-21T00:00:00Z' });
    assert.equal(card.schema_version, SCORECARD_SCHEMA_VERSION);
    assert.deepEqual(card.hindsight, { judged_turns: 5, hit_right: 2, noise: 1, hindsight_miss: 1, storage_gap: 1 });
    assert.equal(card.self_test.headline, 0.82);
    assert.equal(card.self_test.round_id, 2);
    assert.equal(card.volumes.turns_captured, 5);
    assert.equal(card.volumes.retrieval_rows, 4);
    assert.equal(typeof card.capture_health.attempts, 'number');
    assert.equal(card.judge_version, '1.0.0');
    assert.ok(card.producer_version);
    assert.ok(card.producer_sha);
    assert.equal(card.ts, '2026-07-21T00:00:00Z');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing inputs degrade to honest nulls/zeros — never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-empty-'));
  try {
    const project = makeProject(root);
    const card = computeScorecard(project, { now: '2026-07-21T00:00:00Z' });
    assert.deepEqual(card.hindsight, { judged_turns: 0, hit_right: 0, noise: 0, hindsight_miss: 0, storage_gap: 0 });
    assert.equal(card.self_test.headline, null);
    assert.equal(card.self_test.round_id, null);
    assert.equal(card.judge_version, null);
    assert.equal(card.volumes.turns_captured, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('appendScorecard is append-only: prior bytes survive as an exact prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-append-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, computeScorecard(project, { now: '2026-07-21T00:00:00Z' }));
    const before = readFileSync(scorecardLogPath(project), 'utf8');
    appendScorecard(project, computeScorecard(project, { now: '2026-07-22T00:00:00Z' }));
    const after = readFileSync(scorecardLogPath(project), 'utf8');
    assert.ok(after.startsWith(before), 'existing rows never rewritten');
    assert.equal(after.trim().split('\n').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('latestScorecards returns newest-first with limit', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-latest-'));
  try {
    const project = makeProject(root);
    for (const now of ['2026-07-20T00:00:00Z', '2026-07-21T00:00:00Z', '2026-07-22T00:00:00Z']) {
      appendScorecard(project, computeScorecard(project, { now }));
    }
    const two = latestScorecards(project, 2);
    assert.equal(two.length, 2);
    assert.equal(two[0].ts, '2026-07-22T00:00:00Z');
    assert.equal(two[1].ts, '2026-07-21T00:00:00Z');
    assert.equal(latestScorecards(project, 10).length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shouldComputeScorecard: false with nothing new, true once a newer judgment or self-test row exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-gate-'));
  try {
    const project = makeProject(root);
    // nothing at all → nothing to pin
    assert.equal(shouldComputeScorecard(project), false);
    plantJudgments(project, [J('hit-right', '2026-07-20T10:00:00Z')]);
    assert.equal(shouldComputeScorecard(project), true, 'unpinned judgments → compute');
    appendScorecard(project, computeScorecard(project, { now: '2026-07-21T00:00:00Z' }));
    assert.equal(shouldComputeScorecard(project), false, 'everything pinned → skip');
    plantSelfTest(project, [{ kind: 'self-test-run', ts: '2026-07-22T10:00:00Z', round: 3, headline: 0.9 }], '2026-07-22');
    assert.equal(shouldComputeScorecard(project), true, 'newer self-test row → compute');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('data_window spans previous scorecard to now; thresholds are stamped through', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-window-'));
  try {
    const project = makeProject(root);
    appendScorecard(project, computeScorecard(project, { now: '2026-07-20T00:00:00Z' }));
    const card = computeScorecard(project, {
      now: '2026-07-21T00:00:00Z',
      thresholds: { self_test_drop: 5, miss_trend_scorecards: 3 },
    });
    assert.equal(card.data_window.from, '2026-07-20T00:00:00Z');
    assert.equal(card.data_window.to, '2026-07-21T00:00:00Z');
    assert.deepEqual(card.thresholds, { self_test_drop: 5, miss_trend_scorecards: 3 });
    // first-ever card has an open start
    rmSync(scorecardLogPath(project), { force: true });
    assert.equal(computeScorecard(project, { now: '2026-07-21T00:00:00Z' }).data_window.from, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('scorecard rows are numbers/ids/short-strings only — no free-text prose fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'sc-shape-'));
  try {
    const project = makeProject(root);
    const card = computeScorecard(project, { now: '2026-07-21T00:00:00Z' });
    const walk = (v) => {
      if (typeof v === 'string') assert.ok(v.length <= 120, `string field too long for a pinned row: ${v.slice(0, 40)}…`);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(card);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
