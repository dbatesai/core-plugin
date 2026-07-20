import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { checkHostExposureClaudeCode } = await import(pathToFileURL(join(PILOT, 'host-exposure-checker.mjs')).href);

function sha256Hex(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

let n = 0;
function uid() { n += 1; return `uuid-${n}`; }

function writeTranscript(root, lines) {
  const path = join(root, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// Builds a real-shaped (verified against this session's own live transcript)
// Claude Code turn: one user line, the real attachment chain ending in the
// UserPromptSubmit hook_success (unless suppressed), then assistant text
// blocks.
function buildTurn({ promptId, packText, answerTexts = ['Final answer text.'], includeExposure = true, exposureCount = 1 }) {
  let prev = uid();
  const lines = [
    { type: 'user', promptId, uuid: prev, parentUuid: null, message: { role: 'user', content: [{ type: 'text', text: 'a prompt' }] } },
  ];
  const attachmentKinds = ['deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'command_permissions'];
  for (const kind of attachmentKinds) {
    const id = uid();
    lines.push({ type: 'attachment', attachment: { type: kind }, uuid: id, parentUuid: prev });
    prev = id;
  }
  if (includeExposure) {
    for (let i = 0; i < exposureCount; i += 1) {
      const id = uid();
      lines.push({
        type: 'attachment',
        attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: uid(), content: packText, stdout: packText },
        uuid: id, parentUuid: prev,
      });
      prev = id;
    }
  }
  for (const text of answerTexts) {
    const id = uid();
    lines.push({ type: 'assistant', uuid: id, parentUuid: prev, message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text }] } });
    prev = id;
  }
  return lines;
}

test('happy path: exact pack-text match and one real final answer', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const packText = 'Relevant stored context (CORE per-turn retrieval):\n- some-unit: a summary';
    const path = writeTranscript(root, buildTurn({ promptId: 'p-1', packText, answerTexts: ['Working on it.', 'Here is the final answer.'] }));

    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: packText });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'Here is the final answer.', 'the LAST text block is the real final answer, not the first');
    assert.equal(result.injectedContextHash, sha256Hex(packText));
    assert.equal(result.finalAnswerHash, sha256Hex('Here is the final answer.'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a real multi-line user turn (consecutive same-promptId lines) anchors correctly', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const packText = 'context text';
    const lines = buildTurn({ promptId: 'p-1', packText });
    // Insert a second consecutive same-promptId user line right after the first,
    // matching the real observed multi-part shape.
    lines.splice(1, 0, { type: 'user', promptId: 'p-1', uuid: uid(), parentUuid: lines[0].uuid, message: { role: 'user', content: [{ type: 'tool_result', content: 'more input' }] } });
    const path = writeTranscript(root, lines);

    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: packText });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: NO_USER_TURN_FOUND when the promptId does not appear at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const path = writeTranscript(root, buildTurn({ promptId: 'p-1', packText: 'x' }));
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-does-not-exist', expectedPackText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_USER_TURN_FOUND');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: HOST_EXPOSURE_MISSING when the turn has no UserPromptSubmit hook_success attachment', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const path = writeTranscript(root, buildTurn({ promptId: 'p-1', packText: 'x', includeExposure: false }));
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: HOST_EXPOSURE_AMBIGUOUS when two hook_success attachments land in the same turn', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const path = writeTranscript(root, buildTurn({ promptId: 'p-1', packText: 'x', exposureCount: 2 }));
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_AMBIGUOUS');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: HOST_EXPOSURE_HASH_MISMATCH when the observed stdout differs from the expected pack text, even by one byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const path = writeTranscript(root, buildTurn({ promptId: 'p-1', packText: 'the real injected text' }));
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: 'the real injected text!' }); // one extra byte
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_HASH_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: ANSWER_MISSING when the turn has no assistant text block at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const lines = buildTurn({ promptId: 'p-1', packText: 'x', answerTexts: [] });
    // Replace with a tool-only assistant line so the turn has assistant
    // activity but genuinely no text answer.
    lines.push({ type: 'assistant', uuid: uid(), parentUuid: lines[lines.length - 1].uuid, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ANSWER_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('boundary correctness: content from a DIFFERENT turn never leaks into this one', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const packTextA = 'context for turn A';
    const packTextB = 'context for turn B';
    const turnA = buildTurn({ promptId: 'p-A', packText: packTextA, answerTexts: ['Answer A.'] });
    const turnB = buildTurn({ promptId: 'p-B', packText: packTextB, answerTexts: ['Answer B.'] });
    const path = writeTranscript(root, [...turnA, ...turnB]);

    const resultA = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-A', expectedPackText: packTextA });
    assert.equal(resultA.ok, true, JSON.stringify(resultA));
    assert.equal(resultA.finalAnswerText, 'Answer A.', 'turn A must not see turn B\'s answer');

    const resultB = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-B', expectedPackText: packTextB });
    assert.equal(resultB.ok, true, JSON.stringify(resultB));
    assert.equal(resultB.finalAnswerText, 'Answer B.');

    // Turn A checked against turn B's pack text must fail — proves the
    // exposure isn't picked up from anywhere in the file, only THIS turn.
    const crossCheck = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-A', expectedPackText: packTextB });
    assert.equal(crossCheck.ok, false);
    assert.equal(crossCheck.reason, 'HOST_EXPOSURE_HASH_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: MALFORMED_TRANSCRIPT_LINE fails closed instead of silently skipping a corrupt line', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const lines = buildTurn({ promptId: 'p-1', packText: 'x' });
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot valid json\n');
    const result = checkHostExposureClaudeCode(path, { expectedPromptId: 'p-1', expectedPackText: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MALFORMED_TRANSCRIPT_LINE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: TRANSCRIPT_NOT_FOUND for a path that does not exist', () => {
  const result = checkHostExposureClaudeCode('/definitely/does/not/exist.jsonl', { expectedPromptId: 'p-1', expectedPackText: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TRANSCRIPT_NOT_FOUND');
});

test('requires expectedPromptId and expectedPackText — refuses to silently proceed without them', () => {
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPackText: 'x' }), /expectedPromptId/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPromptId: 'p-1' }), /expectedPackText/);
});
