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
let m = 0;
function msgId() { m += 1; return `msg_${m}`; }

function writeTranscript(root, lines) {
  const path = join(root, 'transcript.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

// A minimal "chain" helper: appends a line, wiring its parentUuid to the
// previous line's uuid (or an explicit override), and returns its uuid.
function chain(lines, line, parentUuid) {
  const id = uid();
  lines.push({ ...line, uuid: id, parentUuid: parentUuid ?? (lines.length ? lines[lines.length - 1].uuid : null) });
  return id;
}

/**
 * Builds a real-shaped Claude Code turn, verified against this session's
 * own live transcript: anchor user line, decorative attachment chain, the
 * UserPromptSubmit hook_success exposure, then a caller-supplied sequence
 * of "steps" (tool cycles and/or a terminal end_turn message group).
 */
function buildTurn({ promptId, exposedContent, exposedStdout = exposedContent, exitCode = 0, steps, exposureParent = 'chain', includeExposure = true }) {
  const lines = [];
  const anchorUuid = chain(lines, { type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text: 'a prompt' }] } }, null);

  const attachmentKinds = ['deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'command_permissions'];
  for (const kind of attachmentKinds) chain(lines, { type: 'attachment', attachment: { type: kind } });

  if (includeExposure) {
    const parent = exposureParent === 'orphan' ? uid() : undefined; // 'orphan': parentUuid points to a uuid never in the file
    chain(lines, {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: uid(), content: exposedContent, stdout: exposedStdout, exitCode, command: '', durationMs: 1 },
    }, parent);
  }

  for (const step of steps) {
    if (step.kind === 'toolUse') {
      chain(lines, { type: 'assistant', message: { model: 'claude-sonnet-5', id: msgId(), role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
    } else if (step.kind === 'toolResult') {
      chain(lines, { type: 'user', promptId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: uid(), content: 'result' }] } });
    } else if (step.kind === 'terminal') {
      const id = step.messageId || msgId();
      const parent = step.orphan ? uid() : undefined;
      let first = true;
      for (const block of step.blocks) {
        chain(lines, { type: 'assistant', message: { model: 'claude-sonnet-5', id, role: 'assistant', stop_reason: 'end_turn', content: [block] } }, first && step.orphan ? parent : undefined);
        first = false;
      }
    }
  }
  return { lines, anchorUuid };
}

function baseArgs(overrides = {}) {
  return { expectedPromptId: 'p-1', expectedPackText: 'pack text alone', expectedFullInjectedContext: 'full injected context', ...overrides };
}

test('happy path: tool-using turn — real exposure survives, terminal end_turn is the answer', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [
        { kind: 'toolUse' }, { kind: 'toolResult' },
        { kind: 'terminal', blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Here is the final answer.' }] },
      ],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'Here is the final answer.');
    assert.equal(result.injectedContextHash, sha256Hex(full));
    assert.equal(result.packSha256, sha256Hex('pack text alone'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 1: real same-promptId tool-result row loses the
// initial exposure with a LAST-anchor design (fixed: anchor on FIRST).
test('round 2 item 1: a tool-using turn (same-promptId tool_result mid-turn) does not lose the initial exposure', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'toolUse' }, { kind: 'toolResult' }, { kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 2: a duplicate exposure after the tool_result must
// spoil ambiguous, not hide behind a LAST-anchor design.
test('round 2 item 2: a second exposure appearing after a tool_result is caught as ambiguous, not hidden', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'toolUse' }, { kind: 'toolResult' }, { kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    // Insert a second, real-shaped exposure after the tool_result line.
    const toolResultIdx = lines.findIndex((l) => l.type === 'user' && l.message?.content?.[0]?.type === 'tool_result');
    const dupId = uid();
    lines.splice(toolResultIdx + 1, 0, {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: uid(), content: full, stdout: full, exitCode: 0 },
      uuid: dupId, parentUuid: lines[toolResultIdx].uuid,
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_AMBIGUOUS');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 3: a UserPromptSubmit row whose parentUuid chain does
// not actually descend from the native turn must not pass.
test('round 2 item 3: a non-descendant (orphan) exposure does not pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0, exposureParent: 'orphan',
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_MISSING', 'the orphan exposure must not count at all');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 4: text on a tool_use-terminated assistant event must
// never pass as the final answer.
test('round 2 item 4: text on a tool_use stop_reason never counts as the final answer', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'toolUse' }], // only a tool_use turn, no real end_turn ever follows
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ANSWER_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 5: two distinct end_turn message groups on one native
// turn must spoil ambiguous, never pick-last.
test('round 2 item 5: two distinct terminal answer groups spoil ambiguous, not pick-last', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [
        { kind: 'terminal', blocks: [{ type: 'text', text: 'first answer' }] },
        { kind: 'terminal', blocks: [{ type: 'text', text: 'second answer' }] },
      ],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'AMBIGUOUS_FINAL_ANSWER');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 6: hashing raw stdout (with its real trailing LF)
// against a `content`-shaped expectation must not falsely reject.
test('round 2 item 6: a trailing-LF-only difference between content and stdout never falsely rejects', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the exact injected bytes';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exposedStdout: `${full}\n`, exitCode: 0, // real observed shape: stdout has a trailing LF, content doesn't
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 7: matching stdout must not hide a divergent content —
// content is authoritative, not stdout.
test('round 2 item 7: a divergent content is caught even when stdout happens to match', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const expectedFull = 'the real expected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: 'a divergent, wrong content value', exposedStdout: expectedFull, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: expectedFull }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_HASH_MISMATCH', 'content, not stdout, must be the compared authority');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 8: a nonzero native hook exitCode must spoil closed.
test('round 2 item 8: a nonzero exitCode on the exposure fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 1,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_NONZERO_EXIT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 9: a single terminal message split across multiple
// text blocks/lines must be preserved whole, in order — never reduced to
// just the last block.
test('round 2 item 9: multiple text blocks in one terminal message group are preserved whole, in order', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'context';
    const oneId = msgId();
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', messageId: oneId, blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Part one. ' }, { type: 'text', text: 'Part two.' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'Part one. Part two.', 'both text blocks must survive, in order, not just the last');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 2, item 10: the same promptId reused after an intervening
// different turn must not be treated as one contiguous, pick-last turn.
test('round 2 item 10: a reused promptId after an intervening different turn is out of scope, not pick-last', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const fullA = 'context A';
    const fullOther = 'context OTHER';
    const turnA = buildTurn({ promptId: 'p-1', exposedContent: fullA, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer A' }] }] }).lines;
    const turnOther = buildTurn({ promptId: 'p-OTHER', exposedContent: fullOther, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer other' }] }] }).lines;
    // p-1 reused later, after the intervening different turn — must never
    // be merged into the first p-1 window.
    const turnAReused = buildTurn({ promptId: 'p-1', exposedContent: 'reused context', exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'reused answer' }] }] }).lines;
    const path = writeTranscript(root, [...turnA, ...turnOther, ...turnAReused]);

    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: fullA }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'answer A', 'must bind to the FIRST p-1 window, never merge with the reused one');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: NO_USER_TURN_FOUND when the promptId does not appear at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: 'x', exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'a' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-does-not-exist', expectedFullInjectedContext: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_USER_TURN_FOUND');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: HOST_EXPOSURE_MISSING when the turn has no UserPromptSubmit hook_success attachment', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: 'x', exitCode: 0, includeExposure: false, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'a' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_MISSING');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('boundary correctness: content from a DIFFERENT turn never leaks into this one', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const fullA = 'context for turn A';
    const fullB = 'context for turn B';
    const turnA = buildTurn({ promptId: 'p-A', exposedContent: fullA, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'Answer A.' }] }] }).lines;
    const turnB = buildTurn({ promptId: 'p-B', exposedContent: fullB, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'Answer B.' }] }] }).lines;
    const path = writeTranscript(root, [...turnA, ...turnB]);

    const resultA = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-A', expectedFullInjectedContext: fullA }));
    assert.equal(resultA.ok, true, JSON.stringify(resultA));
    assert.equal(resultA.finalAnswerText, 'Answer A.');

    const crossCheck = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-A', expectedFullInjectedContext: fullB }));
    assert.equal(crossCheck.ok, false);
    assert.equal(crossCheck.reason, 'HOST_EXPOSURE_HASH_MISMATCH');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: MALFORMED_TRANSCRIPT_LINE fails closed instead of silently skipping a corrupt line', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: 'x', exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'a' }] }] });
    const path = join(root, 'transcript.jsonl');
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot valid json\n');
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedFullInjectedContext: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MALFORMED_TRANSCRIPT_LINE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: TRANSCRIPT_NOT_FOUND for a path that does not exist', () => {
  const result = checkHostExposureClaudeCode('/definitely/does/not/exist.jsonl', baseArgs({ expectedFullInjectedContext: 'x' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TRANSCRIPT_NOT_FOUND');
});

test('requires expectedPromptId, expectedPackText, and expectedFullInjectedContext — refuses to silently proceed without them', () => {
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPackText: 'p', expectedFullInjectedContext: 'f' }), /expectedPromptId/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPromptId: 'p-1', expectedFullInjectedContext: 'f' }), /expectedPackText/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPromptId: 'p-1', expectedPackText: 'p' }), /expectedFullInjectedContext/);
});
