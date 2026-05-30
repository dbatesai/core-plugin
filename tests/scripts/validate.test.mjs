import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(process.cwd(), 'skills/core/scripts/validate.mjs');

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
