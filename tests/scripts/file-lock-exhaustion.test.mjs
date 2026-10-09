import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignLockArtifact, withFileLock, acquireFileLock, releaseFileLock,
  currentLockFile, useNoMachineIdentity } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

useNoMachineIdentity();

// Same built-in-fs seam as lock-release-outcome.test.mjs. Tests are synchronous;
// restore bindings before fixture cleanup. No timer-dependent worker or production seam.
function changingMetadata(target, protectedPath) {
  const originals = { lstatSync: fs.lstatSync, readFileSync: fs.readFileSync,
    renameSync: fs.renameSync };
  const seen = { links: [], protectedReads: 0, renames: 0 };
  let enabled = false;
  fs.lstatSync = (path, ...args) => {
    const st = originals.lstatSync(path, ...args);
    if (!enabled || String(path) !== target) return st;
    const nlink = seen.links.length % 2 === 0 ? 2 : 3;
    seen.links.push(nlink);
    return Object.defineProperty(Object.create(st), 'nlink', { value: nlink });
  };
  fs.readFileSync = (path, ...args) => {
    if (enabled && [target, protectedPath].includes(String(path))) seen.protectedReads++;
    return originals.readFileSync(path, ...args);
  };
  fs.renameSync = (...args) => {
    if (enabled) seen.renames++;
    return originals.renameSync(...args);
  };
  syncBuiltinESMExports();
  return { seen, enable() { enabled = true; }, clear() { enabled = false; },
    restore() { Object.assign(fs, originals); syncBuiltinESMExports(); } };
}
function assertExhausted(seam) {
  assert.deepEqual(seam.seen.links, Array.from({ length: 20 }, (_, i) => i % 2 ? 3 : 2),
    'ten scans hit census nlink=2 and re-stat nlink=3, including scan ten');
  assert.equal(seam.seen.protectedReads, 0, 'unproven custody never opens protected bytes');
  assert.equal(seam.seen.renames, 0, 'unproven custody never retires a generation');
}
function thrown(fn) {
  let error;
  try { fn(); } catch (e) { error = e; }
  assert.ok(error, 'must refuse rather than report clean success');
  return error;
}

test('terminal changing-scan exhaustion refuses acquisition; a later clear invocation recovers', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lock-exhaustion-')));
  const lock = join(dir, 'test.lock'), suspect = lock + '.g1.done';
  const payload = join(dir, 'protected.txt');
  fs.writeFileSync(suspect, '{}'); fs.writeFileSync(payload, 'material');
  const before = fs.readdirSync(dir).sort();
  const seam = changingMetadata(suspect, payload);
  let calls = 0;
  const operation = () => { calls++; return fs.readFileSync(payload, 'utf8'); };
  try {
    seam.enable();
    const error = thrown(() => withFileLock(lock, operation, { retries: 0 }));
    assert.equal(error.code, 'LOCK_UNSAFE');
    assert.equal(error.path, suspect);
    assertExhausted(seam);
    assert.equal(calls, 0, 'no protected selection or callback before clearance');
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'no generation created or retired');
    seam.clear();
    assert.equal(foreignLockArtifact(lock), null, 'later completed scan clears; no sticky refusal');
    assert.equal(withFileLock(lock, operation, { retries: 0 }), 'material');
    assert.equal(calls, 1);
    assert.equal(currentLockFile(lock), null, 'normal release succeeds after clearance');
    assert.ok(fs.existsSync(lock + '.g2.done'), 'numbering survives refused acquisition');
  } finally { seam.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('release-only exhaustion preserves completed result; recovery is nonce-bound without replay', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'lock-release-exhaustion-')));
  const lock = join(dir, 'test.lock'), live = lock + '.g1';
  const material = join(dir, 'material.txt');
  const seam = changingMetadata(live, material);
  const result = { appended: 1, path: material };
  let calls = 0, nonce, ownedBytes;
  try {
    const error = thrown(() => withFileLock(lock, () => {
      calls++;
      assert.equal(currentLockFile(lock), live);
      ownedBytes = fs.readFileSync(live, 'utf8');
      nonce = JSON.parse(ownedBytes).nonce;
      fs.appendFileSync(material, 'one\n');
      seam.enable(); // Acquisition and material work completed; only release sees uncertainty.
      return result;
    }, { retries: 0 }));
    assertExhausted(seam);
    assert.equal(error.code, 'LOCK_RELEASE_FAILED');
    assert.equal(error.lockPath, lock);
    assert.equal(error.operationResult, result, 'preserve exact successful result object');
    assert.equal(error.releaseResult.released, false);
    assert.equal(error.releaseResult.reason, 'unsafe-lock-file');
    assert.equal(error.releaseResult.unsafe, basename(live));
    assert.equal(error.recovery.retry_operation, false);
    assert.match(error.recovery.instruction, /Do not repeat the material operation/);
    assert.equal(calls, 1);
    assert.equal(currentLockFile(lock), live, 'failed release retains owned generation');
    assert.equal(fs.existsSync(live + '.done'), false);
    seam.clear();
    assert.equal(fs.readFileSync(live, 'utf8'), ownedBytes, 'retained payload unchanged');
    assert.equal(foreignLockArtifact(lock), null, 'later custody observation clears');
    assert.deepEqual(releaseFileLock(lock, 'wrong-nonce'), { released: false, reason: 'not-owner' });
    assert.equal(fs.readFileSync(live, 'utf8'), ownedBytes, 'wrong owner cannot recover it');
    assert.deepEqual(releaseFileLock(lock, nonce), { released: true });
    assert.equal(currentLockFile(lock), null);
    assert.equal(fs.readFileSync(live + '.done', 'utf8'), ownedBytes);
    const peer = acquireFileLock(lock);
    assert.equal(peer.ok, true);
    assert.ok(peer.gen > 1);
    const peerPath = currentLockFile(lock), peerBytes = fs.readFileSync(peerPath, 'utf8');
    assert.deepEqual(releaseFileLock(lock, nonce), { released: false, reason: 'not-owner' });
    assert.equal(fs.readFileSync(peerPath, 'utf8'), peerBytes, 'old nonce never releases new owner');
    assert.deepEqual(releaseFileLock(lock, peer.nonce), { released: true });
    assert.equal(calls, 1, 'recovery only releases, never replays material work');
    assert.equal(fs.readFileSync(material, 'utf8'), 'one\n');
  } finally { seam.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
