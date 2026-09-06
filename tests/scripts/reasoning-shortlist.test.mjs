import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
// The committed fixture is never touched — reads write the cached index as a side effect.
const FIXT = mkdtempSync(join(tmpdir(), 'obligation3-store-'));
cpSync(FIXT_SRC, FIXT, { recursive: true });
process.on('exit', () => { try { rmSync(FIXT, { recursive: true, force: true }); } catch { /* tmpdir */ } });

const { thinSignal, shouldEscalate, escalationThresholds, isQuestionPrompt } =
  await import(pathToFileURL(join(SCRIPTS, 'reasoning-shortlist.mjs')).href);

test('thinSignal: a literal question has one clear keyword winner and is not thin', () => {
  const s = thinSignal('Is the Omega Speedmaster on sale yet?', FIXT);
  assert.ok(s.qterms >= 3);
  assert.equal(s.isQuestion, true);
  assert.ok(s.flatTop < 0.8, `literal flatTop ${s.flatTop} should sit under the floor`);
  assert.equal(s.zeroHit, false);
  assert.equal(shouldEscalate(s), false);
});

test('thinSignal: an abstract question with no shared words has a flat top and escalates', () => {
  const q = 'Should I lean toward things that were the very first of their kind and carry a long story behind whoever built them?';
  const s = thinSignal(q, FIXT);
  assert.ok(s.qterms >= 4, `qterms ${s.qterms}`);
  assert.equal(s.isQuestion, true);
  assert.ok(s.flatTop >= 0.8, `abstract flatTop ${s.flatTop} should clear the floor`);
  assert.equal(shouldEscalate(s), true);
});

test('shouldEscalate: commands and short prompts never escalate; zero-hit always does', () => {
  assert.equal(shouldEscalate({ qterms: 5, isQuestion: false, top: 12, flatTop: 0.96, zeroHit: false }), false, 'a command with a flat top is still a command');
  assert.equal(shouldEscalate({ qterms: 2, isQuestion: true, top: 5, flatTop: 0.99, zeroHit: false }), false, 'too few terms');
  assert.equal(shouldEscalate({ qterms: 1, isQuestion: false, top: 0, flatTop: 1, zeroHit: true }), true, 'zero-hit');
  assert.equal(shouldEscalate({ qterms: 9, isQuestion: true, top: 19, flatTop: 0.6, zeroHit: false }), false, 'clear winner');
});

test('isQuestionPrompt: question words, trailing ?, and should-I shapes; commands are not questions', () => {
  assert.equal(isQuestionPrompt('Should we bring Chroma in for similarity lookups?'), true);
  assert.equal(isQuestionPrompt('Tests are green on my laptop; can I call this finished'), true);
  assert.equal(isQuestionPrompt('update the changelog for the release and push next'), false);
  assert.equal(isQuestionPrompt('/finalize'), false);
});

test('escalationThresholds: env overrides are numeric and fall back to defaults on garbage', () => {
  process.env.CORE_ESCALATION_MIN_TERMS = '5'; process.env.CORE_ESCALATION_FLAT_FLOOR = 'abc';
  const t = escalationThresholds();
  assert.equal(t.minTerms, 5); assert.equal(t.flatFloor, 0.8);
  delete process.env.CORE_ESCALATION_MIN_TERMS; delete process.env.CORE_ESCALATION_FLAT_FLOOR;
});
