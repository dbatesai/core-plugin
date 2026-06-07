import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the /orient deprecation shim: the skill is kept for backward compatibility
// as a user-invocable no-op that prints a deprecation notice pointing at /core. Its
// real behavior lives in CORE's startup protocol; the shim must not re-grow it.

const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'orient', 'SKILL.md',
);

test('the /orient shim exists and is user-invocable', () => {
  assert.ok(existsSync(SKILL), 'plugins/core/skills/orient/SKILL.md exists');
  const src = readFileSync(SKILL, 'utf8');
  assert.match(src, /^name:\s*orient\s*$/m, 'frontmatter name is orient');
  assert.match(src, /^user-invocable:\s*true\s*$/m, 'shim is user-invocable');
});

test('the /orient shim is a deprecation no-op pointing at /core', () => {
  const src = readFileSync(SKILL, 'utf8');
  assert.match(src, /deprecated/i, 'shim declares itself deprecated');
  assert.match(src, /\/core/, 'shim points the user at /core');
  assert.match(src, /no-op/i, 'shim describes itself as a no-op');
  // It must NOT re-grow the bootstrap behavior that moved into startup.md.
  assert.doesNotMatch(src, /startup-conditional-loads/, 'shim does not re-implement startup branches');
  assert.doesNotMatch(src, /record-retrieval-event|metrics-init|hot-section\.mjs/,
    'shim runs no startup scripts — bootstrap lives in /core');
});
