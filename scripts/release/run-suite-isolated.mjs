#!/usr/bin/env node
/**
 * Runs the test suite against a disposable, seeded account home whose ~/.core cannot take new entries.
 *
 *   node scripts/release/run-suite-isolated.mjs [test files...]     (default: tests/scripts/*.test.mjs)
 *
 * Controls, run before the suite and fatal if any fails:
 *   1. a process under the preload resolves the disposable home, not the real one;
 *   2. creating a new entry in the protected ~/.core is refused (EACCES/EPERM) and nothing appears;
 *   3. the positive control: the shared test root inside it (.test-tmp) still takes writes.
 * After the suite, ~/.core must hold exactly the seed plus whatever is under .test-tmp.
 * This is a tripwire for stray writes, not a security boundary: the owner of the folder can undo it,
 * and it does not stop a test from changing a file that already exists in it, nor, on Windows,
 * from deleting one (see references in the release notes).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRELOAD = join(ROOT, 'tests', 'helpers', 'account-home-preload.mjs');
const win = process.platform === 'win32';
const fail = (msg) => { process.stderr.write(`isolated suite: ${msg}\n`); process.exitCode = 1; };

function protect(dir) {
  if (!win) { chmodSync(dir, 0o555); return () => chmodSync(dir, 0o755); }
  // Folder-only deny (no inheritance): new entries directly in ~/.core are refused; the writable test root below it is not.
  const account = userInfo().username;
  const rights = '(WD,AD,WEA,WA,DC)';
  const r = spawnSync('icacls', [dir, '/deny', `${account}:${rights}`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`icacls deny failed: ${r.stderr || r.stdout}`);
  return () => spawnSync('icacls', [dir, '/remove:d', account], { encoding: 'utf8' });
}

const probe = (home, code) => spawnSync(process.execPath, ['--import', PRELOAD, '--input-type=module', '-e', code],
  { encoding: 'utf8', env: { ...process.env, CORE_TEST_ACCOUNT_HOME: home, NODE_OPTIONS: '' } });

const tests = process.argv.slice(2);
const files = tests.length ? tests : readdirSync(join(ROOT, 'tests', 'scripts')).filter((n) => n.endsWith('.test.mjs')).sort().map((n) => join('tests', 'scripts', n));

const home = realpathSync(mkdtempSync(join(tmpdir(), 'core-suite-home-')));
const core = join(home, '.core');
let restore = () => {};
try {
  mkdirSync(join(core, '.test-tmp'), { recursive: true });
  writeFileSync(join(core, 'projects.json'), '[]');
  const seed = readdirSync(core).sort();
  restore = protect(core);

  // 1. resolved account
  const who = probe(home, "import os from 'node:os'; console.log(os.userInfo().homedir)");
  if (who.stdout.trim() !== home) { fail(`control 1: the preload resolved ${who.stdout.trim() || '(nothing)'} instead of ${home}`); process.exit(1); }
  // 2. a write attempt is refused before mutation
  const denied = probe(home, `import {writeFileSync} from 'node:fs'; try { writeFileSync(${JSON.stringify(join(core, 'stray.txt'))}, 'x'); console.log('WROTE'); } catch (e) { console.log(e.code); }`);
  const code = denied.stdout.trim();
  if (!['EACCES', 'EPERM'].includes(code) || existsSync(join(core, 'stray.txt'))) { fail(`control 2: a write into the protected ~/.core gave '${code}' (running as a user the folder mode cannot bind, such as root?)`); process.exit(1); }
  // 3. positive control
  const ok = probe(home, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(core, '.test-tmp', 'ok.txt'))}, 'x'); console.log('OK')`);
  if (ok.stdout.trim() !== 'OK') { fail(`control 3: the test root inside it refused a write (${ok.stderr.trim().slice(0, 120)})`); process.exit(1); }
  process.stdout.write(`isolated suite: controls passed (account ${home}; write refused with ${code})\n`);

  // NODE_OPTIONS carries the preload into every node process a test spawns (hooks, CLIs), not just the test files.
  const preloadUrl = pathToFileURL(PRELOAD).href;
  const run = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, CORE_TEST_ACCOUNT_HOME: home, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --import ${preloadUrl}`.trim() } });
  restore(); restore = () => {};
  const after = readdirSync(core).sort();
  if (JSON.stringify(after) !== JSON.stringify(seed)) fail(`the suite left new entries in the protected ~/.core: ${after.filter((n) => !seed.includes(n)).join(', ')}`);
  if (run.status !== 0) process.exitCode = run.status || 1;
} finally {
  restore();
  try { chmodSync(core, 0o755); } catch { /* gone or Windows */ }
  rmSync(home, { recursive: true, force: true });
}
