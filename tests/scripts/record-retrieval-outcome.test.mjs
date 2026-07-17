import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { outcomeLockPath, recordRetrievalOutcome } from '../../plugins/core/skills/core/scripts/record-retrieval-outcome.mjs';
import { acquireFileLock } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'retrieval-outcome-'));
  const session = join(project, '_sessions', '2026-07-17');
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'retrieval-log.jsonl'), `${JSON.stringify({ kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1 })}\n`);
  return project;
}

test('writes one evidence-qualified outcome for an existing retrieval', () => {
  const project = fixture();
  try {
    const result = recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }, { today: '2026-07-17', now: '2026-07-17T03:00:00Z' });
    assert.equal(result.written, true);
    assert.deepEqual(result.record, {
      kind: 'retrieval-outcome', schema_version: '1.1.0', retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    });
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[1], { ts: '2026-07-17T03:00:00Z', ...result.record });
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('rejects unknown retrieval ids without writing', () => {
  const project = fixture();
  try {
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'missing', usefulness_outcome: 'useful', evidence_authority: 'agent-attribution', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }), /exactly one retrieval/i);
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('rejects duplicate or relabeled outcomes', () => {
  const project = fixture();
  try {
    recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_authority: 'objective-task-success', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }, { today: '2026-07-17' });
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'miss', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }, { today: '2026-07-17' }), /already has an outcome/i);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('rejects invalid closed-vocabulary values', () => {
  const project = fixture();
  try {
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'great', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }), /usefulness_outcome/i);
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_kind: 'guess',
    }), /evidence_authority/i);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('fails closed while another outcome writer owns the scan-and-append lock', () => {
  const project = fixture();
  try {
    const lock = acquireFileLock(outcomeLockPath(project));
    assert.equal(lock.ok, true);
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }), /writer is locked/i);
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
