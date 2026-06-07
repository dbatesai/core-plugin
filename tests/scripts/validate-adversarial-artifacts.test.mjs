import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/validate-adversarial-artifacts.mjs', import.meta.url));
import {
  validateInitialFrame, validatePersuasionLogLine, validateMindChangeLine,
  validateJsonl, validateAdversarialArtifacts,
} from '../../plugins/core/skills/core/scripts/validate-adversarial-artifacts.mjs';

test('M2: the CLI entry guard canonicalizes BOTH sides (no silent no-op on a symlinked install)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /realpathSync\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'the one-sided guard (realpath on argv[1] only) must be gone');
  assert.match(src, /canon\(process\.argv\[1\]\) === canon\(fileURLToPath\(import\.meta\.url\)\)/,
    'both sides canonicalized through the same helper');
});

test('M6: an unreadable --frames path reports an I/O error, not a schema-error cascade', () => {
  let err;
  try {
    execFileSync('node', [SCRIPT, '--frames', '/no/such/frame-file.json'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { err = e; }
  assert.ok(err, 'a bad frames path exits non-zero');
  assert.equal(err.status, 2, 'exit 2 = I/O error, distinct from exit 1 = invalid-but-readable');
  assert.match(err.stderr, /frame file unreadable or not JSON: \/no\/such\/frame-file\.json/,
    'names the unreadable file instead of emitting "missing required field" schema errors');
  assert.doesNotMatch(err.stderr || '', /missing required field/, 'no misdirecting schema cascade');
});

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
const TS = '2026-05-30T05:00:00Z';
const pLine = (o) => ({ schema_version: '1.0', ts: TS, from_agent: 'A', to_agent: 'B', claim: 'c', shifted: false, ...o });
const mLine = (o) => ({ schema_version: '1.0', ts: TS, agent: 'A', field: 'position', from: 'x', to: 'y', persuaded_by: 'self', ...o });

test('persuasion-log line: shifted=true requires from/to position', () => {
  assert.equal(validatePersuasionLogLine(pLine({ shifted: true, from_position: 'x', to_position: 'y' })).valid, true);
  const r = validatePersuasionLogLine(pLine({ shifted: true }));
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /position/.test(e)));
});

test('persuasion-log line: shifted=false needs no positions', () => {
  assert.equal(validatePersuasionLogLine(pLine({ shifted: false })).valid, true);
});

// --- Hale fix-forward: ts + schema_version checks on JSONL lines ---

test('JSONL line: unparseable ts fails (was accepted before)', () => {
  assert.equal(validatePersuasionLogLine(pLine({ ts: 'not-a-date' })).valid, false);
  assert.equal(validateMindChangeLine(mLine({ ts: 'whenever' })).valid, false);
});

test('JSONL line: wrong/missing schema_version fails', () => {
  assert.equal(validatePersuasionLogLine(pLine({ schema_version: '9.9' })).valid, false);
  const { schema_version, ...noVer } = mLine({});
  assert.equal(validateMindChangeLine(noVer).valid, false);
});

// --- mind-changes.jsonl ---

test('mind-change line: well-formed passes; missing persuaded_by fails', () => {
  assert.equal(validateMindChangeLine(mLine({ persuaded_by: 'B' })).valid, true);
  const { persuaded_by, ...noPb } = mLine({});
  assert.equal(validateMindChangeLine(noPb).valid, false);
});

// --- jsonl harness + empty-persuasion-log policy ---

test('validateJsonl: collects per-line errors with line numbers', () => {
  const content = [JSON.stringify(mLine({})), 'not json', ''].join('\n');
  const r = validateJsonl(content, validateMindChangeLine);
  assert.equal(r.count, 1, 'one valid record; blank skipped');
  assert.ok(r.errors.some((e) => /line 2/.test(e)), 'malformed line reported with number');
});

test('aggregate: empty persuasion-log → WARNING in advisory, not hard fail', () => {
  const r = validateAdversarialArtifacts({ initialFrames: [goodFrame], persuasionLog: '', mindChanges: '' });
  assert.ok(r.warnings.some((w) => /process-suspect|empty persuasion/i.test(w)));
  assert.equal(r.valid, true, 'advisory: empty persuasion is suspect, not invalid');
});

test('aggregate: empty persuasion-log → HARD FAIL in authority mode (Hale)', () => {
  const r = validateAdversarialArtifacts({ initialFrames: [goodFrame], persuasionLog: '', mindChanges: '', mode: 'authority' });
  assert.equal(r.valid, false, 'authority mode blocks an empty persuasion log');
});

test('aggregate: authority mode HARD-FAILS zero initial frames even with logs (Hale edge)', () => {
  // logs present but no Phase-1 frames → cannot prove framing or cross-check participants
  const persuasion = JSON.stringify(pLine({ shifted: true, from_position: 'a', to_position: 'b' }));
  const mind = JSON.stringify(mLine({}));
  const r = validateAdversarialArtifacts({ initialFrames: [], persuasionLog: persuasion, mindChanges: mind, mode: 'authority' });
  assert.equal(r.valid, false, 'authority + zero frames is blocked');
  assert.ok(r.crossErrors.some((e) => /no initial-frame/.test(e)));
});

test('aggregate: advisory mode keeps zero initial frames a warning, not a fail', () => {
  const persuasion = JSON.stringify(pLine({}));
  const r = validateAdversarialArtifacts({ initialFrames: [], persuasionLog: persuasion, mindChanges: '', mode: 'advisory' });
  assert.ok(r.warnings.some((w) => /no initial-frame/.test(w)));
});

test('aggregate: a malformed initial frame makes the set invalid', () => {
  const r = validateAdversarialArtifacts({ initialFrames: [{ ...goodFrame, peer_exposure: true }], persuasionLog: '', mindChanges: '' });
  assert.equal(r.valid, false);
});

// --- Hale fix-forward: cross-artifact integrity ---

test('cross-artifact: a log naming an unframed agent is INVALID', () => {
  // goodFrame is agent 'Anvil'; the persuasion line references 'Ghost' (no frame)
  const persuasion = JSON.stringify(pLine({ from_agent: 'Anvil', to_agent: 'Ghost' }));
  const r = validateAdversarialArtifacts({ initialFrames: [goodFrame], persuasionLog: persuasion, mindChanges: '' });
  assert.equal(r.valid, false);
  assert.ok(r.crossErrors.some((e) => /Ghost/.test(e)));
});

test('cross-artifact: persuaded_by self is exempt; framed agents pass', () => {
  const frames = [goodFrame, { ...goodFrame, agent: 'Forge' }];
  const persuasion = JSON.stringify(pLine({ from_agent: 'Anvil', to_agent: 'Forge', shifted: true, from_position: 'a', to_position: 'b' }));
  const mind = JSON.stringify(mLine({ agent: 'Forge', persuaded_by: 'self' }));
  const r = validateAdversarialArtifacts({ initialFrames: frames, persuasionLog: persuasion, mindChanges: mind });
  assert.equal(r.crossErrors.length, 0);
  assert.equal(r.valid, true);
});
