// CORE's account home comes from the OS account record, once per process; HOME (and a changing HOME)
// decides nothing, and the harness's own transcript root is a separate parameter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountHomeArgs } from '../helpers/account-home.mjs';

const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));
const run = (home, code, env = {}) => spawnSync(process.execPath, [...accountHomeArgs(home), '--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', ...env }, timeout: 20000 });
const fresh = (n) => realpathSync(mkdtempSync(join(tmpdir(), n)));

test('trusted home B wins over a poisoned HOME A, and a HOME that changes mid-process changes nothing', () => {
  const B = fresh('acct-B-'), A = fresh('acct-A-');
  try {
    const r = run(B, `import {coreHome} from ${JSON.stringify(SCRIPTS + 'trusted-home.mjs')};
      const first = coreHome(); process.env.HOME = ${JSON.stringify(A)}; process.env.USERPROFILE = ${JSON.stringify(A)};
      console.log(JSON.stringify([first, coreHome()]));`, { HOME: A, USERPROFILE: A });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [B, B]);
  } finally { rmSync(A, { recursive: true, force: true }); rmSync(B, { recursive: true, force: true }); }
});

test('the capture gate, the metrics gate and purge consult the same account home, and a project registered under HOME A is not read', () => {
  const B = fresh('acct-B-'), A = fresh('acct-A-'), proj = fresh('acct-proj-');
  try {
    for (const h of [A, B]) { mkdirSync(join(h, '.core')); writeFileSync(join(h, '.core', 'projects.json'), JSON.stringify([{ path: proj }])); }
    const r = run(B, `
      import {metricsEnabled} from ${JSON.stringify(SCRIPTS + 'log-event.mjs')};
      import {turnCaptureEnabled, turnCapturePurgeScope} from ${JSON.stringify(SCRIPTS + 'turn-capture.mjs')};
      const env = { CORE_HARNESS: 'claude-code' };
      const scope = turnCapturePurgeScope(${JSON.stringify(proj)}, { env });
      console.log(JSON.stringify({ m: metricsEnabled({ project: ${JSON.stringify(proj)}, env }), t: turnCaptureEnabled({ project: ${JSON.stringify(proj)}, env }), scope: JSON.stringify(scope).includes(${JSON.stringify(A)}) }));`, { HOME: A, USERPROFILE: A });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.scope, false, 'purge never consults the poisoned HOME');
    assert.deepEqual(readdirSync(join(A, '.core')), ['projects.json'], 'nothing was written under the poisoned HOME');
  } finally { for (const d of [A, B, proj]) rmSync(d, { recursive: true, force: true }); }
});

test('with no account home the gates are OFF, never a guess from the environment', () => {
  const A = fresh('acct-A-'), proj = fresh('acct-proj-');
  try {
    const preload = `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.userInfo=()=>{throw new Error('no account')};syncBuiltinESMExports();`;
    const r = spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), '--input-type=module', '-e', `
      import {metricsEnabled} from ${JSON.stringify(SCRIPTS + 'log-event.mjs')};
      import {turnCaptureEnabled} from ${JSON.stringify(SCRIPTS + 'turn-capture.mjs')};
      console.log(JSON.stringify([metricsEnabled({ project: ${JSON.stringify(proj)}, env: {} }), turnCaptureEnabled({ project: ${JSON.stringify(proj)}, env: {} })]));`],
      { encoding: 'utf8', env: { ...process.env, HOME: A, USERPROFILE: A, NODE_OPTIONS: '' }, timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [false, false]);
  } finally { rmSync(A, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); }
});

test('native transcript root and CORE authority are separate parameters', async () => {
  const { runClassification } = await import('../../plugins/core/skills/core/scripts/classify-turns.mjs');
  const { mapProjectPathToSlug } = await import('../../plugins/core/skills/core/scripts/project-slug.mjs');
  const core = fresh('acct-core-'), native = fresh('acct-native-'), proj = fresh('acct-proj-');
  try {
    mkdirSync(join(core, '.core')); writeFileSync(join(core, '.core', 'projects.json'), JSON.stringify([{ path: proj }]));
    mkdirSync(join(proj, '_memories'));
    const tdir = join(native, '.claude', 'projects', mapProjectPathToSlug(proj));
    mkdirSync(tdir, { recursive: true });
    writeFileSync(join(tdir, 's1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, sessionId: 's1', timestamp: '2026-10-05T00:00:00Z' }) + '\n');
    const env = { CORE_HARNESS: 'claude-code' };
    const found = runClassification({ project: proj, cwd: proj, home: core, nativeHome: native, sessionId: 's1', env, today: '2026-10-05' });
    const notFound = runClassification({ project: proj, cwd: proj, home: native, nativeHome: core, sessionId: 's1', env, today: '2026-10-05' });
    assert.notEqual(found.status, 'UNAVAILABLE', JSON.stringify(found));
    assert.equal(notFound.status === 'UNAVAILABLE' || notFound.status === 'DISABLED', true, 'swapping the roots finds no transcript');
  } finally { for (const d of [core, native, proj]) rmSync(d, { recursive: true, force: true }); }
});
