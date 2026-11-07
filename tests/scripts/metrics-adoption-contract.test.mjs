import { registerFixtureProject } from './registered-project-fixture.mjs';
import { updateManifest } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { metricsEnabled, metricsState, logEvent } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { turnCaptureEnabled } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';
import { computePrecision } from '../../plugins/core/skills/core/scripts/calibrate-classifier.mjs';

// Fixtures write state under the claude-code subfolder; CI has no Claude Code env signal.
process.env.CORE_HARNESS ||= 'claude-code';

// Opt-outs live in the project's trusted per-harness manifest. The manifest for an
// unregistered test folder lives under the (temp) home's ~/.core/local, so HOME is
// redirected for this file's process.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'optout-home-'));
process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });
function writeManifestFlags(project, fields) {
  registerFixtureProject(TEST_HOME, project);
  updateManifest({ root: project, harness: 'claude-code', coreDir: join(TEST_HOME, '.core'), fields });
}


// The BBLens metrics-adoption contract (validity-dimension spec §"BBLens field-contract"
// + memory-extension-contracts §6). These invariants are what an overlay relies on when
// it adopts CORE's instrumented-memory system for real prod metrics. A change that breaks
// any of them breaks BBLens adoption — so they get an explicit, named test.

function scratch(flags) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-contract-'));
  const { workspace_id: _id, ...rest } = flags || {};
  if (Object.keys(rest).length) writeManifestFlags(dir, rest);
  return dir;
}

// ---------- 1. Capture gate: DEFAULT-OFF, opt-in ----------
// Analytics run only when the user asks for them: env CORE_METRICS_ENABLED=1 or the
// project's signed manifest metrics_enabled:true. An overlay that wants its corpus sets
// the opt-in. Explicit env wins over the workspace flag in both directions. Capture stays local.

test('capture gate defaults OFF with no env and no workspace flag', () => {
  const dir = scratch({ workspace_id: 'x' });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_HARNESS: 'claude-code' } }), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a project opts OUT via its manifest metrics_enabled:false', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: false });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_HARNESS: 'claude-code' } }), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manifest metrics_enabled:true turns analytics ON (explicit opt-in)', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: true });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_HARNESS: 'claude-code' } }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit CORE_METRICS_ENABLED=0 hard-off overrides a workspace opt-in', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: true });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_METRICS_ENABLED: '0' } }), false); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit CORE_METRICS_ENABLED=1 forces ON over a workspace opt-out', () => {
  const dir = scratch({ workspace_id: 'x', metrics_enabled: false });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_METRICS_ENABLED: '1' } }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit CORE_METRICS_ENABLED=1 turns analytics ON with no workspace flag', () => {
  const dir = scratch({ workspace_id: 'x' });
  try { assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env: { CORE_HARNESS: 'claude-code', CORE_METRICS_ENABLED: '1' } }), true); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no project at all: analytics stay OFF', () => {
  assert.equal(metricsEnabled({ home: TEST_HOME, env: { CORE_HARNESS: 'claude-code' } }), false);
});

test('a signed-manifest opt-in alone turns analytics on: off before it is written, on after, off when read from another home', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-contract-'));
  const otherHome = mkdtempSync(join(tmpdir(), 'optout-other-home-'));
  const env = { CORE_HARNESS: 'claude-code' };   // no CORE_METRICS_ENABLED anywhere
  try {
    registerFixtureProject(TEST_HOME, dir);
    assert.equal(metricsState({ project: dir, home: TEST_HOME, env }), 'default', 'registered, nothing opted in');
    updateManifest({ root: dir, harness: 'claude-code', coreDir: join(TEST_HOME, '.core'), fields: { metrics_enabled: true } });
    assert.equal(metricsState({ project: dir, home: TEST_HOME, env }), 'on', 'the signed manifest opt-in is read');
    assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env }), true);
    assert.equal(metricsState({ project: dir, home: otherHome, env }), 'default', 'the same folder under another home has no trusted opt-in');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(otherHome, { recursive: true, force: true }); }
});

// Two gates. Turn capture has its own opt-in; analytics block it only when they are explicitly off
// (env 0, a manifest opt-out, the fail-closed marker, unreadable state), not by their default.
for (const [metricsEnv, metricsWant] of [[undefined, 'default'], ['1', 'on'], ['0', 'off']]) {
  for (const [captureEnv, captureOptIn] of [[undefined, false], ['1', true], ['0', false]]) {
    const want = captureOptIn && metricsWant !== 'off';
    test(`gates: CORE_METRICS_ENABLED=${metricsEnv ?? '(unset)'}, CORE_TURN_CAPTURE=${captureEnv ?? '(unset)'} -> metrics ${metricsWant}, capture ${want ? 'on' : 'off'}`, () => {
      const dir = scratch({ workspace_id: 'x' });
      const env = { CORE_HARNESS: 'claude-code' };
      if (metricsEnv !== undefined) env.CORE_METRICS_ENABLED = metricsEnv;
      if (captureEnv !== undefined) env.CORE_TURN_CAPTURE = captureEnv;
      try {
        assert.equal(metricsState({ project: dir, home: TEST_HOME, env }), metricsWant);
        assert.equal(turnCaptureEnabled({ project: dir, home: TEST_HOME, env }), want);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('gates: a manifest metrics opt-out blocks a turn-capture env opt-in; a manifest capture opt-in works with analytics at their default', () => {
  const env = { CORE_HARNESS: 'claude-code' };
  const a = scratch({ workspace_id: 'x', metrics_enabled: false });
  const b = scratch({ workspace_id: 'x', turn_capture: true });
  try {
    assert.equal(turnCaptureEnabled({ project: a, home: TEST_HOME, env: { ...env, CORE_TURN_CAPTURE: '1' } }), false);
    assert.equal(metricsState({ project: b, home: TEST_HOME, env }), 'default');
    assert.equal(turnCaptureEnabled({ project: b, home: TEST_HOME, env }), true);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

// Card 214: a forged or transplanted signature never switches analytics or capture on.
function manifestFile(dir) { return join(dir, '_core', 'claude-code', 'workspace.json'); }

test('a signed opt-in whose bytes were changed after signing is not trusted: analytics and capture stay off', () => {
  const env = { CORE_HARNESS: 'claude-code' };
  const dir = scratch({ workspace_id: 'x', metrics_enabled: true, turn_capture: true });
  try {
    assert.equal(metricsState({ project: dir, home: TEST_HOME, env }), 'on', 'control: the signed opt-in is honored');
    assert.equal(turnCaptureEnabled({ project: dir, home: TEST_HOME, env }), true, 'control');
    const f = manifestFile(dir);
    assert.ok(existsSync(f) && existsSync(f + '.mac'), 'fixture: a signed manifest and its MAC');
    const body = JSON.parse(readFileSync(f, 'utf8'));
    writeFileSync(f, JSON.stringify({ ...body, note: 'edited after signing' }, null, 2) + '\n');   // the MAC is left as it was
    assert.notEqual(metricsState({ project: dir, home: TEST_HOME, env }), 'on');
    assert.equal(metricsEnabled({ project: dir, home: TEST_HOME, env }), false);
    assert.equal(turnCaptureEnabled({ project: dir, home: TEST_HOME, env }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Known limit until card 235 binds a signature to its own project: the copied manifest and MAC verify
// in B, so B's analytics and capture switch on. Under opt-in defaults this is the one path where a
// project that asked for nothing gets them; kept as a visible todo, not a pass.
test('a signed opt-in copied with its MAC into another registered project does not switch that project on', { todo: 'card 235: manifest signature bound to its project' }, () => {
  const env = { CORE_HARNESS: 'claude-code' };
  const a = scratch({ workspace_id: 'x', metrics_enabled: true, turn_capture: true });
  const b = scratch({ workspace_id: 'x', metrics_enabled: false });   // registered, with its own signed manifest
  try {
    writeManifestFlags(b, { metrics_enabled: null });                   // then cleared: B opted into nothing
    assert.equal(metricsState({ project: b, home: TEST_HOME, env }), 'default', 'control: B is registered and opted into nothing');
    assert.ok(existsSync(manifestFile(b)), 'fixture: B has its own signed manifest to overwrite');
    copyFileSync(manifestFile(a), manifestFile(b));
    copyFileSync(manifestFile(a) + '.mac', manifestFile(b) + '.mac');
    assert.notEqual(metricsState({ project: b, home: TEST_HOME, env }), 'on');
    assert.equal(turnCaptureEnabled({ project: b, home: TEST_HOME, env }), false);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});

// ---------- 2. Passthrough capture: arbitrary overlay fields written verbatim ----------

function readLegacyEvents(dir) {
  const root = join(dir, '_sessions');
  const out = [];
  for (const d of readdirSync(root).filter((n) => n !== ".gitignore")) {
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
