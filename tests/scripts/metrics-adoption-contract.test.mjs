import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { metricsEnabled, logEvent } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { computePrecision } from '../../plugins/core/skills/core/scripts/calibrate-classifier.mjs';

// The BBLens metrics-adoption contract (validity-dimension spec §"BBLens field-contract"
// + memory-extension-contracts §6). These invariants are what an overlay relies on when
// it adopts CORE's instrumented-memory system for real prod metrics. A change that breaks
// any of them breaks BBLens adoption — so they get an explicit, named test.

function scratch(workspaceJson) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-contract-'));
  if (workspaceJson !== undefined) writeFileSync(join(dir, 'workspace.json'), JSON.stringify(workspaceJson));
  return dir;
}

// ---------- 1. Capture gate: DEFAULT-ON, opt-out (DC-107) ----------
// Changed from default-off to default-on per David 2026-06-04: the instrumented-
// memory thesis needs the corpus, and the calibration gate was starving under opt-in.
// Opt out via env CORE_METRICS_ENABLED=0 or per-workspace metrics_enabled:false.
// Explicit env wins over the workspace flag in both directions. Capture stays local.

test('capture gate defaults ON with no env and no workspace flag', () => {
  const dir = scratch({ workspace_id: 'x' });
  try { assert.equal(metricsEnabled({ project: dir, env: {} }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a workspace opts OUT via workspace.json metrics_enabled:false', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: false });
  try { assert.equal(metricsEnabled({ project: dir, env: {} }), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('workspace.json metrics_enabled:true stays ON (explicit opt-in, harmless under default-on)', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: true });
  try { assert.equal(metricsEnabled({ project: dir, env: {} }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit CORE_METRICS_ENABLED=0 hard-off overrides a workspace opt-in', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: true });
  try { assert.equal(metricsEnabled({ project: dir, env: { CORE_METRICS_ENABLED: '0' } }), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit CORE_METRICS_ENABLED=1 forces ON over a workspace opt-out', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: false });
  try { assert.equal(metricsEnabled({ project: dir, env: { CORE_METRICS_ENABLED: '1' } }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 2. Passthrough capture: arbitrary overlay fields written verbatim ----------

function readLegacyEvents(dir) {
  const root = join(dir, '_sessions');
  const out = [];
  for (const d of readdirSync(root)) {
    for (const f of readdirSync(join(root, d))) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of readFileSync(join(root, d, f), 'utf8').split('\n')) {
        if (line.trim()) out.push(JSON.parse(line));
      }
    }
  }
  return out;
}

test('logEvent passes arbitrary overlay-specific fields through verbatim (capture is passthrough)', () => {
  const dir = scratch();
  try {
    logEvent(dir, 'bblens-log.jsonl',
      { kind: 'bblens-custom', tmobile_region: 'west', query_shape: 'a-shape-core-never-defined', nested: { a: 1 } },
      { today: '2026-06-02', sessionId: 'sess-1' });
    const events = readLegacyEvents(dir);
    const e = events.find((x) => x.kind === 'bblens-custom');
    assert.ok(e, 'custom event written');
    assert.equal(e.tmobile_region, 'west', 'unknown field preserved');
    assert.equal(e.query_shape, 'a-shape-core-never-defined', 'unknown query_shape value preserved, not dropped');
    assert.deepEqual(e.nested, { a: 1 }, 'nested structure preserved');
    assert.ok(e.ts, 'ts stamped');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 3. Additive detector seam: a new detector needs no capture change ----------

test('an overlay detector writes its own event kind without touching capture', () => {
  const dir = scratch();
  try {
    // Simulates a BBLens-authored detector emitting through the shared substrate.
    logEvent(dir, 'metrics-detectors.jsonl',
      { kind: 'bblens-sla-breach-detector', severity: 'HIGH', detail: 'p99 over budget' },
      { today: '2026-06-02', sessionId: 'sess-1' });
    const e = readLegacyEvents(dir).find((x) => x.kind === 'bblens-sla-breach-detector');
    assert.ok(e && e.severity === 'HIGH', 'additive detector event captured intact');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 4. Calibration self-grading guard (R-1): precision only from human gold ----------

test('computePrecision counts ONLY human-labeled turns — the classifier cannot grade itself', () => {
  // All turns carry heuristic output but NO gold label. If the guard regressed and used
  // heuristic self-agreement, this would report precision 1.0 and falsely clear the gate.
  const selfOnly = [
    { heuristic_state: 'rec-fail-tier-0', gold_state: null },
    { heuristic_state: 'tier-0-win', gold_state: null },
  ];
  const r = computePrecision(selfOnly);
  assert.equal(r.overall, null, 'no human labels → no precision (no self-confirmation)');
  assert.equal(r.labeled_count, 0);
});

test('computePrecision derives precision from gold labels, ignoring unlabeled turns in the count', () => {
  const mixed = [
    { heuristic_state: 'A', gold_state: 'A' },   // human-confirmed TP
    { heuristic_state: 'A', gold_state: 'B' },   // human-confirmed FP
    { heuristic_state: 'A', gold_state: null },  // unlabeled — must not count
  ];
  const r = computePrecision(mixed);
  assert.equal(r.labeled_count, 2, 'only the 2 gold-labeled turns count');
  assert.equal(r.by_state.A, 0.5, '1 TP / (1 TP + 1 FP) from human labels');
});
