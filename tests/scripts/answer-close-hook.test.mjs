import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pendingOutcomePath } from '../../plugins/core/skills/core/scripts/record-retrieval-outcome.mjs';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'answer-close-hook.mjs');

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'answer-close-'));
  const session = join(project, '_sessions', '2026-07-17');
  mkdirSync(session, { recursive: true });
  writeFileSync(join(session, 'retrieval-log.jsonl'), `${JSON.stringify({ kind: 'retrieval', retrieval_id: 'r-1', tier_reached: 1 })}\n`);
  return project;
}

function isolatedHooksLog() {
  return join(mkdtempSync(join(tmpdir(), 'answer-close-hook-log-')), 'hooks-log.jsonl');
}

function writePending(project, overrides = {}) {
  const path = pendingOutcomePath(project, 'claude-code', overrides.session_id || 's-test-1');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    retrieval_id: 'r-1', session_id: 's-test-1', harness: 'claude-code', query_terms: ['a'], had_hits: true,
    ...overrides,
  }));
  return path;
}

function runHook(payload, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, CORE_HOOKS_LOG_FILE: isolatedHooksLog(), ...env },
    encoding: 'utf8',
  });
}

test('closes a pending retrieval using the real prompt_id as answer_turn_id, deletes the marker', () => {
  const project = fixture();
  try {
    const pendingPath = writePending(project);
    runHook({ session_id: 's-test-1', prompt_id: 'real-prompt-uuid-123', cwd: project });
    assert.equal(existsSync(pendingPath), false, 'pending marker consumed on confirmed close');
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'outcome-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].retrieval_id, 'r-1');
    assert.equal(rows[0].answer_turn_id, 'real-prompt-uuid-123', 'the harness-provided prompt_id is the real identity — never an alias of retrieval_id');
    assert.notEqual(rows[0].answer_turn_id, rows[0].retrieval_id);
    assert.equal(rows[0].usefulness_outcome, 'unknown');
    assert.equal(rows[0].evidence_authority, 'unobservable');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('falls back to a freshly-generated turn id (never retrieval_id) when prompt_id is absent', () => {
  const project = fixture();
  try {
    writePending(project);
    runHook({ session_id: 's-test-1', cwd: project });
    const rows = readFileSync(join(project, '_sessions', '2026-07-17', 'outcome-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].answer_turn_id, rows[0].retrieval_id, 'fallback id must never alias retrieval_id');
    assert.match(rows[0].answer_turn_id, /^[0-9a-f-]{36}$/i, 'fallback is a fresh UUID, not a copy of anything');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('no pending marker: skips cleanly, writes no outcome row', () => {
  const project = fixture();
  try {
    const out = runHook({ session_id: 's-test-1', cwd: project });
    assert.equal(out.trim(), '', 'Stop hook never injects text');
    assert.equal(existsSync(join(project, '_sessions', '2026-07-17', 'outcome-log.jsonl')), false);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('session id mismatch: does not close a different session\'s pending marker', () => {
  const project = fixture();
  try {
    const pendingPath = writePending(project, { session_id: 's-other-session' });
    runHook({ session_id: 's-test-1', cwd: project });
    assert.equal(existsSync(pendingPath), true, 'a mismatched session must never consume another session\'s pending evidence');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('no session_id in payload: skips cleanly, never crashes', () => {
  const project = fixture();
  try {
    writePending(project);
    const out = runHook({ cwd: project });
    assert.equal(out.trim(), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('hostile session id never escapes the intended directory (sanitized pending path)', () => {
  const project = fixture();
  try {
    // No pending file exists for this hostile id — the hook must still exit
    // clean rather than throw on path construction.
    const out = runHook({ session_id: '../../../etc/passwd', cwd: project });
    assert.equal(out.trim(), '');
  } finally { rmSync(project, { recursive: true, force: true }); }
});
