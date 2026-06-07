import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initMetrics } from '../../plugins/core/skills/core/scripts/metrics-init.mjs';
import { resolveStoragePath } from '../../plugins/core/skills/core/scripts/log-event.mjs';

const METRICS_INIT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/metrics-init.mjs', import.meta.url));

// HC_603-style bar: prove the actual scaffold + the actual consume path, not prose.
// metrics-init pins the storage path; log-event must resolve to that pin.
test('wire-in: metrics-init scaffolds storage + pin, and log-event honors the pin', () => {
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  const origHome = process.env.HOME;
  const origForce = process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK;
  try {
    process.env.HOME = home;
    // Precondition: this platform's homedir() must honor $HOME, or the test is moot.
    assert.equal(homedir(), home, 'test requires os.homedir() to honor $HOME');
    // Force a non-default storage path so "honors the pin" is distinguishable from
    // "fell back to project-local".
    process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = '1';

    const r = initMetrics({ projectDir: project, workspaceId: 'ws-mi' });
    assert.ok(r.ok, `scaffold ok: ${JSON.stringify(r)}`);

    const pinFile = join(home, '.core', 'workspaces', 'ws-mi', 'metrics', 'storage-path.txt');
    assert.ok(existsSync(pinFile), 'pin file written');
    const pinned = readFileSync(pinFile, 'utf8').trim();
    assert.match(pinned, /core-metrics/, 'pinned to the forced appdata path, not project-local');

    // Storage hierarchy created at the pinned location.
    for (const sub of ['traces', 'payloads', 'queue']) {
      assert.ok(existsSync(join(pinned, sub)), `${sub}/ scaffolded`);
    }

    // The actual consume path: log-event's resolveStoragePath reads the pin.
    const resolved = resolveStoragePath(project, { workspaceId: 'ws-mi' });
    assert.equal(resolved, pinned, 'log-event resolves to the metrics-init pin, not the project-local default');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origForce === undefined) delete process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK;
    else process.env.CORE_METRICS_FORCE_APPDATA_FALLBACK = origForce;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('wire-in: metrics-init is idempotent (second run leaves the pin intact)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  const origHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.equal(homedir(), home);
    const r1 = initMetrics({ projectDir: project, workspaceId: 'ws-idem' });
    const r2 = initMetrics({ projectDir: project, workspaceId: 'ws-idem' });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.storagePath, r2.storagePath, 'storage path stable across runs');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// M1: the CLI entry guard must canonicalize BOTH sides, or the script silently
// no-ops when invoked through a symlinked/virtualized path (Node resolves
// import.meta.url to the real file, but argv[1] stays the symlink). startup.md
// invokes it with output+exit-code discarded, so that no-op would be invisible.
test('M1: metrics-init still runs when invoked through a symlink (entry guard canonicalizes both sides)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  const linkDir = mkdtempSync(join(tmpdir(), 'mi-link-'));
  const link = join(linkDir, 'metrics-init.mjs');
  try {
    symlinkSync(METRICS_INIT, link);
    const out = execFileSync('node', [link, project, 'ws-symlink'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    // On the buggy one-sided guard the module imports, the guard is false, and the
    // process exits 0 having printed nothing. The fix makes it actually run.
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true, 'metrics-init actually executed through the symlink');
    assert.ok(existsSync(join(home, '.core', 'workspaces', 'ws-symlink', 'metrics', 'storage-path.txt')),
      'the storage-path pin was written — the scaffold ran');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
    rmSync(linkDir, { recursive: true, force: true });
  }
});

// Doc-guard: the startup protocol must actually invoke metrics-init, or the
// scaffold never runs in a real session (the exact dormant-machinery failure).
test('wire-in: startup.md invokes metrics-init.mjs', () => {
  const startup = join(import.meta.dirname, '..', '..', 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md');
  const src = readFileSync(startup, 'utf8');
  assert.match(src, /metrics-init\.mjs/, 'startup.md must invoke metrics-init.mjs so _metrics/ gets scaffolded');
});
