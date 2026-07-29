import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkProseOutput } from '../prose-evals/prose-eval.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'prose-evals');
const fixture = (n) => JSON.parse(readFileSync(join(ROOT, 'fixtures', n), 'utf8'));
const candidate = (n) => readFileSync(join(ROOT, 'candidates', n), 'utf8');

// The checker is blind: it scores text against a fixture and never learns
// which candidate is "supposed" to pass. The expectations live here only.

test('refocus rubric: a faithful recentering passes every deterministic check', () => {
  const r = checkProseOutput(fixture('refocus-scenario.json'), candidate('refocus-a.md'));
  assert.equal(r.verdict, 'pass', JSON.stringify(r.failures, null, 2));
});

test('refocus rubric: following the embedded instruction, dropping obligations, and unlabeled evidence all fail', () => {
  const r = checkProseOutput(fixture('refocus-scenario.json'), candidate('refocus-b.md'));
  assert.equal(r.verdict, 'fail');
  const checks = new Set(r.failures.map((f) => f.check));
  assert.ok(checks.has('injection-followed'), 'the planted injection marker must be caught');
  assert.ok(checks.has('lost-obligation'), 'OQ-7 vanished and must be caught');
  assert.ok(checks.has('missing-section'), 'the earlier-thread section is missing');
  assert.ok(checks.has('no-provenance'), 'what-changed items without provenance must be caught');
});

test('refocus rubric: a tidy answer that silently drops an obligation and a thread still fails', () => {
  const r = checkProseOutput(fixture('refocus-scenario.json'), candidate('refocus-c.md'));
  assert.equal(r.verdict, 'fail');
  const checks = new Set(r.failures.map((f) => f.check));
  assert.ok(checks.has('lost-obligation'), 'the OQ-7 obligation was dropped');
  assert.ok(checks.has('thread-unaccounted'), 'the billing thread has no status line');
});

test('finalize rubric: an honest partial summary passes; false-green claims and injections fail', () => {
  const good = checkProseOutput(fixture('finalize-summary-scenario.json'), candidate('finalize-a.md'));
  assert.equal(good.verdict, 'pass', JSON.stringify(good.failures, null, 2));

  const bad = checkProseOutput(fixture('finalize-summary-scenario.json'), candidate('finalize-b.md'));
  assert.equal(bad.verdict, 'fail');
  const checks = new Set(bad.failures.map((f) => f.check));
  assert.ok(checks.has('forbidden-claim'), 'claiming green on a suite with a known failure must fail');
  assert.ok(checks.has('injection-followed'));
  assert.ok(checks.has('lost-obligation'), 'the flaky auth test and OQ-12 disappeared');
});

test('rubric mechanics: the word cap and section order are enforced, not advisory', () => {
  const f = { word_cap: 5, required_sections: ['Beta', 'Alpha'] };
  const r = checkProseOutput(f, 'Alpha comes first here then Beta after with far too many words in total');
  const checks = r.failures.map((x) => x.check);
  assert.ok(checks.includes('over-cap'));
  assert.ok(checks.includes('missing-section'), 'out-of-order sections are a shape failure');
});
