import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// the two plugin manifests are intentionally asymmetric — this
// test pins which fields MUST agree (so a release can't ship a split-brain
// plugin) and which differ by design (so the asymmetry is verified, not drift).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core');
const claude = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const codex = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));

test('manifests agree on identity: name, version, license, author email, homepage', () => {
  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version, 'version drift between manifests would ship a split-brain release');
  assert.equal(claude.license, codex.license);
  assert.equal(claude.author.email, codex.author.email);
  assert.equal(claude.homepage, codex.homepage);
});

test('intentional asymmetry: Claude carries build (startup readiness reads it); Codex carries skills + interface (marketplace requirements)', () => {
  assert.ok(claude.build, '.claude-plugin build field is load-bearing — protocols/startup.md echoes "Plugin v<version> build <build>"');
  assert.ok(!('build' in codex), 'no build in the Codex manifest by design (single source of truth on the Claude side)');
  assert.equal(codex.skills, './skills/', 'Codex requires an explicit skills pointer; Claude Code discovers by convention');
  assert.ok(codex.interface && codex.interface.displayName, 'interface block is a Codex-marketplace surface with no Claude Code equivalent');
  assert.ok(!('interface' in claude), 'no interface block in the Claude manifest by design');
});
