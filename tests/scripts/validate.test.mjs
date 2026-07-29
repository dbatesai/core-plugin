import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/validate.mjs', import.meta.url));

function writeFixtureProject() {
  const project = mkdtempSync(join(tmpdir(), 'core-validate-'));
  const memories = join(project, '_memories');
  const tests = join(memories, '_validation/tests');
  mkdirSync(tests, { recursive: true });

  writeFileSync(join(memories, 'expected-unit.md'), [
    '---',
    'id: expected-unit',
    'status: active',
    '---',
    '',
    'alpha beta expected',
    '',
  ].join('\n'));
  writeFileSync(join(memories, 'forbidden-unit.md'), [
    '---',
    'id: forbidden-unit',
    'status: active',
    '---',
    '',
    'alpha beta forbidden',
    '',
  ].join('\n'));

  writeFileSync(join(tests, 'test-forbidden-top5.yaml'), [
    '---',
    'query: "alpha beta expected forbidden"',
    'expected_memories:',
    '  - expected-unit',
    'forbidden_memories:',
    '  - forbidden-unit',
    'tier_expected: 1',
    'notes: "Forbidden unit is not first, but it is still in the retrieved candidate set."',
    '---',
    '',
  ].join('\n'));

  return project;
}

function writeNegatedQueryFixtureProject() {
  const project = mkdtempSync(join(tmpdir(), 'core-validate-negated-'));
  const memories = join(project, '_memories');
  const tests = join(memories, '_validation/tests');
  mkdirSync(tests, { recursive: true });

  writeFileSync(join(memories, 'expected-no-heartbeat.md'), [
    '---',
    'id: expected-no-heartbeat',
    'status: active',
    '---',
    '',
    'codex supervised collab loop with no heartbeat events',
    '',
  ].join('\n'));
  writeFileSync(join(memories, 'forbidden-heartbeat.md'), [
    '---',
    'id: forbidden-heartbeat',
    'status: active',
    '---',
    '',
    'codex supervised collab loop heartbeat automation attached to the thread',
    '',
  ].join('\n'));

  writeFileSync(join(tests, 'test-negated-query-term.yaml'), [
    '---',
    'query: "codex supervised collab loop no heartbeat"',
    'expected_memories:',
    '  - expected-no-heartbeat',
    'forbidden_memories:',
    '  - forbidden-heartbeat',
    'tier_expected: 1',
    'notes: "Negated query terms should not reward a unit that mentions the positive inverse."',
    '---',
    '',
  ].join('\n'));

  return project;
}

test('validate CLI fails when a forbidden memory appears in the top-5 candidate set', () => {
  const project = writeFixtureProject();
  const result = spawnSync(process.execPath, [SCRIPT, project], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL/);

  const report = readFileSync(join(project, '_outputs/validation', new Date().toISOString().slice(0, 10), 'REPORT.md'), 'utf8');
  assert.match(report, /Forbidden hits: \["forbidden-unit"\]/);
});

test('validate CLI treats negated query terms as exclusions, not positive matches', () => {
  const project = writeNegatedQueryFixtureProject();
  const result = spawnSync(process.execPath, [SCRIPT, project], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);

  const report = readFileSync(join(project, '_outputs/validation', new Date().toISOString().slice(0, 10), 'REPORT.md'), 'utf8');
  assert.match(report, /Expected: \["expected-no-heartbeat"\]/);
  assert.match(report, /Forbidden hits: \[\]/);
});

test('a forbidden-hit FAIL row is internally consistent (no FAIL | 1 | 1), precision zeroed', () => {
  // The forbidden fixture ranks the forbidden unit in the candidate pool but below the
  // scoreK precision cut, so before the fix the row read FAIL | 1 | 1 — status and P/R
  // disagreeing. A contaminated candidate pool must zero the run's precision.
  const project = writeFixtureProject();
  const result = spawnSync(process.execPath, [SCRIPT, project], { cwd: process.cwd(), encoding: 'utf8' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);

  const report = readFileSync(join(project, '_outputs/validation', new Date().toISOString().slice(0, 10), 'REPORT.md'), 'utf8');
  const failRow = report.split('\n').find(l => /^\|\s*FAIL\s*\|/.test(l));
  assert.ok(failRow, 'a FAIL row must be present');
  assert.doesNotMatch(failRow, /^\|\s*FAIL\s*\|\s*1\s*\|\s*1\s*\|/, 'no confusing FAIL | 1 | 1 row');
  // The precision column (first number after FAIL) must be 0 on a forbidden-contaminated row.
  assert.match(failRow, /^\|\s*FAIL\s*\|\s*0\s*\|/, 'precision is zeroed when a forbidden unit is in the candidate pool');
});
