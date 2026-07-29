/**
 * require-green-candidate.test.mjs — the gate that stands between a commit on
 * main and a release tag.
 *
 * A tag is a release identity. Handing one to a SHA whose required workflow did
 * not pass makes the identity meaningless, so the gate answers one question over
 * a workflow-runs payload: did the required workflow conclude success for THIS
 * exact commit? Anything else — a failure, a run still going, a run belonging to
 * a different commit, no run at all — refuses.
 *
 * The payloads are the shape GitHub returns from
 * /repos/{owner}/{repo}/actions/workflows/{file}/runs, so the fixtures exercise
 * the same fields the workflow feeds it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, '.github', 'scripts', 'require-green-candidate.mjs');

const CANDIDATE = '1'.repeat(40);
const OTHER = '2'.repeat(40);

function makeRun({ sha = CANDIDATE, status = 'completed', conclusion = 'success', runNumber = 1, attempt = 1 } = {}) {
  return {
    id: runNumber * 1000 + attempt,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_sha: sha,
    status,
    conclusion,
    run_number: runNumber,
    run_attempt: attempt,
    html_url: `https://example.invalid/run/${runNumber}`,
  };
}

function gate(runs, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'green-candidate-'));
  const file = join(dir, 'runs.json');
  writeFileSync(file, typeof runs === 'string' ? runs : JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  try {
    const res = spawnSync(process.execPath,
      [SCRIPT, '--sha', CANDIDATE, '--workflow', 'ci.yml', '--runs-file', file, ...args],
      { encoding: 'utf8' });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a successful required run for the exact commit is taggable', () => {
  const { code, out } = gate([makeRun()]);
  assert.equal(code, 0, `expected the gate to pass:\n${out}`);
  assert.ok(out.includes(CANDIDATE), `verdict should name the candidate:\n${out}`);
});

test('a failing candidate cannot be tagged', () => {
  const { code, out } = gate([makeRun({ conclusion: 'failure' })]);
  assert.equal(code, 1, `a failed required run must refuse the tag, got exit ${code}:\n${out}`);
  assert.match(out, /failure/);
});

test('a run still in progress is not a pass', () => {
  const { code, out } = gate([makeRun({ status: 'in_progress', conclusion: null })]);
  assert.equal(code, 1, `an unfinished run must refuse the tag, got exit ${code}:\n${out}`);
});

test('a green run for a different commit does not license this one', () => {
  const { code, out } = gate([makeRun({ sha: OTHER })]);
  assert.equal(code, 2, `a run for another SHA must be treated as no run, got exit ${code}:\n${out}`);
  assert.ok(out.includes(CANDIDATE), `verdict should name the candidate it found nothing for:\n${out}`);
});

test('no run at all refuses rather than defaulting open', () => {
  const { code } = gate([]);
  assert.equal(code, 2);
});

test('a cancelled run refuses', () => {
  const { code } = gate([makeRun({ conclusion: 'cancelled' })]);
  assert.equal(code, 1);
});

test('the latest attempt decides: a green re-run of a failed candidate is taggable', () => {
  const { code, out } = gate([
    makeRun({ runNumber: 7, attempt: 1, conclusion: 'failure' }),
    makeRun({ runNumber: 7, attempt: 2, conclusion: 'success' }),
  ]);
  assert.equal(code, 0, `the newest attempt should decide:\n${out}`);
});

test('the latest attempt decides: a red re-run revokes an earlier green', () => {
  const { code, out } = gate([
    makeRun({ runNumber: 7, attempt: 1, conclusion: 'success' }),
    makeRun({ runNumber: 7, attempt: 2, conclusion: 'failure' }),
  ]);
  assert.equal(code, 1, `the newest attempt should decide:\n${out}`);
});

test('runs from a different workflow are not counted as the required one', () => {
  const foreign = { ...makeRun(), name: 'lint', path: '.github/workflows/lint.yml' };
  const { code } = gate([foreign]);
  assert.equal(code, 2);
});

test('an unparseable payload is indeterminate, never a pass', () => {
  const { code } = gate('not json at all');
  assert.equal(code, 2);
});
