import { registerFixtureProject } from './registered-project-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSnapshot, resolveSessionId } from '../../plugins/core/skills/core/scripts/record-capability-snapshot.mjs';
import { readHistory } from '../../plugins/core/skills/core/scripts/capability-history.mjs';
import { detectDrift, detectRegression } from '../../plugins/core/skills/core/scripts/analyze-capability-drift.mjs';

// the wire-in must actually APPEND and actually be CONSUMED, not just
// be mentioned in prose. These fixtures exercise the real append + read path.

test('wire-in: record-capability-snapshot appends real probe rows to capability-history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-'));
  try {
    const project = join(home, 'project'); registerFixtureProject(home, project);
    const r = await recordSnapshot({ harness: 'claude-code', cwd: project, sessionId: 's1', home });
    assert.ok(r.appended >= 1, 'should append at least one capability row');
    const hist = readHistory({ root: project, harness: 'claude-code' }, { home });
    assert.ok(hist.length >= 1, 'history file should contain the appended rows');
    assert.ok(hist.every(h => h.row && h.row.capability_id), 'each entry wraps a real capability row');
    assert.ok(hist.every(h => h.session_id === 's1'), 'rows carry the session id');
    // the anti-anchoring row (DEGRADED) is among the recorded rows — proves real probe output
    assert.ok(hist.some(h => h.row.capability_id === 'anti-anchoring-mechanism'), 'real probe rows, not a stub');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('wire-in: record-capability-snapshot reports NOT_STORED without payload fallback when the root cannot be enrolled', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-home-blocked-'));
  const project = mkdtempSync(join(tmpdir(), 'capwire-project-'));
  try {
    writeFileSync(join(home, '.core'), 'not a directory');
    const r = await recordSnapshot({
      harness: 'codex',
      cwd: project,
      sessionId: 's-sandbox',
      home,
    });
    assert.equal(r.status, 'NOT_STORED');
    assert.equal(r.storage, 'none');
    assert.equal(r.path, null);
    assert.equal(r.appended, 0);
    const hist = readHistory({ root: project, harness: 'codex' }, { project });
    assert.equal(hist.length, 0);
    assert.equal(hist.rejected, 0);
    assert.equal(existsSync(join(project, '_metrics')), false);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); }
});

test('wire-in: drift analysis CONSUMES the appended history across two sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-'));
  try {
    const project = join(home, 'project'); registerFixtureProject(home, project);
    await recordSnapshot({ harness: 'claude-code', cwd: project, sessionId: 's1', home });
    await recordSnapshot({ harness: 'claude-code', cwd: project, sessionId: 's2', home });
    const hist = readHistory({ root: project, harness: 'claude-code' }, { home });
    const sessions = new Set(hist.map(h => h.session_id));
    assert.ok(sessions.has('s1') && sessions.has('s2'), 'both sessions present in history');

    // analyze-capability-drift reads the SAME history and returns structured output
    const { drift, healing } = detectDrift(hist);
    const regs = detectRegression(hist);
    assert.ok(Array.isArray(drift) && Array.isArray(healing) && Array.isArray(regs), 'drift analysis consumed the history');
    // identical capability set across the two sessions → no regression, no degrading drift
    assert.equal(regs.length, 0, 'same capabilities both sessions → no regression');
    assert.equal(drift.length, 0, 'stable statuses → no degrading drift');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('wire-in: default session id is non-null and distinct per session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-'));
  try {
    const project = join(home, 'project'); registerFixtureProject(home, project);
    // No --session-id and no session env → must still derive distinct non-null ids,
    // otherwise every session collapses into one null bucket and regression can't fire.
    const r1 = await recordSnapshot({ harness: 'claude-code', cwd: project, home, env: {} });
    const r2 = await recordSnapshot({ harness: 'claude-code', cwd: project, home, env: {} });
    assert.ok(r1.session_id && r2.session_id, 'session id must be non-null on the default path');
    assert.notEqual(r1.session_id, r2.session_id, 'two default-path sessions get distinct ids');
    const hist = readHistory({ root: project, harness: 'claude-code' }, { home });
    const sessions = new Set(hist.map(h => h.session_id));
    assert.ok(sessions.size >= 2, 'history has distinct session buckets, not one collapsed bucket');
    assert.ok(!sessions.has(null), 'no null session bucket');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveSessionId: explicit → env → fallback, never null', () => {
  assert.equal(resolveSessionId({ sessionId: 'explicit' }), 'explicit');
  assert.equal(resolveSessionId({ env: { CLAUDE_CODE_SESSION_ID: 'cc-sess' } }), 'cc-sess');
  assert.equal(resolveSessionId({ env: { CODEX_THREAD_ID: 'cdx' } }), 'cdx');
  const fb = resolveSessionId({ env: {} });
  assert.ok(typeof fb === 'string' && fb.startsWith('session-') && fb.length > 10, 'fallback is a non-null distinct id');
});
