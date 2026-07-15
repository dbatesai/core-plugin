import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Genuinely concurrent child processes (spawnSync would serialize the "race").
function spawnAsync(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000 });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}
import {
  acquireFileLock, releaseFileLock, inspectFileLock, withFileLock,
} from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const LOCK_MODULE = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/file-lock.mjs', import.meta.url));

function tmpLock() {
  return join(mkdtempSync(join(tmpdir(), 'file-lock-')), 'test.lock');
}

// Back-date a file's mtime so staleness checks see it as old.
function backdate(p, ms) {
  const t = new Date(Date.now() - ms);
  utimesSync(p, t, t);
}

test('acquire/release roundtrip: lock file exists while held, gone after verified release', () => {
  const lock = tmpLock();
  const got = acquireFileLock(lock);
  assert.ok(got.ok && got.nonce, 'acquired with a nonce');
  assert.ok(existsSync(lock), 'lock file present while held');
  const rel = releaseFileLock(lock, got.nonce);
  assert.ok(rel.released, 'released with own nonce');
  assert.ok(!existsSync(lock), 'lock file gone after release');
});

test('contended: a live fresh lock refuses a second acquirer', () => {
  const lock = tmpLock();
  const a = acquireFileLock(lock);
  assert.ok(a.ok);
  const b = acquireFileLock(lock);
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'held');
});

test('release is VERIFIED: wrong nonce is a no-op, the owner keeps the lock', () => {
  const lock = tmpLock();
  const got = acquireFileLock(lock);
  const rel = releaseFileLock(lock, 'not-the-nonce');
  assert.equal(rel.released, false);
  assert.equal(rel.reason, 'not-owner');
  assert.ok(existsSync(lock), 'lock survives a non-owner release attempt');
  assert.ok(releaseFileLock(lock, got.nonce).released);
});

test('release can verify by an extra payload field (cross-process, e.g. session_id)', () => {
  const lock = tmpLock();
  acquireFileLock(lock, { extra: { session_id: 's-42' } });
  const wrong = releaseFileLock(lock, null, { verify: { field: 'session_id', value: 's-OTHER' } });
  assert.equal(wrong.released, false);
  const right = releaseFileLock(lock, null, { verify: { field: 'session_id', value: 's-42' } });
  assert.ok(right.released);
});

test('stale lock (dead pid + old mtime) is stolen; the thief owns it', () => {
  const lock = tmpLock();
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000); // 1h old, way past hard-stale
  const got = acquireFileLock(lock);
  assert.ok(got.ok, 'stale lock acquired');
  assert.ok(got.stolen, 'reported as stolen');
  const onDisk = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(onDisk.nonce, got.nonce, 'thief\'s nonce is on disk');
});

test('after one steal, a second would-be stealer sees a FRESH lock and is refused', () => {
  const lock = tmpLock();
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000);
  const first = acquireFileLock(lock);
  assert.ok(first.ok && first.stolen);
  const second = acquireFileLock(lock);
  assert.equal(second.ok, false, 'the rename-claim consumed the stale file; the fresh lock holds');
});

test('withFileLock releases in finally even when fn throws', () => {
  const lock = tmpLock();
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.ok(!existsSync(lock), 'lock released despite the throw');
});

test('withFileLock throws LOCK_HELD after retry budget on a live contended lock', () => {
  const lock = tmpLock();
  const got = acquireFileLock(lock);
  assert.ok(got.ok);
  assert.throws(
    () => withFileLock(lock, () => 'never', { retries: 2, retryDelayMs: 10 }),
    (e) => e.code === 'LOCK_HELD'
  );
  releaseFileLock(lock, got.nonce);
});

// The race proof: N concurrent child processes each do a read-modify-write of a
// shared counter file under withFileLock. Without mutual exclusion this loses
// updates; with it, every increment survives.
test('race: 5 concurrent locked read-modify-writes lose no update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-race-'));
  const lock = join(dir, 'counter.lock');
  const data = join(dir, 'counter.json');
  writeFileSync(data, JSON.stringify({ writers: [] }));
  const child = (id) => `
    import { withFileLock } from ${JSON.stringify('file://' + LOCK_MODULE)};
    import { readFileSync, writeFileSync } from 'node:fs';
    withFileLock(${JSON.stringify(lock)}, () => {
      const d = JSON.parse(readFileSync(${JSON.stringify(data)}, 'utf8'));
      d.writers.push(${JSON.stringify(id)});
      // Widen the race window so unsynchronized writers would actually collide.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
      writeFileSync(${JSON.stringify(data)}, JSON.stringify(d));
    }, { retries: 100, retryDelayMs: 20 });
  `;
  const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const procs = await Promise.all(ids.map(id => spawnAsync(['--input-type=module', '-e', child(id)])));
  for (const p of procs) assert.equal(p.status, 0, `child exited 0 (stderr: ${p.stderr})`);
  const final = JSON.parse(readFileSync(data, 'utf8'));
  assert.deepEqual([...final.writers].sort(), ids, 'all five writers survived — no lost update');
  rmSync(dir, { recursive: true, force: true });
});

test('inspectFileLock: absent is unheld; a YOUNG corrupt lock is held; an OLD corrupt lock is stale', () => {
  const lock = tmpLock();
  assert.deepEqual(inspectFileLock(lock), { held: false, lock: null, stale: false });
  writeFileSync(lock, 'not json');
  const young = inspectFileLock(lock);
  assert.equal(young.held, true, 'young unreadable lock treated as an in-flight write, not stealable');
  assert.equal(young.stale, false);
  backdate(lock, 60 * 60 * 1000);
  const old = inspectFileLock(lock);
  assert.equal(old.held, false);
  assert.equal(old.stale, true, 'aged-out corrupt lock is stealable');
});
