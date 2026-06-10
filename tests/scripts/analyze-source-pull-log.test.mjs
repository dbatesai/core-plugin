import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildReport, loadEvents, formatReport,
} from '../../plugins/core/skills/core/scripts/analyze-source-pull-log.mjs';

function event(overrides = {}) {
  return {
    timestamp: '2026-06-09T10:00:00.000Z',
    source: 'release-notes',
    cadence: 'weekly',
    candidates: 3,
    'mode-a': 2,
    'mode-b': 1,
    'duration-ms': 120,
    errors: [],
    ...overrides,
  };
}

test('buildReport([]) returns a zero report without throwing', () => {
  const report = buildReport([]);
  assert.equal(report.window.eventCount, 0);
  assert.deepEqual(report.perSource, []);
  assert.equal(formatReport(report), 'No source-pull events in window.');
});

test('valid event rows aggregate per-source counts', () => {
  const report = buildReport([
    event(),
    event({ timestamp: '2026-06-09T11:00:00.000Z', candidates: 5, 'duration-ms': 80 }),
    event({ source: 'changelog', candidates: 1, 'mode-a': 0, 'mode-b': 0 }),
  ]);
  assert.equal(report.window.eventCount, 3);
  assert.equal(report.perSource.length, 2);
  // Sorted by pull count descending — release-notes (2 pulls) first.
  const [rn, cl] = report.perSource;
  assert.equal(rn.source, 'release-notes');
  assert.equal(rn.pulls, 2);
  assert.equal(rn.candidates.total, 8);
  assert.equal(rn.candidates.avgPerPull, 4);
  assert.equal(rn.modes.a, 4);
  assert.equal(rn.modes.b, 2);
  assert.equal(rn.duration.avgMs, 100);
  assert.equal(cl.source, 'changelog');
  assert.equal(cl.pulls, 1);
  assert.equal(cl.candidates.total, 1);
});

test('loadEvents skips a malformed JSONL row instead of crashing', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  const wsDir = join(coreHome, 'workspaces', 'ws-test');
  mkdirSync(wsDir, { recursive: true });
  try {
    writeFileSync(join(wsDir, 'source-pull-log.jsonl'), [
      JSON.stringify(event()),
      '{ this is not valid JSON',
      JSON.stringify(event({ source: 'changelog' })),
      '',
    ].join('\n'));
    const events = loadEvents('ws-test', { coreHome, allTime: true });
    assert.equal(events.length, 2, 'bad row skipped, good rows kept');
    assert.deepEqual(events.map((e) => e.source), ['release-notes', 'changelog']);
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});
