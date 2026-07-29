import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRollup, writeRollup, readOrientSignal } from '../../plugins/core/skills/core/scripts/metrics-rollup.mjs';
import { metricsEnabled } from '../../plugins/core/skills/core/scripts/log-event.mjs';

test('M5: a calibrated workspace with no turns must not mislabel the signal PROVISIONAL', () => {
  withClassified({}, ({ home, project }) => {
    const metaDir = join(home, '.core', 'workspaces', WID, 'metrics');
    writeFileSync(join(metaDir, 'calibration-state.json'),
      JSON.stringify({ is_calibrated: true, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION, classified_schema_version: CLASSIFIED_SCHEMA_VERSION }));
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.calibrated, true, 'calibration state read as calibrated');
    assert.doesNotMatch(r.signal, /PROVISIONAL/, 'the no-turns signal must not claim provisional once calibrated');
  });
});

const WID = 'ws-rollup';

function withClassified(byDate, fn) {
  const home = mkdtempSync(join(tmpdir(), 'rollup-home-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-proj-'));
  const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
  mkdirSync(dir, { recursive: true });
  for (const [date, states] of Object.entries(byDate)) {
    // Rows carry the CURRENT instrument stamps: the cohort gate
    // aggregates only rows produced by the running
    // (schema, classifier, proxy) triple — exactly what classify-turns writes.
    const lines = states.map((state, i) => JSON.stringify({
      schema_version: CLASSIFIED_SCHEMA_VERSION, classifier_version: CLASSIFIER_VERSION,
      proxy_version: PROXY_VERSION, state, provisional: true, turn_idx: i,
    }));
    writeFileSync(join(dir, `${date}.jsonl`), lines.join('\n') + '\n');
  }
  try { return fn({ home, project }); }
  finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
}

test('buildRollup computes the headline rec-fail-tier-0 rate for today', () => {
  withClassified({
    '2026-06-02': ['tier-0-win', 'tier-0-win', 'rec-fail-tier-0', 'tier-1-3-win'],
  }, ({ home, project }) => {
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.headline.n, 1);
    assert.equal(r.headline.total, 4);
    assert.equal(r.distribution['tier-0-win'], 2);
    assert.match(r.signal, /rec-fail-tier-0: 1\/4 turns today \(25%\)/);
    assert.match(r.signal, /PROVISIONAL/);
  });
});

test('buildRollup marks an upward trend vs the trailing 7-day average', () => {
  withClassified({
    // prior day: 0% rec-fail; today: 50% → up arrow
    '2026-06-01': ['tier-0-win', 'tier-0-win'],
    '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'],
  }, ({ home, project }) => {
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.match(r.signal, /↑/, 'rising rec-fail rate gets the up marker');
  });
});

test('buildRollup handles an empty day without inventing a distribution', () => {
  withClassified({}, ({ home, project }) => {
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.headline, null);
    assert.match(r.signal, /no classified turns/);
  });
});

test('writeRollup writes the daily md + the orient-signal.txt that readOrientSignal reads', () => {
  withClassified({
    '2026-06-02': ['rec-fail-tier-0', 'tier-0-win', 'tier-0-win'],
  }, ({ home, project }) => {
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }));
    const daily = join(r.metaDir, 'rollups', 'daily', '2026-06-02.md');
    assert.ok(existsSync(daily), 'daily rollup md written');
    assert.match(readFileSync(daily, 'utf8'), /PROVISIONAL/);
    const signal = readOrientSignal(project, { home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.match(signal, /rec-fail-tier-0/);
    assert.match(signal, /PROVISIONAL/);
  });
});

test('readOrientSignal returns null when no signal has been written', () => {
  withClassified({}, ({ home, project }) => {
    assert.equal(readOrientSignal(project, { home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }), null);
  });
});

// ---- Calibration gate (Phase 3): PROVISIONAL clears only when calibrated AND version-matched ----

import { CLASSIFIER_VERSION, PROXY_VERSION, CLASSIFIED_SCHEMA_VERSION } from '../../plugins/core/skills/core/scripts/classify-turns.mjs';

function writeCalState(home, state) {
  const dir = join(home, '.core', 'workspaces', WID, 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'calibration-state.json'), JSON.stringify(state) + '\n');
}

test('rollup drops PROVISIONAL when calibration is cleared at the current classifier version', () => {
  withClassified({ '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'] }, ({ home, project }) => {
    writeCalState(home, { is_calibrated: true, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION, classified_schema_version: CLASSIFIED_SCHEMA_VERSION, overall_precision: 0.82 });
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.calibrated, true);
    assert.doesNotMatch(r.signal, /PROVISIONAL/, 'calibrated signal drops the tag');
  });
});

test('rollup keeps PROVISIONAL when calibration was run against a stale classifier version', () => {
  withClassified({ '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'] }, ({ home, project }) => {
    writeCalState(home, { is_calibrated: true, classifier_version: '0.0.1-old', overall_precision: 0.99 });
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.calibrated, false, 'version mismatch ⇒ treat as uncalibrated');
    assert.match(r.signal, /PROVISIONAL/, 'stale-version calibration cannot clear the tag');
  });
});

test('rollup keeps PROVISIONAL when calibration was run against a stale proxy version', () => {
  withClassified({ '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'] }, ({ home, project }) => {
    writeCalState(home, { is_calibrated: true, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION - 1 });
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.calibrated, false);
    assert.match(r.signal, /PROVISIONAL/);
  });
});

test('ACCEPTANCE (exact-triple calibration): a calibration bound to a DIFFERENT classified-row schema cannot clear PROVISIONAL', () => {
  // The falsifier: calibration validated only classifier/proxy, so a record
  // taken against a different classified-row schema (here 9.9.9) still cleared
  // the tag for the current 1.0.0 cohort. The distinct classified_schema_version
  // leg now binds calibration to the exact instrument triple.
  withClassified({ '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'] }, ({ home, project }) => {
    writeCalState(home, {
      is_calibrated: true, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION,
      classified_schema_version: '9.9.9', overall_precision: 0.99,
    });
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.equal(r.calibrated, false, 'classified-schema mismatch ⇒ treat as uncalibrated');
    assert.match(r.signal, /PROVISIONAL/, 'a calibration against a different row schema cannot clear the tag');
  });
});

// ---- Capture gate (spec §18, DC-107): default-on; opt-out per workspace/env ----

test('metricsEnabled is ON by default (DC-107: instrument by default, capture stays local)', () => {
  assert.equal(metricsEnabled({ project: '/no/such/project', env: {} }), true);
});

test('metricsEnabled honors explicit env opt-out, and env wins over a workspace flag', () => {
  assert.equal(metricsEnabled({ env: { CORE_METRICS_ENABLED: 'true' } }), true);
  assert.equal(metricsEnabled({ env: { CORE_METRICS_ENABLED: '1' } }), true);
  assert.equal(metricsEnabled({ env: { CORE_METRICS_ENABLED: '0' } }), false);
  assert.equal(metricsEnabled({ env: { CORE_METRICS_ENABLED: 'off' } }), false);
});

test('metricsEnabled opt-in via workspace.json metrics_enabled flag', () => {
  const project = mkdtempSync(join(tmpdir(), 'mw-'));
  try {
    writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'w', metrics_enabled: true }));
    assert.equal(metricsEnabled({ project, env: {} }), true);
    // explicit env-off overrides the workspace flag
    assert.equal(metricsEnabled({ project, env: { CORE_METRICS_ENABLED: 'false' } }), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('a disabled workspace produces no rollup artifacts', () => {
  withClassified({ '2026-06-02': ['rec-fail-tier-0', 'tier-0-win'] }, ({ home, project }) => {
    // DC-107: default is now ON, so opt out explicitly to exercise the disabled path.
    const env = { CORE_METRICS_ENABLED: '0' };
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env }));
    assert.equal(r.disabled, true);
    assert.equal(readOrientSignal(project, { home, workspaceId: WID }), null, 'no signal written when opted out');
  });
});

test('MET-013: detector output (anticipation-gap) can never reach the headline signal', () => {
  const home = mkdtempSync(join(tmpdir(), 'mr-det-'));
  const project = mkdtempSync(join(tmpdir(), 'mr-proj-'));
  try {
    const wid = 'mr-det-ws';
    const detDir = join(home, '.core', 'workspaces', wid, 'metrics', 'detectors');
    mkdirSync(detDir, { recursive: true });
    writeFileSync(join(detDir, '2026-06-09.jsonl'),
      JSON.stringify({ detector: 'anticipation-gap', provisional: true, severity: 'low', terms: ['x'] }) + '\n');
    const r = buildRollup({ project, today: '2026-06-09', home, workspaceId: wid });
    assert.match(r.signal, /no classified turns/, 'rollup reads classified/ only — heuristics never grade the headline');
    assert.deepEqual(r.distribution, {});
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ============================================================
// Read-side replay dedupe (metrics-dedupe.mjs wiring) — the replay-identity
// falsifier: reprocessing the same
// (harness, session, turn, producer version) leaves totals unchanged)
// ============================================================

const ident = (over = {}) => ({
  schema_version: '1.0.0', classifier_version: '0.3.0', proxy_version: 2,
  harness: 'claude-code', provisional: true, session_id: 'sess-replay', ...over,
});

test('replay dedupe: a session processed twice in one day yields the same rollup as once', () => {
  const home = mkdtempSync(join(tmpdir(), 'rollup-replay-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-replay-proj-'));
  try {
    const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
    mkdirSync(dir, { recursive: true });
    const once = [
      ident({ turn_idx: 0, state: 'rec-fail-tier-0' }),
      ident({ turn_idx: 1, state: 'tier-0-win' }),
      ident({ turn_idx: 2, state: 'tier-0-win' }),
      ident({ turn_idx: 3, state: 'tier-1-3-win' }),
    ];
    const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    writeFileSync(join(dir, '2026-06-02.jsonl'), lines(once));
    const clean = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    writeFileSync(join(dir, '2026-06-02.jsonl'), lines([...once, ...once])); // replay: same session appended again
    const replayed = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    assert.deepEqual(replayed.distribution, clean.distribution, 'state distribution stable under replay');
    assert.deepEqual(replayed.headline, clean.headline, 'headline rate stable under replay');
    assert.equal(replayed.dedupe.replays_dropped, 4);
    assert.match(replayed.signal, /replay-dedupe: 8→4 store-wide/, 'dedupe surfaced in the one-line signal');
    assert.match(replayed.signal, /rec-fail-tier-0: 1\/4 turns today \(25%\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('ACCEPTANCE (rollup): a same-instrument contradiction is EXCLUDED from the numerator AND denominator, visibly counted', () => {
  const home = mkdtempSync(join(tmpdir(), 'rollup-conflict-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-conflict-proj-'));
  try {
    const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-06-02.jsonl'), [
      // turn 0: an old-instrument row (0.2.0) → out of cohort, coverage gap.
      JSON.stringify(ident({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' })),
      // turn 0 (current instrument): the aggregateable row.
      JSON.stringify(ident({ turn_idx: 0, state: 'rec-fail-tier-0' })),
      // turn 1: same instrument, contradictory states → conflict, excluded entirely.
      JSON.stringify(ident({ turn_idx: 1, state: 'tier-1-3-win' })),
      JSON.stringify(ident({ turn_idx: 1, state: 'rec-fail-tier-0' })),
    ].join('\n') + '\n');
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }));
    assert.equal(r.headline.total, 1, 'only the one non-conflicting current-cohort turn is in the denominator');
    assert.deepEqual(r.distribution, { 'rec-fail-tier-0': 1 }, 'the conflicting turn is not in the distribution');
    assert.equal(r.dedupe.superseded_dropped, 0, 'no cross-instrument supersession');
    assert.equal(r.dedupe.conflicts, 1, 'the contradiction is counted');
    assert.equal(r.coverage_gap.rows_excluded, 1, 'the 0.2.0 row is a coverage gap');
    assert.match(r.signal, /1 conflict/, 'conflict visible in the signal');
    const md = readFileSync(join(r.metaDir, 'rollups', 'daily', '2026-06-02.md'), 'utf8');
    assert.match(md, /1 conflict excluded/, 'daily md reports the conflict as excluded');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// ============================================================
// Instrument-cohort gate: calibration is
// validated against the CURRENT (schema, classifier, proxy) triple, so the
// aggregate may contain ONLY rows produced by that triple. An old-instrument
// row with no newer counterpart survives dedupe — it must land in the
// coverage gap, never in the numbers.
// ============================================================

test("mixed-instrument falsifier: calibrated-true must not aggregate a 0.2.0-era survivor", () => {
  const home = mkdtempSync(join(tmpdir(), 'rollup-cohort-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-cohort-proj-'));
  try {
    const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-06-02.jsonl'), [
      // 0.2.0-only row: different turn, NO newer counterpart — survives dedupe.
      JSON.stringify(ident({ turn_idx: 0, classifier_version: '0.2.0', state: 'tier-0-win' })),
      // Current-instrument row.
      JSON.stringify(ident({ turn_idx: 1, state: 'rec-fail-tier-0' })),
    ].join('\n') + '\n');
    writeCalState(home, { is_calibrated: true, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION, classified_schema_version: CLASSIFIED_SCHEMA_VERSION, overall_precision: 0.82 });
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }));
    assert.equal(r.calibrated, true, 'calibration itself reads true at the current version');
    assert.equal(r.headline.total, 1, 'ONLY the current-cohort row aggregates — never both instruments');
    assert.deepEqual(r.distribution, { 'rec-fail-tier-0': 1 }, 'the 0.2.0 judgment is not in the distribution');
    assert.deepEqual(r.cohort, { schema_version: CLASSIFIED_SCHEMA_VERSION, classifier_version: CLASSIFIER_VERSION, proxy_version: PROXY_VERSION });
    assert.equal(r.coverage_gap.rows_excluded, 1, 'the old-instrument survivor is an explicit gap');
    assert.deepEqual(r.coverage_gap.versions, { 'schema=1.0.0 classifier=0.2.0 proxy=2': 1 });
    assert.match(r.signal, /instrument cohort .*1 row outside cohort EXCLUDED/, 'gap visible in the one-line signal');
    const md = readFileSync(join(r.metaDir, 'rollups', 'daily', '2026-06-02.md'), 'utf8');
    assert.match(md, /Instrument cohort 1\.0\.0\/0\.3\.0\/p2: 1 row outside cohort EXCLUDED from aggregates \(1× schema=1\.0\.0 classifier=0\.2\.0 proxy=2\)/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('cohort gate: a fully current-instrument store reports a zero gap, honestly', () => {
  withClassified({ '2026-06-02': ['tier-0-win', 'rec-fail-tier-0'] }, ({ home, project }) => {
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }));
    assert.equal(r.coverage_gap.rows_excluded, 0);
    assert.doesNotMatch(r.signal, /outside cohort/, 'no gap tag when there is no gap');
    const md = readFileSync(join(r.metaDir, 'rollups', 'daily', '2026-06-02.md'), 'utf8');
    assert.match(md, /Instrument cohort 1\.0\.0\/0\.3\.0\/p2: all in-cohort rows aggregated/);
  });
});

test('cross-date attribution policy (immutable observation day) is explicit in the JSON and the daily markdown', () => {
  withClassified({ '2026-06-02': ['tier-0-win'] }, ({ home, project }) => {
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } }));
    assert.equal(r.day_attribution, 'observation-day');
    assert.match(r.day_attribution_note, /earliest\/original observation day/);
    assert.match(r.day_attribution_note, /turns today.*user turns first observed that day/);
    const md = readFileSync(join(r.metaDir, 'rollups', 'daily', '2026-06-02.md'), 'utf8');
    assert.match(md, /Day attribution: replayed sessions keep their earliest\/original observation day/);
  });
});

test('ACCEPTANCE (order-independence): a same-day contradiction is excluded under BOTH input orders, conflict counted either way', () => {
  // Reversing the two contradictory rows must not flip the aggregate. The
  // corrected policy invents no winner at all — the group is excluded and
  // counted as a conflict regardless of order.
  const states = [
    [ident({ turn_idx: 0, state: 'tier-1-3-win' }), ident({ turn_idx: 0, state: 'rec-fail-tier-0' })],
    [ident({ turn_idx: 0, state: 'rec-fail-tier-0' }), ident({ turn_idx: 0, state: 'tier-1-3-win' })],
  ];
  const results = states.map((rows) => {
    const home = mkdtempSync(join(tmpdir(), 'rollup-order-'));
    const project = mkdtempSync(join(tmpdir(), 'rollup-order-proj-'));
    try {
      const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '2026-06-02.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      return buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
  assert.deepEqual(results[0].distribution, results[1].distribution, 'aggregate independent of input order');
  assert.deepEqual(results[0].distribution, {}, 'the contradiction is excluded, not resolved to a state');
  assert.equal(results[0].headline, null, 'no aggregateable turn today');
  assert.equal(results[0].dedupe.conflicts, 1);
  assert.equal(results[1].dedupe.conflicts, 1, 'the conflict stays visible under both orders');
});

test('ACCEPTANCE (rollup): a cross-date replay attributes to the EARLIEST observation day; today counts only turns first observed today', () => {
  const home = mkdtempSync(join(tmpdir(), 'rollup-xdate-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-xdate-proj-'));
  try {
    const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
    mkdirSync(dir, { recursive: true });
    const sess = [ident({ turn_idx: 0, state: 'tier-0-win' }), ident({ turn_idx: 1, state: 'tier-0-win' })];
    const lines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    // Session first observed 06-01, replayed identically at a catch-up on 06-02;
    // a fresh session (different id) also ran on 06-02.
    writeFileSync(join(dir, '2026-06-01.jsonl'), lines(sess));
    writeFileSync(join(dir, '2026-06-02.jsonl'),
      lines([...sess, ident({ session_id: 'sess-fresh', turn_idx: 0, state: 'rec-fail-tier-0' })]));
    const r = buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: { CORE_METRICS_ENABLED: '1' } });
    // The replayed turns stay on their earliest day (06-01); today (06-02) counts
    // ONLY the turn first observed today.
    assert.equal(r.headline.total, 1, 'today = the 1 fresh turn only; replayed turns stay on 06-01');
    assert.equal(r.dedupe.replays_dropped, 2);
    assert.equal(r.dedupe.rows_kept, 3, 'store-wide: 2 turns under 06-01 + 1 under 06-02');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
