// The session id an agent passes to CORE comes from the harness, through the SessionStart hook,
// never from a folder name. Without one, a project-only close is not certified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const HOOK = join(here, '../../plugins/core/skills/core/hooks/session-start-hook.mjs');
const PO = join(here, '../../plugins/core/skills/core/scripts/project-only.mjs');
const REAL = '6e3a629a-2223-457c-a4e4-36267c9a3f84';
const DECOY = '9db517ba-38ec-4d81-a169-36f26d943188';

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-session-id-')));
  const home = join(base, 'home'); mkdirSync(home);
  const proj = join(base, DECOY, 'project'); mkdirSync(proj, { recursive: true });   // the folder name carries a different id
  return { base, home, proj, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
function hook(s, payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: s.home, USERPROFILE: s.home, CORE_HOOKS_LOG_FILE: '/dev/null', CORE_AUTOSTART: '', CORE_CLOSE_PASS_ACTIVE: '', ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

for (const mode of ['project-only', 'normal']) {
  test(`${mode}: the hook states the harness's session id, never the one in the folder name`, () => {
    const s = sandbox();
    try {
      if (mode === 'project-only') mkdirSync(join(s.proj, '_core', '_project-only', 'claude-code'), { recursive: true });
      const out = hook(s, { cwd: s.proj, session_id: REAL });
      assert.match(out, mode === 'project-only' ? /CORE project-only mode/ : /CORE session protocol/);
      assert.match(out, new RegExp(`CORE session id for this session \\(from the harness\\): ${REAL}`));
      assert.doesNotMatch(out, new RegExp(DECOY), 'the id in the folder path is never offered');
    } finally { s.cleanup(); }
  });
}

test('no id, or one that is not a plain id, gives no id line', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.proj, '_core', '_project-only', 'claude-code'), { recursive: true });
    for (const session_id of [undefined, '', '../etc', 'has space', 'x'.repeat(200), 42]) {
      const out = hook(s, { cwd: s.proj, ...(session_id === undefined ? {} : { session_id }) });
      assert.match(out, /CORE project-only mode/);
      assert.doesNotMatch(out, /CORE session id/, JSON.stringify(session_id));
    }
  } finally { s.cleanup(); }
});

test('a project-only close without a session id is refused, so it cannot be certified', () => {
  const s = sandbox();
  try {
    const r = spawnSync(process.execPath, [PO, 'finalize-begin', '--root', s.proj, '--harness', 'claude-code'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, HOME: s.home } });
    assert.match(r.stdout, /session-required/);
  } finally { s.cleanup(); }
});
