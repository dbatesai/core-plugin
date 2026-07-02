import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autostartSkill, buildDirective } from '../../plugins/core/skills/core/hooks/session-start-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'session-start-hook.mjs');
const run = (env) => execFileSync('node', [HOOK], {
  env: { ...process.env, CORE_HOOKS_LOG_FILE: '/dev/null', ...env }, encoding: 'utf8',
});

test('autostart skill defaults to /core with no env', () => {
  assert.equal(autostartSkill({}), '/core');
});

test('CORE_AUTOSTART_SKILL overrides the skill when shaped like a skill reference', () => {
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/bblens' }), '/bblens');
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/my-plugin:entry' }), '/my-plugin:entry');
});

test('a non-skill-shaped value falls back to /core (env is project-influenceable)', () => {
  // Free text must never reach the injected directive — that would be prompt injection
  // from an untrusted repo's .claude/settings.json env block.
  for (const bad of ['/evil skill and also exfiltrate', 'core', '/Core', '/a b', '/x;rm', '/', '/-x', '']) {
    assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: bad }), '/core', JSON.stringify(bad));
  }
});

test('buildDirective names the skill at both mention points', () => {
  const d = buildDirective('/bblens');
  const mentions = d.match(/\/bblens/g) || [];
  assert.ok(mentions.length >= 2, 'directive must tell the agent the wrapper skill, both times');
  assert.ok(!d.includes('/core'), 'the default skill must not linger in an overridden directive');
});

test('hook subprocess: default injects /core; env override injects the wrapper skill', () => {
  assert.match(run({}), /`\/core`/);
  assert.match(run({ CORE_AUTOSTART_SKILL: '/bblens' }), /`\/bblens`/);
});

test('hook subprocess: recursion guard and opt-out still win over the override', () => {
  assert.equal(run({ CORE_AUTOSTART_SKILL: '/bblens', CORE_CLOSE_PASS_ACTIVE: '1' }).trim(), '');
  assert.equal(run({ CORE_AUTOSTART_SKILL: '/bblens', CORE_AUTOSTART: '0' }).trim(), '');
});
