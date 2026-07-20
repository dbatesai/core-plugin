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
//     end of file).
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
//     zero-hit-automatic path, not packText alone.
//
// Hale re-audit (hale--f2c52de-two-join-failures, superseding an interim
// nine-of-ten note): two more bounded failures on the "corrected" version:
//   1. Reused-promptId ambiguity was NOT closed "for free" as the comment
//      above used to claim. First-anchor + stop-at-next-different-prompt
//      finds the FIRST contiguous segment and simply ignores a LATER
//      reappearance of the same promptId after an intervening different
//      turn -- that is choosing a turn out of two disjoint candidates, the
//      same evidence-ambiguity class as choosing the last one. Fixed: after
//      the first segment's boundary is found, the rest of the transcript is
//      scanned for another `type:'user'` row carrying the same promptId; if
//      one exists, the whole call spoils REUSED_PROMPT_ID rather than
//      silently accepting the first segment.
//   2. `expectedPackText` and `expectedFullInjectedContext` were two
//      independently caller-supplied, UNRELATED assertions -- a caller
//      could pass an arbitrary pack, copy the transcript's real observed
//      content into expectedFullInjectedContext, and get ok:true plus a
//      fabricated packSha256 that proves nothing about pack -> context.
//      Fixed: expectedFullInjectedContext is GONE. Callers now supply
//      expectedPackText and expectedDirectiveText (either may be '') plus
//      an optional byteCap (default 2048, the real OUTPUT_BYTE_CAP); the
//      oracle DERIVES the expected full emission itself, using the real
//      hook's own truncateUtf8() (imported, not reimplemented) under the
//      exact same branching the product uses: pack+directive UTF-8-
//      truncated to byteCap when both exist; pack alone (untruncated) when
//      only pack exists; directive alone (truncated) when only directive
//      exists; empty when neither exists. Only that DERIVED value is ever
//      compared against the transcript's observed content -- there is no
//      longer any call shape that can assert an unrelated "full context"
//      independent of the pack it supposedly came from.
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
import { truncateUtf8 } from '../plugins/core/skills/core/hooks/retrieve-context-hook.mjs';

const OUTPUT_BYTE_CAP = 2048; // matches retrieve-context-hook.mjs's own default

// Hale, hale--stop-wip-3-of-4-command-identity: checking hookName/type/
// exitCode alone still doesn't prove candidate OWNERSHIP -- a foreign hook
// registered under the same hookName with a different underlying command
// (e.g. a stray user hook also named 'Stop') passed on name alone. Bound
// to the exact command strings configured in this candidate's own
// hooks/hooks.json (verified byte-for-byte, same source-of-truth the
// PINNED_HOOK_SOURCE_SHA256 pin in run-claude-synthetic-trial.mjs already
// trusts) -- the env var is intentionally UNEXPANDED, matching what the
// real transcript's attachment.command field shows.
export const EXPECTED_USER_PROMPT_SUBMIT_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/skills/core/hooks/retrieve-context-hook.mjs"';
export const EXPECTED_STOP_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/skills/core/hooks/answer-close-hook.mjs"';

function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// Mirrors retrieve-context-hook.mjs's real stdout-emission branching
// exactly (packText/reasoningDirective combine step) — reusing the real
// truncateUtf8() rather than a second, potentially-drifting one.
function deriveExpectedEmission(packText, directiveText, byteCap) {
  if (packText && directiveText) return truncateUtf8(packText + directiveText, byteCap);
  if (packText) return packText;
  if (directiveText) return truncateUtf8(directiveText, byteCap);
  return '';
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
 * @param {string} opts.expectedPromptId       required — the native turn identity
 * @param {string} opts.expectedPackText       required (may be '') — the
 *   deterministic retrieval pack text alone, before any directive append or
 *   byte-cap. Hashed and returned as `packSha256` for the separate scorer's
 *   provenance.
 * @param {string} opts.expectedDirectiveText  required (may be '') — the
 *   reasoning-escalation directive text alone, before byte-cap.
 * @param {number} [opts.byteCap]              defaults to 2048 (the real
 *   OUTPUT_BYTE_CAP) — the effective byte cap in force for this trial
 *   (smaller only if CORE_RETRIEVAL_BYTE_CAP was set tighter at fire time).
 *
 * The oracle DERIVES the expected full emission from expectedPackText +
 * expectedDirectiveText + byteCap using the real hook's own branching and
 * truncateUtf8() — there is no separate "expected full context" a caller
 * can assert independently of the pack/directive it supposedly came from.
 *
 * @returns {{ok:true, expectedPromptId, packSha256, injectedContextHash,
 *   finalAnswerHash, finalAnswerText} | {ok:false, reason:<CODE>, ...detail}}
 */
export function checkHostExposureClaudeCode(transcriptPath, opts) {
  const { expectedPromptId, expectedPackText, expectedDirectiveText, byteCap = OUTPUT_BYTE_CAP } = opts || {};
  if (typeof expectedPromptId !== 'string' || !expectedPromptId.trim()) {
    throw new Error('checkHostExposureClaudeCode requires expectedPromptId — the native turn identity to bind against');
  }
  if (typeof expectedPackText !== 'string') {
    throw new Error('checkHostExposureClaudeCode requires expectedPackText — the deterministic retrieval pack text alone (may be \'\'), kept separate for scorer provenance');
  }
  if (typeof expectedDirectiveText !== 'string') {
    throw new Error('checkHostExposureClaudeCode requires expectedDirectiveText — the reasoning-directive text alone (may be \'\'); the oracle derives the real expected emission from this plus expectedPackText');
  }
  if (!Number.isInteger(byteCap) || byteCap < 0) {
    throw new Error(`checkHostExposureClaudeCode requires byteCap to be a non-negative integer when supplied, got ${JSON.stringify(byteCap)}`);
  }
  // Hale watcher finding (byte-cap-and-composition-checkpoint): the real
  // product's OUTPUT_BYTE_CAP (2048) is a hard ceiling -- CORE_RETRIEVAL_BYTE_CAP
  // can only ever tighten it (`Math.min(configuredCap, OUTPUT_BYTE_CAP)`), never
  // widen it. Accepting any non-negative integer here let a caller "prove" an
  // emission the real hook could never actually produce.
  if (byteCap > OUTPUT_BYTE_CAP) {
    throw new Error(`checkHostExposureClaudeCode requires byteCap <= ${OUTPUT_BYTE_CAP} (the product's real OUTPUT_BYTE_CAP ceiling — CORE_RETRIEVAL_BYTE_CAP can only tighten it, never widen it), got ${byteCap}`);
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

  // Reused-promptId spoil (Hale re-audit, hale--f2c52de-two-join-failures):
  // the same "unique" native promptId reappearing anywhere AFTER this
  // turn's own boundary means the identity resolves to two disjoint native
  // turns — choosing the first is the same evidence-ambiguity class as
  // choosing the last, so this must fail closed rather than silently pick
  // one.
  for (let i = boundaryEnd; i < lines.length; i += 1) {
    if (lines[i]?.type === 'user' && lines[i]?.promptId === expectedPromptId) {
      return { ok: false, reason: 'REUSED_PROMPT_ID', expectedPromptId };
    }
  }

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

  // Hale, hale--9561fcd-gated-transcript-contamination-hold: a real gated
  // run showed a user-level PreToolUse:Skill hook firing (pre-tool-memory.sh,
  // injecting the GLOBAL memory index) alongside the candidate's own
  // UserPromptSubmit hook -- the isolation the pilot claims is only over
  // PLUGIN enablement, not over the harness's --setting-sources. The
  // orchestrator now also passes `--setting-sources project,local` to
  // exclude the user-global settings source at invocation time (the
  // root-cause fix); this is the second, transcript-side layer.
  //
  // Two self-corrections chained here, both caught by Hale against real
  // native-shape falsifiers, not synthetic fixtures:
  //   1. A first version flagged ANY second hook attachment, false-
  //      positiving on the candidate's OWN legitimate 'Stop' hook
  //      (answer-close-hook.mjs, which fires on every real invocation).
  //   2. Hale, hale--a138d40-isolation-pass-stop-false-positive /
  //      hale--6e4e086-stop-and-telemetry-hold: an allowlist keyed on
  //      hookName ALONE was still too loose -- it does not require the
  //      Stop hook to actually be SUCCESSFUL (a hook_failure Stop with
  //      exitCode:1 still matched the name and passed), and does not
  //      enforce CARDINALITY (a second, foreign attachment using the same
  //      hookName as a legitimate one -- e.g. two 'Stop' attachments,
  //      one real and one a masquerading foreign hook -- both matched the
  //      allowlist and both passed).
  //
  // The real contract: exactly ONE successful UserPromptSubmit exposure
  // (already required above) plus exactly ONE successful ('hook_success',
  // exitCode 0) 'Stop' attachment, and NOTHING else -- no duplicate of
  // either, no hook_failure of either, no foreign hookName. Any deviation
  // from that exact shape spoils, never inferred from hookName alone.
  const otherHookAttachments = turnLines.filter((l) =>
    l?.type === 'attachment'
    && (l?.attachment?.type === 'hook_success' || l?.attachment?.type === 'hook_failure')
    && l?.uuid
    && l.uuid !== exposures[0].uuid
    && isDescendantOf(lineByUuid, l.uuid, anchorUuid));
  const isLegitimateStop = (l) => l.attachment.type === 'hook_success' && l.attachment.hookName === 'Stop' && l.attachment.exitCode === 0 && l.attachment.command === EXPECTED_STOP_COMMAND;
  const legitimateStops = otherHookAttachments.filter(isLegitimateStop);
  const unexpectedHooks = otherHookAttachments.filter((l) => !isLegitimateStop(l));
  if (legitimateStops.length !== 1 || unexpectedHooks.length > 0) {
    return {
      ok: false, reason: 'UNEXPECTED_HOOK_ACTIVITY', expectedPromptId,
      legitimateStopCount: legitimateStops.length,
      unexpectedCount: unexpectedHooks.length,
      hookNames: otherHookAttachments.map((l) => l.attachment.hookName),
      commands: otherHookAttachments.map((l) => l.attachment.command),
    };
  }
  const exposureAttachment = exposures[0].attachment;
  if (exposureAttachment.exitCode !== 0) {
    return { ok: false, reason: 'HOST_EXPOSURE_NONZERO_EXIT', expectedPromptId, exitCode: exposureAttachment.exitCode };
  }
  // Hale, hale--stop-wip-3-of-4-command-identity: hookName alone doesn't
  // prove candidate ownership -- bind the UserPromptSubmit exposure's
  // command too, same as the Stop side above.
  if (exposureAttachment.command !== EXPECTED_USER_PROMPT_SUBMIT_COMMAND) {
    return { ok: false, reason: 'HOST_EXPOSURE_COMMAND_MISMATCH', expectedPromptId, expected: EXPECTED_USER_PROMPT_SUBMIT_COMMAND, found: exposureAttachment.command };
  }
  const observedContent = exposureAttachment.content;
  if (typeof observedContent !== 'string') {
    return { ok: false, reason: 'HOST_EXPOSURE_MISSING', expectedPromptId, detail: 'hook_success attachment has no content string' };
  }

  // Self-caught (2026-07-20) against a REAL live invocation, not a synthetic
  // fixture: `attachment.content` is Claude Code's own trailing-whitespace-
  // trimmed view of stdout (Hale's earlier finding: content === stdout.trimEnd()
  // was verified for the pack-only case; a real always-on, zero-hit,
  // directive-only invocation shows the SAME normalization applies to a
  // directive-only emission too -- the real hook's own template ends every
  // directive in "\n", but the transcript's content field never carries it.
  // The derived expectation must be compared in the SAME normalized form
  // content actually is, not the raw emission the hook wrote to stdout.
  const derivedExpectedEmission = deriveExpectedEmission(expectedPackText, expectedDirectiveText, byteCap).trimEnd();
  const observedHash = sha256Hex(observedContent);
  const expectedHash = sha256Hex(derivedExpectedEmission);
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

  // Hale, hale--paid-run-direct-file-read-confound: a real gated trial's
  // answer turned out to come from the model directly Bash/Read-ing the
  // carrier file, not from the injected (title-only) pack content -- the
  // orchestrator had no way to see that from an ok:true alone. Every
  // tool_use block anywhere in the turn (descendant-verified, any
  // stop_reason -- a tool call can appear mid-turn before the terminal
  // end_turn group) is surfaced here so a caller can classify whether a
  // token match in the final answer might be tool-mediated rather than
  // pack-delivered. This does not itself decide causality -- it makes the
  // confound visible instead of silently absorbing it into "efficacy."
  const descendantAssistantLines = turnLines.filter((l) =>
    l?.type === 'assistant' && l?.uuid && isDescendantOf(lineByUuid, l.uuid, anchorUuid));
  const toolCallsInTurn = [];
  for (const l of descendantAssistantLines) {
    const content = l.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type === 'tool_use') toolCallsInTurn.push({ name: c.name, input: c.input });
    }
  }

  // Hale, hale--observed-identity-must-be-unambiguous: the prior version
  // (group.find / turnLines.find) silently took the FIRST observed model or
  // CLI version, so a contaminated or mixed transcript -- two different
  // message.model values inside the same terminal message group, or two
  // different top-level `version` values across the turn -- still passed
  // as if unambiguous. Collect every unique non-empty value over the
  // verified descendant evidence and require exactly one of each; anything
  // else is a real ambiguity, not something to silently resolve by picking
  // whichever line happened to come first.
  const observedModels = [...new Set(
    group.map((l) => l.message?.model).filter((m) => typeof m === 'string' && m),
  )];
  if (observedModels.length > 1) {
    return { ok: false, reason: 'MODEL_IDENTITY_AMBIGUOUS', expectedPromptId, observedModels };
  }
  const descendantTurnLines = turnLines.filter((l) => l?.uuid && isDescendantOf(lineByUuid, l.uuid, anchorUuid));
  const observedCliVersions = [...new Set(
    descendantTurnLines.map((l) => l.version).filter((v) => typeof v === 'string' && v),
  )];
  if (observedCliVersions.length > 1) {
    return { ok: false, reason: 'CLI_VERSION_AMBIGUOUS', expectedPromptId, observedCliVersions };
  }
  const observedModel = observedModels[0] || null;
  const observedCliVersion = observedCliVersions[0] || null;

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
    toolCallsInTurn,
    observedModel,
    observedCliVersion,
  };
}
