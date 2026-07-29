import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  upsertCanaryLine, generateToken, CANARY_TAG, writeCanary, consumeCanary, canaryLockPath,
} from '../../plugins/core/skills/core/scripts/write-visibility-canary.mjs';
import { acquireFileLock, releaseFileLock } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const MEMORY = [
  '## Recent activity',
  '',
  '- a memory line',
  '',
].join('\n');

function canaryLines(content) {
  return content.split('\n').filter((l) => l.startsWith(CANARY_TAG));
}

test('upsertCanaryLine inserts the canary at the top of content that lacks it', () => {
  const token = 'vcan-0123456789abcdef';
  const out = upsertCanaryLine(MEMORY, token);
  assert.ok(out.startsWith(`${CANARY_TAG} ${token}`), 'canary is the first line');
  assert.match(out, new RegExp(`VISIBILITY-CANARY-ECHO: ${token}`), 'echo instruction included');
  assert.ok(out.includes('- a memory line'), 'existing content preserved');
  assert.equal(canaryLines(out).length, 1);
});

test('a second upsert replaces the existing token rather than duplicating the line', () => {
  const first = upsertCanaryLine(MEMORY, 'vcan-aaaaaaaaaaaaaaaa');
  const second = upsertCanaryLine(first, 'vcan-bbbbbbbbbbbbbbbb');
  assert.equal(canaryLines(second).length, 1, 'never accumulates canary lines');
  assert.ok(second.includes('vcan-bbbbbbbbbbbbbbbb'));
  assert.ok(!second.includes('vcan-aaaaaaaaaaaaaaaa'), 'old token gone');
  assert.ok(second.includes('- a memory line'), 'memory content survives');
});

test('the legacy HTML-comment canary form is also replaced on upsert', () => {
  const legacy = `<!-- ${CANARY_TAG} vcan-oldoldoldoldold1 -->\n\n${MEMORY}`;
  const out = upsertCanaryLine(legacy, 'vcan-cccccccccccccccc');
  assert.ok(!out.includes('vcan-oldoldoldoldold1'), 'legacy comment line stripped');
  assert.equal(canaryLines(out).length, 1);
});

test('generateToken returns vcan-<hex> and differs across calls', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^vcan-[0-9a-f]{16}$/);
  assert.match(b, /^vcan-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
});

// --- The canary token is session-bound, single-use, and owner-only ---

function ws() {
  const home = mkdtempSync(join(tmpdir(), 'canary-'));
  const cwd = join(home, 'proj');
  mkdirSync(cwd, { recursive: true });
  const memPath = join(home, 'MEMORY.md');
  writeFileSync(memPath, MEMORY);
  return { home, cwd, memPath };
}

test('the recorded canary names the session that wrote it and starts unconsumed', () => {
  const { home, cwd, memPath } = ws();
  try {
    const r = writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath, sessionId: 's-writer' });
    const side = JSON.parse(readFileSync(r.side_file, 'utf8'));
    assert.equal(side.written_by_session, 's-writer');
    assert.equal(side.consumed_at, null);
    assert.equal(side.consumed_by_session, null);
    assert.ok(side.token, 'the expected token is recorded');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the canary side file is owner-only', { skip: process.platform === 'win32' ? 'POSIX mode bits are not enforceable on Windows' : false }, () => {
  const { home, cwd, memPath } = ws();
  try {
    const r = writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath });
    assert.equal(statSync(r.side_file).mode & 0o777, 0o600, 'evidence is not world-readable');
    assert.equal(statSync(dirname(r.side_file)).mode & 0o777, 0o700);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the MEMORY.md read-compute-write runs under the canary lock', () => {
  const { home, cwd, memPath } = ws();
  try {
    const lock = acquireFileLock(canaryLockPath('w1', home));
    assert.equal(lock.ok, true);
    assert.throws(() => writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath, lockOpts: { retries: 0, retryDelayMs: 1 } }),
      /lock held/i, 'a concurrent writer must not read-modify-write MEMORY.md unserialized');
    releaseFileLock(canaryLockPath('w1', home), lock.nonce);
    assert.doesNotThrow(() => writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath }));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('consumeCanary records the consuming session once; a replay is not credited again', () => {
  const { home, cwd, memPath } = ws();
  try {
    const r = writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath, sessionId: 's-writer' });
    const first = consumeCanary('w1', { home, sessionId: 's-reader', now: '2026-07-28T00:00:00.000Z' });
    assert.equal(first.consumed, true);
    const side = JSON.parse(readFileSync(r.side_file, 'utf8'));
    assert.equal(side.consumed_by_session, 's-reader');
    assert.equal(side.consumed_at, '2026-07-28T00:00:00.000Z');
    const replay = consumeCanary('w1', { home, sessionId: 's-attacker', now: '2026-07-28T01:00:00.000Z' });
    assert.equal(replay.consumed, false, 'a token already spent cannot be spent again');
    assert.equal(replay.reason, 'already-consumed');
    assert.equal(JSON.parse(readFileSync(r.side_file, 'utf8')).consumed_by_session, 's-reader',
      'the original consumer is not overwritten');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the same session re-running the probe is not treated as a replay', () => {
  const { home, cwd, memPath } = ws();
  try {
    writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath, sessionId: 's-writer' });
    assert.equal(consumeCanary('w1', { home, sessionId: 's-reader' }).consumed, true);
    assert.equal(consumeCanary('w1', { home, sessionId: 's-reader' }).consumed, true, 'idempotent within one session');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
