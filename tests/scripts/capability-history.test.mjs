import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendRows, readHistory, canonicalRowHash, applyRetention, acquireLock,
  LOCK_RETRY_INTERVAL_MS, LOCK_TIMEOUT_MS,
} from '../../plugins/core/skills/core/scripts/capability-history.mjs';
import { currentLockFile } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

test('M8: appendRows writes the history file via the shared atomic writer (no orphan temp files)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/core/skills/core/scripts/capability-history.mjs', import.meta.url)), 'utf8');
  assert.match(src, /from '\.\/fs-atomic\.mjs'/, 'imports the shared atomic writer');
  assert.match(src, /atomicWriteFileSync\(file,/, 'history file written atomically');
  assert.doesNotMatch(src, /\.tmp-\$\{process\.pid\}/, 'the hand-rolled temp+rename (no cleanup on failure) is gone');
});

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'caphist-'));
}

function sampleRow(overrides = {}) {
  return {
    capability_id: 'plugin-root-resolution',
    capability_kind: 'identity',
    identity_status: 'PASS',
    evidence: [{ source: 'starting-path', value: 'x' }],
    ...overrides,
  };
}

// --- canonicalRowHash ---

test('canonicalRowHash: same row twice → same hash', () => {
  const a = canonicalRowHash(sampleRow());
  const b = canonicalRowHash(sampleRow());
  assert.equal(a, b);
});

test('canonicalRowHash: observed_at excluded from hash', () => {
  const a = canonicalRowHash(sampleRow({ observed_at: '2026-01-01T00:00:00Z' }));
  const b = canonicalRowHash(sampleRow({ observed_at: '2026-12-31T23:59:59Z' }));
  assert.equal(a, b, 'observed_at must not affect the hash');
});

test('canonicalRowHash: evidence order does not affect hash', () => {
  const a = canonicalRowHash(sampleRow({ evidence: [{ source: 'a', value: 1 }, { source: 'b', value: 2 }] }));
  const b = canonicalRowHash(sampleRow({ evidence: [{ source: 'b', value: 2 }, { source: 'a', value: 1 }] }));
  assert.equal(a, b, 'evidence sorted by source before hashing');
});

test('canonicalRowHash: different status → different hash', () => {
  const a = canonicalRowHash(sampleRow({ identity_status: 'PASS' }));
  const b = canonicalRowHash(sampleRow({ identity_status: 'DEGRADED' }));
  assert.notEqual(a, b);
});

// --- appendRows ---

test('appendRows: first write creates file with one entry', () => {
  const home = tmpHome();
  try {
    const res = appendRows('ws1', [sampleRow()], { runner_version: '2.7.0' }, { home });
    assert.equal(res.appended, 1);
    assert.ok(existsSync(res.path));
    const hist = readHistory('ws1', { home });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].workspace_id, 'ws1');
    assert.equal(hist[0].runner_version, '2.7.0');
    assert.ok(hist[0].row_content_hash);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('appendRows/readHistory: project-local store supports sandboxed capability history', () => {
  const project = mkdtempSync(join(tmpdir(), 'caphist-project-'));
  try {
    const res = appendRows('ws-project', [sampleRow()], { session_id: 's1' }, { project });
    assert.match(res.path, /_metrics[/\\]capability-history[/\\]ws-project\.jsonl$/); // [/\\]: path.join emits backslashes on Windows
    assert.ok(existsSync(res.path), 'project-local history file created');
    const hist = readHistory('ws-project', { project });
    assert.equal(hist.length, 1);
    assert.equal(hist[0].workspace_id, 'ws-project');
    assert.equal(hist[0].session_id, 's1');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('appendRows: second write appends without overwriting', () => {
  const home = tmpHome();
  try {
    appendRows('ws1', [sampleRow()], {}, { home });
    appendRows('ws1', [sampleRow({ identity_status: 'DEGRADED' })], {}, { home });
    const hist = readHistory('ws1', { home });
    assert.equal(hist.length, 2);
    assert.equal(hist[0].row.identity_status, 'PASS');
    assert.equal(hist[1].row.identity_status, 'DEGRADED');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('appendRows: content hash stable across sessions for identical row', () => {
  const home = tmpHome();
  try {
    appendRows('ws1', [sampleRow()], { session_id: 's1' }, { home });
    appendRows('ws1', [sampleRow()], { session_id: 's2' }, { home });
    const hist = readHistory('ws1', { home });
    assert.equal(hist[0].row_content_hash, hist[1].row_content_hash,
      'identical row in two sessions → same content hash (drift detection relies on this)');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- applyRetention ---

test('applyRetention: under cap → all kept, zero truncated', () => {
  const lines = Array.from({ length: 5 }, (_, i) =>
    JSON.stringify({ observed_at: `2026-01-0${i + 1}`, row: { capability_id: 'c' } }));
  const { kept, truncated } = applyRetention(lines, { byteCap: 1024 * 1024 });
  assert.equal(kept.length, 5);
  assert.equal(truncated, 0);
});

test('applyRetention: over cap → keeps most recent N per capability', () => {
  // Lexically-sortable observed_at values (fixed width) — mirrors real ISO timestamps.
  const lines = Array.from({ length: 200 }, (_, i) =>
    JSON.stringify({ observed_at: `seq-${String(i).padStart(4, '0')}`, row: { capability_id: 'c' } }));
  const { kept, truncated } = applyRetention(lines, { byteCap: 100, perCapability: 10 });
  assert.equal(kept.length, 10, 'keeps perCapability most recent');
  assert.equal(truncated, 190);
  // Verify they are the most recent (highest observed_at): seq-0190 .. seq-0199
  const last = JSON.parse(kept[kept.length - 1]);
  assert.equal(last.observed_at, 'seq-0199', 'most recent entry retained');
  const first = JSON.parse(kept[0]);
  assert.equal(first.observed_at, 'seq-0190', 'kept window starts at the 10th-from-last');
});

test('applyRetention: separate caps per capability_id', () => {
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ observed_at: `2026-01-01T00:00:${String(i).padStart(2,'0')}Z`, row: { capability_id: 'a' } }));
  for (let i = 0; i < 100; i++) lines.push(JSON.stringify({ observed_at: `2026-01-02T00:00:${String(i).padStart(2,'0')}Z`, row: { capability_id: 'b' } }));
  const { kept } = applyRetention(lines, { byteCap: 100, perCapability: 5 });
  const aCount = kept.filter(l => JSON.parse(l).row.capability_id === 'a').length;
  const bCount = kept.filter(l => JSON.parse(l).row.capability_id === 'b').length;
  assert.equal(aCount, 5);
  assert.equal(bCount, 5);
} );

test('appendRows: retention truncates when cap exceeded', () => {
  const home = tmpHome();
  try {
    // Write enough large rows to exceed a small cap
    const bigRow = sampleRow({ evidence: [{ source: 's', value: 'x'.repeat(500) }] });
    for (let i = 0; i < 50; i++) {
      appendRows('ws1', [bigRow], {}, { home, retentionOpts: { byteCap: 2000, perCapability: 3 } });
    }
    const hist = readHistory('ws1', { home });
    assert.ok(hist.length <= 3, `retention should cap at 3, got ${hist.length}`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- acquireLock ---

test('acquireLock: acquires and releases (generation model — live gen while held, none after)', () => {
  const home = tmpHome();
  try {
    const lf = join(home, 'test.lock');
    const release = acquireLock(lf);
    assert.ok(currentLockFile(lf), 'a live generation exists while held');
    release();
    assert.equal(currentLockFile(lf), null, 'no live generation after release');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('acquireLock: recovers a stale lock', () => {
  const home = tmpHome();
  try {
    const lf = join(home, 'stale.lock');
    writeFileSync(lf, '0');  // pre-existing legacy lock, unparseable owner
    const old = new Date(Date.now() - 60_000);
    utimesSync(lf, old, old); // aged past staleMs below
    const release = acquireLock(lf, { staleMs: 1000 });
    assert.ok(currentLockFile(lf), 'new owner holds the next generation');
    release();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('acquireLock: fails closed while the recorded pid is ALIVE, even past staleMs (Hale 2026-07-15)', () => {
  const home = tmpHome();
  try {
    const lf = join(home, 'live.lock');
    // A lock held by THIS live process, aged past staleMs (2× via backdate) but
    // safely under the 10× hard ceiling for the whole retry window.
    writeFileSync(lf, JSON.stringify({ pid: process.pid, nonce: 'n', t: 0 }));
    const twoStale = new Date(Date.now() - 2 * 60_000);
    utimesSync(lf, twoStale, twoStale);
    assert.throws(
      () => acquireLock(lf, { timeoutMs: 80, staleMs: 60_000 }),
      /could not acquire lock/,
      'age alone must not steal from a live writer'
    );
    // Past the hard ceiling (age > staleMs*10) it supersedes regardless — the
    // recycled-pid strand escape. now() far in the future simulates the age.
    const release = acquireLock(lf, { timeoutMs: 80, staleMs: 60_000, now: () => Date.now() + 700_000 });
    assert.ok(currentLockFile(lf), 'new owner holds the current generation');
    release();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('acquireLock: release is nonce-verified — a superseded owner\'s release cannot touch the fresh lock', () => {
  const home = tmpHome();
  try {
    const lf = join(home, 'verify.lock');
    const releaseA = acquireLock(lf);
    // Simulate A being superseded: age A's generation to hard-stale, let B supersede.
    const cur = currentLockFile(lf);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(cur, old, old);
    const releaseB = acquireLock(lf, { staleMs: 1000 });
    const bFile = currentLockFile(lf);
    const bBytes = readFileSync(bFile, 'utf8');
    releaseA(); // must be a strict no-op — B's generation untouched
    assert.equal(currentLockFile(lf), bFile, 'fresh owner\'s generation survives');
    assert.equal(readFileSync(bFile, 'utf8'), bBytes, 'byte-identical — never moved or rewritten');
    releaseB();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('acquireLock: times out when lock held and not stale', () => {
  const home = tmpHome();
  try {
    const lf = join(home, 'held.lock');
    writeFileSync(lf, String(Date.now()));
    assert.throws(
      () => acquireLock(lf, { timeoutMs: 100, staleMs: 1000000 }),
      /could not acquire lock/,
    );
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('MET-011: contention waits via injected sleep in bounded retries — no busy-spin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ch-spin-'));
  try {
    const lf = join(dir, 'x.lock');
    writeFileSync(lf, 'held');
    let t = 0;
    const sleeps = [];
    assert.throws(
      () => acquireLock(lf, {
        now: () => t,
        timeoutMs: 100,
        staleMs: Number.MAX_SAFE_INTEGER,
        sleep: (ms) => { sleeps.push(ms); t += ms; },
      }),
      /could not acquire lock/,
    );
    assert.ok(sleeps.length >= 1 && sleeps.length <= 6, `bounded retry count, got ${sleeps.length}`);
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= LOCK_RETRY_INTERVAL_MS), 'each wait is one short interval');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MET-011: default lock timeout is bounded at 1s, not 5s', () => {
  assert.equal(LOCK_TIMEOUT_MS, 1000);
});

// --- two-writer fixture (HC's required proof: no lost history) ---

test('appendRows: sequential writes under lock lose no history (two-writer proof)', () => {
  const home = tmpHome();
  try {
    // Simulate two writers appending; lock serializes them.
    // (Node test is single-threaded, but this proves the read-modify-write
    //  under lock preserves prior entries — the lost-update scenario HC named.)
    appendRows('ws1', [sampleRow({ identity_status: 'PASS' })], { session_id: 'w1' }, { home });
    appendRows('ws1', [sampleRow({ identity_status: 'DEGRADED' })], { session_id: 'w2' }, { home });
    appendRows('ws1', [sampleRow({ identity_status: 'NOT-YET' })], { session_id: 'w3' }, { home });
    const hist = readHistory('ws1', { home });
    assert.equal(hist.length, 3, 'all three writes preserved — no lost update');
    assert.deepEqual(hist.map(h => h.session_id), ['w1', 'w2', 'w3']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
