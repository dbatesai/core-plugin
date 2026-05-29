import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordSnapshot } from '../../skills/core/scripts/record-capability-snapshot.mjs';
import { readHistory } from '../../skills/core/scripts/capability-history.mjs';
import { detectDrift, detectRegression } from '../../skills/core/scripts/analyze-capability-drift.mjs';

// HC_603 bar: the wire-in must actually APPEND and actually be CONSUMED, not just
// be mentioned in prose. These fixtures exercise the real append + read path.

test('wire-in: record-capability-snapshot appends real probe rows to capability-history', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-'));
  try {
    const wid = 'ws-append-test';
    const r = await recordSnapshot({ workspaceId: wid, harness: 'claude-code', cwd: '/work/Proj', sessionId: 's1', home });
    assert.ok(r.appended >= 1, 'should append at least one capability row');
    const hist = readHistory(wid, { home });
    assert.ok(hist.length >= 1, 'history file should contain the appended rows');
    assert.ok(hist.every(h => h.row && h.row.capability_id), 'each entry wraps a real capability row');
    assert.ok(hist.every(h => h.session_id === 's1'), 'rows carry the session id');
    // the anti-anchoring row (DEGRADED) is among the recorded rows — proves real probe output
    assert.ok(hist.some(h => h.row.capability_id === 'anti-anchoring-mechanism'), 'real probe rows, not a stub');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('wire-in: drift analysis CONSUMES the appended history across two sessions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capwire-'));
  try {
    const wid = 'ws-drift-test';
    await recordSnapshot({ workspaceId: wid, harness: 'claude-code', cwd: '/work/Proj', sessionId: 's1', home });
    await recordSnapshot({ workspaceId: wid, harness: 'claude-code', cwd: '/work/Proj', sessionId: 's2', home });
    const hist = readHistory(wid, { home });
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
