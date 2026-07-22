// Behavioral test for the one-time first-run metrics disclosure (Fix 1 of the
// dc-107 public-marketplace gap: metrics capture is default-on but was never
// disclosed to users). HOME is redirected to a temp dir so the manifest write
// under `~/.core/workspaces/<id>/workspace.json` never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { checkMetricsDisclosure, NOTICE_TEXT } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';

const SCRIPT = join(process.cwd(), 'plugins/core/skills/core/scripts/metrics-disclosure.mjs');

function withFakeHome(fn) {
  const fakeHome = mkdtempSync(join(tmpdir(), 'metrics-disclosure-home-'));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    return fn(fakeHome);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

test('first call for a workspace id shows the notice and persists the flag', () => {
  withFakeHome((fakeHome) => {
    const workspaceId = 'test-disclosure-a1';
    const manifestDir = join(fakeHome, '.core', 'workspaces', workspaceId);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'workspace.json'), JSON.stringify({ workspace_id: workspaceId, schema_version: 'v2' }, null, 2));

    const result = checkMetricsDisclosure({ workspaceId });

    assert.equal(result.ok, true);
    assert.equal(result.shown, true);
    assert.equal(result.alreadyShown, false);
    assert.equal(result.noticeText, NOTICE_TEXT);

    const manifest = JSON.parse(readFileSync(join(manifestDir, 'workspace.json'), 'utf8'));
    assert.equal(manifest.metrics_disclosure_shown, true, 'flag persisted into the manifest');
    assert.equal(manifest.workspace_id, workspaceId, 'pre-existing manifest fields preserved, not clobbered');
    assert.equal(manifest.schema_version, 'v2', 'pre-existing manifest fields preserved, not clobbered');
  });
});

test('second and subsequent calls for the same workspace id report ALREADY-SHOWN and write nothing further', () => {
  withFakeHome((fakeHome) => {
    const workspaceId = 'test-disclosure-a2';
    const manifestDir = join(fakeHome, '.core', 'workspaces', workspaceId);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'workspace.json'), JSON.stringify({ workspace_id: workspaceId }, null, 2));

    const first = checkMetricsDisclosure({ workspaceId });
    assert.equal(first.shown, true);

    const beforeSecond = readFileSync(join(manifestDir, 'workspace.json'), 'utf8');

    const second = checkMetricsDisclosure({ workspaceId });
    assert.equal(second.ok, true);
    assert.equal(second.shown, false);
    assert.equal(second.alreadyShown, true);
    assert.equal(second.noticeText, null, 'no notice text on repeat calls — never nags');

    const third = checkMetricsDisclosure({ workspaceId });
    assert.equal(third.alreadyShown, true);

    const afterThird = readFileSync(join(manifestDir, 'workspace.json'), 'utf8');
    assert.equal(afterThird, beforeSecond, 'manifest untouched on repeat calls');
  });
});

test('a workspace with no manifest yet still shows once and creates the manifest with the flag set', () => {
  withFakeHome((fakeHome) => {
    const workspaceId = 'test-disclosure-no-manifest';
    const manifestPath = join(fakeHome, '.core', 'workspaces', workspaceId, 'workspace.json');
    assert.equal(existsSync(manifestPath), false);

    const result = checkMetricsDisclosure({ workspaceId });
    assert.equal(result.shown, true);
    assert.ok(existsSync(manifestPath), 'manifest created');
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).metrics_disclosure_shown, true);
  });
});

test('missing workspaceId fails without throwing and shows nothing', () => {
  const result = checkMetricsDisclosure({});
  assert.equal(result.ok, false);
  assert.equal(result.shown, false);
  assert.equal(result.noticeText, null);
  assert.equal(result.reason, 'missing-workspace-id');
});

test('an unparseable manifest fails without throwing rather than silently skipping or clobbering', () => {
  withFakeHome((fakeHome) => {
    const workspaceId = 'test-disclosure-corrupt';
    const manifestDir = join(fakeHome, '.core', 'workspaces', workspaceId);
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'workspace.json'), '{ not valid json');

    const result = checkMetricsDisclosure({ workspaceId });
    assert.equal(result.ok, false);
    assert.equal(result.noticeText, null);
    assert.match(result.reason, /manifest-unparseable/);
  });
});

test('the notice text names both opt-out mechanisms and the local-only claim', () => {
  assert.match(NOTICE_TEXT, /CORE_METRICS_ENABLED=0/, 'names the env-var opt-out');
  assert.match(NOTICE_TEXT, /metrics_enabled:\s*false/, 'names the workspace.json opt-out');
  assert.match(NOTICE_TEXT, /workspace\.json/, 'names the config file by its real name');
  assert.match(NOTICE_TEXT, /this machine/i, 'states the local-only claim in plain terms');
});

test('CLI: first run prints the notice text; second run prints ALREADY-SHOWN', { skip: platform() === 'win32' ? 'shell redirection differs on Windows CI' : false }, () => {
  withFakeHome((fakeHome) => {
    const workspaceId = 'test-disclosure-cli';
    const env = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };

    const firstOut = execFileSync('node', [SCRIPT, 'check', workspaceId], { encoding: 'utf8', env });
    assert.equal(firstOut.trim(), NOTICE_TEXT.trim());

    const secondOut = execFileSync('node', [SCRIPT, 'check', workspaceId], { encoding: 'utf8', env });
    assert.equal(secondOut.trim(), 'ALREADY-SHOWN');
  });
});

test('CLI: missing workspace-id argument exits nonzero with a usage message', () => {
  assert.throws(() => {
    execFileSync('node', [SCRIPT, 'check'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }, /Command failed/);
});
