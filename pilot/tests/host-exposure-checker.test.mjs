import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { checkHostExposureClaudeCode, checkControlAnswerClaudeCode, EXPECTED_USER_PROMPT_SUBMIT_COMMAND, EXPECTED_STOP_COMMAND } = await import(pathToFileURL(join(PILOT, 'host-exposure-checker.mjs')).href);

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
 * of "steps" (tool cycles and/or a terminal end_turn message group), then
 * (by default) the candidate's own legitimate Stop hook attachment -- a
 * REAL completed `-p` invocation always fires both (verified against the
 * real transcript captured in iteration 21). Pass `includeStop: false` to
 * explore the no-Stop-yet case explicitly.
 */
function buildTurn({ promptId, exposedContent, exposedStdout = exposedContent, exitCode = 0, steps, exposureParent = 'chain', includeExposure = true, includeStop = true }) {
  const lines = [];
  const anchorUuid = chain(lines, { type: 'user', promptId, message: { role: 'user', content: [{ type: 'text', text: 'a prompt' }] } }, null);

  const attachmentKinds = ['deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta', 'skill_listing', 'command_permissions'];
  for (const kind of attachmentKinds) chain(lines, { type: 'attachment', attachment: { type: kind } });

  if (includeExposure) {
    const parent = exposureParent === 'orphan' ? uid() : undefined; // 'orphan': parentUuid points to a uuid never in the file
    chain(lines, {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: uid(), content: exposedContent, stdout: exposedStdout, exitCode, command: EXPECTED_USER_PROMPT_SUBMIT_COMMAND, durationMs: 1 },
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
  if (includeStop) {
    chain(lines, {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', toolUseID: uid(), content: '', stdout: '', exitCode: 0, command: EXPECTED_STOP_COMMAND, durationMs: 1 },
    });
  }
  return { lines, anchorUuid };
}

// expectedPackText alone (no directive) IS the full expected emission, per
// the oracle's own deriveExpectedEmission() branching — pack-only, no
// truncation, matches this string byte-for-byte as long as it's under the
// byte cap.
function baseArgs(overrides = {}) {
  return { expectedPromptId: 'p-1', expectedPackText: 'default pack text', expectedDirectiveText: '', ...overrides };
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'Here is the final answer.');
    assert.equal(result.injectedContextHash, sha256Hex(full));
    assert.equal(result.packSha256, sha256Hex(full));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Real emission contract: pack + directive, UTF-8 byte-capped, exactly as
// retrieve-context-hook.mjs emits it — the oracle must derive this itself,
// not trust a caller-supplied "full context" independent of the pack.
test('pack + directive combine under the real byte-cap contract, derived internally', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const pack = 'pack portion. ';
    const directive = 'directive portion.';
    const combined = pack + directive; // well under the 2048 default cap
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: combined, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: pack, expectedDirectiveText: directive }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.packSha256, sha256Hex(pack), 'packSha256 is the pack ALONE, not the combined emission');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Self-caught (2026-07-20) against a REAL live invocation (always-on arm,
// zero retrieval hits, directive-only emission) -- not a synthetic fixture.
// The real hook's own directive template always ends in "\n", but Claude
// Code's transcript `attachment.content` field is trailing-whitespace-
// trimmed relative to raw stdout (the SAME normalization Hale's earlier
// content-vs-stdout finding described, now shown to apply to a
// directive-only emission too, not just the pack case already covered).
// A derived expectation ending in real trailing whitespace must still match
// the transcript's trimmed content, or every always-on zero-hit trial would
// falsely reject.
test('a derived emission with real trailing whitespace (the real directive template) still matches the transcript\'s trimmed content', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const directiveWithTrailingNewline = 'CORE reasoning escalation required: Tier 1 found no lexical context. Follow the Tier 3 retrieval protocol.\n';
    const observedTrimmedContent = directiveWithTrailingNewline.trimEnd(); // exactly what Claude Code's real content field carries
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: observedTrimmedContent, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: '', expectedDirectiveText: directiveWithTrailingNewline }));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale re-audit (hale--f2c52de-two-join-failures), item 2: expectedPackText
// and the old expectedFullInjectedContext used to be two unrelated
// assertions -- a caller could fabricate a pack and separately supply the
// transcript's real observed content, proving context->answer but nothing
// about pack->context. Now there is no such call shape: the derived
// emission MUST come from expectedPackText/expectedDirectiveText, so a
// pack/directive pair that doesn't actually combine to the observed bytes
// fails, even if some other unrelated string would have matched.
test('round 3 item 2: a fabricated pack cannot be paired with unrelated observed content to force ok:true', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const realObserved = 'the real host-injected bytes';
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: realObserved, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }] });
    const path = writeTranscript(root, lines);
    // A caller cannot pass "the real observed content" directly anymore —
    // it must derive from pack+directive. A fabricated pack that doesn't
    // actually equal the observed bytes must fail.
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: 'a fabricated, unrelated pack', expectedDirectiveText: '' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'HOST_EXPOSURE_HASH_MISMATCH');
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: expectedFull }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'Part one. Part two.', 'both text blocks must survive, in order, not just the last');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale round 3, item 1: the same promptId reused after an intervening
// different turn resolves to TWO disjoint native turns — must spoil, never
// silently pick the first (or the last).
test('round 3 item 1: a reused promptId after an intervening different turn spoils REUSED_PROMPT_ID, never pick-first', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const fullA = 'context A';
    const fullOther = 'context OTHER';
    const turnA = buildTurn({ promptId: 'p-1', exposedContent: fullA, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer A' }] }] }).lines;
    const turnOther = buildTurn({ promptId: 'p-OTHER', exposedContent: fullOther, exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer other' }] }] }).lines;
    const turnAReused = buildTurn({ promptId: 'p-1', exposedContent: 'reused context', exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'reused answer' }] }] }).lines;
    const path = writeTranscript(root, [...turnA, ...turnOther, ...turnAReused]);

    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: fullA }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'REUSED_PROMPT_ID');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: NO_USER_TURN_FOUND when the promptId does not appear at all', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: 'x', exitCode: 0, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'a' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-does-not-exist', expectedPackText: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'NO_USER_TURN_FOUND');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: HOST_EXPOSURE_MISSING when the turn has no UserPromptSubmit hook_success attachment', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({ promptId: 'p-1', exposedContent: 'x', exitCode: 0, includeExposure: false, steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'a' }] }] });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: 'x' }));
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

    const resultA = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-A', expectedPackText: fullA }));
    assert.equal(resultA.ok, true, JSON.stringify(resultA));
    assert.equal(resultA.finalAnswerText, 'Answer A.');

    const crossCheck = checkHostExposureClaudeCode(path, baseArgs({ expectedPromptId: 'p-A', expectedPackText: fullB }));
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
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: 'x' }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'MALFORMED_TRANSCRIPT_LINE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: TRANSCRIPT_NOT_FOUND for a path that does not exist', () => {
  const result = checkHostExposureClaudeCode('/definitely/does/not/exist.jsonl', baseArgs({ expectedPackText: 'x' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TRANSCRIPT_NOT_FOUND');
});

test('requires expectedPromptId, expectedPackText, and expectedDirectiveText — refuses to silently proceed without them', () => {
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPackText: 'p', expectedDirectiveText: '' }), /expectedPromptId/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPromptId: 'p-1', expectedDirectiveText: '' }), /expectedPackText/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', { expectedPromptId: 'p-1', expectedPackText: 'p' }), /expectedDirectiveText/);
});

test('requires byteCap to be a non-negative integer when supplied', () => {
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', baseArgs({ byteCap: -1 })), /byteCap/);
  assert.throws(() => checkHostExposureClaudeCode('/tmp/whatever.jsonl', baseArgs({ byteCap: 'nope' })), /byteCap/);
});

// Hale watcher finding (byte-cap-and-composition-checkpoint): the real
// product's OUTPUT_BYTE_CAP (2048) is a hard ceiling a caller must never be
// able to exceed -- a byteCap > 2048 would let a caller "prove" an emission
// the real hook could never actually produce.
test('rejects byteCap greater than the real product OUTPUT_BYTE_CAP (2048)', () => {
  assert.throws(
    () => checkHostExposureClaudeCode('/tmp/whatever.jsonl', baseArgs({ byteCap: 2049 })),
    /byteCap <= 2048/,
  );
  // The real ceiling itself must still be accepted (boundary, not off-by-one).
  assert.doesNotThrow(() => {
    try { checkHostExposureClaudeCode('/tmp/whatever.jsonl', baseArgs({ byteCap: 2048 })); } catch (e) {
      if (e.message.includes('byteCap')) throw e; // only re-throw if it's the cap check itself
    }
  });
});

// Hale, hale--9561fcd-gated-transcript-contamination-hold: a real gated run
// showed a user-level PreToolUse:Skill hook (pre-tool-memory.sh, global
// memory index injection) firing alongside the candidate's own
// UserPromptSubmit hook -- the pilot's isolation only covered plugin
// enablement, not the harness's own --setting-sources. This is the
// transcript-side second layer: for a bare `-p` prompt with no tool use,
// the ONLY hook activity in the turn should be the one counted exposure.
test('UNEXPECTED_HOOK_ACTIVITY: a second hook_success attachment (e.g. a leaked global PreToolUse hook) fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    // Splice in a second, foreign hook_success attachment right after the
    // real exposure -- same shape a leaked global PreToolUse:Skill hook
    // (pre-tool-memory.sh) produces in a real transcript.
    const exposureIdx = lines.findIndex((l) => l.attachment?.hookName === 'UserPromptSubmit');
    const foreignHookLine = {
      type: 'attachment', uuid: 'foreign-hook-1', parentUuid: lines[exposureIdx].uuid,
      attachment: { type: 'hook_success', hookName: 'PreToolUse', hookEvent: 'PreToolUse', toolUseID: 'tu-foreign', content: 'global memory index injected', stdout: 'global memory index injected', exitCode: 0, command: 'bash ~/.claude/hooks/pre-tool-memory.sh', durationMs: 1 },
    };
    lines.splice(exposureIdx + 1, 0, foreignHookLine);
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNEXPECTED_HOOK_ACTIVITY');
    assert.equal(result.unexpectedCount, 1);
    assert.equal(result.legitimateStopCount, 1, 'the default-included legitimate Stop hook must still be recognized as legitimate alongside the foreign one');
    assert.ok(result.hookNames.includes('PreToolUse'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// buildTurn includes the candidate's own legitimate Stop hook by default
// (real transcript shape) -- this is the exposure-plus-legitimate-Stop
// happy path, not "no other hook activity" (that case is covered
// separately below via includeStop:false).
test('UNEXPECTED_HOOK_ACTIVITY: exposure plus the candidate\'s own legitimate Stop hook is NOT a false positive', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale, hale--b75fecc-paid-run-not-release-evidence: "spoil duplicate,
// failed, missing, or mismatched candidate hooks." A MISSING Stop hook
// (the turn window captured before Stop fired, or Stop never fired at
// all) must spoil too -- a real completed `-p` invocation always has one.
test('UNEXPECTED_HOOK_ACTIVITY: a missing Stop hook (never fired) spoils, not treated as optional', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0, includeStop: false,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNEXPECTED_HOOK_ACTIVITY');
    assert.equal(result.legitimateStopCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale's exact falsifier 1 (hale--b75fecc-paid-run-not-release-evidence):
// two descendant Stop attachments -- one real, one a foreign command
// disguised with the SAME hookName -- must not both pass just because the
// name matches. Hale, hale--stop-wip-3-of-4-command-identity: hookName
// alone doesn't prove ownership; the command binding added below is what
// actually catches this -- the foreign one is now correctly classified as
// unexpected (wrong command), not as a second "legitimate" duplicate.
test('UNEXPECTED_HOOK_ACTIVITY: a foreign Stop attachment masquerading with the same hookName but a different command spoils', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    // buildTurn already appended one legitimate Stop; splice in a SECOND
    // one masquerading as the candidate's own (same hookName, different
    // underlying command) right before it.
    const lastUuid = lines[lines.length - 1].uuid;
    lines.splice(lines.length - 1, 0, {
      type: 'attachment', uuid: 'foreign-stop-1', parentUuid: lastUuid,
      attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', toolUseID: 'tu-foreign-stop', content: '', stdout: '', exitCode: 0, command: 'bash ~/.claude/hooks/some-other-stop-hook.sh', durationMs: 1 },
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNEXPECTED_HOOK_ACTIVITY');
    assert.equal(result.legitimateStopCount, 1);
    assert.equal(result.unexpectedCount, 1);
    assert.ok(result.commands.includes('bash ~/.claude/hooks/some-other-stop-hook.sh'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// True duplicate: TWO attachments both with the exact expected command --
// same evidence-ambiguity class as every other duplicate check in this
// pilot. Neither wrong name nor wrong command catches this; cardinality
// (legitimateStops.length !== 1) is what must.
test('UNEXPECTED_HOOK_ACTIVITY: two Stop attachments both with the correct command still spoils (cardinality, not just command binding)', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const lastUuid = lines[lines.length - 1].uuid;
    lines.splice(lines.length - 1, 0, {
      type: 'attachment', uuid: 'true-duplicate-stop-1', parentUuid: lastUuid,
      attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', toolUseID: 'tu-true-dup', content: '', stdout: '', exitCode: 0, command: EXPECTED_STOP_COMMAND, durationMs: 1 },
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNEXPECTED_HOOK_ACTIVITY');
    assert.equal(result.legitimateStopCount, 2);
    assert.equal(result.unexpectedCount, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale's exact falsifier 2: a Stop attachment with type:hook_failure and
// exitCode:1 must not pass just because the hookName matches -- a FAILED
// Stop hook is not "the candidate operating normally."
test('UNEXPECTED_HOOK_ACTIVITY: a failed Stop hook (hook_failure, exitCode 1) spoils, never passes on hookName alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0, includeStop: false,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const lastUuid = lines[lines.length - 1].uuid;
    lines.push({
      type: 'attachment', uuid: 'failed-stop-1', parentUuid: lastUuid,
      attachment: { type: 'hook_failure', hookName: 'Stop', hookEvent: 'Stop', toolUseID: 'tu-failed-stop', content: '', stdout: '', exitCode: 1, command: '', durationMs: 1 },
    });
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'UNEXPECTED_HOOK_ACTIVITY');
    assert.equal(result.legitimateStopCount, 0);
    assert.equal(result.unexpectedCount, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale, hale--observed-identity-must-be-unambiguous: group.find/turnLines.find
// silently took the first observed model/version, so a mixed/contaminated
// transcript still passed as if unambiguous. These four cover the checker's
// own contract directly (missing, mixed-model, mixed-version); the
// requested-vs-observed MISMATCH case is an orchestrator-level concern,
// already covered in run-claude-synthetic-trial.test.mjs.

test('observedModel/observedCliVersion are null (not thrown) when genuinely absent from the transcript', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    for (const l of lines) { if (l.message) delete l.message.model; } // buildTurn's fixture always sets a model — strip it to test genuine absence
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.observedModel, null, 'missing model must surface as null, not throw or silently invent a value');
    assert.equal(result.observedCliVersion, null, 'buildTurn fixtures never set a top-level version field — must be null, not throw');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: MODEL_IDENTITY_AMBIGUOUS when the terminal message group carries two different message.model values', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [{ kind: 'terminal', messageId: 'msg_shared', blocks: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'answer' }] }],
    });
    // Both blocks share one message.id (one logical terminal message split
    // across lines, per the checker's own grouping) but disagree on model —
    // exactly Hale's counterexample: sonnet on one line, opus on the next.
    const terminal = lines.filter((l) => l.type === 'assistant' && l.message?.id === 'msg_shared');
    assert.equal(terminal.length, 2, 'fixture sanity: expected exactly two lines in the shared terminal group');
    terminal[0].message.model = 'claude-sonnet-5';
    terminal[1].message.model = 'claude-opus-4-8';
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'MODEL_IDENTITY_AMBIGUOUS');
    assert.deepEqual([...result.observedModels].sort(), ['claude-opus-4-8', 'claude-sonnet-5']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: CLI_VERSION_AMBIGUOUS when descendant turn lines carry two different top-level version values', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [
        { kind: 'toolUse' }, { kind: 'toolResult' },
        { kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] },
      ],
    });
    // Real transcripts carry a top-level `version` on every line; a mixed
    // sequence (e.g. a CLI upgrade mid-session) must not silently resolve
    // to whichever value happened to appear first.
    let toggled = false;
    for (const l of lines) {
      if (l.type === 'assistant' || (l.type === 'user' && l.message?.content?.[0]?.type === 'tool_result')) {
        l.version = toggled ? '2.1.999' : '2.1.215';
        toggled = !toggled;
      }
    }
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'CLI_VERSION_AMBIGUOUS');
    assert.deepEqual([...result.observedCliVersions].sort(), ['2.1.215', '2.1.999']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a single consistent model and version across the whole descendant turn resolves cleanly, not flagged ambiguous', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const full = 'the full injected context';
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: full, exitCode: 0,
      steps: [
        { kind: 'toolUse' }, { kind: 'toolResult' },
        { kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] },
      ],
    });
    for (const l of lines) { if (l.type === 'assistant' || l.type === 'user') l.version = '2.1.215'; }
    const path = writeTranscript(root, lines);
    const result = checkHostExposureClaudeCode(path, baseArgs({ expectedPackText: full }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.observedModel, 'claude-sonnet-5');
    assert.equal(result.observedCliVersion, '2.1.215');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Hale, hale--6676db9-audit-hold-remediation-plan-required: the control-leg
// oracle for the matched treatment/control design. Its entire premise is
// that no exposure occurred -- these prove that premise is actually
// enforced, not just assumed.

test('checkControlAnswerClaudeCode: a real suppressed turn (no exposure attachment) yields the answer + observed identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: '', includeExposure: false,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer without any injected context' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkControlAnswerClaudeCode(path, { expectedPromptId: 'p-1' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.finalAnswerText, 'answer without any injected context');
    assert.equal(result.observedModel, 'claude-sonnet-5');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('spoil: CONTROL_HOOK_NOT_SUPPRESSED when a UserPromptSubmit exposure exists despite the opt-out (red falsifier)', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-exposure-'));
  try {
    const { lines } = buildTurn({
      promptId: 'p-1', exposedContent: 'context that should never have been injected', includeExposure: true,
      steps: [{ kind: 'terminal', blocks: [{ type: 'text', text: 'answer' }] }],
    });
    const path = writeTranscript(root, lines);
    const result = checkControlAnswerClaudeCode(path, { expectedPromptId: 'p-1' });
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, 'CONTROL_HOOK_NOT_SUPPRESSED');
    assert.equal(result.exposureCount, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('checkControlAnswerClaudeCode requires expectedPromptId, same contract as the treatment checker', () => {
  assert.throws(() => checkControlAnswerClaudeCode('/tmp/whatever.jsonl', {}), /expectedPromptId/);
});
