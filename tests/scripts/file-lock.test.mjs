import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireFileLock, releaseFileLock, inspectFileLock, withFileLock, currentLockFile,
} from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const LOCK_MODULE = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/file-lock.mjs', import.meta.url));

// Genuinely concurrent child processes (spawnSync would serialize the "race").
function spawnAsync(args, env = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000, env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}

function tmpLock() {
  return join(mkdtempSync(join(tmpdir(), 'file-lock-')), 'test.lock');
}

// Back-date a file's mtime so staleness checks see it as old.
function backdate(p, ms) {
  const t = new Date(Date.now() - ms);
  utimesSync(p, t, t);
}

test('acquire/release roundtrip: a live generation exists while held, none after release', () => {
  const lock = tmpLock();
  const got = acquireFileLock(lock);
  assert.ok(got.ok && got.nonce, 'acquired with a nonce');
  assert.ok(currentLockFile(lock), 'a live generation file exists while held');
  const rel = releaseFileLock(lock, got.nonce);
  assert.ok(rel.released, 'released with own nonce');
  assert.equal(currentLockFile(lock), null, 'no live generation after release (tombstone remains)');
  // The tombstone preserves numbering: the next acquire gets a HIGHER generation.
  const again = acquireFileLock(lock);
  assert.ok(again.ok);
  assert.ok(again.gen > got.gen, `numbering never restarts (${got.gen} then ${again.gen})`);
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
  assert.ok(currentLockFile(lock), 'lock survives a non-owner release attempt');
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

test('legacy single-file lock (pre-generation format) is respected and superseded', () => {
  const lock = tmpLock();
  // A still-running old session's lock: bare file at the lock path, fresh, live pid.
  writeFileSync(lock, JSON.stringify({ pid: process.pid, session_id: 's-old', started_at: 'x' }));
  const refused = acquireFileLock(lock);
  assert.equal(refused.ok, false, 'a fresh legacy lock is held');
  // Once stale (dead owner), a new-format acquirer numbers itself above it.
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000);
  const got = acquireFileLock(lock);
  assert.ok(got.ok && got.stolen, 'stale legacy lock superseded');
  assert.ok(got.gen >= 1);
  assert.ok(!existsSync(lock), 'inert legacy file garbage-collected by the winner');
});

test('stale lock (dead pid + old mtime) is superseded; the new owner holds the next generation', () => {
  const lock = tmpLock();
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000); // 1h old, way past hard-stale
  const got = acquireFileLock(lock);
  assert.ok(got.ok, 'stale lock acquired past');
  assert.ok(got.stolen, 'reported as stolen');
  const onDisk = JSON.parse(readFileSync(currentLockFile(lock), 'utf8'));
  assert.equal(onDisk.nonce, got.nonce, 'new owner\'s nonce is on disk');
});

test('after one steal, a second would-be stealer sees a FRESH lock and is refused', () => {
  const lock = tmpLock();
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000);
  const first = acquireFileLock(lock);
  assert.ok(first.ok && first.stolen);
  const second = acquireFileLock(lock);
  assert.equal(second.ok, false, 'the winner\'s fresh generation holds');
});

test('withFileLock releases in finally even when fn throws', () => {
  const lock = tmpLock();
  assert.throws(() => withFileLock(lock, () => { throw new Error('boom'); }), /boom/);
  assert.equal(currentLockFile(lock), null, 'lock released despite the throw');
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

// K12 (Hale's audit, 2026-07-16): the finally block used to discard
// releaseFileLock's return value entirely, so a real release failure (another
// process already superseded/GC'd the generation, a filesystem error) was
// indistinguishable from success to every caller.
test('K12: a genuine release failure is never silent when fn() succeeds — it becomes the thrown error', () => {
  const lock = tmpLock();
  assert.throws(
    () => withFileLock(lock, () => {
      // Simulate another process superseding/GC'ing our generation while we
      // still hold it (renaming to .done is exactly what a real release does)
      // — by the time withFileLock's own release runs, the generation is gone.
      const live = currentLockFile(lock);
      
      renameSync(live, `${live}.done`);
      return 'fn-succeeded';
    }),
    (e) => e.code === 'LOCK_RELEASE_FAILED' && e.lockPath === lock && e.releaseResult && e.releaseResult.released === false,
    'a release failure after a successful fn() must surface as a real thrown error, not silent success',
  );
});

test('K12: a real fn() error still propagates (unmasked) even when release also fails, with the release failure attached', () => {
  const lock = tmpLock();
  assert.throws(
    () => withFileLock(lock, () => {
      const live = currentLockFile(lock);
      
      renameSync(live, `${live}.done`);
      throw new Error('the-real-failure');
    }),
    (e) => e.message === 'the-real-failure' && e.lockReleaseFailure && e.lockReleaseFailure.released === false,
    'fn()\'s real error must still be what propagates — a lock-release problem must never mask it',
  );
});

test('K12 control: a clean release (fn succeeds, release succeeds) still returns fn\'s value with no throw', () => {
  const lock = tmpLock();
  const result = withFileLock(lock, () => 'clean-result');
  assert.equal(result, 'clean-result');
  assert.equal(currentLockFile(lock), null, 'lock genuinely released on the happy path');
});

// The v2 design's three-process corner (Hale, 2026-07-15) is structurally gone in
// v3: release only ever renames the caller's OWN generation file to a tombstone.
// A revived owner whose lock was superseded cannot disturb the fresh owner at all.
test('release after supersession: revived owner is a strict no-op on the fresh owner\'s lock', () => {
  const lock = tmpLock();
  // Owner A: a crashed session's generation — dead pid, aged stale (a LIVE pid
  // is never supersedable under the round-3 policy, so A is crafted dead).
  writeFileSync(`${lock}.g1`, JSON.stringify({ pid: 999999999, nonce: 'a-nonce', gen: 1, started_at: 'x' }));
  backdate(`${lock}.g1`, 60 * 60 * 1000);
  const b = acquireFileLock(lock);
  assert.ok(b.ok && b.stolen, 'B superseded A\'s stale generation');
  const bFile = currentLockFile(lock);
  const bBytes = readFileSync(bFile, 'utf8');
  // A "revives" and releases with ITS nonce: must not touch B's generation.
  const attempt = releaseFileLock(lock, 'a-nonce');
  assert.equal(attempt.released, false);
  assert.equal(attempt.reason, 'not-owner');
  assert.equal(currentLockFile(lock), bFile, 'B\'s generation is still the current lock');
  assert.equal(readFileSync(bFile, 'utf8'), bBytes, 'B\'s lock is byte-identical — never moved or rewritten');
  assert.ok(releaseFileLock(lock, b.nonce).released, 'B releases normally');
});

// The race proof: N concurrent child processes each do a read-modify-write of a
// shared counter file under withFileLock. Without mutual exclusion this loses
// updates; with it, every increment survives.
function raceChild(lock, data, id) {
  return `
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
}

test('race: 5 concurrent locked read-modify-writes lose no update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-race-'));
  const lock = join(dir, 'counter.lock');
  const data = join(dir, 'counter.json');
  writeFileSync(data, JSON.stringify({ writers: [] }));
  const ids = ['w1', 'w2', 'w3', 'w4', 'w5'];
  const procs = await Promise.all(ids.map(id => spawnAsync(['--input-type=module', '-e', raceChild(lock, data, id)])));
  for (const p of procs) assert.equal(p.status, 0, `child exited 0 (stderr: ${p.stderr})`);
  const final = JSON.parse(readFileSync(data, 'utf8'));
  assert.deepEqual([...final.writers].sort(), ids, 'all five writers survived — no lost update');
  rmSync(dir, { recursive: true, force: true });
});

// Hale's second 2026-07-15 challenge: the hard-link-unavailable fallback recreates
// the wx+write window. The young-unreadable-is-held rule is supposed to cover it —
// this test PROVES it under force (CORE_FILELOCK_NO_LINK=1) instead of asserting it.
test('race: 5 concurrent locked writers under FORCED wx fallback (no hard links) lose no update', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-nolink-'));
  const lock = join(dir, 'counter.lock');
  const data = join(dir, 'counter.json');
  writeFileSync(data, JSON.stringify({ writers: [] }));
  const ids = ['f1', 'f2', 'f3', 'f4', 'f5'];
  const procs = await Promise.all(ids.map(id =>
    spawnAsync(['--input-type=module', '-e', raceChild(lock, data, id)], { CORE_FILELOCK_NO_LINK: '1' })));
  for (const p of procs) assert.equal(p.status, 0, `child exited 0 (stderr: ${p.stderr})`);
  const final = JSON.parse(readFileSync(data, 'utf8'));
  assert.deepEqual([...final.writers].sort(), ids, 'fallback path holds mutual exclusion');
  rmSync(dir, { recursive: true, force: true });
});

// Hale's earlier advisory: hold both children at a barrier and release them at the
// same instant against the same stale lock — a sequential "race" proves nothing.
test('race: two SIMULTANEOUS stealers of one stale lock — exactly one wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'steal-race-'));
  const lock = join(dir, 'contested.lock');
  const go = join(dir, 'go');
  writeFileSync(lock, JSON.stringify({ pid: 999999999, nonce: 'dead', started_at: 'x' }));
  backdate(lock, 60 * 60 * 1000);
  const child = `
    import { acquireFileLock } from ${JSON.stringify('file://' + LOCK_MODULE)};
    import { existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(go)})) { /* barrier spin */ }
    const got = acquireFileLock(${JSON.stringify(lock)});
    process.exit(got.ok ? 0 : 3);
  `;
  const p1 = spawnAsync(['--input-type=module', '-e', child]);
  const p2 = spawnAsync(['--input-type=module', '-e', child]);
  await new Promise(r => setTimeout(r, 150)); // let both reach the barrier
  writeFileSync(go, '1');
  const [r1, r2] = await Promise.all([p1, p2]);
  const wins = [r1, r2].filter(r => r.status === 0).length;
  const losses = [r1, r2].filter(r => r.status === 3).length;
  assert.equal(wins, 1, `exactly one stealer wins (got ${wins}; stderr: ${r1.stderr} ${r2.stderr})`);
  assert.equal(losses, 1, 'the other reports the lock as contended');
  rmSync(dir, { recursive: true, force: true });
});

// Hale's round-3 ask: a barrier-controlled A/B/C proof that C cannot enter while a
// wrong-owner (revived A) release runs against B's live lock. In v3 A's release is
// a read-only scan (it renames only a file whose content matched), so C must be
// refused on every attempt and B's lock must stay byte-identical throughout.
test('race A/B/C: C can never acquire during a revived owner\'s wrong-owner release; B\'s lock untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abc-race-'));
  const lock = join(dir, 'abc.lock');
  const go = join(dir, 'go');
  // A: a superseded owner — dead-pid stale generation crafted on disk.
  writeFileSync(`${lock}.g1`, JSON.stringify({ pid: 999999999, nonce: 'a-nonce', gen: 1, started_at: 'x' }));
  backdate(`${lock}.g1`, 60 * 60 * 1000);
  // B: legitimate current owner (supersedes A's stale generation).
  const b = acquireFileLock(lock);
  assert.ok(b.ok && b.stolen, 'B superseded A');
  const bFile = currentLockFile(lock);
  const bBytes = readFileSync(bFile, 'utf8');
  // C: hammers acquire from a child process; exits 0 if it EVER gets the lock.
  const childC = `
    import { acquireFileLock } from ${JSON.stringify('file://' + LOCK_MODULE)};
    import { existsSync } from 'node:fs';
    while (!existsSync(${JSON.stringify(go)})) { /* barrier spin */ }
    for (let i = 0; i < 300; i++) {
      if (acquireFileLock(${JSON.stringify(lock)}).ok) process.exit(0);
    }
    process.exit(3);
  `;
  const pC = spawnAsync(['--input-type=module', '-e', childC]);
  await new Promise(r => setTimeout(r, 100));
  writeFileSync(go, '1');
  // Revived A releases with its stale nonce over and over while C hammers.
  for (let i = 0; i < 300; i++) {
    const rel = releaseFileLock(lock, 'a-nonce');
    assert.equal(rel.released, false, 'revived A never succeeds');
  }
  const rC = await pC;
  assert.equal(rC.status, 3, `C was refused on every attempt (stderr: ${rC.stderr})`);
  assert.equal(currentLockFile(lock), bFile, 'B still holds the current generation');
  assert.equal(readFileSync(bFile, 'utf8'), bBytes, 'B\'s lock byte-identical throughout');
  rmSync(dir, { recursive: true, force: true });
});

test('a live-pid lock is NEVER auto-superseded, at any age (Hale round 3)', () => {
  const lock = tmpLock();
  writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce: 'mine', started_at: 'x' }));
  backdate(lock, 24 * 60 * 60 * 1000); // a full day old — far past every ceiling
  const got = acquireFileLock(lock);
  assert.equal(got.ok, false, 'live owner respected at any age');
  assert.equal(got.reason, 'held');
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

// Hale round 4: the old release swallowed EVERY rename failure as "already gone"
// and returned released:true over a live lock. Inject a real failure (read-only
// parent dir → EACCES) and prove it fails closed. POSIX-only injection; the
// ENOENT-tolerant branch (superseded + GC'd) is covered by the supersession test.
test('release fails CLOSED when the tombstone rename cannot be performed — no false success', { skip: process.platform === 'win32' }, async () => {
  const { chmodSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'rel-fail-'));
  const lock = join(dir, 'x.lock');
  const got = acquireFileLock(lock);
  assert.ok(got.ok);
  chmodSync(dir, 0o555); // read-only dir: rename inside it throws EACCES/EPERM
  try {
    const rel = releaseFileLock(lock, got.nonce);
    assert.equal(rel.released, false, 'no false success over a live lock');
    assert.equal(rel.reason, 'release-failed');
    assert.ok(rel.error, 'the failure names its cause');
    assert.ok(currentLockFile(lock), 'the live lock is still on disk — reported truthfully');
  } finally {
    chmodSync(dir, 0o755);
    assert.ok(releaseFileLock(lock, got.nonce).released, 'release succeeds once the cause clears');
    rmSync(dir, { recursive: true, force: true });
  }
});

// Hale round 5: the operator RECOVERY path lied the same way — force release
// swallowed removal failures and reported released:true.
test('force release fails CLOSED when removal cannot be performed — recovery never lies', { skip: process.platform === 'win32' }, async () => {
  const { chmodSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'force-fail-'));
  const lock = join(dir, 'x.lock');
  acquireFileLock(lock);
  chmodSync(dir, 0o555);
  try {
    const rel = releaseFileLock(lock, null, { force: true });
    assert.equal(rel.released, false, 'force release must not report success over a surviving lock');
    assert.equal(rel.reason, 'release-failed');
    assert.match(rel.error, /x\.lock/, 'names the surviving artifact');
    assert.ok(currentLockFile(lock), 'lock still on disk, reported truthfully');
  } finally {
    chmodSync(dir, 0o755);
    assert.ok(releaseFileLock(lock, null, { force: true }).released, 'recovery succeeds once the cause clears');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('force release removes every generation artifact', () => {
  const lock = tmpLock();
  const a = acquireFileLock(lock);
  releaseFileLock(lock, a.nonce);          // leaves a tombstone
  acquireFileLock(lock);                    // live generation
  const rel = releaseFileLock(lock, null, { force: true });
  assert.ok(rel.released);
  assert.equal(currentLockFile(lock), null);
  const fresh = acquireFileLock(lock);
  assert.ok(fresh.ok, 'lock is cleanly acquirable after force release');
});
