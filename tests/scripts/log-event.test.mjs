import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  logEvent, eventLogPath, todayUTC,
} from '../../plugins/core/skills/core/scripts/log-event.mjs';

const TODAY = '2026-06-09';

test('logEvent appends a JSONL record with a ts field under _sessions/<today>/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-event-'));
  try {
    logEvent(dir, 'hygiene-log.jsonl', { kind: 'test-event', detail: 42 }, { today: TODAY, sessionId: 'test-session' });
    const logPath = eventLogPath(dir, 'hygiene-log.jsonl', { today: TODAY });
    assert.equal(logPath, join(dir, '_sessions', TODAY, 'hygiene-log.jsonl'));
    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.ok(record.ts, 'record carries a ts field');
    assert.equal(record.kind, 'test-event');
    assert.equal(record.detail, 42);

    // A second emit appends, never clobbers.
    logEvent(dir, 'hygiene-log.jsonl', { kind: 'second' }, { today: TODAY, sessionId: 'test-session' });
    const after = readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(after.length, 2);
    assert.equal(JSON.parse(after[1]).kind, 'second');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a nonexistent projectDir is a silent no-op — returns, never throws', () => {
  const ghost = join(tmpdir(), 'log-event-ghost-dir-that-does-not-exist');
  assert.doesNotThrow(() => {
    logEvent(ghost, 'hygiene-log.jsonl', { kind: 'dropped' }, { today: TODAY, sessionId: 'test-session' });
  });
});

test('todayUTC returns a YYYY-MM-DD date string', () => {
  const d = todayUTC();
  assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!isNaN(new Date(d).getTime()), 'parses as a real date');
});
