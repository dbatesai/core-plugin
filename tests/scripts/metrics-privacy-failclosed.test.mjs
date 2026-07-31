// metrics-privacy-failclosed.test.mjs — the OneDrive privacy redirect must
// FAIL CLOSED when its storage pin cannot be written.
//
// The audited defect: metrics-init wrote storage-path.txt non-atomically and
// swallowed the failure; log-event.resolveStoragePath then silently fell back
// to <project>/_metrics — putting turn capture back into the synced folder the
// redirect exists to avoid. The contract now: the pin write is atomic
// (fs-atomic sibling temp), and a pin failure disables capture — typed
// capture-disabled.json marker + one loud CORE-METRICS-PIN-FAILED stderr line
// — with metricsEnabled/turnCaptureEnabled reading the marker as OFF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const INIT_URL = pathToFileURL(join(SCRIPTS, 'metrics-init.mjs')).href;
const LOG_EVENT_URL = pathToFileURL(join(SCRIPTS, 'log-event.mjs')).href;
const TURN_CAPTURE_URL = pathToFileURL(join(SCRIPTS, 'turn-capture.mjs')).href;

// chmod-based unwritability is not enforceable the same way on Windows ACLs;
// the fail-closed logic itself is platform-neutral and covered on POSIX.
const WIN_SKIP = process.platform === 'win32'
  ? 'win32: chmod 0o500 does not make a directory unwritable under Windows ACLs'
  : false;

function runChild(runner, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('pin write failure fails CLOSED: ok:false, typed marker, loud stderr, capture gates read OFF', { skip: WIN_SKIP }, () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'core-pin-home-'));
  const project = mkdtempSync(join(tmpdir(), 'core-pin-project-'));
  const ws = 'pin-fail-ws';
  const meta = join(fakeHome, '.core', 'workspaces', ws, 'metrics');
  mkdirSync(meta, { recursive: true });
  chmodSync(meta, 0o500); // pin (and meta-dir marker) unwritable
  const runner = [
    `import { initMetrics } from ${JSON.stringify(INIT_URL)};`,
    `import { resolveStoragePath, metricsEnabled } from ${JSON.stringify(LOG_EVENT_URL)};`,
    `import { turnCaptureEnabled } from ${JSON.stringify(TURN_CAPTURE_URL)};`,
    `const result = initMetrics({ projectDir: ${JSON.stringify(project)}, workspaceId: ${JSON.stringify(ws)} });`,
    'process.stdout.write(JSON.stringify({',
    '  result,',
    `  resolved: resolveStoragePath(${JSON.stringify(project)}, { workspaceId: ${JSON.stringify(ws)} }),`,
    `  metricsOn: metricsEnabled({ project: ${JSON.stringify(project)} }),`,
    `  turnCaptureOn: turnCaptureEnabled({ project: ${JSON.stringify(project)} }),`,
    '}));',
  ].join('\n');
  try {
    const child = runChild(runner, {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CORE_METRICS_FORCE_APPDATA_FALLBACK: '1', // the redirect-required shape
    });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);

    // Never "ok" over a failed pin — the exact adversarial-regression contract.
    assert.equal(observed.result.ok, false, 'initMetrics must not report success when the pin cannot land');
    assert.equal(observed.result.reason, 'storage-pin-write-failed');
    assert.equal(observed.result.captureDisabled, true);

    // One loud stderr line.
    assert.match(child.stderr, /CORE-METRICS-PIN-FAILED/, 'pin failure must be loud, never swallowed');
    assert.match(child.stderr, /DISABLED/);

    // Typed marker landed at the project-local fallback location (the meta dir
    // is the thing that is unwritable in this failure).
    const marker = join(project, '_metrics', 'capture-disabled.json');
    assert.ok(existsSync(marker), 'typed capture-disabled marker must exist');
    const parsed = JSON.parse(readFileSync(marker, 'utf8'));
    assert.equal(parsed.marker, 'core-capture-disabled');
    assert.equal(parsed.reason, 'storage-pin-write-failed');

    // The capture gates FAIL CLOSED off the marker — capture never proceeds
    // into the synced project folder as if nothing happened.
    assert.equal(observed.metricsOn, false, 'metricsEnabled must read the marker as OFF');
    assert.equal(observed.turnCaptureOn, false, 'turnCaptureEnabled must follow the closed gate');
  } finally {
    chmodSync(meta, 0o700);
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('capture-disabled marker beats an explicit CORE_METRICS_ENABLED=1 opt-in (privacy fail-closed wins)', () => {
  const project = mkdtempSync(join(tmpdir(), 'core-pin-optin-'));
  const fakeHome = mkdtempSync(join(tmpdir(), 'core-pin-optin-home-'));
  try {
    mkdirSync(join(project, '_metrics'), { recursive: true });
    writeFileSync(join(project, '_metrics', 'capture-disabled.json'),
      JSON.stringify({ marker: 'core-capture-disabled', reason: 'storage-pin-write-failed' }) + '\n');
    const runner = [
      `import { metricsEnabled } from ${JSON.stringify(LOG_EVENT_URL)};`,
      `process.stdout.write(JSON.stringify(metricsEnabled({ project: ${JSON.stringify(project)} })));`,
    ].join('\n');
    const child = runChild(runner, { HOME: fakeHome, USERPROFILE: fakeHome, CORE_METRICS_ENABLED: '1' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout), false,
      'an env opt-in must not override the fail-closed marker — re-enabling is re-running metrics-init successfully');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('a successful pin is atomic-written and clears a stale capture-disabled marker (recovery path)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'core-pin-recover-home-'));
  const project = mkdtempSync(join(tmpdir(), 'core-pin-recover-'));
  const ws = 'pin-recover-ws';
  try {
    // Stale marker from a previously failed scaffold.
    mkdirSync(join(project, '_metrics'), { recursive: true });
    writeFileSync(join(project, '_metrics', 'capture-disabled.json'),
      JSON.stringify({ marker: 'core-capture-disabled', reason: 'storage-pin-write-failed' }) + '\n');
    const runner = [
      `import { initMetrics } from ${JSON.stringify(INIT_URL)};`,
      `import { metricsEnabled } from ${JSON.stringify(LOG_EVENT_URL)};`,
      `const result = initMetrics({ projectDir: ${JSON.stringify(project)}, workspaceId: ${JSON.stringify(ws)} });`,
      `process.stdout.write(JSON.stringify({ result, metricsOn: metricsEnabled({ project: ${JSON.stringify(project)} }) }));`,
    ].join('\n');
    const child = runChild(runner, { HOME: fakeHome, USERPROFILE: fakeHome, CORE_METRICS_FORCE_PROJECT_LOCAL: '1' });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    assert.equal(observed.result.ok, true, JSON.stringify(observed.result));

    // Pin landed with the resolved storage path as its exact content.
    const pin = join(fakeHome, '.core', 'workspaces', ws, 'metrics', 'storage-path.txt');
    assert.ok(existsSync(pin), 'pin file exists after a successful scaffold');
    assert.equal(readFileSync(pin, 'utf8'), observed.result.storagePath);

    // Marker cleared; capture re-enabled.
    assert.equal(existsSync(join(project, '_metrics', 'capture-disabled.json')), false,
      'a successful pin clears the stale fail-closed marker');
    assert.equal(observed.metricsOn, true);

    // No torn sibling temp left behind by the atomic write.
    const metaDir = join(fakeHome, '.core', 'workspaces', ws, 'metrics');
    const leftovers = readdirSync(metaDir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'no .tmp- litter after the atomic pin write');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
