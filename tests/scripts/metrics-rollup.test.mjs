import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRollup, writeRollup, readOrientSignal } from '../../plugins/core/skills/core/scripts/metrics-rollup.mjs';
import { metricsEnabled } from '../../plugins/core/skills/core/scripts/log-event.mjs';

const WID = 'ws-rollup';

function withClassified(byDate, fn) {
  const home = mkdtempSync(join(tmpdir(), 'rollup-home-'));
  const project = mkdtempSync(join(tmpdir(), 'rollup-proj-'));
  const dir = join(home, '.core', 'workspaces', WID, 'metrics', 'classified');
  mkdirSync(dir, { recursive: true });
  for (const [date, states] of Object.entries(byDate)) {
    const lines = states.map((state, i) => JSON.stringify({ state, provisional: true, turn_idx: i }));
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

// ---- Privacy gate (spec §18): default-off; opt-in per workspace ----

test('metricsEnabled is OFF by default (privacy-safe for plugin distribution)', () => {
  assert.equal(metricsEnabled({ project: '/no/such/project', env: {} }), false);
});

test('metricsEnabled opt-in via env, and explicit off wins over a workspace flag', () => {
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
    // no opt-in (env {} and no workspace flag) → disabled
    const r = writeRollup(buildRollup({ project, today: '2026-06-02', home, workspaceId: WID, env: {} }));
    assert.equal(r.disabled, true);
    assert.equal(readOrientSignal(project, { home, workspaceId: WID }), null, 'no signal written when disabled');
  });
});
