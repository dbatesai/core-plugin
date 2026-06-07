import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the Move 2 extraction (option E): the two safe conditional-load branches
// (new-workspace + folder-rename) live in protocols/startup-conditional-loads.md,
// while cold-start migration stays inline in startup.md by design (it's the one
// irreversible branch and its plan/flag backstops must stay in context).

const CORE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'plugins', 'core', 'skills', 'core',
);
const protocols = join(CORE, 'protocols');
const subFile = join(protocols, 'startup-conditional-loads.md');
const startup = join(protocols, 'startup.md');
const skill = join(CORE, 'SKILL.md');

test('the conditional-load sub-file exists and holds both extracted branch headers', () => {
  assert.ok(existsSync(subFile), 'protocols/startup-conditional-loads.md exists');
  const sub = readFileSync(subFile, 'utf8');
  assert.match(sub, /## Load — new workspace/, 'sub-file holds the new-workspace branch');
  assert.match(sub, /## Load — folder rename only/, 'sub-file holds the folder-rename branch');
  // Re-entry pointer back into the inline returning-workspace load.
  assert.match(sub, /Load — returning workspace/, 'sub-file points back to the returning-workspace load');
});

test('startup.md routing carries the imperative load-pointer to the sub-file', () => {
  const src = readFileSync(startup, 'utf8');
  assert.match(src, /startup-conditional-loads\.md/, 'startup.md names the sub-file in its routing block');
  assert.match(src, /STOP and read/, 'startup.md gives an imperative read instruction for the conditional branches');
});

test('startup.md no longer contains the two EXTRACTED headers (but keeps migration + returning inline)', () => {
  const src = readFileSync(startup, 'utf8');
  // Match the specific extracted headers, NOT a /## Load —/ regex —
  // "## Load — returning workspace" and "## Load — cold-start migration" stay inline.
  assert.doesNotMatch(src, /## Load — new workspace/, 'new-workspace header was removed from startup.md');
  assert.doesNotMatch(src, /## Load — folder rename only/, 'folder-rename header was removed from startup.md');
  // Migration and returning-workspace must remain inline.
  assert.match(src, /## Load — cold-start migration/, 'cold-start migration stays inline in startup.md');
  assert.match(src, /## Load — returning workspace/, 'returning-workspace load stays inline in startup.md');
});

test('SKILL.md indexes the sub-file (orphan-detector requirement)', () => {
  const src = readFileSync(skill, 'utf8');
  assert.match(src, /protocols\/startup-conditional-loads\.md/,
    'SKILL.md protocol index references the sub-file so orphan-detector does not flag it');
});
