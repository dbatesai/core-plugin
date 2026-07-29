/**
 * close-hook-decision.test.mjs — SessionEnd decision logic (HOOK-01 … HOOK-08).
 *
 * Slice 4, RED-first.
 *
 * The hook currently receives `session_id` on the SessionEnd payload and drops
 * it: `didWork` is set from "a transcript file exists", `shouldSpawn()` answers
 * on store-level state, and the spawned command carries no session at all. That
 * is the production half of the duplicate close — the mechanism from slices 1–2
 * cannot help while the caller never names the session.
 *
 * The decision is extracted as a pure function so it can be tested without a
 * real workspace registry and without spawning anything, matching the existing
 * `buildChildEnv` precedent in this module.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { decideCloseAction } from '../../plugins/core/skills/core/hooks/close-pass-hook.mjs';
import { writeCloseReceipt } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

const SESSION_A = 'sess-hook-0192aa8c-1f4d-4a51-9d3e-11c0ffee0010';
const SESSION_B = 'sess-hook-0192aa8c-1f4d-4a51-9d3e-11c0ffee0011';

function freshStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-hook-decide-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  return store;
}
function opts() {
  return { storageRoot: mkdtempSync(join(tmpdir(), 'close-hook-storage-')) };
}

test('HOOK-01 decideCloseAction returns enqueue for an unclosed session with real identity', () => {
  const store = freshStore();
  const d = decideCloseAction({ session_id: SESSION_A, reason: 'other', cwd: store }, { store }, opts());

  assert.equal(d.action, 'enqueue');
  assert.equal(d.sessionId, SESSION_A);
});

test('HOOK-02 [the bug] decideCloseAction returns skip for a session with a closed receipt', () => {
  const store = freshStore();
  const o = opts();
  writeCloseReceipt(store, { session_id: SESSION_A, status: 'closed' }, o);

  const d = decideCloseAction({ session_id: SESSION_A, reason: 'other', cwd: store }, { store }, o);

  assert.equal(d.action, 'skip', 'a second SessionEnd for a closed session must not spawn');
  assert.match(d.reason, /already-closed|session-closed/,
    'the skip reason must name exact-session closure, not generic "nothing owed"');
});

test('HOOK-03 decideCloseAction still returns enqueue for a distinct session after another closed', () => {
  const store = freshStore();
  const o = opts();
  writeCloseReceipt(store, { session_id: SESSION_A, status: 'closed' }, o);

  const d = decideCloseAction({ session_id: SESSION_B, reason: 'other', cwd: store }, { store }, o);
  assert.equal(d.action, 'enqueue');
});

test('HOOK-04 decideCloseAction returns enqueue again after a failed prior close', () => {
  const store = freshStore();
  const o = opts();
  writeCloseReceipt(store, { session_id: SESSION_A, status: 'failed' }, o);

  const d = decideCloseAction({ session_id: SESSION_A, reason: 'other', cwd: store }, { store }, o);
  assert.equal(d.action, 'enqueue', 'a failed close must remain recoverable');
});

test('HOOK-05 decideCloseAction degrades honestly on a missing session id, never synthesizes one', () => {
  const store = freshStore();
  for (const payload of [{ reason: 'other', cwd: store }, { session_id: '', reason: 'other', cwd: store }]) {
    const d = decideCloseAction(payload, { store }, opts());
    assert.equal(d.action, 'skip', 'no identity → do not spawn a close that cannot be deduped');
    assert.match(d.reason, /identity/i, 'reason must name the missing identity');
    assert.ok(!/auto-\d/.test(JSON.stringify(d)), 'must never invent an auto-<timestamp> identity');
  }
});

test('HOOK-06 decideCloseAction does not treat transcript existence as evidence of work', () => {
  const store = freshStore();
  const o = opts();
  writeCloseReceipt(store, { session_id: SESSION_A, status: 'closed' }, o);

  // The old gate said: transcript exists → didWork → spawn. A closed receipt
  // must win over that regardless of any transcript path on the payload.
  const d = decideCloseAction(
    { session_id: SESSION_A, reason: 'other', cwd: store, transcript_path: fileURLToPath(import.meta.url) },
    { store }, o,
  );
  assert.equal(d.action, 'skip', 'a real transcript must not override a closed receipt');
});

test('HOOK-07 decideCloseAction honors skip reasons before any receipt work', () => {
  const store = freshStore();
  const d = decideCloseAction({ session_id: SESSION_A, reason: 'resume', cwd: store }, { store }, opts());
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /session-reason/);
});

test('HOOK-08 the decideCloseAction enqueue decision carries the session through to argv', () => {
  const store = freshStore();
  const d = decideCloseAction({ session_id: SESSION_A, reason: 'other', cwd: store }, { store }, opts());

  assert.ok(Array.isArray(d.args), 'decision must expose the child argv');
  assert.ok(d.args.includes('--session'), 'argv must pass --session');
  assert.ok(d.args.includes(SESSION_A), 'argv must carry the real session id');
  assert.ok(!d.args.includes('run'), 'must not invoke the legacy broad `run` subcommand');
});
