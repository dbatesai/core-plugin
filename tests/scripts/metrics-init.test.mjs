import { operationalMetricsDir, resolveStoragePath } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { writeSignedFile } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
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

function signedPin(meta, home, path) { writeSignedFile({ dir: meta, name: 'storage-path.txt', body: path, coreDir: join(home, '.core') }); }

test('the AppData metrics folder is one-to-one, and an unclaimed legacy folder is never taken by whichever project scaffolds first', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-appdata-'));
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      const A = join(home, 'p', 'a.b');
      const B = join(home, 'p', 'a-b');
      const slug = (p) => p.replace(/[/\\.:]/g, '-');
      assert.notEqual(detectStoragePath({ projectDir: A, home }).path, detectStoragePath({ projectDir: B, home }).path);

      const legacy = join(home, 'AppData', 'Local', 'core-metrics', slug(A));
      assert.equal(slug(A), slug(B), 'the two names really do share one slug');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'evidence.jsonl'), '{"a":1}\n');
      assert.notEqual(detectStoragePath({ projectDir: B, home }).path, legacy, 'unclaimed: not taken by B');
      assert.notEqual(detectStoragePath({ projectDir: A, home }).path, legacy, 'unclaimed: not taken by A either, it comes through A\'s own pin');
      assert.equal(existsSync(join(legacy, '.project-root')), false, 'and nobody claimed it by asking');

      writeFileSync(join(legacy, '.project-root'), A + '\n');
      assert.equal(detectStoragePath({ projectDir: A, home }).path, legacy, 'claimed by A: A keeps it');
      assert.notEqual(detectStoragePath({ projectDir: B, home }).path, legacy, 'claimed by A: B gets its own');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

test('B scaffolding first cannot take A\'s unclaimed legacy folder; A keeps it through its own pin and claims it then', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-owner-home-'));
    const A = mkdtempSync(join(tmpdir(), 'metrics-a.b-'));
    const B = mkdtempSync(join(tmpdir(), 'metrics-a-b-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      const legacy = join(home, 'AppData', 'Local', 'core-metrics', 'shared-slug-with-old-evidence');
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'evidence.jsonl'), '{"a":1}\n');
      signedPin(operationalMetricsDir(A, { home, env: {} }), home, legacy);

      const rb = initMetrics({ projectDir: B, env: {} });
      assert.notEqual(rb.storagePath, legacy, 'B is not handed A\'s bytes');
      const ra = initMetrics({ projectDir: A, env: {} });
      assert.equal(ra.storagePath, legacy, 'A keeps the folder its own pin names');
      assert.equal(readFileSync(join(legacy, '.project-root'), 'utf8').trim(), A, 'and claims it');
      assert.equal(readFileSync(join(legacy, 'evidence.jsonl'), 'utf8'), '{"a":1}\n');
    } finally { for (const d of [home, A, B]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a pin that already names an existing external folder survives the scaffold; a missing, foreign-claimed or forced-local one is recomputed', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-pin-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-pin-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      const pinFile = join(meta, 'storage-path.txt');
      const old = join(home, 'AppData', 'Local', 'core-metrics', 'old-workspace-id');
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, 'evidence.jsonl'), '{"row":1}\n');
      signedPin(meta, home, old);
      process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';

      let r = initMetrics({ projectDir, env: {} });
      assert.equal(r.storagePath, old, 'the carried-in pin is kept');
      assert.equal(readFileSync(pinFile, 'utf8'), old);

      writeFileSync(join(old, '.project-root'), '/some/other/project\n');
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, old, 'a folder another project claimed is not reused');

      signedPin(meta, home, join(home, 'AppData', 'Local', 'core-metrics', 'gone'));
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, join(home, 'AppData', 'Local', 'core-metrics', 'gone'), 'a pin to a missing folder is recomputed');

      signedPin(meta, home, old);
      rmSync(join(old, '.project-root'));
      process.env.CORE_METRICS_FORCE_PROJECT_LOCAL = '1';
      r = initMetrics({ projectDir, env: {} });
      assert.equal(r.storagePath, join(projectDir, '_metrics'), 'the force-local escape hatch still wins');
    } finally { rmSync(home, { recursive: true, force: true }); rmSync(projectDir, { recursive: true, force: true }); }
  });
});

test('a pin that this install did not sign, or that names somewhere metrics may not live, redirects nothing', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-trust-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-trust-proj-'));
    const outside = mkdtempSync(join(tmpdir(), 'metrics-trust-outside-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      writeFileSync(join(meta, 'storage-path.txt'), outside);
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'an unsigned pin is ignored');
      let r = initMetrics({ projectDir, env: {} });
      assert.equal(r.storagePath, join(projectDir, '_metrics'), 'and the scaffold does not keep it');

      signedPin(meta, home, outside);
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'a signed pin outside the allowed folders is ignored');
      process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, outside, 'the scaffold does not keep it either');

      const inside = join(home, 'AppData', 'Local', 'core-metrics', 'ok');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(meta, 'storage-path.txt'), inside);
      rmSync(join(meta, 'storage-path.txt.mac'), { force: true });
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'an unsigned pin is ignored even when it names an allowed folder');
      signedPin(meta, home, inside);
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), inside, 'a signed pin inside AppData is honored');
    } finally { for (const d of [home, projectDir, outside]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('two registered projects whose signed pins name the same unclaimed folder: neither takes it, both are told, and the bytes are untouched', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-hold-home-'));
    const A = mkdtempSync(join(tmpdir(), 'metrics-hold-a-'));
    const B = mkdtempSync(join(tmpdir(), 'metrics-hold-b-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      const coreDir = join(home, '.core');
      registerProject(coreDir, A);
      registerProject(coreDir, B);
      const shared = join(home, 'AppData', 'Local', 'core-metrics', 'shared-before-the-claim');
      mkdirSync(shared, { recursive: true });
      writeFileSync(join(shared, 'evidence.jsonl'), '{"who":"unknown"}\n');
      signedPin(operationalMetricsDir(A, { home, env: {} }), home, shared);
      signedPin(operationalMetricsDir(B, { home, env: {} }), home, shared);

      for (const [me, other] of [[B, A], [A, B]]) {
        const r = initMetrics({ projectDir: me, env: {} });
        assert.notEqual(r.storagePath, shared, 'not taken, whoever scaffolds first');
        assert.equal(r.held_legacy_folder.folder, shared);
        assert.deepEqual(r.held_legacy_folder.also_named_by.map((x) => x.replace(/^\/private/, '')), [other.replace(/^\/private/, '')]);
      }
      assert.equal(existsSync(join(shared, '.project-root')), false, 'still unclaimed');
      assert.equal(readFileSync(join(shared, 'evidence.jsonl'), 'utf8'), '{"who":"unknown"}\n');
    } finally { for (const d of [home, A, B]) rmSync(d, { recursive: true, force: true }); }
  });
});
