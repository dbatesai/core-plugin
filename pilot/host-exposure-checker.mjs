#!/usr/bin/env node
// host-exposure-checker.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 4, 2026-07-20,
// hale--397ab25-join-pass-host-exposure-next).
//
// The join checker proves a retrieval and its immediate Stop outcome exist
// and join cleanly. It does NOT prove the host actually exposed the
// retrieved content to the model, or that a real final answer followed --
// Hale named that explicitly as a separate, still-required receipt. This is
// that receipt, for Claude Code, built against a REAL verified transcript
// shape.
//
// Hale re-audit (hale--bc46d66-consolidated-ten-case-hold), superseding an
// earlier five-item first pass: the first version's model of a "turn" was
// wrong on any tool-using turn, and it hashed the wrong field. Corrected
// turn model, verified against this session's own live transcript again:
//   - A native turn begins at the FIRST `type:'user'` line carrying the
//     expected `promptId` (not the last -- a tool-using turn re-emits
//     `type:'user'` tool_result lines with the SAME promptId later in the
//     same turn; anchoring on the last one loses the real initial exposure
//     entirely).
//   - The turn's boundary runs through same-promptId tool-result lines and
//     ends at the next `type:'user'` line carrying a DIFFERENT promptId (or
//     end of file). This also closes reused-promptId ambiguity for free --
//     content after an intervening different turn is simply outside the
//     window.
//   - Every candidate exposure/terminal-answer line inside that window must
//     additionally be a real parentUuid DESCENDANT of the turn's anchor
//     line -- a line that happens to sit in the right index range but
//     doesn't actually chain back through this turn (sidechain/subagent
//     interleaving, a stray/duplicated uuid) is not this turn's content.
//   - The exposure's authoritative bytes are `attachment.content`, not
//     `attachment.stdout` -- verified on a real row: `stdout` carries a
//     trailing LF `content` does not (`content === stdout.trimEnd()`).
//     Hashing stdout produces both false rejects (content matches, stdout's
//     extra byte doesn't) and false passes (content diverges, stdout still
//     matches by coincidence) -- content is the real host-injected value.
//     `attachment.exitCode` must also be exactly 0 -- a nonzero exit means
//     the hook's own output is not trustworthy as "what was injected."
//   - Claude Code emits ONE JSONL line per content BLOCK, not one line per
//     logical message -- a single model turn with a thinking block and a
//     text block is TWO consecutive `type:'assistant'` lines, both sharing
//     one `message.id` and one `message.stop_reason`. The real terminal
//     answer is identified by `stop_reason === 'end_turn'`, grouped by
//     `message.id` (there must be exactly one such group in the window),
//     with ALL of that group's `text`-type blocks concatenated in file
//     order -- never just the last block, and never a `tool_use`-terminated
//     turn's text mistaken for the real answer.
//   - The full expected injected context and the deterministic pack text
//     alone are DIFFERENT things and must not be conflated: the real hook
//     emits `packText + reasoningDirective` (byte-capped) on the always-on/
//     zero-hit-automatic path, not packText alone. Callers now supply both
//     separately; only the full-context value is compared against the
//     transcript, and the pack-text hash is preserved separately as
//     provenance for the (separate) scorer, never asserted equal to the
//     observed bytes itself.
//
// Codex explicitly NOT covered here (Hale's own allowance: implement one
// harness fully rather than block on transcript-shape discovery for both).
// Checked real rollout-*.jsonl files on this machine: Codex persists NO
// per-line turn identifier in the saved transcript at all -- named as the
// next real step, not silently assumed done.
//
// Scope, stated honestly: `ok:true` proves the full expected injected
// context matches, byte-for-byte, what the transcript shows the host
// actually injected for this exact native turn (exitCode 0, single
// descendant exposure), AND that exactly one real terminal answer followed
// (single descendant end_turn message group, its ordered text preserved
// whole). It says nothing about whether the model USED the context or
// whether the answer was correct -- that is the separate, still-to-build
// raw-answer-vs-hook-delivery scorer, deliberately kept out of this file.
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function isDescendantOf(lineByUuid, candidateUuid, ancestorUuid) {
  let cur = candidateUuid;
  let steps = 0;
  while (cur != null && steps < 100000) {
    if (cur === ancestorUuid) return true;
    const node = lineByUuid.get(cur);
    if (!node) return false;
    cur = node.parentUuid;
    steps += 1;
  }
  return false;
}

/**
 * checkHostExposureClaudeCode — the host-exposure oracle for Claude Code.
 *
 * @param {string} transcriptPath   path to the real .jsonl transcript
 * @param {object} opts
 * @param {string} opts.expectedPromptId              required — the native turn identity
 * @param {string} opts.expectedPackText               required — the deterministic
 *   retrieval pack text ALONE, before any directive append/byte-cap. Hashed
 *   and returned as `packSha256` for the separate scorer's provenance —
 *   never compared against the transcript directly (the hook may append a
 *   reasoning directive and byte-cap the result, so pack text alone is not
 *   what actually lands on stdout/content).
 * @param {string} opts.expectedFullInjectedContext    required — the exact
 *   text the runner computed the hook SHOULD have emitted for this trial
 *   (pack text plus any directive, already byte-capped as the real hook
 *   would). Compared byte-for-byte against the transcript's observed
 *   `attachment.content`.
 * @returns {{ok:true, expectedPromptId, packSha256, injectedContextHash,
 *   finalAnswerHash, finalAnswerText} | {ok:false, reason:<CODE>, ...detail}}
 */
export function checkHostExposureClaudeCode(transcriptPath, opts) {
  const { expectedPromptId, expectedPackText, expectedFullInjectedContext } = opts || {};
  if (typeof expectedPromptId !== 'string' || !expectedPromptId.trim()) {
    throw new Error('checkHostExposureClaudeCode requires expectedPromptId — the native turn identity to bind against');
  }
  if (typeof expectedPackText !== 'string') {
    throw new Error('checkHostExposureClaudeCode requires expectedPackText — the deterministic retrieval pack text alone, kept separate for scorer provenance');
  }
  if (typeof expectedFullInjectedContext !== 'string') {
    throw new Error('checkHostExposureClaudeCode requires expectedFullInjectedContext — the exact full text the hook should have emitted (pack + directive, byte-capped), compared against the transcript');
  }
  if (!existsSync(transcriptPath)) {
    return { ok: false, reason: 'TRANSCRIPT_NOT_FOUND', path: transcriptPath };
  }

  const raw = readFileSync(transcriptPath, 'utf8');
  const rawLines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const lines = [];
  for (const line of rawLines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch {
      return { ok: false, reason: 'MALFORMED_TRANSCRIPT_LINE' };
    }
    lines.push(parsed);
  }

  const lineByUuid = new Map();
  for (const l of lines) { if (l?.uuid) lineByUuid.set(l.uuid, l); }

  // The anchor is the FIRST line carrying the expected promptId — a
  // tool-using turn re-emits type:'user' tool_result lines with the SAME
  // promptId later in the SAME turn; anchoring on the last occurrence loses
  // the real initial exposure entirely.
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.type === 'user' && lines[i]?.promptId === expectedPromptId) { anchorIdx = i; break; }
  }
  if (anchorIdx === -1) {
    return { ok: false, reason: 'NO_USER_TURN_FOUND', expectedPromptId };
  }
  const anchorUuid = lines[anchorIdx].uuid;

  let boundaryEnd = lines.length;
  for (let i = anchorIdx + 1; i < lines.length; i += 1) {
    if (lines[i]?.type === 'user' && lines[i]?.promptId !== expectedPromptId) { boundaryEnd = i; break; }
  }
  const turnLines = lines.slice(anchorIdx + 1, boundaryEnd);

  const exposures = turnLines.filter((l) =>
    l?.type === 'attachment'
    && l?.attachment?.type === 'hook_success'
    && l?.attachment?.hookName === 'UserPromptSubmit'
    && l?.uuid
    && isDescendantOf(lineByUuid, l.uuid, anchorUuid));
  if (exposures.length === 0) {
    return { ok: false, reason: 'HOST_EXPOSURE_MISSING', expectedPromptId };
  }
  if (exposures.length > 1) {
    return { ok: false, reason: 'HOST_EXPOSURE_AMBIGUOUS', expectedPromptId, count: exposures.length };
  }
  const exposureAttachment = exposures[0].attachment;
  if (exposureAttachment.exitCode !== 0) {
    return { ok: false, reason: 'HOST_EXPOSURE_NONZERO_EXIT', expectedPromptId, exitCode: exposureAttachment.exitCode };
  }
  const observedContent = exposureAttachment.content;
  if (typeof observedContent !== 'string') {
    return { ok: false, reason: 'HOST_EXPOSURE_MISSING', expectedPromptId, detail: 'hook_success attachment has no content string' };
  }

  const observedHash = sha256Hex(observedContent);
  const expectedHash = sha256Hex(expectedFullInjectedContext);
  if (observedHash !== expectedHash) {
    return { ok: false, reason: 'HOST_EXPOSURE_HASH_MISMATCH', expected: expectedHash, observed: observedHash };
  }

  // Terminal answer: real descendant assistant lines with stop_reason
  // 'end_turn', grouped by message.id (one logical message can split
  // across several consecutive lines, one content block per line).
  const terminalLines = turnLines.filter((l) =>
    l?.type === 'assistant'
    && l?.message?.stop_reason === 'end_turn'
    && l?.uuid
    && isDescendantOf(lineByUuid, l.uuid, anchorUuid));
  const messageIds = [...new Set(terminalLines.map((l) => l.message.id).filter(Boolean))];
  if (messageIds.length === 0) {
    return { ok: false, reason: 'ANSWER_MISSING', expectedPromptId };
  }
  if (messageIds.length > 1) {
    return { ok: false, reason: 'AMBIGUOUS_FINAL_ANSWER', expectedPromptId, count: messageIds.length };
  }
  const group = terminalLines.filter((l) => l.message.id === messageIds[0]);
  const textBlocks = [];
  for (const l of group) {
    const content = l.message.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string') textBlocks.push(c.text);
    }
  }
  if (textBlocks.length === 0) {
    return { ok: false, reason: 'ANSWER_MISSING', expectedPromptId };
  }
  const finalAnswerText = textBlocks.join('');

  // This ok:true proves exposure + a real terminal answer, nothing about
  // whether the answer was correct or actually used the context — that
  // stays the separate scorer's job.
  return {
    ok: true,
    expectedPromptId,
    packSha256: sha256Hex(expectedPackText),
    injectedContextHash: observedHash,
    finalAnswerHash: sha256Hex(finalAnswerText),
    finalAnswerText,
  };
}
