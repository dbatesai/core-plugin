// The CI guard catches a write into the account's ~/.core and lets the shared test root and the named
// baseline through; the positive controls prove it can fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../../scripts/release/real-home-guard.mjs', import.meta.url));
const run = (...a) => spawnSync(process.execPath, [GUARD, ...a], { encoding: 'utf8' });

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'guard-home-')));
  mkdirSync(join(home, '.core', 'local'), { recursive: true });
  writeFileSync(join(home, '.core', 'projects.json'), '[]');
  return { home, snap: join(home, 'snap.json') };
}

test('an untouched home passes; the shared test root and the named baseline are allowed', () => {
  const { home, snap } = fixture();
  try {
    assert.equal(run('snapshot', snap, '--home', home).status, 0);
    mkdirSync(join(home, '.core', '.test-tmp', 'x'), { recursive: true });
    writeFileSync(join(home, '.core', 'close-pass-last.log'), 'x');
    const r = run('check', snap, '--home', home);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an added file, a changed file, a removed file and a new folder each fail the check', () => {
  for (const [name, act] of [
    ['added file', (c) => writeFileSync(join(c, 'local', 'new.json'), '{}')],
    ['changed file', (c) => writeFileSync(join(c, 'projects.json'), '[1,2,3]')],
    ['removed file', (c) => rmSync(join(c, 'projects.json'))],
    ['new folder', (c) => mkdirSync(join(c, 'workspaces'))],
    ['new link', (c) => symlinkSync(c, join(c, 'loop'))],
  ]) {
    const { home, snap } = fixture();
    try {
      run('snapshot', snap, '--home', home);
      act(join(home, '.core'));
      const r = run('check', snap, '--home', home);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, /changed the real account/, name);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test('the global stamp lock an older installed version takes is allowed; a new top-level name is not', () => {
  const { home, snap } = fixture();
  try {
    run('snapshot', snap, '--home', home);
    writeFileSync(join(home, '.core', 'state-cache.lock.g9.done'), '{}');
    assert.equal(run('check', snap, '--home', home).status, 0);
    writeFileSync(join(home, '.core', 'topics.md'), 'x');
    assert.equal(run('check', snap, '--home', home).status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
