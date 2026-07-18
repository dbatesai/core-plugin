import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { outcomeLockPath, recordRetrievalOutcome, resolveOutcomeAuthority, pendingOutcomePath, sanitizeForFilename } from '../../plugins/core/skills/core/scripts/record-retrieval-outcome.mjs';
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
      retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    }, { today: '2026-07-17', now: '2026-07-17T03:00:00Z' });
    assert.equal(result.written, true);
    assert.deepEqual(result.record, {
      kind: 'retrieval-outcome', schema_version: '1.2.0', retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    });
    // Outcomes live in a SEPARATE later log (Hale stop-note): the retrieval
    // log they judge stays untouched.
    const baseRows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(baseRows.length, 1, 'retrieval log untouched');
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'outcome-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { ts: '2026-07-17T03:00:00Z', ...result.record });
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// producer_sha, 2026-07-18: required like producer_version -- a caller can't
// silently omit stating which exact build produced a row. 'unknown' is a
// valid VALUE (the honest default for unstamped builds) but an absent FIELD
// is a caller bug, same distinction the honesty coupling above enforces for
// usefulness_outcome/evidence_authority.
test('rejects a missing producer_sha without writing', () => {
  const project = fixture();
  try {
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1',
    }), /producer_sha must be a non-empty string/i);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test("accepts the literal value 'unknown' as a valid, honest producer_sha", () => {
  const project = fixture();
  try {
    const result = recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'partial', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'unknown',
    }, { today: '2026-07-17', now: '2026-07-17T03:00:00Z' });
    assert.equal(result.written, true);
    assert.equal(result.record.producer_sha, 'unknown');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('rejects unknown retrieval ids without writing', () => {
  const project = fixture();
  try {
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'missing', usefulness_outcome: 'useful', evidence_authority: 'agent-attribution', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    }), /exactly one retrieval/i);
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('permits a stronger later outcome to be appended (does not throw)', () => {
  // Hale audit, 2026-07-17, hazard: "an automatic unknown blocks stronger
  // later evidence." An auto-close writing 'unknown'/'unobservable' must
  // never permanently prevent a real, stronger-authority outcome from being
  // recorded for the same retrieval afterward.
  const project = fixture();
  try {
    const first = recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'unknown', evidence_authority: 'unobservable', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    }, { today: '2026-07-17' });
    assert.equal(first.written, true);
    const second = recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'miss', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-2', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    }, { today: '2026-07-17' });
    assert.equal(second.written, true);
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'outcome-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2, 'both outcome rows persist — the second never overwrites or is rejected');
    assert.equal(resolveOutcomeAuthority(rows), 'miss', 'higher-authority evidence (user-confirmed) resolves over the automatic unknown');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('resolveOutcomeAuthority resolves equal-authority disagreement to unknown', () => {
  const rows = [
    { usefulness_outcome: 'useful', evidence_authority: 'agent-attribution' },
    { usefulness_outcome: 'miss', evidence_authority: 'agent-attribution' },
  ];
  assert.equal(resolveOutcomeAuthority(rows), 'unknown');
});

test('resolveOutcomeAuthority returns null for no rows / no recognized outcomes', () => {
  assert.equal(resolveOutcomeAuthority([]), null);
  assert.equal(resolveOutcomeAuthority([{ usefulness_outcome: 'bogus', evidence_authority: 'user-confirmed' }]), null);
});

test('pendingOutcomePath sanitizes a hostile session id into a filename-safe slug', () => {
  const project = '/tmp/whatever-project';
  const path = pendingOutcomePath(project, 'claude-code', '../../../etc/passwd');
  assert.ok(!path.includes('..'), 'no path-traversal sequence survives into the filename');
  assert.match(path, /pending-retrieval-claude-code-[A-Za-z0-9_-]+\.json$/);
});

test('pendingOutcomePath returns null without both harness and session id', () => {
  assert.equal(pendingOutcomePath('/tmp/x', null, 's-1'), null);
  assert.equal(pendingOutcomePath('/tmp/x', 'claude-code', null), null);
});

test('sanitizeForFilename collapses illegal characters and caps length', () => {
  assert.equal(sanitizeForFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeForFilename('x'.repeat(50), 24).length, 24);
});

test('rejects invalid closed-vocabulary values', () => {
  const project = fixture();
  try {
    assert.throws(() => recordRetrievalOutcome(project, {
      retrieval_id: 'r-1', usefulness_outcome: 'great', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
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
      retrieval_id: 'r-1', usefulness_outcome: 'useful', evidence_authority: 'user-confirmed', harness: 'claude-code', session_id: 's-test-1', answer_turn_id: 'turn-test-1', producer_version: '3.12.0-rc.1', producer_sha: 'deadbeef',
    }), /writer is locked/i);
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'retrieval-log.jsonl'), 'utf8').trim().split('\n');
    assert.equal(rows.length, 1);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
