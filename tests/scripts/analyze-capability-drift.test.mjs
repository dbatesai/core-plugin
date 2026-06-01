import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupByCapability, detectDrift, detectRegression, attributeDrift, renderDriftLog, loadCapabilityHistory,
  removeLegacyDriftLog,
} from '../../plugins/core/skills/core/scripts/analyze-capability-drift.mjs';
import { appendRows } from '../../plugins/core/skills/core/scripts/capability-history.mjs';

// History entry shape: { observed_at, session_id, row_content_hash, row: { capability_id, identity_status, evidence } }
function entry(capId, status, observedAt, session, evidence = []) {
  return {
    observed_at: observedAt, session_id: session, row_content_hash: 'h',
    row: { capability_id: capId, identity_status: status, evidence },
  };
}

// --- groupByCapability ---

test('groupByCapability: groups and sorts by observed_at', () => {
  const history = [
    entry('a', 'PASS', '2026-01-02', 's2'),
    entry('a', 'PASS', '2026-01-01', 's1'),
    entry('b', 'PASS', '2026-01-01', 's1'),
  ];
  const grouped = groupByCapability(history);
  assert.equal(grouped.get('a').length, 2);
  assert.equal(grouped.get('a')[0].observed_at, '2026-01-01', 'sorted ascending');
  assert.equal(grouped.get('b').length, 1);
});

// --- detectDrift ---

test('detectDrift: PASS→DEGRADED is degrading drift', () => {
  const history = [
    entry('plugin-root', 'PASS', '2026-01-01', 's1'),
    entry('plugin-root', 'DEGRADED', '2026-01-02', 's2'),
  ];
  const { drift, healing } = detectDrift(history);
  assert.equal(drift.length, 1);
  assert.equal(healing.length, 0);
  assert.equal(drift[0].direction, 'degrading');
  assert.equal(drift[0].from_status, 'PASS');
  assert.equal(drift[0].to_status, 'DEGRADED');
});

test('detectDrift: DEGRADED→PASS is healing (informational, not drift)', () => {
  const history = [
    entry('plugin-root', 'DEGRADED', '2026-01-01', 's1'),
    entry('plugin-root', 'PASS', '2026-01-02', 's2'),
  ];
  const { drift, healing } = detectDrift(history);
  assert.equal(drift.length, 0, 'healing is not drift');
  assert.equal(healing.length, 1);
  assert.equal(healing[0].direction, 'healing');
});

test('detectDrift: PASS→NOT-YET and PASS→UNKNOWN both degrading', () => {
  const h1 = [entry('a', 'PASS', '2026-01-01', 's1'), entry('a', 'NOT-YET', '2026-01-02', 's2')];
  const h2 = [entry('b', 'PASS', '2026-01-01', 's1'), entry('b', 'UNKNOWN', '2026-01-02', 's2')];
  assert.equal(detectDrift(h1).drift.length, 1);
  assert.equal(detectDrift(h2).drift.length, 1);
});

test('detectDrift: identical status → no drift event', () => {
  const history = [
    entry('a', 'PASS', '2026-01-01', 's1'),
    entry('a', 'PASS', '2026-01-02', 's2'),
  ];
  const { drift, healing } = detectDrift(history);
  assert.equal(drift.length, 0);
  assert.equal(healing.length, 0);
});

test('detectDrift: DEGRADED→UNKNOWN is degrading (further down rank)', () => {
  const history = [
    entry('a', 'DEGRADED', '2026-01-01', 's1'),
    entry('a', 'UNKNOWN', '2026-01-02', 's2'),
  ];
  assert.equal(detectDrift(history).drift.length, 1);
});

// --- attributeDrift ---

test('attributeDrift: new evidence source → med confidence hypothesis', () => {
  const prev = { evidence: [{ source: 'starting-path' }] };
  const cur = { evidence: [{ source: 'starting-path' }, { source: 'consuming-harness-conflict' }] };
  const a = attributeDrift(prev, cur);
  assert.equal(a.confidence, 'med');
  assert.match(a.hypothesis, /consuming-harness-conflict/);
});

test('attributeDrift: no evidence change → low confidence', () => {
  const prev = { evidence: [{ source: 'x' }] };
  const cur = { evidence: [{ source: 'x' }] };
  const a = attributeDrift(prev, cur);
  assert.equal(a.confidence, 'low');
});

test('attributeDrift: always a hypothesis, never asserted fact (HC bar)', () => {
  const a = attributeDrift({ evidence: [] }, { evidence: [{ source: 'new' }] });
  assert.ok('hypothesis' in a && 'confidence' in a, 'must carry hypothesis + confidence');
  assert.ok(['low', 'med', 'high'].includes(a.confidence));
});

// --- detectRegression ---

test('detectRegression: capability in prior session absent from latest → regression', () => {
  const history = [
    entry('a', 'PASS', '2026-01-01T00:00:00Z', 's1'),
    entry('b', 'PASS', '2026-01-01T00:00:01Z', 's1'),
    entry('a', 'PASS', '2026-01-02T00:00:00Z', 's2'), // b is gone in s2
  ];
  const regs = detectRegression(history);
  assert.equal(regs.length, 1);
  assert.equal(regs[0].capability_id, 'b');
  assert.equal(regs[0].prior_session, 's1');
  assert.equal(regs[0].latest_session, 's2');
});

test('detectRegression: no regression when all capabilities persist', () => {
  const history = [
    entry('a', 'PASS', '2026-01-01T00:00:00Z', 's1'),
    entry('a', 'PASS', '2026-01-02T00:00:00Z', 's2'),
  ];
  assert.equal(detectRegression(history).length, 0);
});

test('detectRegression: single session → no regression possible', () => {
  const history = [entry('a', 'PASS', '2026-01-01', 's1')];
  assert.equal(detectRegression(history).length, 0);
});

// --- renderDriftLog ---

test('renderDriftLog: clean state renders no-drift message', () => {
  const md = renderDriftLog([], [], [], '2026-01-01T00:00:00Z');
  assert.match(md, /No degrading drift or regression detected/);
});

test('renderDriftLog: drift section includes confidence-qualified attribution', () => {
  const drift = [{
    capability_id: 'plugin-root', from_status: 'PASS', to_status: 'DEGRADED',
    from_observed_at: '2026-01-01', to_observed_at: '2026-01-02',
    from_session: 's1', to_session: 's2',
    attribution: { hypothesis: 'new evidence: conflict', confidence: 'med' },
  }];
  const md = renderDriftLog(drift, [], [], '2026-01-03');
  assert.match(md, /PASS → DEGRADED/);
  assert.match(md, /confidence: med/);
  assert.match(md, /Likely cause/);
});

test('renderDriftLog: regression section renders', () => {
  const regs = [{
    capability_id: 'target-surface', prior_session: 's1', latest_session: 's2',
    attribution: { hypothesis: 'descriptor changed', confidence: 'med' },
  }];
  const md = renderDriftLog([], [], regs, '2026-01-03');
  assert.match(md, /Regression/);
  assert.match(md, /target-surface no longer reports/);
});

test('loadCapabilityHistory: includes project-local fallback rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'capdrift-home-'));
  const project = mkdtempSync(join(tmpdir(), 'capdrift-project-'));
  try {
    appendRows('ws-fallback', [
      { capability_id: 'plugin-root-resolution', identity_status: 'PASS', evidence: [] },
    ], { session_id: 's1' }, { project });
    const history = loadCapabilityHistory('ws-fallback', project, { home });
    assert.equal(history.length, 1);
    assert.equal(history[0].workspace_id, 'ws-fallback');
    assert.equal(history[0].session_id, 's1');
    assert.equal(history[0].row.capability_id, 'plugin-root-resolution');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

// v3.2.2 migration cleanup — see removeLegacyDriftLog
test('removeLegacyDriftLog: deletes the legacy non-prefixed file, idempotent, surgical', () => {
  const root = mkdtempSync(join(tmpdir(), 'drift-legacy-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    const legacy = join(mem, 'capability-drift-log.md');
    const current = join(mem, '_capability-drift-log.md');
    const realUnit = join(mem, 'dc-1-real.md');
    writeFileSync(legacy, 'stale render artifact, no frontmatter');
    writeFileSync(current, '# current drift log');
    writeFileSync(realUnit, '---\nid: dc-1-real\n---\n# real');

    assert.equal(removeLegacyDriftLog(root), true, 'removed the legacy file');
    assert.equal(existsSync(legacy), false, 'legacy file gone');
    assert.equal(existsSync(current), true, 'current _-prefixed file untouched');
    assert.equal(existsSync(realUnit), true, 'real units untouched');

    // Idempotent — nothing left to remove.
    assert.equal(removeLegacyDriftLog(root), false, 'no-op when legacy absent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
