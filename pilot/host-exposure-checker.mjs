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
// shape rather than an invented one.
//
// Real substrate, verified against this session's own live transcript
// (~/.claude/projects/<slug>/<session>.jsonl) before writing a line of this
// module, not assumed:
//   - A native turn's real content lands in one or more `type:'user'` lines
//     sharing one `promptId` (the harness's own per-turn identity).
//   - Immediately after, a short chain of `type:'attachment'` lines follows
//     (deferred_tools_delta, agent_listing_delta, mcp_instructions_delta,
//     skill_listing, command_permissions, ...) linked front-to-back via
//     parentUuid. ONE of these, when CORE's UserPromptSubmit hook fires,
//     has `attachment.type === 'hook_success'` and
//     `attachment.hookName === 'UserPromptSubmit'` -- its `.stdout` field
//     is the EXACT bytes Claude Code injected into the turn's context.
//     This is the host-observed exposure, independent of anything the hook
//     itself claims about its own delivery.
//   - `type:'assistant'` lines follow, each `message.content[]` carrying
//     `{type:'text', text}` and/or `{type:'tool_use', ...}` blocks. A turn
//     can legitimately contain several text blocks interleaved with tool
//     calls; the real final answer is the LAST text block before the next
//     user-type line begins a new turn.
//
// Codex explicitly NOT covered here (Hale's own allowance: implement one
// harness fully rather than block on transcript-shape discovery for both).
// Checked real rollout-*.jsonl files on this machine first: Codex persists
// NO per-line turn identifier in the saved transcript at all (only
// `{payload, timestamp, type}` -- `turn_id` exists only in the Stop hook's
// ephemeral stdin payload at fire time, never written to the rollout file).
// Binding a Codex turn therefore needs its own verified ordering algorithm,
// not a field-based join like Claude Code's promptId -- named as the next
// real step, not silently assumed done.
//
// Scope, stated honestly: `ok:true` proves the deterministic pack text the
// runner computed matches, byte-for-byte, what the transcript shows the
// host actually injected for this exact native turn, AND that exactly one
// real final answer followed. It says nothing about whether the model USED
// the context or whether the answer was correct -- that is the separate,
// still-to-build raw-answer-vs-hook-delivery scorer, deliberately kept out
// of this file (Hale's point 6: keep scoring separate).
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * checkHostExposureClaudeCode — the host-exposure oracle for Claude Code.
 *
 * @param {string} transcriptPath   path to the real .jsonl transcript
 * @param {object} opts
 * @param {string} opts.expectedPromptId   required — the native turn identity
 *   (Claude Code's own per-turn `promptId`, captured by the runner at the
 *   moment it fires the trial's real prompt)
 * @param {string} opts.expectedPackText   required — the exact deterministic
 *   content the runner computed SHOULD have been injected for this trial
 *   (e.g. captured from the retrieval trace at fire time). Hashed and
 *   compared byte-for-byte against what the transcript shows was actually
 *   observed on stdout -- never assumed equal.
 * @returns {{ok:true, expectedPromptId, injectedContextHash, finalAnswerHash,
 *   finalAnswerText} | {ok:false, reason:<CODE>, ...detail}}
 */
export function checkHostExposureClaudeCode(transcriptPath, opts) {
  const { expectedPromptId, expectedPackText } = opts || {};
  if (typeof expectedPromptId !== 'string' || !expectedPromptId.trim()) {
    throw new Error('checkHostExposureClaudeCode requires expectedPromptId — the native turn identity to bind against');
  }
  if (typeof expectedPackText !== 'string') {
    throw new Error('checkHostExposureClaudeCode requires expectedPackText — the deterministic content the runner computed should have been injected, hashed and compared against what the transcript actually observed');
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

  // The anchor is the LAST line carrying the expected promptId — a real
  // turn can legitimately span several consecutive same-promptId user
  // lines (verified on disk); everything that follows, up to the next
  // DIFFERENT promptId's user line, belongs to this turn.
  let anchorIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.type === 'user' && lines[i]?.promptId === expectedPromptId) anchorIdx = i;
  }
  if (anchorIdx === -1) {
    return { ok: false, reason: 'NO_USER_TURN_FOUND', expectedPromptId };
  }

  let boundaryEnd = lines.length;
  for (let i = anchorIdx + 1; i < lines.length; i += 1) {
    if (lines[i]?.type === 'user' && lines[i]?.promptId !== expectedPromptId) { boundaryEnd = i; break; }
  }
  const turnLines = lines.slice(anchorIdx + 1, boundaryEnd);

  const exposures = turnLines.filter((l) => l?.type === 'attachment' && l?.attachment?.type === 'hook_success' && l?.attachment?.hookName === 'UserPromptSubmit');
  if (exposures.length === 0) {
    return { ok: false, reason: 'HOST_EXPOSURE_MISSING', expectedPromptId };
  }
  if (exposures.length > 1) {
    return { ok: false, reason: 'HOST_EXPOSURE_AMBIGUOUS', expectedPromptId, count: exposures.length };
  }
  const observedStdout = exposures[0].attachment.stdout;
  if (typeof observedStdout !== 'string') {
    return { ok: false, reason: 'HOST_EXPOSURE_MISSING', expectedPromptId, detail: 'hook_success attachment has no stdout string' };
  }

  const observedHash = sha256Hex(observedStdout);
  const expectedHash = sha256Hex(expectedPackText);
  if (observedHash !== expectedHash) {
    return { ok: false, reason: 'HOST_EXPOSURE_HASH_MISMATCH', expected: expectedHash, observed: observedHash };
  }

  const answerTexts = [];
  for (const l of turnLines) {
    if (l?.type !== 'assistant') continue;
    const content = l?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) answerTexts.push(c.text);
    }
  }
  if (answerTexts.length === 0) {
    return { ok: false, reason: 'ANSWER_MISSING', expectedPromptId };
  }
  const finalAnswerText = answerTexts[answerTexts.length - 1];

  // This ok:true proves exposure + a real final answer, nothing about
  // whether the answer was correct or actually used the context — that
  // stays the separate scorer's job.
  return {
    ok: true,
    expectedPromptId,
    injectedContextHash: observedHash,
    finalAnswerHash: sha256Hex(finalAnswerText),
    finalAnswerText,
  };
}
