import { operationalMetricsDir, resolveStoragePath, metricsEnabled, metricsHistoryFolders } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { writePinSigned, writeHeldSigned, markMetricsEverExternal, projectRootFor, canonical as canonicalPath } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
// Behavioral companion to the metrics-init-wirein doc-guard: exercises the real
// scaffold against temp dirs. HOME (and USERPROFILE for Windows) is redirected to
// a temp dir for the initMetrics test so the operational-meta write under
// the project's metrics state never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { symlinkSync, readdirSync, renameSync } from 'node:fs';
import { symlinkCapable } from './trusted-test-tmp.mjs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initMetrics,
  detectStoragePath,
} from '../../plugins/core/skills/core/scripts/metrics-init.mjs';

// Fixtures write state under the claude-code subfolder; CI has no Claude Code env signal.
process.env.CORE_HARNESS ||= 'claude-code';

// HOME is redirected per test; restore it afterwards.
function withCleanEnv(fn) {
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
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
      assert.equal(existsSync(join(metaDir, 'storage-path.txt')), false, 'no pin is written: nothing routes by one');
      assert.match(readFileSync(join(result.storagePath, '.gitignore'), 'utf8'), /^\*$/m, 'generated captures stay out of git');

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

test('detectStoragePath keeps captured turns in the project folder on non-Windows, synced or not', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-synced-home-'));
    const dirs = [
      join(home, 'Library', 'CloudStorage', 'OneDrive-Org', 'Projects', 'app'),
      join(home, 'Library', 'CloudStorage', 'iCloud Drive', 'Projects', 'app'),
      join(home, 'Dropbox', 'Projects', 'app'),
      join(home, 'Google Drive', 'Projects', 'app'),
      join(home, 'Documents', 'Projects', 'app'),
    ];
    for (const dir of dirs) mkdirSync(dir, { recursive: true });
    try {
      for (const projectDir of dirs) {
        for (const platformName of ['darwin', 'linux']) {
          const detection = detectStoragePath({ projectDir, home, platformName });
          assert.equal(detection.path, join(projectDir, '_metrics'), `${projectDir} on ${platformName} stays with the project`);
          assert.match(detection.reason, /project-local/);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

test('detectStoragePath on Windows keeps captured turns in the project folder, OneDrive included', () => {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-win-synced-home-'));
    try {
      for (const sub of ['OneDrive', 'OneDrive - Contoso', 'Dropbox', 'Google Drive', 'iCloudDrive', 'Documents']) {
        const projectDir = join(home, sub, 'Projects', 'app');
        mkdirSync(projectDir, { recursive: true });
        const detection = detectStoragePath({ projectDir, home, platformName: 'win32' });
        assert.equal(detection.path, join(projectDir, '_metrics'), `${sub} stays with the project`);
        assert.match(detection.reason, /project-local/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function signedPin(meta, home, path, project) { const coreDir = join(home, '.core'); writePinSigned({ dir: meta, path, root: projectRootFor(project, { home, coreDir }), coreDir }); }

// A throwaway home with one project, redirected for the duration of fn.
function withProject(fn, { projects = 1 } = {}) {
  withCleanEnv(() => {
    const home = mkdtempSync(join(tmpdir(), 'metrics-hist-home-'));
    const dirs = Array.from({ length: projects }, () => mkdtempSync(join(tmpdir(), 'metrics-hist-proj-')));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try { fn({ home, projectDir: dirs[0], dirs }); }
    finally { for (const d of [home, ...dirs]) rmSync(d, { recursive: true, force: true }); }
  });
}
const E = { CORE_HARNESS: 'claude-code' };
const appData = (home, name) => join(home, 'AppData', 'Local', 'core-metrics', name);

test('a signed pin naming an AppData folder routes nothing: the scaffold and every writer use the project folder, and the old folder is left as it was', () => {
  withProject(({ home, projectDir }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const old = appData(home, 'old-workspace-id');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'evidence.jsonl'), '{"row":1}\n');
    signedPin(meta, home, old, projectDir);

    const r = initMetrics({ projectDir, env: E });
    assert.equal(r.storagePath, join(projectDir, '_metrics'));
    assert.equal(resolveStoragePath(projectDir), join(projectDir, '_metrics'));
    assert.equal(readFileSync(join(old, 'evidence.jsonl'), 'utf8'), '{"row":1}\n', 'history untouched');
    assert.equal(existsSync(join(old, '.project-root')), false, 'and not claimed by asking');
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: old }], 'it is named as history');
  });
});

test('a lost, tampered or foreign pin never turns capture off or sends it anywhere: a pin is history, not a route', () => {
  withProject(({ home, dirs: [A, B] }) => {
    const metaA = operationalMetricsDir(A, { home, env: E });
    const metaB = operationalMetricsDir(B, { home, env: E });
    const folder = appData(home, 'a-store');
    mkdirSync(folder, { recursive: true });
    signedPin(metaA, home, folder, A);
    assert.equal(metricsEnabled({ project: A, env: {}, home }), true);
    writeFileSync(join(metaA, 'storage-path.txt'), folder + '-tampered');
    assert.equal(metricsEnabled({ project: A, env: {}, home }), true, 'tampered: capture stays on');
    assert.equal(resolveStoragePath(A), join(A, '_metrics'));
    assert.deepEqual(metricsHistoryFolders(A, { home, env: E }), [], 'a tampered record names nothing');
    rmSync(join(metaA, 'storage-path.txt'));
    assert.equal(metricsEnabled({ project: A, env: {}, home }), true, 'half a pin: capture stays on');

    // A's pin and its MAC copied into B verify as a signature but name the wrong project.
    signedPin(metaA, home, folder, A);
    writeFileSync(join(metaB, 'storage-path.txt'), readFileSync(join(metaA, 'storage-path.txt')));
    writeFileSync(join(metaB, 'storage-path.txt.mac'), readFileSync(join(metaA, 'storage-path.txt.mac')));
    assert.equal(metricsEnabled({ project: B, env: {}, home }), true);
    assert.deepEqual(metricsHistoryFolders(B, { home, env: {} }), [], "B does not adopt A's folder as its history");
  }, { projects: 2 });
});

test('history is found only where metrics may live; a folder another project claims is named and marked foreign', () => {
  withProject(({ home, projectDir, dirs: [, B] }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const outside = mkdtempSync(join(tmpdir(), 'metrics-hist-outside-'));
    try {
      signedPin(meta, home, outside, projectDir);
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [], 'outside the allowed folders: not history');
      const claimed = appData(home, 'claimed-by-other');
      mkdirSync(claimed, { recursive: true });
      writeFileSync(join(claimed, '.project-root'), B + '\n');
      signedPin(meta, home, claimed, projectDir);
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: claimed, foreign: true }]);
      signedPin(meta, home, appData(home, 'gone'), projectDir);
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [], 'missing folder: nothing to name');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }, { projects: 2 });
});

test('two projects whose records name the same folder both see it as history, and neither purge deletes it', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, dirs: [A, B] }) => {
    const coreDir = join(home, '.core');
    registerProject(coreDir, A);
    registerProject(coreDir, B);
    const shared = appData(home, 'shared-before-the-claim');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'evidence.jsonl'), '{"who":"unknown"}\n');
    signedPin(operationalMetricsDir(A, { home, env: E }), home, shared, A);
    signedPin(operationalMetricsDir(B, { home, env: E }), home, shared, B);
    for (const p of [A, B]) {
      assert.deepEqual(metricsHistoryFolders(p, { home, env: E }), [{ folder: shared }]);
      assert.equal(initMetrics({ projectDir: p, env: E }).storagePath, join(p, '_metrics'));
      assert.equal(purgeTurnCapture(p, { apply: true, home, env: E }).purged, false);
    }
    assert.equal(readFileSync(join(shared, 'evidence.jsonl'), 'utf8'), '{"who":"unknown"}\n');
  }, { projects: 2 });
});

test('a held-folder record names history', () => {
  withProject(({ home, projectDir }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const held = appData(home, 'held');
    mkdirSync(held, { recursive: true });
    writeHeldSigned({ dir: meta, folder: held, alsoNamedBy: ['/some/peer'], coreDir: join(home, '.core') });
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: held }]);
  });
});

test('losing the pin leaves the ever-external marker, which still names the history folder', () => {
  withProject(({ home, projectDir }) => {
    const old = appData(home, 'marked');
    mkdirSync(old, { recursive: true });
    markMetricsEverExternal({ projectDir, harness: 'claude-code', home, coreDir: join(home, '.core'), folder: old });
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((h) => h.folder), [old]);
  });
});

test('a capture-disabled marker an earlier scaffold left is cleared by the next scaffold, and capture resumes', () => {
  withProject(({ home, projectDir }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    writeFileSync(join(meta, 'capture-disabled.json'), '{"marker":"core-capture-disabled"}\n');
    assert.equal(metricsEnabled({ project: projectDir, env: {}, home }), false);
    assert.equal(initMetrics({ projectDir, env: E }).ok, true);
    assert.equal(metricsEnabled({ project: projectDir, env: {}, home }), true);
  });
});

test('stats report project and history rows separately; purge empties the project and never deletes outside it', async () => {
  const { purgeTurnCapture, turnCaptureStats } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const { markCloseSummary } = await import('../../plugins/core/skills/core/scripts/close-artifacts.mjs');
  const { createHash } = await import('node:crypto');
  withProject(({ home, projectDir }) => {
    const old = appData(home, 'real-store');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    mkdirSync(join(old, 'close', 'summaries'), { recursive: true });
    const oldRows = join(old, 'turn-capture', '2026-09-28.jsonl');
    writeFileSync(oldRows, '{"row":1}\n{"row":2}\n');
    writeFileSync(join(old, 'turn-capture-health.json'), '{}\n');
    const oldSummary = join(old, 'close', 'summaries', createHash('sha256').update('auto').digest('hex') + '.md');
    writeFileSync(oldSummary, markCloseSummary('# synthetic automatic summary\n'));
    writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
    signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);
    mkdirSync(join(projectDir, '_metrics', 'turn-capture'), { recursive: true });
    const newRows = join(projectDir, '_metrics', 'turn-capture', '2026-10-03.jsonl');
    writeFileSync(newRows, '{"row":3}\n');

    const stats = turnCaptureStats(projectDir, { env: E });
    assert.equal(stats.rows, 1, 'project rows only');
    assert.deepEqual(stats.history.map((h) => [h.dir, h.days, h.rows]), [[join(old, 'turn-capture'), 1, 2]]);

    const done = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(existsSync(newRows), false, 'project rows purged');
    assert.equal(done.purged, false, 'not complete while earlier rows exist outside the project');
    assert.equal(done.scope.some((e) => e.id.startsWith('history')), false, 'nothing outside the project is in scope');
    assert.deepEqual(done.held_history.map((h) => h.what), [old]);
    assert.match(done.held_history[0].reason, /whether to delete the folder is your call/);
    for (const f of [oldRows, join(old, 'turn-capture-health.json'), oldSummary]) assert.equal(existsSync(f), true, `kept: ${f}`);
  });
});

test('purge reports, rather than claims, a record of an older external folder that does not verify', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const old = appData(home, 'unverifiable');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    writeFileSync(join(old, 'turn-capture', '2026-09-28.jsonl'), '{"row":1}\n');
    writeFileSync(join(meta, 'storage-path.txt'), old);   // unsigned: the folder cannot be vouched for
    const dry = purgeTurnCapture(projectDir, { apply: false, home, env: E });
    assert.equal(dry.held_history.length, 1, 'the dry run names it');
    const real = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(real.purged, false);
    assert.match(real.held_history[0].reason, /does not verify/);
    assert.equal(existsSync(join(old, 'turn-capture', '2026-09-28.jsonl')), true, 'and does not touch it');
  });
});

test('a purge with no history at all reports purged', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, true);
    assert.deepEqual(r.held_history, []);
  });
});

test('the status command reports project rows and history rows separately', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = join(process.cwd(), 'plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const old = appData(home, 'status-store');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    writeFileSync(join(old, 'turn-capture', '2026-09-28.jsonl'), '{"row":1}\n{"row":2}\n');
    signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);
    const out = spawnSync(process.execPath, [script, projectDir, '--status'], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CORE_HARNESS: 'claude-code' } });
    const status = JSON.parse(out.stdout);
    assert.equal(status.rows, 0);
    assert.deepEqual(status.history.map((h) => h.rows), [2]);
  });
});

// Deny this user read access to a file for a test, the way each platform enforces it: chmod on
// POSIX, an ACL deny on Windows (where Node reports the denied read as EPERM and fs.access does
// not evaluate ACLs). Returns false when the platform did not actually deny the read.
function denyRead(file) {
  if (process.platform === 'win32') execFileSync('icacls', [file, '/deny', `${process.env.USERNAME}:(R)`], { stdio: 'ignore' });
  else chmodSync(file, 0o000);
  try { readFileSync(file); return false; } catch (e) { return e.code === 'EACCES' || e.code === 'EPERM'; }
}
// Deny listing a folder: chmod on POSIX, an ACL "(RD)" deny on Windows.
function denyList(dir) {
  if (process.platform === 'win32') execFileSync('icacls', [dir, '/deny', `${process.env.USERNAME}:(RD)`], { stdio: 'ignore' });
  else chmodSync(dir, 0o000);
  try { readdirSync(dir); return false; } catch (e) { return e.code === 'EACCES' || e.code === 'EPERM'; }
}
function restoreList(dir) {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [dir, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
    else chmodSync(dir, 0o755);
  } catch { /* already restored */ }
}
function restoreRead(file) {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [file, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
    else chmodSync(file, 0o644);
  } catch { /* not created in this case */ }
}

// Whatever the folder's ownership record says, the purge never deletes outside the project; it
// names the folder and why.
for (const [label, claim, reason] of [
  ['names this project', 'self', /whether to delete the folder is your call/],
  ['names another project', 'other', /another project claims/],
  ['is absent', 'none', /whether to delete the folder is your call/],
]) {
  test(`purge never deletes a history folder whose ownership record ${label}`, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    withProject(({ home, dirs: [A, B] }) => {
      const folder = appData(home, 'legacy');
      mkdirSync(join(folder, 'turn-capture'), { recursive: true });
      const row = join(folder, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(row, '{"synthetic":1}\n');
      if (claim !== 'none') writeFileSync(join(folder, '.project-root'), canonicalPath(claim === 'self' ? A : B) + '\n');
      signedPin(operationalMetricsDir(A, { home, env: E }), home, folder, A);
      const r = purgeTurnCapture(A, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.equal(existsSync(row), true, 'the row stays');
      assert.match(r.held_history.map((h) => h.reason).join(' '), reason);
    }, { projects: 2 });
  });
}

test('when the records of older folders cannot be read at all, the held list says so instead of coming back empty', async () => {
  const { metricsHistoryHeld } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    assert.deepEqual(metricsHistoryHeld(projectDir, { home, env: E }), [], 'readable records, no history: nothing held');
    writeFileSync(join(home, '.core', 'projects.json'), '{ not json');
    const held = metricsHistoryHeld(projectDir, { home, env: E });
    assert.equal(held.length, 1);
    assert.match(held[0].reason, /could not be read/);
  });
});

// Planning a purge only reads state. With the project's own stamp unreadable, neither a dry run
// nor a real purge may move the record of an older folder, and the result says why it held.
for (const apply of [false, true]) {
  test(`purge with this project's own stamp unreadable (${apply ? 'apply' : 'dry run'}) moves nothing and reports held`, async (t) => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    let skipped = false;
    withProject(({ home, projectDir }) => {
      registerProject(join(home, '.core'), projectDir);
      const old = appData(home, 'own-history');
      mkdirSync(join(old, 'turn-capture'), { recursive: true });
      const row = join(old, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(row, '{"synthetic":1}\n');
      writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
      const meta = operationalMetricsDir(projectDir, { home, env: E });
      signedPin(meta, home, old, projectDir);
      const pinFile = join(meta, 'storage-path.txt');
      const stamp = join(projectDir, '.core', 'claude-code', 'stamp');
      assert.ok(existsSync(stamp), 'fixture has a stamp');
      if (!denyRead(stamp)) { skipped = true; restoreRead(stamp); return; }
      try {
        const r = purgeTurnCapture(projectDir, { apply, home, env: E });
        assert.equal(existsSync(pinFile), true, 'the history record stays where it was');
        assert.equal(existsSync(row), true, 'the old row stays');
        assert.equal(r.purged, false);
        assert.match(r.held_history.map((h) => h.reason).join(' '), /cannot be read as its own/);
      } finally { restoreRead(stamp); }
    });
    if (skipped) t.skip('the platform does not deny the read');
  });
}

// This project's own state that exists but cannot be read as its own hides any record of an older
// folder in it, so the purge holds even when the folder itself is provably this project's.
for (const [label, fence] of [
  ['another install wrote it (foreign-install)', ({ stampFile }) => {
    const st = JSON.parse(readFileSync(stampFile, 'utf8'));
    writeFileSync(stampFile, JSON.stringify({ ...st, install_id: 'synthetic-foreign-install' }));
  }],
  ['it was relocated and the old path and its parent are gone (ask)', async ({ stampFile, home }) => {
    const { ensureInstallIdentity, stampHmac } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
    const st = JSON.parse(readFileSync(stampFile, 'utf8'));
    const moved = { ...st, path: join(home, 'gone-parent', 'gone-project') };
    const { secret } = ensureInstallIdentity({ coreDir: join(home, '.core') });
    writeFileSync(stampFile, JSON.stringify({ ...moved, hmac: stampHmac(secret, moved) }));
  }],
  ['a migration is in progress', async ({ harnessDir }) => {
    const { MIGRATING_MARKER } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
    writeFileSync(join(harnessDir, MIGRATING_MARKER), '');
  }],
]) {
  test(`purge holds when this project's own state cannot be read as its own: ${label}`, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    const base = mkdtempSync(join(tmpdir(), 'metrics-fence-'));
    const home = join(base, 'home');
    const projectDir = join(base, 'project');
    mkdirSync(join(home, '.core'), { recursive: true });
    mkdirSync(projectDir);
    try {
      registerProject(join(home, '.core'), projectDir);
      const old = appData(home, 'fenced');
      mkdirSync(join(old, 'turn-capture'), { recursive: true });
      const row = join(old, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(row, '{"synthetic":1}\n');
      writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
      signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);
      const harnessDir = join(projectDir, '.core', 'claude-code');
      const stampFile = join(harnessDir, 'stamp');
      await fence({ stampFile, home, harnessDir });
      const before = readFileSync(stampFile, 'utf8');
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.equal(existsSync(row), true, 'the old row stays');
      assert.match(r.reason, /cannot be read as its own/);
      assert.equal(readFileSync(stampFile, 'utf8'), before, 'the purge changed no state');
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
}

test('history recorded under another harness is found and listed by this one', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const old = appData(home, 'codex-recorded');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    const row = join(old, 'turn-capture', '2026-09-28.jsonl');
    writeFileSync(row, '{"synthetic":1}\n');
    signedPin(operationalMetricsDir(projectDir, { home, harness: 'codex' }), home, old, projectDir);
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((h) => h.folder), [old], 'a Codex record is visible to a Claude Code purge');
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, false);
    assert.deepEqual(r.held_history.map((h) => h.what), [old]);
    assert.equal(existsSync(row), true);
  });
});

// The purge's physical boundary: an entry whose folder resolves outside the project (a linked
// _metrics, present before planning or swapped in after it) is refused, and its target untouched.
for (const when of ['before planning', 'after planning']) {
  test(`purge refuses a _metrics folder that links outside the project (${when})`, { skip: process.platform !== 'win32' && !symlinkCapable() ? 'symlink privilege unavailable' : false }, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    withProject(({ home, projectDir }) => {
      const outside = mkdtempSync(join(tmpdir(), 'metrics-linked-base-'));
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        mkdirSync(join(outside, 'turn-capture'), { recursive: true });
        const precious = join(outside, 'turn-capture', '2026-09-28.jsonl');
        writeFileSync(precious, '{"not":"this project"}\n');
        const metrics = join(projectDir, '_metrics');
        if (when === 'before planning') symlinkSync(outside, metrics, linkType);
        else mkdirSync(join(metrics, 'turn-capture'), { recursive: true });
        let swapped = when === 'before planning';
        const r = purgeTurnCapture(projectDir, { apply: true, home, env: E, beforeEntryDelete: (entry) => {
          if (swapped || entry.id !== 'stream') return;
          rmSync(metrics, { recursive: true, force: true });
          symlinkSync(outside, metrics, linkType);
          swapped = true;
        } });
        assert.equal(swapped, true);
        assert.equal(r.purged, false);
        // Swapping _metrics also removes the lock file inside it, so the overall reason can be the
        // lock release; the stream entry's own refusal is the boundary check.
        assert.match(r.scope.find((e) => e.id === 'stream').reason || '', /refusing purge/);
        assert.equal(readFileSync(precious, 'utf8'), '{"not":"this project"}\n', 'the outside folder is untouched');
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });
  });
}

test('a harness state folder that is a link is reported, not skipped as absent', { skip: process.platform !== 'win32' && !symlinkCapable() ? 'symlink privilege unavailable' : false }, async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    operationalMetricsDir(projectDir, { home, env: E });
    const elsewhere = mkdtempSync(join(tmpdir(), 'metrics-linked-harness-'));
    try {
      symlinkSync(elsewhere, join(projectDir, '.core', 'codex'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.match(r.held_history.map((h) => h.reason).join(' '), /codex state cannot be read as its own \(refused\)/);
    } finally { rmSync(elsewhere, { recursive: true, force: true }); }
  });
});

test('a state folder that cannot be listed is reported as unknown, in the helper and in the purge result', async (t) => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const { metricsHistoryHeld } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  let skipped = false;
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    operationalMetricsDir(projectDir, { home, env: E });
    const core = join(projectDir, '.core');
    try {
      if (!denyList(core)) { skipped = true; return; }
      assert.match(metricsHistoryHeld(projectDir, { home, env: E }).map((h) => h.reason).join(' '), /could not be listed/);
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.match((r.held_history || []).map((h) => h.reason).join(' '), /could not be listed/, 'the purge result carries the unknown, even when it fails for another reason');
    } finally { restoreList(core); }
  });
  if (skipped) t.skip('the platform does not deny the listing');
});

for (const [label, registry] of [
  ['a JSON object instead of a list', () => '{"path":"/x"}'],
  ['an entry without a usable path', (ctx) => JSON.stringify([{ path: ctx.projectDir }, { path: 42 }])],
]) {
  test(`a malformed registry (${label}) holds the purge instead of reporting it complete`, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    withProject(({ home, projectDir }) => {
      registerProject(join(home, '.core'), projectDir);
      writeFileSync(join(home, '.core', 'projects.json'), registry({ projectDir }));
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.match(JSON.stringify(r), /registry is malformed|not a list|no usable path/);
    });
  });
}

// Allowed roots are pinned at planning: a project root, or this project's local fallback folder,
// replaced with a link to another project after planning cannot carry the purge there.
for (const swap of ['project root', 'local fallback folder']) {
  test(`purge does not follow a ${swap} replaced with a link to another project after planning`, { skip: (process.platform !== 'win32' && !symlinkCapable()) || (swap === 'local fallback folder' && process.platform === 'win32') ? 'needs symlinks, and a read-only root that POSIX can express' : false }, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    const { classifyTurnsDirFor } = { classifyTurnsDirFor: (p, home) => join(operationalMetricsDir(p, { home, env: E }), 'classified') };
    withProject(({ home, dirs: [A, B] }) => {
      const coreDir = join(home, '.core');
      registerProject(coreDir, A);
      registerProject(coreDir, B);
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      const rows = {};
      for (const p of [A, B]) {
        mkdirSync(join(p, '_metrics', 'turn-capture'), { recursive: true });
        rows[p] = { stream: join(p, '_metrics', 'turn-capture', '2026-10-03.jsonl') };
        writeFileSync(rows[p].stream, `{"project":"${p === A ? 'A' : 'B'}"}\n`);
        if (swap === 'local fallback folder') chmodSync(p, 0o555);
        const cls = classifyTurnsDirFor(p, home);
        mkdirSync(cls, { recursive: true });
        rows[p].classified = join(cls, '2026-10-03.jsonl');
        writeFileSync(rows[p].classified, '{"user_text":"synthetic"}\n');
      }
      let swapped = false;
      try {
        const r = purgeTurnCapture(A, { apply: true, home, env: E, beforeEntryDelete: (entry) => {
          if (swapped) return;
          if (swap === 'project root' && entry.id === 'stream') {
            renameSync(A, A + '.aside');
            symlinkSync(B, A, linkType);
            swapped = true;
          }
          if (swap === 'local fallback folder' && entry.id === 'classified') {
            const localA = dirname(dirname(entry.base));
            const localB = dirname(dirname(dirname(dirname(rows[B].classified))));
            renameSync(localA, localA + '.aside');
            symlinkSync(localB, localA, linkType);
            swapped = true;
          }
        } });
        assert.equal(swapped, true, 'the swap ran after planning');
        assert.equal(r.purged, false);
        assert.equal(readFileSync(rows[B].stream, 'utf8'), '{"project":"B"}\n', "B's stream row stays");
        assert.equal(existsSync(rows[B].classified), true, "B's classified row stays");
      } finally {
        for (const p of [A, B, A + '.aside']) { try { chmodSync(p, 0o755); } catch { /* not there */ } }
      }
    }, { projects: 2 });
  });
}

test("a purge removes this project's classified log under every harness with trusted state", async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const files = [];
    for (const harness of ['claude-code', 'codex']) {
      const cls = join(operationalMetricsDir(projectDir, { home, harness }), 'classified');
      mkdirSync(cls, { recursive: true });
      const f = join(cls, '2026-10-03.jsonl');
      writeFileSync(f, '{"user_text":"synthetic"}\n');
      files.push(f);
    }
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, true, r.reason);
    for (const f of files) assert.equal(existsSync(f), false, `purged: ${f}`);
  });
});

// History discovery and the classified purge read every place a harness's state can be, not just
// the one routed to today.
const POSIX_RO = process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a read-only root that POSIX can express' : false;

test('a pin written while the project was unregistered still names its folder after the project is registered', async () => {
  const { localStateDir } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const coreDir = join(home, '.core');
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    assert.equal(meta, join(localStateDir({ root: projectRootFor(projectDir, { home, coreDir }), harness: 'claude-code', coreDir }), 'metrics'));
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true });
    signedPin(meta, home, old, projectDir);
    registerProject(coreDir, projectDir);
    assert.notEqual(operationalMetricsDir(projectDir, { home, env: E }), meta, 'routing moved to the project');
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((f) => f.folder), [old]);
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, false);
    assert.ok(r.held_history.some((h) => h.what === old), JSON.stringify(r.held_history));
    assert.equal(existsSync(old), true, 'the old folder is left alone');
  });
});

test('a pin in the project folder still names its folder when the root turns read-only and routing falls back', { skip: POSIX_RO }, async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    assert.doesNotMatch(meta, /[\\/]local[\\/]/, 'state starts in the project folder');
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true });
    signedPin(meta, home, old, projectDir);
    chmodSync(projectDir, 0o555);
    try {
      assert.notEqual(operationalMetricsDir(projectDir, { home, env: E }), meta, 'routing fell back');
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((f) => f.folder), [old]);
      const r = purgeTurnCapture(projectDir, { apply: false, home, env: E });
      assert.ok(r.held_history.some((h) => h.what === old), JSON.stringify(r.held_history));
    } finally { chmodSync(projectDir, 0o755); }
  });
});

test('a purge removes classified rows in the project folder and the local fallback when the registry is reset', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const coreDir = join(home, '.core');
    registerProject(coreDir, projectDir);
    const write = () => {
      const cls = join(operationalMetricsDir(projectDir, { home, env: E }), 'classified');
      mkdirSync(cls, { recursive: true });
      const f = join(cls, '2026-10-03.jsonl'); writeFileSync(f, '{"user_text":"synthetic"}\n'); return f;
    };
    const inProject = write();
    writeFileSync(join(coreDir, 'projects.json'), '[]\n');
    const local = write();
    assert.notEqual(inProject, local, 'the two rows are in different places');
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, true, r.reason);
    assert.equal(existsSync(inProject), false, 'project-folder row purged');
    assert.equal(existsSync(local), false, 'local row purged');
  });
});

test("a local state folder linked to another project's before the purge is not this project's to purge", { skip: process.platform !== 'win32' && !symlinkCapable() ? 'needs symlinks' : false }, async () => {
  const { localStateDir } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, dirs: [A, B] }) => {
    const coreDir = join(home, '.core');
    const clsB = join(operationalMetricsDir(B, { home, env: E }), 'classified');
    mkdirSync(clsB, { recursive: true });
    const rowB = join(clsB, '2026-10-03.jsonl'); writeFileSync(rowB, '{"user_text":"B"}\n');
    const keyOf = (p) => dirname(localStateDir({ root: projectRootFor(p, { home, coreDir }), harness: 'claude-code', coreDir }));
    mkdirSync(dirname(keyOf(A)), { recursive: true });
    symlinkSync(keyOf(B), keyOf(A), process.platform === 'win32' ? 'junction' : 'dir');
    const r = purgeTurnCapture(A, { apply: true, home, env: E });
    assert.equal(r.purged, false);
    assert.equal(readFileSync(rowB, 'utf8'), '{"user_text":"B"}\n', "B's row stays");
    assert.match(JSON.stringify(r.held_history), /link or resolves outside/);
  }, { projects: 2 });
});

// A path that can't be looked at is unknown, never absent: discovery holds it and the purge does
// not call itself complete. A genuinely missing folder is absent and owes nothing.
const AS_ROOT = process.getuid?.() === 0 ? 'root ignores permission denial' : false;
// Deny all access to p (chmod on POSIX; on Windows an inherited ACL full deny, since a plain deny
// on a folder leaves its children reachable by path); true when a stat of `probe` now fails the
// way the code under test must handle.
function denyAll(p, probe = p) {
  if (process.platform === 'win32') execFileSync('icacls', [p, '/deny', `${process.env.USERNAME}:(OI)(CI)(F)`], { stdio: 'ignore' });
  else chmodSync(p, 0o000);
  try { statSync(probe); return false; } catch (e) { return e.code === 'EACCES' || e.code === 'EPERM'; }
}
function restoreAll(p) {
  try {
    if (process.platform === 'win32') execFileSync('icacls', [p, '/remove:d', process.env.USERNAME, '/T'], { stdio: 'ignore' });
    else chmodSync(p, 0o755);
  } catch { /* already restored */ }
}

function registeredThenReset(home, projectDir) {
  const coreDir = join(home, '.core');
  registerProject(coreDir, projectDir);
  const meta = operationalMetricsDir(projectDir, { home, env: E });
  return { coreDir, meta, reset: () => { writeFileSync(join(coreDir, 'projects.json'), '[]\n'); operationalMetricsDir(projectDir, { home, env: E }); } };
}

test('a denied metrics folder in inactive project state is held, not read as having no records', { skip: AS_ROOT }, async (t) => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const { meta, reset } = registeredThenReset(home, projectDir);
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'row.jsonl'), '{}\n');
    signedPin(meta, home, old, projectDir);
    reset();
    try {
      if (!denyAll(meta, join(meta, 'storage-path.txt'))) { t.skip('a stat inside a denied folder still succeeds here'); return; }
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.ok(r.held_history.some((h) => h.what.startsWith(meta) && /EACCES|EPERM/.test(h.reason)), JSON.stringify(r.held_history));
    } finally { restoreAll(meta); }
    assert.equal(existsSync(join(old, 'row.jsonl')), true);
  });
});

test('a denied classified log in inactive project state is planned, so the purge reports it unremoved', { skip: AS_ROOT }, async (t) => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const { meta, reset } = registeredThenReset(home, projectDir);
    const cls = join(meta, 'classified'); mkdirSync(cls, { recursive: true });
    const row = join(cls, '2026-10-03.jsonl'); writeFileSync(row, '{"user_text":"synthetic"}\n');
    reset();
    let r;
    try {
      if (!denyAll(meta, cls)) { t.skip('a stat inside a denied folder still succeeds here'); return; }
      r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    } finally { restoreAll(meta); }
    assert.equal(r.purged, false);
    assert.ok(r.scope.some((e) => e.id === 'classified' && e.path === cls && !e.removed), JSON.stringify(r.scope.map((e) => [e.id, e.path, e.removed])));
    assert.equal(existsSync(row), true);
  });
});

for (const [level, up] of [['parent', 1], ['containment root (AppData\\Local)', 2]]) {
  test(`a history folder whose ${level} is denied is held as unknown; one that is really gone owes nothing`, { skip: AS_ROOT }, async (t) => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'row.jsonl'), '{}\n');
    signedPin(meta, home, old, projectDir);
    const denied = up === 1 ? dirname(old) : dirname(dirname(old));
    let r;
    try {
      if (!denyAll(denied, old)) { t.skip('a stat inside a denied folder still succeeds here'); return; }
      r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    } finally { restoreAll(denied); }
    assert.equal(r.purged, false);
    assert.ok(r.held_history.some((h) => h.what === old && /could not be read/.test(h.reason)), JSON.stringify(r.held_history));
    rmSync(old, { recursive: true });
    const gone = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(gone.purged, true, gone.reason);
  });
});
}

// Before the first /core migration, a project's pin is still in its legacy workspace.
for (const alias of ['path', 'project_path']) {
  test(`an unmigrated legacy workspace's pin (index.json ${alias}) names its history folder`, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    withProject(({ home, projectDir }) => {
      const coreDir = join(home, '.core');
      const ws = join(coreDir, 'workspaces', 'ws1');
      mkdirSync(join(ws, 'metrics'), { recursive: true });
      writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ workspace_id: 'ws1', harness: 'claude-code' }));
      writeFileSync(join(coreDir, 'index.json'), JSON.stringify([{ workspace_id: 'ws1', harness: 'claude-code', [alias]: projectDir }]));
      const old = appData(home, 'p1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'row.jsonl'), '{}\n');
      writeFileSync(join(ws, 'metrics', 'storage-path.txt'), old + '\n');
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((f) => f.folder), [old]);
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.ok(r.held_history.some((h) => h.what === old), JSON.stringify(r.held_history));
      if (AS_ROOT) return;
      if (!denyRead(join(ws, 'metrics', 'storage-path.txt'))) { restoreRead(join(ws, 'metrics', 'storage-path.txt')); assert.fail('the pin could not be denied'); }
      try {
        const denied = purgeTurnCapture(projectDir, { apply: true, home, env: E });
        assert.equal(denied.purged, false);
        assert.ok(denied.held_history.some((h) => h.what.endsWith('storage-path.txt') && /EACCES|EPERM/.test(h.reason)), JSON.stringify(denied.held_history));
      } finally { restoreRead(join(ws, 'metrics', 'storage-path.txt')); }
    });
  });
}

test("a legacy workspace with no pin adds nothing, and after the real migration the folder is still named", async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const { applyMigration } = await import('../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs');
  withProject(({ home, projectDir }) => {
    const coreDir = join(home, '.core');
    const ws = join(coreDir, 'workspaces', 'ws1');
    mkdirSync(join(ws, 'metrics'), { recursive: true });
    mkdirSync(join(projectDir, '_memories'), { recursive: true });
    writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ workspace_id: 'ws1', harness: 'claude-code' }));
    writeFileSync(join(coreDir, 'index.json'), JSON.stringify([{ workspace_id: 'ws1', harness: 'claude-code', path: projectDir }]));
    const none = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(none.purged, true, none.reason);
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'row.jsonl'), '{}\n');
    writeFileSync(join(ws, 'metrics', 'storage-path.txt'), old + '\n');
    const m = applyMigration({ root: projectDir, harness: 'claude-code', coreDir });
    assert.equal(m.status, 'migrated', JSON.stringify(m));
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((f) => f.folder), [old]);
    assert.equal(purgeTurnCapture(projectDir, { apply: true, home, env: E }).purged, false);
  });
});

test('one unknown state location does not hide a known history folder from the purge result', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const old = appData(home, 'p1'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'row.jsonl'), '{}\n');
    signedPin(meta, home, old, projectDir);
    const codex = join(projectDir, '.core', 'codex');
    mkdirSync(codex, { recursive: true }); writeFileSync(join(codex, 'workspace.json'), '{}');
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, false);
    const whats = r.held_history.map((h) => h.what);
    assert.ok(whats.includes(old), `the known folder is named: ${JSON.stringify(whats)}`);
    assert.ok(whats.some((w) => canonicalPath(w) === canonicalPath(codex)), `the unknown state is named: ${JSON.stringify(whats)}`);
    assert.equal(readFileSync(join(old, 'row.jsonl'), 'utf8'), '{}\n');
  });
});
