import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildReport, loadEvents, formatReport, workspaceExists, resolveLogPath,
} from '../../plugins/core/skills/core/scripts/analyze-source-pull-log.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/analyze-source-pull-log.mjs', import.meta.url));

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

// ---- coverage additions (2026-07-20, iteration ~72): formatReport's body was
// entirely untested past the empty-report line, and the whole CLI surface
// (_parseArgs, _printHelp, main) had zero tests. Real gaps on exported/
// user-facing behavior, not speculative padding. ----

test('workspaceExists / resolveLogPath reflect real filesystem state', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  try {
    assert.equal(workspaceExists('nope', { coreHome }), false);
    mkdirSync(join(coreHome, 'workspaces', 'ws-real'), { recursive: true });
    assert.equal(workspaceExists('ws-real', { coreHome }), true);
    assert.equal(
      resolveLogPath('ws-real', { coreHome }),
      join(coreHome, 'workspaces', 'ws-real', 'source-pull-log.jsonl'),
    );
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});

test('formatReport renders cadence, mode percentages, error, and duration lines', () => {
  const report = buildReport([
    event(),
    event({ timestamp: '2026-06-09T11:00:00.000Z', 'mode-c': 1, errors: ['timeout fetching feed'] }),
  ]);
  const text = formatReport(report);
  assert.match(text, /■ release-notes \(weekly\)/, 'source + cadence line');
  assert.match(text, /pulls: 2 \| candidates: 6/, 'pulls/candidates line');
  assert.match(text, /modes: A \d+(\.\d)?% \/ B \d+(\.\d)?% \/ C \d+(\.\d)?% \(\d+ obs\)/, 'mode percentage line');
  assert.match(text, /errors: 1 \(latest @ .+: timeout fetching feed\)/, 'error line with truncated message');
  assert.match(text, /duration: avg \d+ms \/ p50 \d+ms \/ p95 \d+ms/, 'duration line');
  assert.match(text, /last seen: /, 'last-seen line');
});

test('formatReport omits mode/error/duration lines when a source carries none of that data', () => {
  const report = buildReport([event({ 'mode-a': undefined, 'mode-b': undefined, 'duration-ms': undefined, errors: [] })]);
  const text = formatReport(report);
  assert.ok(!text.includes('modes:'), 'no mode line when nothing was moded');
  assert.ok(!text.includes('errors:'), 'no error line when zero errors');
  assert.ok(!text.includes('duration:'), 'no duration line when zero durations');
});

test('formatReport with includeHeader:false omits the header and empty-report text', () => {
  assert.equal(formatReport(buildReport([]), { includeHeader: false }), '');
  const text = formatReport(buildReport([event()]), { includeHeader: false });
  assert.ok(!text.startsWith('source-pull-log analysis'), 'header suppressed');
  assert.match(text, /■ release-notes/, 'source lines still present');
});

test('CLI: --help (or no --workspace) prints usage and exits 1 without a workspace', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 1, 'bare --help still exits 1 — args.workspaceId is null');
  assert.match(res.stdout, /Usage: node analyze-source-pull-log\.mjs/);

  const res2 = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(res2.status, 1, 'missing --workspace exits 1');
  assert.match(res2.stdout, /Usage:/);
});

test('CLI: --help with --workspace exits 0 (help takes priority over running the report)', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--workspace', 'anything', '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

test('CLI: unknown workspace exits 1 with an error on stderr', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--workspace', 'ghost'], {
      encoding: 'utf8', env: { ...process.env, HOME: coreHome, USERPROFILE: coreHome },
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Workspace not found: ghost/);
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});

test('CLI: real workspace with no log prints the empty-report text and exits 0', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  try {
    mkdirSync(join(coreHome, '.core', 'workspaces', 'ws-empty'), { recursive: true });
    const res = spawnSync(process.execPath, [SCRIPT, '--workspace', 'ws-empty'], {
      encoding: 'utf8', env: { ...process.env, HOME: coreHome, USERPROFILE: coreHome },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /No source-pull events in window\./);
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});

test('CLI: --json emits a parseable report; formatted mode emits the ■ text form', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  try {
    const wsDir = join(coreHome, '.core', 'workspaces', 'ws-json');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'source-pull-log.jsonl'), JSON.stringify(event()) + '\n');
    const env = { ...process.env, HOME: coreHome, USERPROFILE: coreHome };

    const jsonRes = spawnSync(process.execPath, [SCRIPT, '--workspace', 'ws-json', '--all', '--json'], { encoding: 'utf8', env });
    assert.equal(jsonRes.status, 0);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.window.eventCount, 1);
    assert.equal(parsed.perSource[0].source, 'release-notes');

    const textRes = spawnSync(process.execPath, [SCRIPT, '--workspace', 'ws-json', '--all'], { encoding: 'utf8', env });
    assert.equal(textRes.status, 0);
    assert.match(textRes.stdout, /■ release-notes/);
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});

test('CLI: --source filters, and a malformed --since-days falls back to the default window rather than NaN', () => {
  const coreHome = mkdtempSync(join(tmpdir(), 'source-pull-'));
  try {
    const wsDir = join(coreHome, '.core', 'workspaces', 'ws-filter');
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, 'source-pull-log.jsonl'), [
      JSON.stringify(event()),
      JSON.stringify(event({ source: 'changelog' })),
    ].join('\n'));
    const env = { ...process.env, HOME: coreHome, USERPROFILE: coreHome };

    const res = spawnSync(process.execPath, [
      SCRIPT, '--workspace', 'ws-filter', '--source', 'changelog', '--since-days', 'abc', '--today', '2026-06-10', '--json',
    ], { encoding: 'utf8', env });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.perSource.length, 1, 'only the filtered source appears');
    assert.equal(parsed.perSource[0].source, 'changelog');
  } finally { rmSync(coreHome, { recursive: true, force: true }); }
});
