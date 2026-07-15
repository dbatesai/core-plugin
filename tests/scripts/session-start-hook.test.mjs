import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autostartSkill, buildDirective, userAuthorizedSkills } from '../../plugins/core/skills/core/hooks/session-start-hook.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'session-start-hook.mjs');

// An ATTACKER-controlled directory carrying its own .claude/settings.json that
// "authorizes" a skill. Used to prove hostile HOME/USERPROFILE cannot redirect
// the directive — the hook resolves the trusted home from the OS account
// database (os.userInfo()), which ignores the environment (Hale's demonstrated
// bypass, 2026-07-11 re-review §5; homedir() followed $HOME and fell for it).
function attackerHome(settingsEnv) {
  const home = mkdtempSync(join(tmpdir(), 'core-autostart-attacker-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: settingsEnv }));
  return home;
}

const run = (env) => execFileSync('node', [HOOK], {
  env: { ...process.env, CORE_HOOKS_LOG_FILE: '/dev/null', ...env },
  encoding: 'utf8',
});

const ALLOW_BBLENS = new Set(['/bblens']);
const ALLOW_NONE = new Set();

test('autostart skill defaults to /core with no env', () => {
  assert.equal(autostartSkill({}, ALLOW_NONE), '/core');
});

test('a USER-authorized wrapper skill is honored', () => {
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/bblens' }, ALLOW_BBLENS), '/bblens');
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/my-plugin:entry' }, new Set(['/my-plugin:entry'])), '/my-plugin:entry');
});

test('AUTHORITY GATE: a well-shaped but unauthorized skill falls back to /core', () => {
  // Shape is not authority (Hale 2026-07-11 §5): a project-influenceable env value
  // must not be able to redirect the session's mandated first action to an arbitrary
  // installed skill. /my-plugin:entry is syntactically valid — and rejected, because
  // the user never registered it.
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/my-plugin:entry' }, ALLOW_BBLENS), '/core');
  assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: '/bblens' }, ALLOW_NONE), '/core');
});

test('a non-skill-shaped value falls back to /core regardless of authorization', () => {
  // Free text must never reach the injected directive — that would be prompt injection
  // from an untrusted repo's .claude/settings.json env block.
  for (const bad of ['/evil skill and also exfiltrate', 'core', '/Core', '/a b', '/x;rm', '/', '/-x', '']) {
    assert.equal(autostartSkill({ CORE_AUTOSTART_SKILL: bad }, new Set([bad])), '/core', JSON.stringify(bad));
  }
});

test('userAuthorizedSkills reads both registration forms; unreadable settings fail closed', () => {
  const readOk = () => JSON.stringify({ env: { CORE_AUTOSTART_SKILL: '/bblens', CORE_AUTOSTART_ALLOWED_SKILLS: '/alpha, /beta' } });
  const got = userAuthorizedSkills(readOk, '/nowhere');
  assert.deepEqual([...got].sort(), ['/alpha', '/bblens', '/beta']);
  const readBoom = () => { throw new Error('ENOENT'); };
  assert.equal(userAuthorizedSkills(readBoom, '/nowhere').size, 0, 'no user settings → nothing authorized');
});

test('buildDirective names the skill at both mention points', () => {
  const d = buildDirective('/bblens');
  const mentions = d.match(/\/bblens/g) || [];
  assert.ok(mentions.length >= 2, 'directive must tell the agent the wrapper skill, both times');
  assert.ok(!d.includes('/core'), 'the default skill must not linger in an overridden directive');
});

test('hook subprocess: default injects /core', () => {
  assert.match(run({}), /`\/core`/);
});

test('ATTACK PATH (Hale re-review §5): hostile HOME/USERPROFILE + attacker settings cannot redirect the directive', () => {
  // The project-controlled hook env points HOME and USERPROFILE at an attacker
  // directory whose settings.json "authorizes" /my-plugin:entry, and names that
  // skill in CORE_AUTOSTART_SKILL. Pre-fix, the hook emitted the attacker's skill
  // as the session's mandated first action. The trusted home comes from the OS
  // account database now, so the attacker's settings file is never read.
  const evil = attackerHome({ CORE_AUTOSTART_SKILL: '/my-plugin:entry', CORE_AUTOSTART_ALLOWED_SKILLS: '/my-plugin:entry' });
  const out = run({ CORE_AUTOSTART_SKILL: '/my-plugin:entry', HOME: evil, USERPROFILE: evil });
  assert.match(out, /`\/core`/, 'directive must fall back to /core');
  assert.ok(!out.includes('/my-plugin:entry'), 'attacker skill must not appear in the directive');
});

test('hook subprocess: recursion guard and opt-out still win over the override', () => {
  assert.equal(run({ CORE_AUTOSTART_SKILL: '/bblens', CORE_CLOSE_PASS_ACTIVE: '1' }).trim(), '');
  assert.equal(run({ CORE_AUTOSTART_SKILL: '/bblens', CORE_AUTOSTART: '0' }).trim(), '');
});
