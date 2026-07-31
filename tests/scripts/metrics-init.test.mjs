// Behavioral companion to the metrics-init-wirein doc-guard: exercises the real
// scaffold against temp dirs. HOME (and USERPROFILE for Windows) is redirected to
// a temp dir for the initMetrics test so the operational-meta write under
// `~/.core/workspaces/<id>/metrics/` never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initMetrics,
  detectStoragePath,
  projectPathContainsOneDriveSubstring,
} from '../../plugins/core/skills/core/scripts/metrics-init.mjs';

// detectStoragePath honors these as escape hatches — make sure ambient shell
// state can't flip the detection branch under test.
function withCleanEnv(fn) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CORE_METRICS_FORCE_PROJECT_LOCAL: process.env.CORE_METRICS_FORCE_PROJECT_LOCAL,
    CORE_METRICS_FORCE_APPDATA_FALLBACK: process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK,
  };
  delete process.env.CORE_METRICS_FORCE_PROJECT_LOCAL;
  delete process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('initMetrics scaffolds the metrics storage observably on disk', () => {
  withCleanEnv(() => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'metrics-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-proj-'));
    const workspaceId = 'test-metrics-init-a7';
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // os.homedir() source on Windows
    try {
      const result = initMetrics({ projectDir, workspaceId });

      assert.equal(result.ok, true);
      assert.equal(result.storagePath, join(projectDir, '_metrics'));

      // Storage root exists on disk; the retired OTel/push subdirectories
      // (no shipped producer or consumer) are NOT scaffolded.
      assert.ok(existsSync(result.storagePath), 'storage root scaffolded');
      for (const sub of ['traces', 'payloads', 'queue']) {
        assert.equal(existsSync(join(result.storagePath, sub)), false, `${sub}/ not scaffolded (retired)`);
      }

      // Operational meta landed under the redirected HOME, never the real one
      const metaDir = join(fakeHome, '.core', 'workspaces', workspaceId, 'metrics');
      assert.equal(result.operationalMetaDir, metaDir);
      assert.ok(existsSync(join(metaDir, 'scaffold.log')), 'forensic scaffold.log written');
      assert.equal(
        readFileSync(join(metaDir, 'storage-path.txt'), 'utf8'),
        result.storagePath,
        'storage-path.txt pins the resolved storage path'
      );

      // Idempotent: a re-run still reports ok against existing structure
      assert.equal(initMetrics({ projectDir, workspaceId }).ok, true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

test('detectStoragePath returns the default project-local path when the path has no OneDrive substring', () => {
  withCleanEnv(() => {
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-detect-'));
    try {
      const detection = detectStoragePath({ projectDir, workspaceId: 'test-detect-a7' });
      assert.equal(detection.path, join(projectDir, '_metrics'));
      // On non-Windows the platform branch decides; on Windows it's the
      // no-OneDrive branch. Either way the reason names project-local.
      assert.match(detection.reason, /project-local/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

test('projectPathContainsOneDriveSubstring is true for OneDrive paths and false otherwise', () => {
  assert.equal(projectPathContainsOneDriveSubstring('C:\\Users\\david\\OneDrive\\Projects\\app'), true);
  assert.equal(projectPathContainsOneDriveSubstring('C:\\Users\\david\\OneDrive - Contoso\\Projects\\app'), true);
  assert.equal(projectPathContainsOneDriveSubstring('/Users/david/OneDrive/Projects/app'), true);
  assert.equal(projectPathContainsOneDriveSubstring('/Users/david/Documents/Projects/app'), false);
  // Characterized: the "substring" check is a whole-path-component match, so a
  // component merely containing the word does not trip it.
  assert.equal(projectPathContainsOneDriveSubstring('/Users/david/OneDrive-backup-archive/app'), false);
});
