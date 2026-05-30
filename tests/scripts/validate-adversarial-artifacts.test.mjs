import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInitialFrame, validatePersuasionLogLine, validateMindChangeLine,
  validateJsonl, validateAdversarialArtifacts,
} from '../../skills/core/scripts/validate-adversarial-artifacts.mjs';

// --- initial-frame.json ---

const goodFrame = {
  schema_version: '1.0', agent: 'Anvil', role: 'critic', ts: '2026-05-30T05:00:00Z',
  peer_exposure: false, frame: { position: 'skeptical', key_claims: ['x'], assumptions: [], confidence: 'high' },
};

test('initial-frame: well-formed passes', () => {
  assert.equal(validateInitialFrame(goodFrame).valid, true);
});

test('initial-frame: peer_exposure=true FAILS (anti-anchoring guarantee)', () => {
  const r = validateInitialFrame({ ...goodFrame, peer_exposure: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /peer_exposure/.test(e)));
});

test('initial-frame: empty key_claims fails', () => {
  const r = validateInitialFrame({ ...goodFrame, frame: { ...goodFrame.frame, key_claims: [] } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /key_claims/.test(e)));
});

test('initial-frame: bad confidence enum fails', () => {
  const r = validateInitialFrame({ ...goodFrame, frame: { ...goodFrame.frame, confidence: 'pretty sure' } });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /confidence/.test(e)));
});

test('initial-frame: missing required field fails', () => {
  const { agent, ...noAgent } = goodFrame;
  assert.equal(validateInitialFrame(noAgent).valid, false);
});

// --- persuasion-log.jsonl ---

test('persuasion-log line: shifted=true requires from/to position', () => {
  assert.equal(validatePersuasionLogLine({ ts: 't', from_agent: 'A', to_agent: 'B', claim: 'c', shifted: true, from_position: 'x', to_position: 'y' }).valid, true);
  const r = validatePersuasionLogLine({ ts: 't', from_agent: 'A', to_agent: 'B', claim: 'c', shifted: true });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /position/.test(e)));
});

test('persuasion-log line: shifted=false needs no positions', () => {
  assert.equal(validatePersuasionLogLine({ ts: 't', from_agent: 'A', to_agent: 'B', claim: 'c', shifted: false }).valid, true);
});

// --- mind-changes.jsonl ---

test('mind-change line: well-formed passes; missing persuaded_by fails', () => {
  assert.equal(validateMindChangeLine({ ts: 't', agent: 'A', field: 'position', from: 'x', to: 'y', persuaded_by: 'B' }).valid, true);
  assert.equal(validateMindChangeLine({ ts: 't', agent: 'A', field: 'position', from: 'x', to: 'y' }).valid, false);
});

// --- jsonl harness + empty-persuasion-log policy ---

test('validateJsonl: collects per-line errors with line numbers', () => {
  const content = [JSON.stringify({ ts: 't', agent: 'A', field: 'f', from: 'x', to: 'y', persuaded_by: 'self' }), 'not json', ''].join('\n');
  const r = validateJsonl(content, validateMindChangeLine);
  assert.equal(r.count, 1, 'one valid record; blank skipped');
  assert.ok(r.errors.some((e) => /line 2/.test(e)), 'malformed line reported with number');
});

test('aggregate: empty persuasion-log → WARNING process-suspect, not hard fail', () => {
  const r = validateAdversarialArtifacts({ initialFrames: [goodFrame], persuasionLog: '', mindChanges: '' });
  assert.ok(r.warnings.some((w) => /process-suspect|empty persuasion/i.test(w)));
  assert.equal(r.valid, true, 'empty persuasion log is suspect, not invalid (legitimate consensus is possible)');
});

test('aggregate: a malformed initial frame makes the set invalid', () => {
  const r = validateAdversarialArtifacts({ initialFrames: [{ ...goodFrame, peer_exposure: true }], persuasionLog: '', mindChanges: '' });
  assert.equal(r.valid, false);
});
