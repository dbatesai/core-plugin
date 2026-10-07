// The isolated runner fails a suite that writes into the protected account ~/.core, and passes one
// that writes only to the shared test root: the negative and the positive control for the CI step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isRunnerHome } from '../helpers/disposable-home.mjs';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../../scripts/release/run-suite-isolated.mjs', import.meta.url));
const FIX = (n) => `tests/isolated-controls/${n}.control.mjs`;
const run = (file) => spawnSync(process.execPath, [RUNNER, file], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', CORE_TEST_ACCOUNT_HOME: '', NODE_TEST_CONTEXT: undefined } });
const skip = process.platform === 'win32' || (process.getuid && process.getuid() === 0);

test('a test that writes into the protected ~/.core fails the run, with EACCES before any file exists', { skip }, () => {
  const r = run(FIX('stray-write'));
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout + r.stderr, /EACCES/);
  assert.match(r.stdout, /controls passed/);
});

test('a test that writes only to the shared test root passes, and the controls ran first', { skip }, () => {
  const r = run(FIX('test-root-write'));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /controls passed .*write refused with EACCES/);
});

test('a spawned node process resolves the same protected account home, so a stray write there is refused too', { skip }, () => {
  const r = run(FIX('child-stray-write'));
  assert.equal(r.status, 0, r.stdout + r.stderr);   // the fixture asserts the child got EACCES
});

// Source-level guards for two Windows-only defects; the behavioral proof is a run of the runner on Windows.
test('the control probes import the preload as a file URL, and a failed control unwinds through finally', () => {
  const src = readFileSync(RUNNER, 'utf8');
  assert.ok(!/\['--import', PRELOAD,/.test(src), 'a bare path after --import fails on Windows Node');
  assert.match(src, /'--import', PRELOAD_URL/);
  assert.ok(!/process\.exit\(/.test(src), 'process.exit inside the try skips finally and leaves the protected temp home behind');
  assert.match(src, /catch \(e\) \{\s*if \(e !== STOP\) throw e;/);
});

// A failed permission restore must be reported, not ignored: the restore result is the only signal that the
// temporary home may be undeletable.
import { restoreProblem } from '../../scripts/release/restore-result.mjs';

test('restoreProblem: success is null; a nonzero exit, a spawn that never started, and a missing result each name why', () => {
  assert.equal(restoreProblem({ status: 0 }), null);
  assert.match(restoreProblem({ status: 5, stderr: 'Access is denied.\n' }), /exit 5: Access is denied\./);
  assert.match(restoreProblem({ status: null, error: new Error('spawnSync icacls ENOENT') }), /ENOENT/);
  assert.match(restoreProblem({ status: 0, error: new Error('timed out') }), /timed out/);
  assert.match(restoreProblem(undefined), /exit unknown/);
});

test('the runner reads the restore result at both call sites and keeps the primary exit status', () => {
  const src = readFileSync(RUNNER, 'utf8');
  assert.match(src, /denyWithCompensation\(spawnSync, dir, account, rights\)/);
  assert.match(readFileSync(new URL('../../scripts/release/restore-result.mjs', import.meta.url), 'utf8'), /restoreProblem\(run\('icacls', \[dir, '\/remove:d'/);
  assert.match(src, /const stuck = restore\(\);\s*restore = \(\) => null;\s*if \(stuck\) fail\(stuck\)/);
  assert.match(src, /cleanupTempHome\(\{ restore, remove: \(\) => rmSync\(home/);
  assert.match(src, /reportFailure\(process, msg\)/);
});

// A deny that was applied before its own command reported failure must still be removed, without hiding the setup error.
import { denyWithCompensation } from '../../scripts/release/restore-result.mjs';

test('denyWithCompensation: a failed deny still attempts the removal and keeps the setup error; a failed removal is named beside it', () => {
  const calls = [];
  const fake = (deny, remove) => (cmd, args) => { calls.push(args[1]); return args[1] === '/deny' ? deny : remove; };
  assert.throws(() => denyWithCompensation(fake({ status: 5, stderr: 'Access is denied.' }, { status: 0 }), 'D', 'u', '(WD)'),
    (e) => /deny failed: Access is denied\./.test(e.message) && !/compensating/.test(e.message));
  assert.deepEqual(calls, ['/deny', '/remove:d'], 'the removal was attempted after the failed deny');
  assert.throws(() => denyWithCompensation(fake({ status: null, error: new Error('spawn icacls ENOENT') }, { status: 5, stderr: 'nope' }), 'D', 'u', '(WD)'),
    (e) => /ENOENT/.test(e.message) && /compensating removal also failed: .*exit 5: nope/.test(e.message));
});

test('denyWithCompensation: on success the removal is not run until the returned closure is called, and it reports its own result', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args[1]); return { status: args[1] === '/deny' ? 0 : 5, stderr: 'late' }; };
  const undo = denyWithCompensation(run, 'D', 'u', '(WD)');
  assert.deepEqual(calls, ['/deny']);
  assert.match(undo(), /exit 5: late/);
  assert.deepEqual(calls, ['/deny', '/remove:d']);
});

// A deterministic control for the cleanup path: a failed restore AND a failed removal, after a failing test run.
import { reportFailure, cleanupTempHome, oneLine } from '../../scripts/release/restore-result.mjs';

test('a failed restore and a failed removal are both reported by name, the failing suite keeps its own exit status, and nothing is printed over several lines', () => {
  const written = [], proc = { exitCode: 2, stderr: { write: (s) => written.push(s) } };
  cleanupTempHome({
    restore: () => 'icacls /remove:d did not restore the folder (exit 5: Access is denied.)',
    remove: () => { throw Object.assign(new Error('EPERM: cannot remove\nsecond line\tTAB'), { code: 'EPERM' }); },
    home: '/tmp/core-suite-home-x', report: (m) => reportFailure(proc, m),
  });
  assert.equal(proc.exitCode, 2, 'the suite failure status is kept');
  assert.equal(written.length, 2);
  assert.match(written[0], /did not restore the folder/);
  assert.match(written[1], /temporary home \/tmp\/core-suite-home-x was left behind \(EPERM: cannot remove second line TAB\)/);
  for (const w of written) assert.equal(w.trimEnd().split('\n').length, 1, 'one line per diagnostic');
  const clean = { exitCode: undefined, stderr: { write() {} } };
  cleanupTempHome({ restore: () => null, remove: () => {}, home: 'h', report: (m) => reportFailure(clean, m) });
  assert.equal(clean.exitCode, undefined, 'a clean cleanup changes nothing');
  const only = { exitCode: undefined, stderr: { write() {} } };
  cleanupTempHome({ restore: () => 'x', remove: () => {}, home: 'h', report: (m) => reportFailure(only, m) });
  assert.equal(only.exitCode, 1, 'a restore failure alone fails a passing run');
});

test('oneLine and restoreProblem keep a multi-line spawn error on one line', () => {
  assert.equal(oneLine('a\r\nb\u0007c'), 'a b c');
  assert.doesNotMatch(restoreProblem({ status: 5, stderr: 'Access\nis denied\n' }), /\n/);
  assert.doesNotMatch(restoreProblem({ status: null, error: new Error('x\ny') }), /\n/);
});

// The runner process itself, with its cleanup made to fail twice and the suite failing: both failures are named on one line
// each, the leftover home is named, and the run still exits nonzero.
test('the runner process reports a failed restore and a failed removal, names the leftover home, and exits nonzero when the suite fails', { skip }, () => {
  const r = run(FIX('cleanup-failure'));
  const err = r.stderr;
  const named = /^isolated suite: the temporary home (\S+) was left behind \(.*\)$/m.exec(err);   // `.` stops at a newline: the whole message is on one line
  let cleanupProblem = null;
  try {
    assert.notEqual(r.status, 0, 'the suite failure is not hidden');
    assert.match(err, /^isolated suite: chmod \S+\.core failed \(.*\)$/m, 'the failed restore is named, on one line');
    assert.match(err, /^isolated suite: the protected ~\/\.core could not be read after the run \(ENOENT\)$/m, 'the unreadable inventory is reported, not thrown');
    assert.ok(named, `the leftover home is named (stderr: ${err.slice(-600)})`);
    assert.doesNotMatch(err, /Uncaught|at (async )?(Object\.)?readdirSync/, 'no uncaught exception from the runner');
    assert.match(r.stdout, /controls passed/);
  } finally {
    // Only the folder the runner itself created may be removed, and a failed or refused cleanup is reported, never dropped.
    if (named) {
      if (!isRunnerHome(named[1])) cleanupProblem = `refused to remove ${named[1]}: not the runner's disposable home`;
      else {
        for (const d of ['locked', '.core-moved']) { try { chmodSync(join(named[1], d), 0o700); } catch (e) { if (e.code !== 'ENOENT') cleanupProblem = `could not unlock ${d}: ${e.code}`; } }
        try { rmSync(named[1], { recursive: true }); } catch (e) { cleanupProblem = `could not remove ${named[1]}: ${e.code}`; }
      }
    }
  }
  assert.equal(cleanupProblem, null, 'the test left nothing behind');
});

// The test that removes a leftover home trusts only a folder the runner itself would have made.
import { mkdtempSync as mk, mkdirSync as mkd, symlinkSync as sym, writeFileSync as wf } from 'node:fs';
import { tmpdir } from 'node:os';

test('isRunnerHome accepts a runner-shaped folder in the temp root and refuses lookalikes', () => {
  const real = mk(join(tmpdir(), 'core-suite-home-'));
  const elsewhere = mk(join(tmpdir(), 'elsewhere-'));
  try {
    assert.equal(isRunnerHome(real), true);
    assert.equal(isRunnerHome(join(tmpdir(), 'core-suite-home-short')), false, 'a missing folder');
    const lookalike = join(elsewhere, 'core-suite-home-abc123'); mkd(lookalike);
    assert.equal(isRunnerHome(lookalike), false, 'right name, wrong parent');
    const link = join(tmpdir(), `core-suite-home-L${String(process.pid).slice(-5).padStart(5, '0')}`); sym(elsewhere, link);
    try { assert.equal(isRunnerHome(link), false, 'a link with a matching name'); } finally { rmSync(link, { force: true }); }
    const file = join(tmpdir(), `core-suite-home-F${String(process.pid).slice(-5).padStart(5, '0')}`); wf(file, 'x');
    try { assert.equal(isRunnerHome(file), false, 'a file with a matching name'); } finally { rmSync(file, { force: true }); }
    assert.equal(isRunnerHome(undefined), false);
    assert.equal(isRunnerHome('/'), false);
  } finally { rmSync(real, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
});
