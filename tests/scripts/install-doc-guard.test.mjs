import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the doc-code truth boundary (SYN-001):
// hooks.json is empty, so no public doc may claim hooks register automatically,
// and INSTALL.md's skill lists must match the shipped skill directories.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const install = readFileSync(join(ROOT, 'INSTALL.md'), 'utf8');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const architecture = readFileSync(join(ROOT, 'ARCHITECTURE.md'), 'utf8');
const SKILLS_DIR = join(ROOT, 'plugins', 'core', 'skills');

test('empty hooks.json means no public doc claims hooks self-register', () => {
  const hooksJson = JSON.parse(
    readFileSync(join(ROOT, 'plugins', 'core', 'hooks', 'hooks.json'), 'utf8'),
  );
  if (Object.keys(hooksJson.hooks ?? {}).length > 0) return; // hooks ship now; claim would be true
  for (const [name, text] of [
    ['README.md', readme],
    ['INSTALL.md', install],
    ['ARCHITECTURE.md', architecture],
  ]) {
    assert.ok(!/register on their own/i.test(text), `${name} claims hooks self-register`);
    assert.ok(!/two hooks register/i.test(text), `${name} claims two hooks register`);
    assert.ok(
      !/hooks come in through the manifest/i.test(text),
      `${name} claims manifest-shipped hooks`,
    );
    assert.ok(
      !/register[s]? through the plugin manifest/i.test(text),
      `${name} claims manifest registration`,
    );
  }
});

test('every shipped skill directory is named somewhere in INSTALL.md', () => {
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(dirs.length >= 6, 'expected at least six shipped skills');
  for (const dir of dirs) {
    assert.ok(install.includes(dir), `INSTALL.md never mentions shipped skill "${dir}"`);
  }
});

test('INSTALL.md Codex bundled-skills list names only skills that exist on disk', () => {
  const m = install.match(/Codex finds the bundled skills \(([^)]+)\)/);
  assert.ok(m, 'Codex bundled-skills sentence missing from INSTALL.md');
  const named = [...m[1].matchAll(/`([a-z][a-z-]*)`/g)].map((x) => x[1]);
  assert.ok(named.length >= 6, 'expected at least six bundled skills named');
  for (const skill of named) {
    assert.ok(
      existsSync(join(SKILLS_DIR, skill, 'SKILL.md')),
      `INSTALL.md names "${skill}" but plugins/core/skills/${skill}/SKILL.md does not exist`,
    );
  }
});
