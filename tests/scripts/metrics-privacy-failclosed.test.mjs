import { operationalMetricsDir } from '../../plugins/core/skills/core/scripts/log-event.mjs';
// metrics-privacy-failclosed.test.mjs — the capture-disabled marker an earlier
// scaffold left (when it could not pin storage) keeps capture OFF until a scaffold
// clears it. Nothing writes the marker now; one left behind is still honored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const INIT_URL = pathToFileURL(join(SCRIPTS, 'metrics-init.mjs')).href;
const LOG_EVENT_URL = pathToFileURL(join(SCRIPTS, 'log-event.mjs')).href;

function runChild(runner, env) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

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

test('a scaffold clears a stale capture-disabled marker and capture resumes (recovery path), and writes no pin', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'core-pin-recover-home-'));
  const project = mkdtempSync(join(tmpdir(), 'core-pin-recover-'));
  try {
    // Stale marker from a previously failed scaffold.
    mkdirSync(join(project, '_metrics'), { recursive: true });
    writeFileSync(join(project, '_metrics', 'capture-disabled.json'),
      JSON.stringify({ marker: 'core-capture-disabled', reason: 'storage-pin-write-failed' }) + '\n');
    const runner = [
      `import { initMetrics } from ${JSON.stringify(INIT_URL)};`,
      `import { metricsEnabled } from ${JSON.stringify(LOG_EVENT_URL)};`,
      `const result = initMetrics({ projectDir: ${JSON.stringify(project)}});`,
      `process.stdout.write(JSON.stringify({ result, metricsOn: metricsEnabled({ project: ${JSON.stringify(project)} }) }));`,
    ].join('\n');
    const child = runChild(runner, { HOME: fakeHome, USERPROFILE: fakeHome });
    assert.equal(child.status, 0, child.stderr);
    const observed = JSON.parse(child.stdout);
    assert.equal(observed.result.ok, true, JSON.stringify(observed.result));
    assert.equal(observed.result.storagePath, join(project, '_metrics'));
    assert.equal(existsSync(join(project, '_metrics', 'capture-disabled.json')), false,
      'the scaffold clears the stale fail-closed marker');
    assert.equal(observed.metricsOn, true);
    const metaDir = operationalMetricsDir(project, { home: fakeHome, env: {} });
    assert.equal(existsSync(join(metaDir, 'storage-path.txt')), false, 'no pin is written');
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
