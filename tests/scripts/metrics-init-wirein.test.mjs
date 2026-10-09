import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { symlinkCapable } from './trusted-test-tmp.mjs';
import { initMetrics } from '../../plugins/core/skills/core/scripts/metrics-init.mjs';
import { resolveStoragePath, operationalMetricsDir } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { readPinSigned, writePinSigned, projectRootFor } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { accountHomeArgs } from '../helpers/account-home.mjs';

// Fixtures write state under the claude-code subfolder; CI has no Claude Code env signal.
process.env.CORE_HARNESS ||= 'claude-code';

const METRICS_INIT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/metrics-init.mjs', import.meta.url));

// prove the actual scaffold + the actual consume path, not prose.
// metrics-init scaffolds the project's own _metrics/; log-event resolves there.
test('wire-in: metrics-init scaffolds project-local storage, and log-event resolves to it even when an older pin names another folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  mkdirSync(join(home,'.core'));writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:project}]));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
    // Precondition: this platform's homedir() must honor the redirected home, or the test is moot.
    assert.equal(homedir(), home, 'test requires os.homedir() to honor the redirected home');
    const env = { CORE_HARNESS: 'claude-code' };
    const coreDir = join(home, '.core');
    const old = join(home, 'AppData', 'Local', 'core-metrics', 'older-redirect');
    mkdirSync(old, { recursive: true });
    writePinSigned({ dir: operationalMetricsDir(project, { home, env }), path: old, root: projectRootFor(project, { home, coreDir }), coreDir });

    const r = initMetrics({ projectDir: project, home, env });
    assert.ok(r.ok, `scaffold ok: ${JSON.stringify(r)}`);
    assert.equal(r.storagePath, join(project, '_metrics'));
    assert.ok(existsSync(r.storagePath), 'storage root scaffolded');
    for (const sub of ['traces', 'payloads', 'queue']) {
      assert.equal(existsSync(join(r.storagePath, sub)), false, `${sub}/ not scaffolded (retired)`);
    }
    assert.equal(readPinSigned({ dir: operationalMetricsDir(project, { home, env }), root: projectRootFor(project, { home, coreDir }), coreDir }), old, 'the older pin is left alone as history');

    // The actual consume path: log-event's resolveStoragePath.
    assert.equal(resolveStoragePath(project), r.storagePath, 'log-event writes where the scaffold made the store, not where the older pin points');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('wire-in: metrics-init is idempotent (second run leaves the storage path stable)', () => {
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  mkdirSync(join(home,'.core'));writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:project}]));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home; // Windows: os.homedir() reads USERPROFILE, not HOME
    assert.equal(homedir(), home);
    const r1 = initMetrics({ projectDir: project, home, env: { CORE_HARNESS: 'claude-code' } });
    const r2 = initMetrics({ projectDir: project, home, env: { CORE_HARNESS: 'claude-code' } });
    assert.ok(r1.ok && r2.ok);
    assert.equal(r1.storagePath, r2.storagePath, 'storage path stable across runs');
  } finally {
    if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// The CLI entry guard must canonicalize BOTH sides, or the script silently
// no-ops when invoked through a symlinked/virtualized path (Node resolves
// import.meta.url to the real file, but argv[1] stays the symlink). startup.md
// invokes it with output+exit-code discarded, so that no-op would be invisible.
test('metrics-init still runs when invoked through a symlink (entry guard canonicalizes both sides)', (t) => {
  if (!symlinkCapable()) return t.skip('symlink privilege unavailable (Windows non-elevated box)');
  const home = mkdtempSync(join(tmpdir(), 'mi-home-'));
  const project = mkdtempSync(join(tmpdir(), 'mi-project-'));
  mkdirSync(join(home,'.core'));writeFileSync(join(home,'.core','projects.json'),JSON.stringify([{path:project}]));
  const linkDir = mkdtempSync(join(tmpdir(), 'mi-link-'));
  const link = join(linkDir, 'metrics-init.mjs');
  try {
    symlinkSync(METRICS_INIT, link);
    const out = execFileSync('node', [...accountHomeArgs(home), link, project], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CORE_HARNESS: 'claude-code' }, // USERPROFILE: Windows homedir()
      encoding: 'utf8',
    });
    // On the buggy one-sided guard the module imports, the guard is false, and the
    // process exits 0 having printed nothing. The fix makes it actually run.
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true, 'metrics-init actually executed through the symlink');
    assert.ok(existsSync(join(project, '_metrics')), 'the storage root was created — the scaffold ran');
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
