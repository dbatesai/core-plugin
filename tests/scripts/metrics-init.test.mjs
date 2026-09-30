import { operationalMetricsDir, resolveStoragePath, metricsEnabled, storagePinInvalid } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { writePinSigned, readPinSigned, projectRootFor, stateDir, readSignedFileAt, metricsStorageAllowed, localRootKey, localStateDir, canonical } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
// Behavioral companion to the metrics-init-wirein doc-guard: exercises the real
// scaffold against temp dirs. HOME (and USERPROFILE for Windows) is redirected to
// a temp dir for the initMetrics test so the operational-meta write under
// the project's metrics state never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initMetrics,
  detectStoragePath,
  projectPathContainsOneDriveSubstring,
  projectInOneDriveSyncSettings,
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
        readPinSigned({ dir: metaDir, root: projectRootFor(projectDir, { home: fakeHome, coreDir: join(fakeHome, '.core') }), coreDir: join(fakeHome, '.core') }),
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

test('detectStoragePath redirects off a synced folder on non-Windows — iCloud, Dropbox, Google Drive', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-synced-home-'));
    // Real mkdirSync so isSyncedPath's component-by-component check runs against an
    // actual path, not a string that only looks synced.
    const icloud = join(home, 'Library', 'CloudStorage', 'iCloud Drive', 'Projects', 'app');
    const dropbox = join(home, 'Dropbox', 'Projects', 'app');
    const googleDrive = join(home, 'Google Drive', 'Projects', 'app');
    const plain = join(home, 'Documents', 'Projects', 'app');
    for (const dir of [icloud, dropbox, googleDrive, plain]) mkdirSync(dir, { recursive: true });
    try {
      for (const projectDir of [icloud, dropbox, googleDrive]) {
        const detection = detectStoragePath({ projectDir, home, platformName: 'linux' });
        assert.notEqual(detection.path, join(projectDir, '_metrics'), `${projectDir} should redirect, not land under the synced project folder`);
        assert.match(detection.reason, /synced-folder-detected-redirect-local/);
        assert.ok(detection.path.startsWith(join(home, '.core', 'local-metrics')), 'redirected path lands under the local-metrics namespace, not the shared per-harness state tree');
        assert.ok(!detection.path.startsWith(projectDir), 'redirected path is never nested inside the synced project folder itself');
      }
      // The non-synced control still resolves project-local, same as before this fix.
      const control = detectStoragePath({ projectDir: plain, home, platformName: 'linux' });
      assert.equal(control.path, join(plain, '_metrics'));
      assert.match(control.reason, /project-local/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('detectStoragePath on Windows redirects Dropbox, Google Drive and iCloud Drive folders to AppData, the way it does OneDrive', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-win-synced-home-'));
    try {
      for (const sub of ['Dropbox', 'Google Drive', 'iCloudDrive']) {
        const projectDir = join(home, sub, 'Projects', 'app');
        mkdirSync(projectDir, { recursive: true });
        const detection = detectStoragePath({ projectDir, home, platformName: 'win32' });
        assert.match(detection.reason, /windows-synced-folder-detected-redirect-appdata/, `${sub} must not stay project-local`);
        assert.ok(detection.path.startsWith(join(home, 'AppData', 'Local', 'core-metrics')), 'redirect target is the AppData store');
        assert.ok(!detection.path.startsWith(projectDir), 'never nested inside the synced folder');
      }
      const plain = join(home, 'Documents', 'Projects', 'app');
      mkdirSync(plain, { recursive: true });
      const control = detectStoragePath({ projectDir: plain, home, platformName: 'win32' });
      assert.equal(control.path, join(plain, '_metrics'));
      assert.match(control.reason, /windows-no-onedrive-project-local/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('detectStoragePath classifies a symlink alias by its real target, not the alias spelling — the junction-bypass class reported on a real Windows install', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-alias-home-'));
    const dropboxTarget = join(home, 'Dropbox', 'Projects', 'app');
    mkdirSync(dropboxTarget, { recursive: true });
    // The alias sits OUTSIDE any name isSyncedPath recognizes — none of its own path
    // components say "Dropbox" — exactly the Windows junction shape reported live
    // (`Documents/Projects/core-windows` symlinked into `OneDrive/Documents/Projects/core-windows`):
    // detection has to resolve through it to see the real, synced location.
    const aliasParent = join(home, 'Documents', 'Projects');
    mkdirSync(aliasParent, { recursive: true });
    const alias = join(aliasParent, 'app');
    // A junction needs no privilege on Windows; a directory symlink there needs Developer Mode.
    symlinkSync(dropboxTarget, alias, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const detection = detectStoragePath({ projectDir: alias, home, platformName: 'linux' });
      assert.match(detection.reason, /synced-folder-detected-redirect-local/, 'the alias spelling alone gives no hint of Dropbox; only the real target does');
      assert.ok(detection.path.startsWith(join(home, '.core', 'local-metrics')));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('projectInOneDriveSyncSettings only matches a backslash-spelled projectDir against the (backslash-spelled) ini content — the gap a forward-slash caller falls through', () => {
  const settingsRoot = mkdtempSync(join(tmpdir(), 'onedrive-settings-'));
  const personal = join(settingsRoot, 'Personal');
  mkdirSync(personal, { recursive: true });
  const oneDriveRoot = 'C:\\Users\\david\\OneDrive';
  writeFileSync(join(personal, 'account.ini'), Buffer.from(`libraryScope=${oneDriveRoot}\\Documents\r\n`, 'utf16le'));
  try {
    const backslashProject = `${oneDriveRoot}\\Documents\\Projects\\app`;
    const forwardSlashProject = 'C:/Users/david/OneDrive/Documents/Projects/app';
    assert.equal(projectInOneDriveSyncSettings(backslashProject, settingsRoot), true, 'the spelling the .ini actually uses is matched');
    // Characterizes the exact gap reported from a real Windows install: the same logical
    // path, forward-slash spelled (what Git Bash and CORE's own script calls pass), is not
    // recognized — canonical() resolving to the backslash spelling before this function is
    // ever called (detectStoragePath's fix) is what closes it, not a change to this function.
    assert.equal(projectInOneDriveSyncSettings(forwardSlashProject, settingsRoot), false, 'forward-slash spelling of the identical path is not recognized on its own');
  } finally {
    rmSync(settingsRoot, { recursive: true, force: true });
  }
});

test('metricsStorageAllowed accepts the local-metrics redirect target, and does not accept the shared per-harness state tree', () => {
  const home = mkdtempSync(join(tmpdir(), 'metrics-allowed-home-'));
  const projectDir = join(home, 'Library', 'CloudStorage', 'iCloud Drive', 'Projects', 'app');
  mkdirSync(projectDir, { recursive: true });
  try {
    // containedPath requires the root to exist on disk (it's checked once the storage dir
    // has already been scaffolded, same as the real read-back path in log-event.mjs) —
    // mkdirSync mirrors what initMetrics would already have created by then.
    const redirected = join(home, '.core', 'local-metrics', localRootKey(projectDir));
    mkdirSync(redirected, { recursive: true });
    assert.equal(metricsStorageAllowed(redirected, { projectDir, home }), true, 'the actual redirect target detectStoragePath computes must be an allowed pin');
    // A pin pointed at the shared harness-state tree instead (same project, wrong
    // namespace) is refused — that tree has no .project-root owner file to catch a
    // collision, so it never gets treated as valid metrics storage.
    const harnessStateDir = localStateDir({ root: projectDir, harness: 'claude-code', coreDir: join(home, '.core') });
    mkdirSync(harnessStateDir, { recursive: true });
    assert.equal(metricsStorageAllowed(harnessStateDir, { projectDir, home }), false, 'a pin naming the per-harness state tree is not allowed metrics storage');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

function signedPin(meta, home, path, project) { const coreDir = join(home, '.core'); writePinSigned({ dir: meta, path, root: projectRootFor(project, { home, coreDir }), coreDir }); }

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
      signedPin(operationalMetricsDir(A, { home, env: {} }), home, legacy, A);

      const rb = initMetrics({ projectDir: B, env: {} });
      assert.notEqual(rb.storagePath, legacy, 'B is not handed A\'s bytes');
      const ra = initMetrics({ projectDir: A, env: {} });
      assert.equal(ra.storagePath, legacy, 'A keeps the folder its own pin names');
      // Canonical, not raw: detectStoragePath now classifies (and appDataStorePath's owner
      // check now reads/writes) against the canonical root, so the owner file agrees with
      // that — matters on macOS, where mkdtempSync under tmpdir() returns a /var/folders/...
      // spelling that realpath resolves to /private/var/folders/....
      assert.equal(readFileSync(join(legacy, '.project-root'), 'utf8').trim(), canonical(A), 'and claims it');
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
      const old = join(home, 'AppData', 'Local', 'core-metrics', 'old-workspace-id');
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, 'evidence.jsonl'), '{"row":1}\n');
      signedPin(meta, home, old, projectDir);
      process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';

      let r = initMetrics({ projectDir, env: {} });
      assert.equal(r.storagePath, old, 'the carried-in pin is kept');
      assert.equal(readPinSigned({ dir: meta, root: projectRootFor(projectDir, { home, coreDir: join(home, '.core') }), coreDir: join(home, '.core') }), old);

      writeFileSync(join(old, '.project-root'), '/some/other/project\n');
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, old, 'a folder another project claimed is not reused');

      signedPin(meta, home, join(home, 'AppData', 'Local', 'core-metrics', 'gone'), projectDir);
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, join(home, 'AppData', 'Local', 'core-metrics', 'gone'), 'a pin to a missing folder is recomputed');

      signedPin(meta, home, old, projectDir);
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

      signedPin(meta, home, outside, projectDir);
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'a signed pin outside the allowed folders is ignored');
      process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
      r = initMetrics({ projectDir, env: {} });
      assert.notEqual(r.storagePath, outside, 'the scaffold does not keep it either');

      const inside = join(home, 'AppData', 'Local', 'core-metrics', 'ok');
      mkdirSync(inside, { recursive: true });
      writeFileSync(join(meta, 'storage-path.txt'), inside);
      rmSync(join(meta, 'storage-path.txt.mac'), { force: true });
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'an unsigned pin is ignored even when it names an allowed folder');
      signedPin(meta, home, inside, projectDir);
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
      signedPin(operationalMetricsDir(A, { home, env: {} }), home, shared, A);
      signedPin(operationalMetricsDir(B, { home, env: {} }), home, shared, B);

      for (const [me, other] of [[B, A], [A, B]]) {
        const r = initMetrics({ projectDir: me, env: {} });
        assert.notEqual(r.storagePath, shared, 'not taken, whoever scaffolds first');
        assert.equal(r.held_legacy_folder.folder, shared);
        assert.deepEqual(r.held_legacy_folder.also_named_by.map((x) => realpathSync.native(x)), [realpathSync.native(other)]);
      }
      assert.equal(existsSync(join(shared, '.project-root')), false, 'still unclaimed');
      assert.equal(readFileSync(join(shared, 'evidence.jsonl'), 'utf8'), '{"who":"unknown"}\n');
    } finally { for (const d of [home, A, B]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a pin that stops verifying turns capture off instead of falling back to the project folder, and the next scaffold recovers it', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-fail-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-fail-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      const ok = join(home, 'AppData', 'Local', 'core-metrics', 'ok');
      mkdirSync(ok, { recursive: true });
      signedPin(meta, home, ok, projectDir);
      assert.equal(metricsEnabled({ project: projectDir, env: {}, home }), true, 'a valid pin leaves capture on');
      writeFileSync(join(meta, 'storage-path.txt'), ok + '-tampered');
      assert.equal(metricsEnabled({ project: projectDir, env: {}, home }), false, 'a tampered pin switches capture off');
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'));
      initMetrics({ projectDir, env: {} });
      assert.equal(metricsEnabled({ project: projectDir, env: {}, home }), true, 'the scaffold writes a fresh signed pin and capture resumes');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a signed pin naming an AppData folder another project claimed is refused at the reader', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-xown-home-'));
    const A = mkdtempSync(join(tmpdir(), 'metrics-xown-a-'));
    const B = mkdtempSync(join(tmpdir(), 'metrics-xown-b-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const folderA = join(home, 'AppData', 'Local', 'core-metrics', 'a-store');
      mkdirSync(folderA, { recursive: true });
      writeFileSync(join(folderA, '.project-root'), A + '\n');
      signedPin(operationalMetricsDir(B, { home, env: {} }), home, folderA, B);
      assert.equal(metricsEnabled({ project: B, env: {}, home }), false, "B's pin into A's store switches B's capture off");
      assert.notEqual(resolveStoragePath(B, { home, env: {} }), folderA, "and B never resolves to A's store");
      signedPin(operationalMetricsDir(A, { home, env: {} }), home, folderA, A);
      assert.equal(resolveStoragePath(A, { home, env: {} }), folderA, "A's own pin into its own claimed store still works");
    } finally { for (const d of [home, A, B]) rmSync(d, { recursive: true, force: true }); }
  });
});

test("a pin file and its MAC copied from another project verify as a signature but are refused, and a competing signed claim on an unclaimed folder keeps capture off", () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-copy-home-'));
    const A = mkdtempSync(join(tmpdir(), 'metrics-copy-a-'));
    const B = mkdtempSync(join(tmpdir(), 'metrics-copy-b-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const coreDir = join(home, '.core');
      registerProject(coreDir, A);
      registerProject(coreDir, B);
      const shared = join(home, 'AppData', 'Local', 'core-metrics', 'unclaimed-shared');
      mkdirSync(shared, { recursive: true });
      const metaA = operationalMetricsDir(A, { home, env: {} });
      const metaB = operationalMetricsDir(B, { home, env: {} });
      signedPin(metaA, home, shared, A);
      assert.equal(metricsEnabled({ project: A, env: {}, home }), true, 'A alone on an unclaimed folder: capture is on');

      // Copy A's pin and its valid MAC into B's state.
      writeFileSync(join(metaB, 'storage-path.txt'), readFileSync(join(metaA, 'storage-path.txt')));
      writeFileSync(join(metaB, 'storage-path.txt.mac'), readFileSync(join(metaA, 'storage-path.txt.mac')));
      assert.equal(metricsEnabled({ project: B, env: {}, home }), false, "B's copy of A's signed pin is refused");
      assert.notEqual(resolveStoragePath(B, { home, env: {} }), shared);

      // Two genuine signed pins on one unclaimed folder: neither writes until the scaffold decides.
      signedPin(metaB, home, shared, B);
      assert.equal(metricsEnabled({ project: A, env: {}, home }), false, 'a competing signed claim keeps A off');
      assert.equal(metricsEnabled({ project: B, env: {}, home }), false, 'and B off');
    } finally { for (const d of [home, A, B]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('with a pin that does not verify, purge and stats refuse with pin-unverified instead of reporting a clean result for the wrong folder', async () => {
  const { purgeTurnCapture, turnCaptureStats } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-purge-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-purge-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      const store = join(home, 'AppData', 'Local', 'core-metrics', 'real-store');
      mkdirSync(join(store, 'turn-capture'), { recursive: true });
      const rows = join(store, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(rows, '{"row":1}\n{"row":2}\n');
      signedPin(meta, home, store, projectDir);
      assert.equal(turnCaptureStats(projectDir, { env: {} }).rows, 2, 'with a good pin the stream is found');
      assert.equal(purgeTurnCapture(projectDir, { apply: false }).existed, true);

      writeFileSync(join(meta, 'storage-path.txt'), join(projectDir, '_metrics'));   // tamper only the pin
      const dry = purgeTurnCapture(projectDir, { apply: false });
      const real = purgeTurnCapture(projectDir, { apply: true });
      const stats = turnCaptureStats(projectDir, { env: {} });
      for (const r of [dry, real]) {
        assert.equal(r.purged, false);
        assert.equal(r.reason, 'pin-unverified');
      }
      assert.equal(stats.reason, 'pin-unverified');
      assert.equal(stats.rows, null, 'stats do not say zero for rows that exist');
      assert.equal(readFileSync(rows, 'utf8'), '{"row":1}\n{"row":2}\n', 'nothing was deleted');

      signedPin(meta, home, store, projectDir);
      assert.equal(purgeTurnCapture(projectDir, { apply: false }).existed, true, 'once the pin is repaired the stream is located again');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a pin body missing while its signature remains (or the reverse) refuses instead of reading the fallback as clean', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-halfpin-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-halfpin-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      const r = initMetrics({ projectDir, env: {} });
      assert.equal(r.ok, true);
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      const store = r.storagePath;
      writeFileSync(join(store, 'rows.jsonl'), '{"row":1}\n{"row":2}\n');

      rmSync(join(meta, 'storage-path.txt'));   // signature remains, body gone
      assert.equal(storagePinInvalid(projectDir, { env: {} }), true, 'body missing, .mac present: invalid, not absent');
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'));

      const after = initMetrics({ projectDir, env: {} });
      assert.equal(after.ok, true, 'the scaffold repairs it');
      assert.equal(storagePinInvalid(projectDir, { env: {} }), false);
      assert.equal(readFileSync(join(store, 'rows.jsonl'), 'utf8'), '{"row":1}\n{"row":2}\n', 'the AppData rows were never touched');

      rmSync(join(meta, 'storage-path.txt.mac'));   // body remains, signature gone
      assert.equal(storagePinInvalid(projectDir, { env: {} }), true, '.mac missing, body present: invalid, not absent');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('losing the pin entirely after an external scaffold is still caught by a durable marker; a project never redirected reads clean', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-lostpin-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-lostpin-proj-'));
    const never = mkdtempSync(join(tmpdir(), 'metrics-neverext-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      initMetrics({ projectDir, env: {} });
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      rmSync(join(meta, 'storage-path.txt'), { force: true });
      rmSync(join(meta, 'storage-path.txt.mac'), { force: true });
      assert.equal(storagePinInvalid(projectDir, { env: {} }), true, 'both files gone, but the durable marker remembers this project was redirected');

      delete process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK;
      initMetrics({ projectDir: never, env: {} });   // this one was never redirected (no OneDrive/AppData force)
      assert.equal(storagePinInvalid(never, { env: {} }), false, 'a project that was never externally pinned reads clean, no marker written');
    } finally { for (const d of [home, projectDir, never]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a project detected as needing the AppData redirect but never scaffolded refuses capture instead of landing its first row in the synced folder', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-neverscaffolded-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-neverscaffolded-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      // Never call initMetrics: no pin, no marker, nothing has run yet for this project.
      process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';   // stands in for "path detection says redirect"
      assert.equal(storagePinInvalid(projectDir, { env: {} }), true, 'refuses before the first scaffold, on path detection alone');
      assert.equal(resolveStoragePath(projectDir, { home, env: {} }), join(projectDir, '_metrics'), 'read side still falls back, but a capture producer is gated off by storagePinInvalid');

      delete process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK;
      const notRedirected = mkdtempSync(join(tmpdir(), 'metrics-neverscaffolded-plain-'));
      assert.equal(storagePinInvalid(notRedirected, { env: {} }), false, 'an ordinary project with no redirect signal reads clean with no scaffold at all');
      rmSync(notRedirected, { recursive: true, force: true });
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a marker write failure during an external scaffold fails the scaffold closed, the same as a pin write failure', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-markerfail-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-markerfail-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      // Make the durable state's would-be marker file path unwritable: a directory in its place,
      // one level up so mkdirSync(recursive) collides.
      const coreDir = join(home, '.core');
      const durable = stateDir({ root: projectDir, harness: 'claude-code', coreDir, forWrite: true });
      mkdirSync(join(durable.dir, 'metrics-ever-external.txt'), { recursive: true });   // a dir where a file must go
      const r = initMetrics({ projectDir, env: { CORE_HARNESS: 'claude-code' } });
      assert.equal(r.ok, false, 'the scaffold does not report success with no marker behind it');
      const meta = operationalMetricsDir(projectDir, { home, env: {} });
      assert.equal(existsSync(join(meta, 'storage-path.txt')), false, 'no pin was left pointing at an external folder with no marker');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a valid external pin from before the marker existed gets one backfilled on read, so a later total loss is still caught', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-backfill-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-backfill-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    try {
      // env carries CORE_HARNESS explicitly throughout: storagePinInvalid's harness detection
      // falls back to reading it straight off process.env when the passed env has no signal,
      // which only resolves to 'claude-code' when actually run inside that harness. On a bare
      // CI runner it resolves to 'unknown' instead, sending the backfill to the wrong harness
      // folder — pin the harness so the test is deterministic regardless of where it runs.
      const stateEnv = { CORE_HARNESS: 'claude-code' };
      initMetrics({ projectDir, env: stateEnv });
      const coreDir = join(home, '.core');
      const durable = stateDir({ root: projectDir, harness: 'claude-code', coreDir, forWrite: true });
      rmSync(join(durable.dir, 'metrics-ever-external.txt'), { force: true });
      rmSync(join(durable.dir, 'metrics-ever-external.txt.mac'), { force: true });
      assert.equal(readSignedFileAt({ dir: durable.dir, name: 'metrics-ever-external.txt', coreDir }), null, 'no marker yet, as if from before it existed');

      assert.equal(storagePinInvalid(projectDir, { env: stateEnv }), false, 'the pin is currently valid');
      assert.notEqual(readSignedFileAt({ dir: durable.dir, name: 'metrics-ever-external.txt', coreDir }), null, 'reading a valid pin backfilled the marker');

      const meta = operationalMetricsDir(projectDir, { home, env: stateEnv });
      rmSync(join(meta, 'storage-path.txt'), { force: true });
      rmSync(join(meta, 'storage-path.txt.mac'), { force: true });
      assert.equal(storagePinInvalid(projectDir, { env: stateEnv }), true, 'losing the pin afterward is still caught, via the backfilled marker');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});

test('a valid external pin whose marker cannot be backfilled on read is refused, not reported clean', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-backfillfail-home-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'metrics-backfillfail-proj-'));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';
    const stateEnv = { CORE_HARNESS: 'claude-code' };
    try {
      initMetrics({ projectDir, env: stateEnv });
      const coreDir = join(home, '.core');
      const durable = stateDir({ root: projectDir, harness: 'claude-code', coreDir, forWrite: true });
      rmSync(join(durable.dir, 'metrics-ever-external.txt'), { force: true });
      rmSync(join(durable.dir, 'metrics-ever-external.txt.mac'), { force: true });
      // Block the backfill write the same way the migration-producer and scaffold fault tests do:
      // a directory where the marker file must go.
      mkdirSync(join(durable.dir, 'metrics-ever-external.txt'), { recursive: true });
      assert.equal(storagePinInvalid(projectDir, { env: stateEnv }), true, 'a pin that is currently valid is still refused when its marker cannot be persisted — read-time protection, not best-effort');
    } finally { for (const d of [home, projectDir]) rmSync(d, { recursive: true, force: true }); }
  });
});
