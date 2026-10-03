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
import { symlinkSync, renameSync } from 'node:fs';
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
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: old, purgeable: false, reason: "no ownership record in the folder names this project; to purge it, write this project's root into its .project-root" }], 'it is named as history, held until claimed');
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

test('history is found only where metrics may live; a folder another project claims is named but never purgeable', () => {
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
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }),
        [{ folder: claimed, purgeable: false, reason: 'another project claims this folder', foreign: true }],
        'claimed by another project: named, never purgeable, and marked foreign');
      signedPin(meta, home, appData(home, 'gone'), projectDir);
      assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [], 'missing folder: nothing to name');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  }, { projects: 2 });
});

test('two projects whose records name the same unclaimed folder both see it as history, and neither may purge it', () => {
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
      assert.deepEqual(metricsHistoryFolders(p, { home, env: E }), [{ folder: shared, purgeable: false, reason: "no ownership record in the folder names this project; to purge it, write this project's root into its .project-root" }]);
      assert.equal(initMetrics({ projectDir: p, env: E }).storagePath, join(p, '_metrics'));
    }
    assert.equal(readFileSync(join(shared, 'evidence.jsonl'), 'utf8'), '{"who":"unknown"}\n');
  }, { projects: 2 });
});

test('a held-folder record names history, and it is purgeable only once the project claims the folder', () => {
  withProject(({ home, projectDir }) => {
    const meta = operationalMetricsDir(projectDir, { home, env: E });
    const held = appData(home, 'held');
    mkdirSync(held, { recursive: true });
    writeHeldSigned({ dir: meta, folder: held, alsoNamedBy: ['/some/peer'], coreDir: join(home, '.core') });
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: held, purgeable: false, reason: "no ownership record in the folder names this project; to purge it, write this project's root into its .project-root" }]);
    writeFileSync(join(held, '.project-root'), canonicalPath(projectDir) + '\n');
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }), [{ folder: held, purgeable: true }]);
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

test('stats report the project rows and the history rows separately, and purge reaches the history folder', async () => {
  const { purgeTurnCapture, turnCaptureStats } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    const old = appData(home, 'real-store');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    const oldRows = join(old, 'turn-capture', '2026-09-28.jsonl');
    writeFileSync(oldRows, '{"row":1}\n{"row":2}\n');
    writeFileSync(join(old, 'turn-capture-health.json'), '{}\n');
    writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
    signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);
    mkdirSync(join(projectDir, '_metrics', 'turn-capture'), { recursive: true });
    const newRows = join(projectDir, '_metrics', 'turn-capture', '2026-10-03.jsonl');
    writeFileSync(newRows, '{"row":3}\n');

    const stats = turnCaptureStats(projectDir, { env: E });
    assert.equal(stats.rows, 1, 'project rows only');
    assert.deepEqual(stats.history.map((h) => [h.dir, h.days, h.rows]), [[join(old, 'turn-capture'), 1, 2]]);

    const dry = purgeTurnCapture(projectDir, { apply: false, home, env: E });
    assert.ok(dry.scope.some((e) => e.id === 'history-stream' && e.existed), 'the dry run names the history stream');
    assert.equal(readFileSync(oldRows, 'utf8'), '{"row":1}\n{"row":2}\n', 'a dry run deletes nothing');

    const done = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(done.purged, true);
    assert.equal(existsSync(oldRows), false, 'history rows purged');
    assert.equal(existsSync(join(old, 'turn-capture-health.json')), false, 'history health purged');
    assert.equal(existsSync(newRows), false, 'project rows purged');
    assert.equal(existsSync(old), true, 'the folder itself and anything else in it stay');
  });
});

test('purge never touches a history folder that is ambiguous or another project\'s', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, dirs: [A, B] }) => {
    const coreDir = join(home, '.core');
    registerProject(coreDir, A);
    registerProject(coreDir, B);
    const shared = appData(home, 'shared');
    mkdirSync(join(shared, 'turn-capture'), { recursive: true });
    const rows = join(shared, 'turn-capture', '2026-09-28.jsonl');
    writeFileSync(rows, '{"row":1}\n');
    signedPin(operationalMetricsDir(A, { home, env: E }), home, shared, A);
    signedPin(operationalMetricsDir(B, { home, env: E }), home, shared, B);
    const r = purgeTurnCapture(A, { apply: true, home, env: E });
    assert.equal(r.scope.some((e) => e.id.startsWith('history-')), false);
    assert.equal(r.purged, false, 'a folder that cannot be proven this project\'s is not counted as purged');
    assert.deepEqual(r.held_history.map((h) => h.what), [shared]);
    assert.match(r.reason, /history not purged/);
    assert.equal(readFileSync(rows, 'utf8'), '{"row":1}\n');
  }, { projects: 2 });
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

test('a purge with no history at all, or only provably-owned history, reports purged', async () => {
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

// Paired ownership controls through the real purge: each case is one fixture change away from
// the owned positive control, and only provable ownership may remove a row.
for (const [label, setup, expect] of [
  ['the folder\'s ownership record names this project', (ctx) => writeFileSync(ctx.ownerFile, canonicalPath(ctx.A) + '\n'), { purged: true }],
  ['the folder\'s ownership record names another registered project', (ctx) => writeFileSync(ctx.ownerFile, canonicalPath(ctx.B) + '\n'), { purged: false, reason: /another project claims this folder/ }],
  ['the folder\'s ownership record cannot be read', (ctx) => {
    writeFileSync(ctx.ownerFile, canonicalPath(ctx.B) + '\n');
    ctx.denied.push(ctx.ownerFile);
    if (!denyRead(ctx.ownerFile)) return 'skip';
  }, { purged: false, reason: /ownership record cannot be read/ }],
  ['another registered project\'s signed record names the same folder', (ctx) => signedPin(operationalMetricsDir(ctx.B, { home: ctx.home, env: E }), ctx.home, ctx.folder, ctx.B), { purged: false, reason: /no ownership record/ }],
  ['another registered project\'s record cannot be read', (ctx) => {
    const peerPin = join(operationalMetricsDir(ctx.B, { home: ctx.home, env: E }), 'storage-path.txt');
    signedPin(dirname(peerPin), ctx.home, appData(ctx.home, 'elsewhere'), ctx.B);
    ctx.denied.push(peerPin);
    if (!denyRead(peerPin)) return 'skip';
  }, { purged: false, reason: /no ownership record/ }],
  ['another registered project\'s signature for a record naming the folder cannot be read', (ctx) => {
    const peerMeta = operationalMetricsDir(ctx.B, { home: ctx.home, env: E });
    signedPin(peerMeta, ctx.home, ctx.folder, ctx.B);
    const mac = join(peerMeta, 'storage-path.txt.mac');
    ctx.denied.push(mac);
    if (!denyRead(mac)) return 'skip';
  }, { purged: false, reason: /no ownership record/ }],
  ['another registered project names the folder only by its ever-external marker', (ctx) => {
    markMetricsEverExternal({ projectDir: ctx.B, harness: 'claude-code', home: ctx.home, coreDir: join(ctx.home, '.core'), folder: ctx.folder });
  }, { purged: false, reason: /no ownership record/ }],
  ['the project registry cannot be read', (ctx) => writeFileSync(join(ctx.home, '.core', 'projects.json'), '{ not json'), { purged: false, unnamed: true, reason: /JSON|could not be read/ }],
]) {
  test(`purge ownership control: ${label}`, async (t) => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    const { metricsHistoryFolders: history } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
    let skipped = false;
    withProject(({ home, dirs: [A, B] }) => {
      const coreDir = join(home, '.core');
      registerProject(coreDir, A);
      registerProject(coreDir, B);
      const folder = appData(home, 'legacy');
      mkdirSync(join(folder, 'turn-capture'), { recursive: true });
      const row = join(folder, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(row, '{"synthetic":1}\n');
      signedPin(operationalMetricsDir(A, { home, env: E }), home, folder, A);
      const ownerFile = join(folder, '.project-root');
      const ctx = { home, A, B, folder, ownerFile, denied: [] };
      try {
        if (setup(ctx) === 'skip') { skipped = true; return; }
        assert.equal(history(A, { home, env: E }).length, expect.unnamed ? 0 : 1, 'the folder is named as history whenever the records can be read');
        const r = purgeTurnCapture(A, { apply: true, home, env: E });
        assert.equal(r.purged, expect.purged, JSON.stringify(r.held_history));
        if (expect.purged) {
          assert.equal(existsSync(row), false, 'provably owned: the row is removed');
        } else {
          assert.equal(existsSync(row), true, 'not provably owned: the row stays');
          assert.match(r.reason, expect.reason);
          if (!expect.unnamed) assert.equal(r.held_history.length, 1, 'and the purge names what it left');
        }
      } finally {
        for (const f of ctx.denied) restoreRead(f);
      }
    }, { projects: 2 });
    if (skipped) t.skip('the platform does not deny the read (running as root or under ACLs)');
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

test('purge reaches the automatic close artifacts in a provably owned history folder and keeps the human-authored ones', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const { markCloseSummary, markCloseReceipt } = await import('../../plugins/core/skills/core/scripts/close-artifacts.mjs');
  const { createHash } = await import('node:crypto');
  const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');
  withProject(({ home, projectDir }) => {
    const old = appData(home, 'with-close');
    const summaries = join(old, 'close', 'summaries');
    const receipts = join(old, 'close', 'receipts');
    mkdirSync(summaries, { recursive: true });
    mkdirSync(receipts, { recursive: true });
    writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
    const autoSummary = join(summaries, sha('auto-session') + '.md');
    writeFileSync(autoSummary, markCloseSummary('# synthetic automatic close summary\n'));
    const humanSummary = join(summaries, sha('human-session') + '.md');
    writeFileSync(humanSummary, '# a person wrote this\n');
    const autoReceipt = join(receipts, sha('auto-receipt-session') + '.json');
    writeFileSync(autoReceipt, JSON.stringify(markCloseReceipt({ session_id: 'auto-receipt-session', status: 'recorded' })));
    signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);

    const dry = purgeTurnCapture(projectDir, { apply: false, home, env: E });
    const hs = dry.scope.find((e) => e.id === 'history-close-summaries');
    assert.deepEqual(hs.candidates, [autoSummary], 'the dry run names the old automatic summary');
    const r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, true, r.reason);
    assert.equal(existsSync(autoSummary), false, 'old automatic summary purged');
    assert.equal(existsSync(autoReceipt), false, 'old automatic receipt purged');
    assert.equal(existsSync(humanSummary), true, 'human-authored summary kept');
    assert.ok(r.scope.find((e) => e.id === 'history-close-summaries').kept.some((k) => k.path === humanSummary), 'and reported as kept');
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

// The swap happens through the purge's test seam, after planning and discovery have already seen a
// real folder, so this exercises the deletion-time re-check, not discovery. Junctions on Windows
// need no privilege, so only POSIX without symlink privilege skips.
for (const swap of ['entry', 'folder', 'folder-inside-root']) {
  test(`purge refuses a history ${swap} swapped for a link after discovery, and never follows it`, { skip: process.platform !== 'win32' && !symlinkCapable() ? 'symlink privilege unavailable' : false }, async () => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    withProject(({ home, projectDir }) => {
      const old = appData(home, 'swapped');
      mkdirSync(join(old, 'turn-capture'), { recursive: true });
      writeFileSync(join(old, 'turn-capture', '2026-09-28.jsonl'), '{"synthetic":1}\n');
      writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
      signedPin(operationalMetricsDir(projectDir, { home, env: E }), home, old, projectDir);
      // 'folder-inside-root' points the link at another folder under the same AppData root (another
      // project's history), which a containment check alone would accept.
      const outside = swap === 'folder-inside-root' ? appData(home, 'another-projects-history') : mkdtempSync(join(tmpdir(), 'metrics-outside-target-'));
      mkdirSync(outside, { recursive: true });
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      try {
        mkdirSync(join(outside, 'turn-capture'), { recursive: true });
        const precious = join(outside, 'turn-capture', 'keep.jsonl');
        writeFileSync(precious, '{"not":"captured"}\n');
        let swapped = false;
        const r = purgeTurnCapture(projectDir, { apply: true, home, env: E, beforeEntryDelete: (entry) => {
          if (entry.id !== 'history-stream' || swapped) return;
          swapped = true;
          if (swap === 'entry') {
            rmSync(entry.path, { recursive: true, force: true });
            symlinkSync(join(outside, 'turn-capture'), entry.path, linkType);
          } else {
            renameSync(entry.base, entry.base + '.moved');
            symlinkSync(outside, entry.base, linkType);
          }
        } });
        assert.equal(swapped, true, 'the swap ran after planning');
        assert.equal(r.purged, false);
        assert.match(r.reason, /refusing history purge/);
        assert.equal(readFileSync(precious, 'utf8'), '{"not":"captured"}\n', 'the link target is untouched');
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });
  });
}

// A peer whose state exists but cannot be verified (its stamp unreadable) is unknown, not absent.
for (const deny of [false, true]) {
  test(`purge with a peer that names the folder and whose stamp is ${deny ? 'unreadable' : 'readable'} holds the shared row`, async (t) => {
    const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
    let skipped = false;
    withProject(({ home, dirs: [A, B] }) => {
      const coreDir = join(home, '.core');
      registerProject(coreDir, A);
      registerProject(coreDir, B);
      const folder = appData(home, 'shared-peer-stamp');
      mkdirSync(join(folder, 'turn-capture'), { recursive: true });
      const row = join(folder, 'turn-capture', '2026-09-28.jsonl');
      writeFileSync(row, '{"synthetic":1}\n');
      signedPin(operationalMetricsDir(A, { home, env: E }), home, folder, A);
      signedPin(operationalMetricsDir(B, { home, env: E }), home, folder, B);
      const stamp = join(B, '.core', 'claude-code', 'stamp');
      try {
        if (deny && !denyRead(stamp)) { skipped = true; return; }
        const r = purgeTurnCapture(A, { apply: true, home, env: E });
        assert.equal(r.purged, false);
        assert.equal(existsSync(row), true, 'the shared row stays');
        assert.match(r.reason, /no ownership record/);
      } finally { if (deny) restoreRead(stamp); }
    }, { projects: 2 });
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

test('history recorded under another harness is found and purged by this one; held when not claimed', async () => {
  const { purgeTurnCapture } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  withProject(({ home, projectDir }) => {
    registerProject(join(home, '.core'), projectDir);
    const old = appData(home, 'codex-recorded');
    mkdirSync(join(old, 'turn-capture'), { recursive: true });
    const row = join(old, 'turn-capture', '2026-09-28.jsonl');
    writeFileSync(row, '{"synthetic":1}\n');
    signedPin(operationalMetricsDir(projectDir, { home, harness: 'codex' }), home, old, projectDir);
    assert.deepEqual(metricsHistoryFolders(projectDir, { home, env: E }).map((h) => h.folder), [old], 'a Codex record is visible to a Claude Code purge');
    let r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, false, 'unclaimed: held');
    assert.equal(existsSync(row), true);
    writeFileSync(join(old, '.project-root'), canonicalPath(projectDir) + '\n');
    r = purgeTurnCapture(projectDir, { apply: true, home, env: E });
    assert.equal(r.purged, true, r.reason);
    assert.equal(existsSync(row), false, 'claimed: purged');
  });
});
