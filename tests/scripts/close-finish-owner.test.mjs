import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginClose, finishClose, releaseLock } from '../../plugins/core/skills/core/scripts/close-pass.mjs';
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
