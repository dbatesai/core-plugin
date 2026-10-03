import { operationalMetricsDir, resolveStoragePath, metricsEnabled, metricsHistoryFolders } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { writePinSigned, writeHeldSigned, markMetricsEverExternal, projectRootFor, canonical as canonicalPath } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { registerProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
// Behavioral companion to the metrics-init-wirein doc-guard: exercises the real
// scaffold against temp dirs. HOME (and USERPROFILE for Windows) is redirected to
// a temp dir for the initMetrics test so the operational-meta write under
// the project's metrics state never touches the real ~/.core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { symlinkSync, readdirSync } from 'node:fs';
import { symlinkCapable } from './trusted-test-tmp.mjs';
import { join } from 'node:path';
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
          swapped = true;
          rmSync(metrics, { recursive: true, force: true });
          symlinkSync(outside, metrics, linkType);
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

test('a state folder that cannot be listed is reported as unknown, not as no history', async (t) => {
  const { metricsHistoryHeld } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  let skipped = false;
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    operationalMetricsDir(projectDir, { home, env: E });
    const core = join(projectDir, '.core');
    if (process.platform === 'win32') { skipped = true; return; }
    chmodSync(core, 0o000);
    try {
      try { readdirSync(core); skipped = true; return; } catch (e) { if (e.code !== 'EACCES') { skipped = true; return; } }
      const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
      assert.equal(r.purged, false);
      assert.match(metricsHistoryHeld(projectDir, { home, env: E }).map((h) => h.reason).join(' '), /could not be listed/);
    } finally { chmodSync(core, 0o755); }
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
