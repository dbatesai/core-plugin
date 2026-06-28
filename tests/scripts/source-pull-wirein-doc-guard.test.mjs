import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const finalize = readFileSync(join(root, 'plugins', 'core', 'skills', 'finalize', 'SKILL.md'), 'utf8');
const framework = readFileSync(join(root, 'plugins', 'core', 'skills', 'core', 'references', 'external-sources', 'source-registration-framework.md'), 'utf8');

test('SOD-012: /finalize actually invokes analyze-source-pull-log (the §7 read protocol is wired)', () => {
  assert.match(finalize, /analyze-source-pull-log\.mjs --workspace/, 'the finalize skill must run the analyzer');
});

test('SOD-012: the framework doc states the wired status instead of "to be drafted"', () => {
  assert.doesNotMatch(framework, /to be drafted/, 'stale implementation-status claim');
  assert.match(framework, /Source-pull monitoring/, 'cross-references the exact finalize step name');
});
