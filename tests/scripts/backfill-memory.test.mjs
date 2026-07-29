import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { writeCloseReceipt } from '../../plugins/core/skills/core/scripts/close-pass.mjs';
import { listPendingBackfill, markBackfilled } from '../../plugins/core/skills/core/scripts/backfill-memory.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'backfill-memory.mjs');

function freshStore() {
  const store = mkdtempSync(join(tmpdir(), 'backfill-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  return store;
}

function storageRoot(store) {
  const root = join(store, '_metrics');
  mkdirSync(join(root, 'close', 'receipts'), { recursive: true });
  return root;
}

function receipt(sessionId, status, extra = {}) {
  return {
    session_id: sessionId, status, harness: 'claude-code',
    ended_at: '2026-07-28T10:00:00Z', ...extra,
  };
}

test('listPendingBackfill: recorded and partial receipts without a processed stamp are pending; closed and stamped ones are not', () => {
  const store = freshStore();
  try {
    const opts = { storageRoot: storageRoot(store) };
    writeCloseReceipt(store, receipt('s-auto', 'recorded'), opts);
    writeCloseReceipt(store, receipt('s-partial', 'partial'), opts);
    writeCloseReceipt(store, receipt('s-manual', 'closed'), opts);
    writeCloseReceipt(store, receipt('s-done', 'recorded', { memory_processed_at: '2026-07-28T11:00:00Z' }), opts);

    const r = listPendingBackfill(store, opts);
    const ids = r.pending.map((p) => p.session_id).sort();
    assert.deepEqual(ids, ['s-auto', 's-partial']);
    assert.equal(r.corrupt, 0);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('listPendingBackfill: a corrupt receipt is counted, never silently elided', () => {
  const store = freshStore();
  try {
    const root = storageRoot(store);
    const opts = { storageRoot: root };
    writeCloseReceipt(store, receipt('s-ok', 'recorded'), opts);
    writeFileSync(join(root, 'close', 'receipts', 'deadbeef.json'), '{not json', 'utf8');

    const r = listPendingBackfill(store, opts);
    assert.equal(r.pending.length, 1);
    assert.equal(r.corrupt, 1, 'corrupt receipts must surface as a count');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('markBackfilled: stamps memory_processed_at on the exact receipt and preserves every other field', () => {
  const store = freshStore();
  try {
    const opts = { storageRoot: storageRoot(store) };
    const p = writeCloseReceipt(store, receipt('s-auto', 'recorded', { tool_calls: 7 }), opts);
    const r = markBackfilled(store, 's-auto', opts);
    assert.ok(r.ok);
    const after = JSON.parse(readFileSync(p, 'utf8'));
    assert.equal(after.status, 'recorded');
    assert.equal(after.tool_calls, 7);
    assert.ok(typeof after.memory_processed_at === 'string' && after.memory_processed_at.length > 0);

    const list = listPendingBackfill(store, opts);
    assert.deepEqual(list.pending, [], 'a stamped session leaves the pending list');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('markBackfilled: a session with no receipt reports missing rather than inventing one', () => {
  const store = freshStore();
  try {
    const opts = { storageRoot: storageRoot(store) };
    const r = markBackfilled(store, 's-never-existed', opts);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('CLI: list emits JSON with pending sessions ordered newest-first and honors a validated --limit', () => {
  const store = freshStore();
  try {
    const root = storageRoot(store);
    const opts = { storageRoot: root };
    writeCloseReceipt(store, receipt('s-old', 'recorded', { ended_at: '2026-07-20T10:00:00Z' }), opts);
    writeCloseReceipt(store, receipt('s-new', 'recorded', { ended_at: '2026-07-28T10:00:00Z' }), opts);

    const r = spawnSync(process.execPath, [SCRIPT, 'list', store, '--json', '--limit', '1', '--storage-root', root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pending.length, 1);
    assert.equal(out.pending[0].session_id, 's-new', 'newest session comes first under a limit');
    assert.equal(out.total_pending, 2, 'the total is reported even when the list is limited');

    const bad = spawnSync(process.execPath, [SCRIPT, 'list', store, '--limit', '-3', '--storage-root', root], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0, 'a non-positive limit is rejected at the boundary');
  } finally { rmSync(store, { recursive: true, force: true }); }
});
