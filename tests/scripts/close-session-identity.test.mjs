/**
 * close-session-identity.test.mjs — exact-session close receipts (ID-01 … ID-08).
 *
 * RED-first for the finalize/refocus redesign. These encode the four oracles
 * ratified three-way (Keel/Hale/Agy, 2026-07-27):
 *
 *   1. a manual close for sess-A writes a valid terminal exact-session receipt;
 *   2. SessionEnd for the SAME sess-A creates no second request/claimant/model call;
 *   3. a distinct sess-B is still preserved and processed;
 *   4. a failed/partial sess-A remains owed and recoverable.
 *
 * Root cause these target: the close marker is keyed per STORE
 * (`_memories/_close-marker.json`), never per session, and `shouldSpawn()`
 * returns true on `didWork` before asking whether this exact session already
 * closed. The SessionEnd hook receives `session_id` and drops it. That is why a
 * manual finalize can be followed 59.7s later by a second reasoning close.
 *
 * Baseline for the RED run: e81903fc5c58529f7ab0b05421df126c3f9e4f2d (clean tree).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  sessionKey,
  receiptPath,
  readCloseReceipt,
  writeCloseReceipt,
  shouldEnqueueClose,
  runDeterministicClose,
} from '../../plugins/core/skills/core/scripts/close-pass.mjs';

function freshStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-identity-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  return store;
}

/** Hermetic storage root so tests never touch the real ~/.core. */
function opts(store) {
  return { storageRoot: mkdtempSync(join(tmpdir(), 'close-identity-storage-')) , store };
}

const SESSION_A = 'sess-A-0192aa8c-1f4d-4a51-9d3e-11c0ffee0001';
const SESSION_B = 'sess-B-0192aa8c-1f4d-4a51-9d3e-11c0ffee0002';

function terminalReceipt(sessionId, status = 'closed') {
  return {
    session_id: sessionId,
    status,
    harness: 'claude-code',
    closed_at: '2026-07-27T16:00:00.000Z',
    ops: { capture: 'done', summary: 'done', 'project-state': 'skipped' },
    summary_path: '_summaries/summary-2026-07-27.md',
    summary_sha256: 'a'.repeat(64),
  };
}

// ─────────────────────────── ID-01 … ID-02: identity primitives ───────────────

test('ID-01 sessionKey() derives a stable key and refuses a non-identity', () => {
  const k1 = sessionKey(SESSION_A);
  const k2 = sessionKey(SESSION_A);
  assert.equal(k1, k2, 'same session id must derive the same key');
  assert.notEqual(sessionKey(SESSION_B), k1, 'distinct sessions must not collide');
  assert.match(k1, /^[0-9a-f]{64}$/, 'key is a sha256 hex digest');

  // A missing identity must never silently become an identity. The current
  // runner invents `auto-<timestamp>`, which is exactly how two SessionEnd
  // events for one session become two distinct "sessions".
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    assert.throws(() => sessionKey(bad), /session/i,
      `sessionKey(${JSON.stringify(bad)}) must throw, not synthesize`);
  }
});

test('ID-02 receiptPath() is session-keyed and lives outside the project store', () => {
  const store = freshStore();
  const o = opts(store);
  const p = receiptPath(store, SESSION_A, o);

  assert.ok(p.includes(sessionKey(SESSION_A)), 'path must be keyed by the session digest');
  assert.ok(!p.includes(join(store, '_memories')),
    'receipts are close-system state, not project memory');
  assert.notEqual(receiptPath(store, SESSION_B, o), p, 'distinct sessions get distinct paths');
});

// ─────────────────────────── ORACLE 1: manual close writes a receipt ──────────

test('ID-03 [oracle 1] a manual close writes a terminal receipt that reads back', () => {
  const store = freshStore();
  const o = opts(store);

  assert.equal(readCloseReceipt(store, SESSION_A, o), null,
    'no receipt before any close');

  writeCloseReceipt(store, terminalReceipt(SESSION_A), o);

  const got = readCloseReceipt(store, SESSION_A, o);
  assert.ok(got, 'receipt must read back after a close');
  assert.equal(got.session_id, SESSION_A);
  assert.equal(got.status, 'closed');
  assert.equal(got.ops.capture, 'done');
  assert.equal(got.summary_sha256, 'a'.repeat(64));
});

test('ID-04 receipts are owner-only on disk', () => {
  const store = freshStore();
  const o = opts(store);
  writeCloseReceipt(store, terminalReceipt(SESSION_A), o);

  const mode = statSync(receiptPath(store, SESSION_A, o)).mode & 0o777;
  assert.equal(mode, 0o600, `receipt mode must be 0600, got ${mode.toString(8)}`);
});

// ─────────────────────────── ORACLE 2: no second close for the same session ───

test('ID-05 [oracle 2] a closed session is never enqueued again', () => {
  const store = freshStore();
  const o = opts(store);

  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_A, harness: 'claude-code' }, o),
    true,
    'first SessionEnd for an unclosed session must enqueue',
  );

  writeCloseReceipt(store, terminalReceipt(SESSION_A), o);

  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_A, harness: 'claude-code' }, o),
    false,
    'THE BUG: a second SessionEnd for an already-closed session must NOT enqueue',
  );
});

test('ID-06 [oracle 2] the store-level legacy marker cannot certify an exact session', () => {
  const store = freshStore();
  const o = opts(store);

  // The pre-existing per-store marker says "this project closed". That is the
  // surface today's shouldSpawn()/detectCloseState() reason over, and it cannot
  // distinguish which session closed. It must not be readable as exact-session
  // proof, or the dedup silently degrades back to per-project.
  writeFileSync(
    join(store, '_memories', '_close-marker.json'),
    JSON.stringify({ status: 'closed', session_id: SESSION_A, ops: {} }),
  );

  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_B, harness: 'claude-code' }, o),
    true,
    'a marker naming sess-A must not suppress a close for sess-B',
  );
});

// ─────────────────────────── ORACLE 3: other sessions still close ─────────────

test('ID-07 [oracle 3] closing sess-A does not suppress a distinct sess-B', () => {
  const store = freshStore();
  const o = opts(store);

  writeCloseReceipt(store, terminalReceipt(SESSION_A), o);

  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_B, harness: 'claude-code' }, o),
    true,
    'a distinct session must still be preserved and processed',
  );
  assert.equal(readCloseReceipt(store, SESSION_B, o), null,
    'sess-B must not inherit sess-A receipt');
});

// ─────────────────────────── ORACLE 4: failure stays recoverable ──────────────

test('ID-08 [oracle 4] a failed or partial close remains owed', () => {
  for (const status of ['failed', 'partial']) {
    const store = freshStore();
    const o = opts(store);

    writeCloseReceipt(store, terminalReceipt(SESSION_A, status), o);

    assert.equal(
      shouldEnqueueClose(store, { sessionId: SESSION_A, harness: 'claude-code' }, o),
      true,
      `a '${status}' close must remain owed and recoverable, never certified closed`,
    );
  }
});

// ─────────────────── ID-09..ID-10: the wired deterministic close ─────────────

test('ID-09 runDeterministicClose writes receipt + summary and makes zero model calls', () => {
  const store = freshStore();
  const o = opts(store);

  const receipt = runDeterministicClose(store, {
    sessionId: SESSION_A,
    harness: 'claude-code',
    events: [
      { idx: 0, kind: 'text', role: 'user', text: 'wire the deterministic close' },
      { idx: 1, kind: 'tool', role: 'assistant', name: 'Edit', text: '{"file_path":"/repo/x.mjs"}' },
    ],
    startedAt: '2026-07-27T16:00:00.000Z',
    endedAt: '2026-07-27T16:10:00.000Z',
    now: '2026-07-27T16:10:01.000Z',
  }, o);

  assert.equal(receipt.model_calls, 0, 'automatic close must make ZERO model calls');
  assert.equal(receipt.status, 'closed');
  assert.equal(receipt.record.counts.mutating_tools, 1);
  assert.match(receipt.summary_sha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(receipt.summary_path), 'summary must exist on disk');
  assert.match(readFileSync(receipt.summary_path, 'utf8'), /Session close record/);

  // and it must now dedup, end to end
  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_A, harness: 'claude-code' }, o),
    false,
    'after a real deterministic close, the same session must not re-enqueue',
  );
});

test('ID-10 a partial-coverage deterministic close stays owed', () => {
  const store = freshStore();
  const o = opts(store);

  const receipt = runDeterministicClose(store, {
    sessionId: SESSION_A,
    harness: 'claude-code',
    events: [{ idx: 0, kind: 'text', role: 'user', text: 'x' }],
    coverage: 'partial',
  }, o);

  assert.equal(receipt.status, 'partial', 'partial coverage never certifies closed');
  assert.equal(
    shouldEnqueueClose(store, { sessionId: SESSION_A, harness: 'claude-code' }, o),
    true,
    'a partial close must remain owed and recoverable',
  );
});
