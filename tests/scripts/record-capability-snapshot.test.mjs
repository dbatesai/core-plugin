import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveSessionId, recordSnapshot,
} from '../../plugins/core/skills/core/scripts/record-capability-snapshot.mjs';

test('resolveSessionId honors an explicit id over everything else', () => {
  const sid = resolveSessionId({ sessionId: 'explicit-id', env: { CLAUDE_CODE_SESSION_ID: 'env-id' } });
  assert.equal(sid, 'explicit-id');
});

test('resolveSessionId honors the harness env vars in order', () => {
  assert.equal(resolveSessionId({ env: { CLAUDE_CODE_SESSION_ID: 'cc-id', CODEX_THREAD_ID: 'cx-id' } }), 'cc-id');
  assert.equal(resolveSessionId({ env: { CODEX_THREAD_ID: 'cx-id' } }), 'cx-id');
});

// Characterization: with no harness env the fallback is NOT a fixed sentinel — it is a
// per-invocation `session-<base36 ts>-<hex>` id, distinct across calls, so per-session
// history buckets never collapse (HC_614 blocker 1).
test('resolveSessionId with an empty env generates a distinct per-invocation fallback', () => {
  const a = resolveSessionId({ env: {} });
  const b = resolveSessionId({ env: {} });
  assert.match(a, /^session-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.match(b, /^session-[a-z0-9]+-[0-9a-f]{6}$/);
  assert.notEqual(a, b, 'fallback ids are distinct across invocations');
});

test('recordSnapshot appends to the workspace history rather than clobbering it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rcs-home-'));
  try {
    // Pass an explicit harness — recordSnapshot detects it from env at real startup,
    // but CI has no harness env signal, so an ambient-detected 'unknown' harness yields
    // zero probe rows. The test verifies append behavior, not harness detection.
    const r1 = await recordSnapshot({ workspaceId: 'ws-test', harness: 'claude-code', home, sessionId: 's-one' });
    assert.equal(r1.workspace_id, 'ws-test');
    assert.equal(r1.session_id, 's-one');
    assert.equal(r1.storage, 'home');
    assert.ok(r1.appended > 0, 'startup probes produced rows');
    assert.ok(existsSync(r1.path), 'history file created under the temp home');
    assert.ok(r1.path.startsWith(home), 'writes stay inside the temp home');
    const lines1 = readFileSync(r1.path, 'utf8').trim().split('\n');
    assert.equal(lines1.length, r1.appended);

    const r2 = await recordSnapshot({ workspaceId: 'ws-test', harness: 'claude-code', home, sessionId: 's-two' });
    const lines2 = readFileSync(r2.path, 'utf8').trim().split('\n');
    assert.equal(r2.path, r1.path, 'same history file');
    assert.equal(lines2.length, r1.appended + r2.appended, 'second snapshot appended');
    assert.deepEqual(lines2.slice(0, lines1.length), lines1, 'first snapshot rows untouched');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a snapshot over an unprobed harness is reported incomplete, not as a clean snapshot', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rcs-unknown-'));
  try {
    const r = await recordSnapshot({ workspaceId: 'ws-unknown', harness: 'no-such-harness', home, sessionId: 's-1' });
    assert.equal(r.complete, false, 'an unprobed capability set is not a complete snapshot');
    assert.equal(r.summary.unknown, 1, 'the gap is recorded as an UNKNOWN row');
    assert.equal(r.appended, 1, 'the UNKNOWN row is persisted so history carries the gap');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a snapshot over a probed harness is reported complete', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rcs-complete-'));
  try {
    const r = await recordSnapshot({ workspaceId: 'ws-ok', harness: 'claude-code', home, sessionId: 's-1' });
    assert.equal(r.complete, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
