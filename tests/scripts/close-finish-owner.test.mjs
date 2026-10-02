import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { beginClose, finishClose, releaseLock, inspectLock } from '../../plugins/core/skills/core/scripts/close-pass.mjs';
import { currentLockFile } from '../../plugins/core/skills/core/scripts/file-lock.mjs';
const script = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/close-pass.mjs', import.meta.url));
function fixture(t) {
  const store = mkdtempSync(join(tmpdir(), 'core-finish-owner-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, '_memories'));
  assert.equal(beginClose(store, { sessionId: 'owner-A', ops: ['memory-refresh'] }).ok, true);
  return store;
}
function bytes(store) {
  const dir = join(store, '_memories');
  return Object.fromEntries(readdirSync(dir).map(name => [name, readFileSync(join(dir, name), 'utf8')]));
}
for (const sessionId of [undefined, null, '', ' ', 'owner-B']) {
  test(`ordinary finish rejects ${JSON.stringify(sessionId)} without changing marker or lock`, t => {
    const store = fixture(t);
    const before = bytes(store);
    const result = finishClose(store, { sessionId });
    assert.equal(result.ok, false);
    assert.deepEqual(bytes(store), before);
    assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, false, 'live owner still excludes other closers');
  });
}
test('matching lock but mismatched marker is refused before any mutation', t => {
  const store = fixture(t);
  const markerPath = join(store, '_memories', '_close-marker.json');
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  writeFileSync(markerPath, JSON.stringify({ ...marker, session_id: 'owner-B' }));
  const before = bytes(store);
  assert.equal(finishClose(store, { sessionId: 'owner-A' }).ok, false);
  assert.deepEqual(bytes(store), before);
});
test('with no lock, finish completes the marker: the startup catch-up closing a close whose owner is gone', t => {
  const store = fixture(t);
  assert.equal(releaseLock(store).released, true);
  assert.equal(finishClose(store).status, 'closed');
  assert.equal(JSON.parse(bytes(store)['_close-marker.json']).status, 'closed');
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, true);
});
test('a close begun without a session is finished without one; a named session cannot finish it', t => {
  const store = mkdtempSync(join(tmpdir(), 'core-finish-owner-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, '_memories'));
  assert.equal(beginClose(store, { ops: ['memory-refresh'] }).ok, true);
  const before = bytes(store);
  assert.equal(finishClose(store, { sessionId: 'owner-B' }).ok, false);
  assert.deepEqual(bytes(store), before);
  assert.equal(finishClose(store).status, 'closed');
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, true);
});
test('matching owner can finish and release; CLI missing/wrong identity is nonzero', t => {
  const store = fixture(t);
  for (const args of [[], ['--session', 'owner-B']]) {
    const before = bytes(store);
    const result = spawnSync(process.execPath, [script, 'finish', store, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refus/i);
    assert.deepEqual(bytes(store), before);
  }
  const finished = finishClose(store, { sessionId: 'owner-A' });
  assert.equal(finished.status, 'closed');
  assert.equal(finished.release.released, true);
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, true);
});

const lockFile = store => currentLockFile(join(store, '_memories', '_close.lock'));
test('a live lock that cannot be read has an unknown owner: finish refuses and the lock survives', t => {
  const store = fixture(t);
  writeFileSync(lockFile(store), '{TORN');
  const before = bytes(store);
  for (const sessionId of [undefined, 'owner-A', 'owner-B']) {
    assert.deepEqual(finishClose(store, { sessionId }), { ok: false, reason: 'lock-unreadable' });
  }
  assert.deepEqual(bytes(store), before);
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, false);
});
test('a stale lock left by a named owner does not block the sessionless catch-up finish', t => {
  const store = fixture(t);
  // The owner process is gone and the lock has aged: a pid that is not running, an old mtime.
  const file = lockFile(store);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pid: 2147483646 }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(file, old, old);
  assert.equal(inspectLock(store).stale, true, 'test setup: the lock must read as stale');
  assert.equal(finishClose(store).status, 'closed');
  assert.equal(inspectLock(store).held, false);
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, true);
});
test('a whitespace session is no session: it finishes a sessionless close and the lock is really released', t => {
  const store = mkdtempSync(join(tmpdir(), 'core-finish-owner-'));
  t.after(() => rmSync(store, { recursive: true, force: true }));
  mkdirSync(join(store, '_memories'));
  assert.equal(beginClose(store, { ops: ['memory-refresh'] }).ok, true);
  const done = finishClose(store, { sessionId: ' ' });
  assert.equal(done.status, 'closed');
  assert.equal(done.release.released, true);
  assert.equal(inspectLock(store).held, false);
  assert.equal(beginClose(store, { sessionId: 'owner-B' }).ok, true);
});
test('a finish with no lock holds the lock while it writes, and leaves none behind', t => {
  const store = fixture(t);
  assert.equal(releaseLock(store).released, true);
  const done = finishClose(store);
  assert.equal(done.status, 'closed');
  assert.equal(done.release.released, true);
  assert.equal(inspectLock(store).held, false);
});

test('a begin that lands while a no-lock finish is writing the marker is refused, and nothing of its is released', t => {
  const store = fixture(t);
  assert.equal(releaseLock(store).released, true);
  // Run a competing begin at the exact moment the finish replaces the marker.
  const realRename = fs.renameSync;
  let racing = null;
  fs.renameSync = (from, to) => {
    if (racing === null && String(to).endsWith('_close-marker.json')) {
      racing = false;
      racing = beginClose(store, { sessionId: 'owner-B' });
    }
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.renameSync = realRename; syncBuiltinESMExports(); });
  const done = finishClose(store);
  fs.renameSync = realRename; syncBuiltinESMExports();
  assert.ok(racing, 'test setup: the marker write must go through renameSync');
  assert.equal(racing.ok, false, 'a begin acquired the lock in the middle of a finish');
  assert.equal(done.status, 'closed');
  assert.equal(inspectLock(store).held, false);
});
