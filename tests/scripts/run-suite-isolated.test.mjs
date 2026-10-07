// The isolated runner fails a suite that writes into the protected account ~/.core, and passes one
// that writes only to the shared test root: the negative and the positive control for the CI step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
