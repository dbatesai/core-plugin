import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  judgeUnjudgedTurns,
  judgmentLogPath,
  JUDGE_VERSION,
} from '../../plugins/core/skills/core/scripts/hindsight-judge.mjs';
import { captureTurnEvidence, computeStoreSignature } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

const WS_ID = 'hj-fixture';

// A tiny controlled store: exactly one unit about watches; the rest are
// unmistakably about cooking, so a watch prompt has exactly one eligible match.
function makeStore(root) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: WS_ID }));
  const unit = (id, title, body) =>
    writeFileSync(join(store, `${id}.md`),
      `---\nid: ${id}\ntype: decision\nstatus: active\ncreated: 2026-06-01\ntitle: ${title}\n---\n\n${body}\n`);
  unit('dc-omega', 'Omega Speedmaster purchase decision', 'The omega speedmaster chronograph purchase decision and its sale price window.');
  unit('dc-soup', 'Soup recipe', 'Tomato soup recipe with basil and garlic.');
  unit('dc-bread', 'Bread baking', 'Sourdough bread starter maintenance schedule.');
  unit('dc-cake', 'Cake decision', 'Chocolate cake layering approach for the party.');
  return project;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.CORE_METRICS_ENABLED;
  delete env.CORE_TURN_CAPTURE;
  return env;
}

// Plant one evidence row via the REAL capture path so the judge reads what
// production writes.
function plantTurn(project, { rid, prompt, deliveredIds, sig }) {
  const res = captureTurnEvidence(project, {
    retrieval_id: rid,
    session_id: 's-1',
    harness: 'claude-code',
    prompt_text: prompt,
    pack_text: 'pack',
    delivered: deliveredIds.map((id) => ({ id, score: 1, source_stage: 'ranked' })),
    rejected_top: [],
    truncation: { byte_cap_applied: false, prompt_tokens_used: 3 },
    store_signature: sig ?? computeStoreSignature(project),
    producer_version: 'v', producer_sha: 'sha',
  }, { env: cleanEnv() });
  assert.equal(res.written, true, `fixture capture must succeed: ${res.reason}`);
}

function judgments(project) {
  const f = judgmentLogPath(project);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('delivered matches the full-text expectation → hit-right', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-hit-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-hit', prompt: 'omega speedmaster sale price', deliveredIds: ['dc-omega'] });
    const res = judgeUnjudgedTurns(project);
    assert.equal(res.judged, 1);
    const [row] = judgments(project);
    assert.equal(row.verdict, 'hit-right');
    assert.equal(row.retrieval_id, 'r-hit');
    assert.equal(row.judge_version, JUDGE_VERSION);
    assert.ok(row.thresholds.gap_floor >= 0);
    assert.equal(row.store_drifted, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('store contained a better undelivered match → hindsight-miss', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-miss-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-miss', prompt: 'omega speedmaster sale price', deliveredIds: ['dc-soup'] });
    judgeUnjudgedTurns(project);
    assert.equal(judgments(project)[0].verdict, 'hindsight-miss');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('delivered nothing while the store had a match → hindsight-miss', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-empty-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-empty', prompt: 'omega speedmaster sale price', deliveredIds: [] });
    judgeUnjudgedTurns(project);
    assert.equal(judgments(project)[0].verdict, 'hindsight-miss');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('right unit delivered plus an irrelevant one → noise', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-noise-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-noise', prompt: 'omega speedmaster sale price', deliveredIds: ['dc-omega', 'dc-cake'] });
    judgeUnjudgedTurns(project);
    assert.equal(judgments(project)[0].verdict, 'noise');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nothing in the store matches the prompt → storage-gap', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-gap-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-gap', prompt: 'quantum blockchain sailboat despair', deliveredIds: [] });
    judgeUnjudgedTurns(project);
    assert.equal(judgments(project)[0].verdict, 'storage-gap');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('store drifted between capture and judge → drift-invalidated, never a graded verdict (Gate A)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-drift-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-drift', prompt: 'omega speedmaster sale price', deliveredIds: ['dc-omega'], sig: 'sSTALE-m000' });
    judgeUnjudgedTurns(project);
    const [row] = judgments(project);
    assert.equal(row.verdict, 'drift-invalidated');
    assert.equal(row.store_drifted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('idempotent: a second pass judges zero; limit bounds the batch', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-idem-'));
  try {
    const project = makeStore(root);
    for (let i = 0; i < 5; i++) {
      plantTurn(project, { rid: `r-${i}`, prompt: 'omega speedmaster sale price', deliveredIds: ['dc-omega'] });
    }
    assert.equal(judgeUnjudgedTurns(project, { limit: 2 }).judged, 2, 'limit respected');
    assert.equal(judgeUnjudgedTurns(project).judged, 3, 'remaining judged');
    assert.equal(judgeUnjudgedTurns(project).judged, 0, 'idempotent when done');
    assert.equal(judgments(project).length, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('malformed evidence lines are skipped and counted, never a throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'hj-malformed-'));
  try {
    const project = makeStore(root);
    plantTurn(project, { rid: 'r-ok', prompt: 'omega speedmaster sale price', deliveredIds: ['dc-omega'] });
    // corrupt the stream: a torn JSON line and a row with no usable prompt
    const dir = join(project, '_metrics', 'turn-capture');
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    assert.equal(files.length, 1);
    appendFileSync(join(dir, files[0]),
      '{"kind":"turn-evidence","retrieval_id":"r-torn","prompt_te\n'
      + JSON.stringify({ kind: 'turn-evidence', retrieval_id: 'r-noprompt', prompt_text: '' }) + '\n');
    const res = judgeUnjudgedTurns(project);
    assert.equal(res.judged, 1, 'only the well-formed row judged');
    assert.equal(res.skipped, 1, 'the promptless row counted as skipped');
    assert.equal(judgments(project).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
