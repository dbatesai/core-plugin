import { operationalMetricsDir } from '../../plugins/core/skills/core/scripts/log-event.mjs';
// Behavioral companion to the metrics-init-wirein doc-guard: exercises the real
// scaffold against temp dirs. HOME (and USERPROFILE for Windows) is redirected to
// a temp dir for the initMetrics test so the operational-meta write under
// the project's metrics state never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // os.homedir() source on Windows
    try {
      const result = initMetrics({ projectDir, env: {} });

      assert.equal(result.ok, true);
      assert.equal(result.storagePath, join(projectDir, '_metrics'));

      // Storage root exists on disk; the retired OTel/push subdirectories
      // (no shipped producer or consumer) are NOT scaffolded.
      assert.ok(existsSync(result.storagePath), 'storage root scaffolded');
      for (const sub of ['traces', 'payloads', 'queue']) {
        assert.equal(existsSync(join(result.storagePath, sub)), false, `${sub}/ not scaffolded (retired)`);
      }

      // Operational meta landed under the redirected HOME, never the real one
      const metaDir = operationalMetricsDir(projectDir, { home: fakeHome, env: {} });
      assert.equal(result.operationalMetaDir, metaDir);
      assert.ok(existsSync(join(metaDir, 'scaffold.log')), 'forensic scaffold.log written');
      assert.equal(
        readFileSync(join(metaDir, 'storage-path.txt'), 'utf8'),
        result.storagePath,
        'storage-path.txt pins the resolved storage path'
      );

      // Idempotent: a re-run still reports ok against existing structure
      assert.equal(initMetrics({ projectDir, env: {} }).ok, true);
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
      const detection = detectStoragePath({ projectDir });
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

test('the AppData metrics folder is one-to-one: a.b and a-b never share it, and an unclaimed legacy folder keeps its owner', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-appdata-'));
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      const a = detectStoragePath({ projectDir: join(home, 'p', 'a.b'), home }).path;
      const b = detectStoragePath({ projectDir: join(home, 'p', 'a-b'), home }).path;
      assert.notEqual(a, b);

      // A folder from before the claim existed: the first project to scaffold keeps it and claims it.
      const legacy = join(home, 'AppData', 'Local', 'core-metrics', join(home, 'p', 'a.b').replace(/[/\\.:]/g, '-'));
      mkdirSync(legacy, { recursive: true });
      assert.equal(detectStoragePath({ projectDir: join(home, 'p', 'a.b'), home }).path, legacy, 'unclaimed: kept for continuity');
      writeFileSync(join(legacy, '.project-root'), join(home, 'p', 'a.b') + '\n');
      assert.equal(detectStoragePath({ projectDir: join(home, 'p', 'a.b'), home }).path, legacy, 'claimed by this project: kept');
      const other = join(home, 'p', 'a-b');
      const legacyOther = join(home, 'AppData', 'Local', 'core-metrics', other.replace(/[/\\.:]/g, '-'));
      assert.equal(legacyOther, legacy, 'the two names really do share one slug');
      assert.notEqual(detectStoragePath({ projectDir: other, home }).path, legacy, 'claimed by another project: this one gets its own');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
