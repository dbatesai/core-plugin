/**
 * close-payload.test.mjs — deterministic zero-model close record (DET-01 … DET-11).
 *
 * Slice 2 of the finalize/refocus redesign, RED-first.
 *
 * Contract being encoded: the AUTOMATIC close makes zero model calls. Agy's
 * challenge — "if nothing reads the prose, we are paying a model to generate
 * dead text" — was ratified three-way, with supporting evidence that
 * `startup.md` already instructs the agent to SKIP session summaries at
 * bootstrap. So the automatic close emits a deterministic structured record
 * built from already-normalized transcript events, not generated prose.
 *
 * The record answers "if this session vanished, what happened?" using only
 * facts that can be counted: identity, time range, turn and tool counts, files
 * touched, git state. Anything requiring judgment is out of scope by design and
 * belongs to the manual close, which has the active context to do it honestly.
 *
 * Baseline: e81903f + 7476b98 (exact-session receipts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  clipUtf8,
  classifySession,
  buildCloseRecord,
  renderCloseSummary,
} from '../../plugins/core/skills/core/scripts/close-payload.mjs';

/** Normalized events, the shape read-transcript.mjs already emits for both harnesses. */
const SUBSTANTIVE_EVENTS = [
  { idx: 0, kind: 'text', role: 'user', text: 'add exact-session receipts to the close path' },
  { idx: 1, kind: 'text', role: 'assistant', text: 'Reading close-pass.mjs first.' },
  { idx: 2, kind: 'tool', role: 'assistant', name: 'Read', text: '{"file_path":"/repo/close-pass.mjs"}' },
  { idx: 3, kind: 'tool', role: 'assistant', name: 'Edit', text: '{"file_path":"/repo/close-pass.mjs"}' },
  { idx: 4, kind: 'tool', role: 'assistant', name: 'Bash', text: '{"command":"node --test"}' },
  { idx: 5, kind: 'text', role: 'assistant', text: '8/8 green.' },
];

const TRIVIAL_EVENTS = [
  { idx: 0, kind: 'text', role: 'user', text: 'what version is installed' },
  { idx: 1, kind: 'text', role: 'assistant', text: 'v3.14.1.' },
];

const BASE = {
  sessionId: 'sess-det-0192aa8c-1f4d-4a51-9d3e-11c0ffee0003',
  harness: 'claude-code',
  startedAt: '2026-07-27T16:00:00.000Z',
  endedAt: '2026-07-27T16:42:00.000Z',
};

// ───────────────────────────── DET-01..03: UTF-8 clipping ────────────────────

test('DET-01 clipUtf8 never splits a multi-byte character', () => {
  // Each emoji is 4 bytes. A naive code-unit slice at 6 bytes would sever one.
  const s = '👍👍👍';
  const out = clipUtf8(s, 6);
  assert.equal(Buffer.byteLength(out, 'utf8') <= 6, true, 'must not exceed the budget');
  assert.equal(out, '👍', 'must clip to a whole character, never a broken one');
  assert.equal(Buffer.from(out, 'utf8').includes(0xef), false, 'no replacement-char corruption');
});

test('DET-02 clipUtf8 respects the byte budget for mixed-width text', () => {
  const s = 'café — naïve';
  for (const budget of [1, 2, 3, 5, 8, 13, 21]) {
    const out = clipUtf8(s, budget);
    assert.ok(Buffer.byteLength(out, 'utf8') <= budget,
      `budget ${budget}: got ${Buffer.byteLength(out, 'utf8')} bytes`);
  }
  assert.equal(clipUtf8(s, 1000), s, 'a budget over the length returns the whole string');
});

test('DET-03 clipUtf8 handles empty and non-string input without throwing', () => {
  assert.equal(clipUtf8('', 10), '');
  assert.equal(clipUtf8(null, 10), '');
  assert.equal(clipUtf8(undefined, 10), '');
  assert.equal(clipUtf8('abc', 0), '');
});

// ───────────────────────────── DET-04..05: classification ────────────────────

test('DET-04 classifySession marks a read-only exchange trivial', () => {
  const c = classifySession(TRIVIAL_EVENTS);
  assert.equal(c.substantive, false, 'no mutation and no tool use → trivial');
  assert.equal(c.mutatingToolCount, 0);
});

test('DET-05 classifySession marks a mutating session substantive', () => {
  const c = classifySession(SUBSTANTIVE_EVENTS);
  assert.equal(c.substantive, true, 'an Edit means real work happened');
  assert.ok(c.mutatingToolCount >= 1, 'must count the mutating tool calls');
  assert.ok(c.toolCount >= 3, 'must count all tool calls');
});

// ───────────────────────────── DET-06..09: the record ────────────────────────

test('DET-06 buildCloseRecord is deterministic — identical input, identical output', () => {
  const a = buildCloseRecord({ ...BASE, events: SUBSTANTIVE_EVENTS });
  const b = buildCloseRecord({ ...BASE, events: SUBSTANTIVE_EVENTS });
  assert.deepEqual(a, b, 'same input must yield byte-identical records');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'including key order');
});

test('DET-07 buildCloseRecord captures countable facts, not judgment', () => {
  const r = buildCloseRecord({ ...BASE, events: SUBSTANTIVE_EVENTS });

  assert.equal(r.session_id, BASE.sessionId);
  assert.equal(r.harness, 'claude-code');
  assert.equal(r.started_at, BASE.startedAt);
  assert.equal(r.ended_at, BASE.endedAt);
  assert.equal(r.model_calls, 0, 'the automatic close must make ZERO model calls');
  assert.ok(r.counts.tools >= 3, 'tool count present');
  assert.ok(Array.isArray(r.tools_used), 'tool names listed');
  assert.ok(r.tools_used.includes('Edit'), 'Edit recorded');
  assert.ok(Array.isArray(r.files_touched), 'files touched listed');
  assert.ok(r.files_touched.includes('/repo/close-pass.mjs'), 'file path extracted from tool input');
});

test('DET-08 buildCloseRecord bounds every excerpt it retains', () => {
  const huge = 'x'.repeat(50_000);
  const r = buildCloseRecord({
    ...BASE,
    events: [{ idx: 0, kind: 'text', role: 'user', text: huge }],
  });
  const serialized = JSON.stringify(r);
  assert.ok(serialized.length < 8_000,
    `record must stay bounded regardless of transcript size, got ${serialized.length} bytes`);
});

test('DET-09 a trivial session yields a record that does not certify substantive work', () => {
  const r = buildCloseRecord({ ...BASE, events: TRIVIAL_EVENTS });
  assert.equal(r.substantive, false);
  assert.equal(r.model_calls, 0);
});

// ───────────────────────────── DET-10..11: rendering ─────────────────────────

test('DET-10 renderCloseSummary is deterministic and invents nothing', () => {
  const r = buildCloseRecord({ ...BASE, events: SUBSTANTIVE_EVENTS });
  const s1 = renderCloseSummary(r);
  const s2 = renderCloseSummary(r);

  assert.equal(s1, s2, 'rendering must be deterministic');
  assert.ok(s1.includes(BASE.sessionId), 'names the exact session');
  assert.ok(s1.includes('Edit'), 'reports a tool that actually ran');
  assert.ok(!/\bprobably\b|\blikely\b|\bseems\b/i.test(s1),
    'a deterministic summary must contain no hedged inference');
});

test('DET-11 renderCloseSummary marks partial coverage and never claims closed on it', () => {
  const r = buildCloseRecord({
    ...BASE,
    events: SUBSTANTIVE_EVENTS,
    coverage: 'partial',
  });
  const s = renderCloseSummary(r);

  assert.equal(r.coverage, 'partial');
  assert.ok(/partial/i.test(s), 'partial coverage must be visible in the artifact');
  assert.notEqual(r.status, 'closed',
    'partial capsule coverage can never certify a closed status');
});
