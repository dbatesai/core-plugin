/**
 * close-process-request.test.mjs — reachability of the automatic close.
 *
 * The reachability gap this closes: the SessionEnd
 * hook enqueues `close-pass.mjs process-request <store> --session <id>`, but no CLI case
 * ever existed for `process-request` — direct reproduction exits 2, "unknown subcommand".
 * Every prior RED for this redesign exercised the underlying functions directly
 * (runDeterministicClose, shouldEnqueueClose, decideCloseAction) and therefore never
 * caught that the wiring between them was never built. These tests run the REAL argv
 * decideCloseAction produces through the REAL subprocess boundary the hook actually spawns
 * (`spawn('node', decision.args, ...)`), so a reachability gap here fails an assertion,
 * not just a manual reproduction.
 *
 * Baseline for the RED run: aba0a74 (process-request has no CLI case at all — exit 2).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { decideCloseAction } from '../../plugins/core/skills/core/hooks/close-pass-hook.mjs';
import { readCloseReceipt, shouldEnqueueClose } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

const SESSION_A = 'sess-rc-0192aa8c-1f4d-4a51-9d3e-11c0ffee0020';
const SESSION_B = 'sess-rc-0192aa8c-1f4d-4a51-9d3e-11c0ffee0021';

function freshStore() {
  const store = mkdtempSync(join(tmpdir(), 'close-rc-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  return store;
}

function fixtureTranscript(dir) {
  const p = join(dir, 'transcript.jsonl');
  const lines = [
    { timestamp: '2026-07-27T20:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'wire process-request' }] } },
    { timestamp: '2026-07-27T20:05:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/close-pass.mjs' } }] } },
    { timestamp: '2026-07-27T20:10:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ];
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

/** Run the EXACT argv the hook would spawn: `spawn('node', decision.args, ...)`. */
function runDecisionArgv(decision) {
  return spawnSync(process.execPath, decision.args, { encoding: 'utf8' });
}

test('[oracle 1] the real hook argv, run through the real subprocess boundary, certifies a closed receipt', () => {
  const store = freshStore();
  try {
    const transcriptPath = fixtureTranscript(store);
    const decision = decideCloseAction(
      { session_id: SESSION_A, reason: 'other', cwd: store, transcript_path: transcriptPath },
      { store },
    );
    assert.equal(decision.action, 'enqueue');
    assert.ok(decision.args.includes('--transcript'), 'the transcript path must reach argv, not just the session id');
    assert.ok(decision.args.includes(transcriptPath));

    const res = runDecisionArgv(decision);
    assert.equal(res.status, 0, `process-request must be a real subcommand, not exit 2 unknown-subcommand: ${res.stderr}`);

    const receipt = readCloseReceipt(store, SESSION_A);
    assert.ok(receipt, 'a receipt must exist after the real argv runs');
    // Spec §4.5/§2.2: automatic close writes 'recorded' (lifecycle evidence), never 'closed'
    // (semantic capture is manual /finalize's alone to certify).
    assert.equal(receipt.status, 'recorded');
    assert.equal(receipt.model_calls, 0, 'the automatic close must make zero model calls');
    assert.equal(receipt.record.started_at, '2026-07-27T20:00:00.000Z');
    assert.equal(receipt.record.ended_at, '2026-07-27T20:10:00.000Z');
    assert.ok(receipt.record.files_touched.includes('/repo/close-pass.mjs'));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('[oracle 2] the identical argv run twice for the same session does not duplicate work', () => {
  const store = freshStore();
  try {
    const transcriptPath = fixtureTranscript(store);
    const decision = decideCloseAction(
      { session_id: SESSION_A, reason: 'other', cwd: store, transcript_path: transcriptPath },
      { store },
    );
    const first = runDecisionArgv(decision);
    assert.equal(first.status, 0);

    const second = runDecisionArgv(decision);
    assert.equal(second.status, 0, 'a repeat request for an already-closed session must not error');
    assert.match(second.stdout, /already closed/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('[oracle 3] a distinct session is still processed after another session closed', () => {
  const store = freshStore();
  try {
    const transcriptPath = fixtureTranscript(store);
    runDecisionArgv(decideCloseAction(
      { session_id: SESSION_A, reason: 'other', cwd: store, transcript_path: transcriptPath },
      { store },
    ));

    const decisionB = decideCloseAction(
      { session_id: SESSION_B, reason: 'other', cwd: store, transcript_path: transcriptPath },
      { store },
    );
    assert.equal(decisionB.action, 'enqueue', 'sess-B must not be suppressed by sess-A closing');
    const resB = runDecisionArgv(decisionB);
    assert.equal(resB.status, 0);

    const receiptB = readCloseReceipt(store, SESSION_B);
    assert.ok(receiptB, 'sess-B must get its own receipt');
    assert.equal(receiptB.status, 'recorded');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('[oracle 4] no usable transcript records partial coverage and stays owed, never falsely closed', () => {
  const store = freshStore();
  try {
    // No transcript_path on the payload at all — the harness genuinely has none to offer.
    const decision = decideCloseAction({ session_id: SESSION_A, reason: 'other', cwd: store }, { store });
    assert.ok(!decision.args.includes('--transcript'), 'no transcript on the payload -> none invented on argv');

    const res = runDecisionArgv(decision);
    assert.equal(res.status, 0);

    const receipt = readCloseReceipt(store, SESSION_A);
    assert.ok(receipt, 'a partial receipt is still written -- the close is observed, just not fully');
    assert.equal(receipt.status, 'partial', 'unobserved coverage must never be certified closed');
    assert.equal(shouldEnqueueClose(store, { sessionId: SESSION_A }), true,
      'a partial close must remain owed so startup catch-up can recover it');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('process-request without --session is a CLI usage error, not a silent no-op', () => {
  const store = freshStore();
  try {
    const runner = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
      'plugins', 'core', 'skills', 'core', 'scripts', 'close-pass.mjs');
    const res = spawnSync(process.execPath, [runner, 'process-request', store], { encoding: 'utf8' });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--session/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});
