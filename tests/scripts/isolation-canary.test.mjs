// Isolation canary: inside the isolated runner, CORE's default account home is the runner's disposable one,
// a registration through the default resolution lands in a test registry, and the real account's
// ~/.core/projects.json and index.json keep their bytes. Setting HOME alone does not isolate CORE (it reads
// the OS account record), so this proves the preload is in effect before anything is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { trustedHome } from '../../plugins/core/skills/core/scripts/trusted-home.mjs';
import { defaultCoreDir, readProjects } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { assertIsolatedAccountHome } from '../helpers/isolation-guard.mjs';
import { isRunnerHome } from '../helpers/disposable-home.mjs';

const SCRIPTS = new URL('../../plugins/core/skills/core/scripts/', import.meta.url).href;
const GUARD = new URL('../helpers/isolation-guard.mjs', import.meta.url).href;

// The OS account record's home, read in a node process without the test preload (an empty
// CORE_TEST_ACCOUNT_HOME makes the preload a no-op). Read-only.
function realOsHome() {
  const r = spawnSync(process.execPath, ['-e', "process.stdout.write(require('node:os').userInfo().homedir)"],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', CORE_TEST_ACCOUNT_HOME: '' }, timeout: 20000 });
  const home = r.status === 0 ? r.stdout.trim() : '';
  assert.ok(home && isAbsolute(home), `could not read the real OS account home (${r.stderr || r.status})`);
  return home;
}

const fingerprint = (file) => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch (e) { return e.code === 'ENOENT' ? 'absent' : `unreadable:${e.code}`; } };
const realFiles = (home) => ['projects.json', 'index.json'].map((n) => join(home, '.core', n));
const within = (root, p) => { const rel = relative(root, p); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };

const OS_HOME = realOsHome();
const REAL_BEFORE = realFiles(OS_HOME).map(fingerprint);

test('CORE resolves the runner\'s disposable account home, a default registration lands in a test registry, and the real registry keeps its bytes', (t) => {
  // 1. Guard before any write: the account home CORE resolves is the runner's disposable one, not the OS account's.
  const coreHome = trustedHome();
  assertIsolatedAccountHome({ coreHome, osHome: OS_HOME, isTestArea: (h) => h === process.env.CORE_TEST_ACCOUNT_HOME && isRunnerHome(h) });
  assert.equal(defaultCoreDir(), join(coreHome, '.core'));
  assert.notEqual(defaultCoreDir(), join(OS_HOME, '.core'));

  // 2. The runner's ~/.core takes no new entries, so the registration runs in a node process spawned the way the
  // suite spawns every process (NODE_OPTIONS carries the preload), pointed at a test home under the shared test root.
  // It resolves its core dir by default (no coreDir passed) and guards again before writing.
  const testRoot = join(coreHome, '.core', '.test-tmp');
  mkdirSync(testRoot, { recursive: true });
  const base = mkdtempSync(join(testRoot, 'isolation-canary-'));
  // The native realpath, as CORE canonicalizes roots: on Windows it expands an 8.3 short name in the temp path.
  const proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'isolation-canary-proj-')));
  t.after(() => { rmSync(base, { recursive: true, force: true }); rmSync(proj, { recursive: true, force: true }); });
  const home = join(base, 'home');
  mkdirSync(home);

  const code = `import { trustedHome } from ${JSON.stringify(SCRIPTS + 'trusted-home.mjs')};
    import { defaultCoreDir, registerProject } from ${JSON.stringify(SCRIPTS + 'index-registry.mjs')};
    import { assertIsolatedAccountHome } from ${JSON.stringify(GUARD)};
    import { isAbsolute, relative, sep } from 'node:path';
    const testRoot = ${JSON.stringify(testRoot)};
    const inTestRoot = (h) => { const rel = relative(testRoot, h); return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
    const home = trustedHome();
    assertIsolatedAccountHome({ coreHome: home, osHome: ${JSON.stringify(OS_HOME)}, isTestArea: inTestRoot });
    const result = registerProject(undefined, ${JSON.stringify(proj)});
    process.stdout.write(JSON.stringify({ home, coreDir: defaultCoreDir(), result }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { encoding: 'utf8', env: { ...process.env, CORE_TEST_ACCOUNT_HOME: home }, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.home, home);
  assert.equal(out.coreDir, join(home, '.core'));
  assert.ok(within(testRoot, out.coreDir));
  assert.deepEqual(out.result, { action: 'new', root: proj });
  assert.deepEqual(readProjects(out.coreDir).map((e) => e.path), [proj]);

  // 3. The real account's registry files are byte-identical, and the scratch project is not in them.
  assert.deepEqual(realFiles(OS_HOME).map(fingerprint), REAL_BEFORE);
  for (const f of realFiles(OS_HOME)) { let text = ''; try { text = readFileSync(f, 'utf8'); } catch { /* absent */ } assert.ok(!text.includes(JSON.stringify(proj).slice(1, -1)), `${f} names the scratch project`); }
});
