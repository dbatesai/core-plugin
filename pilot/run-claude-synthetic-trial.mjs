#!/usr/bin/env node
// run-claude-synthetic-trial.mjs — synthetic-decoy runner orchestrator,
// three-arm memory-efficacy pilot (Hale's runner amendment 7, 2026-07-20,
// hale--byte-cap-and-composition-checkpoint / hale--685d9c6-auth-unblock).
//
// Composes every proven primitive into one real, rerunnable, fail-closed
// evidence envelope: corpus validation, candidate identity via the
// verified settings-overlay/--plugin-dir technique, one real authenticated
// `claude -p` invocation, the trial-window join checker, and the host-
// exposure checker -- exactly the six-step contract Hale specified, minus
// step 1's "copy content-only memory files" (the caller supplies a
// ready-made decoy storeDir; this module validates it, it doesn't build it).
//
// PROVEN FOR REAL this iteration, not simulated: this exact composition
// (settings overlay -> real `claude -p` spawn -> real retrieval/outcome
// rows -> join checker -> host-exposure checker with independently-derived
// pack/directive text) was run by hand against a real authenticated
// invocation and returned ok:true end to end, including extracting the
// real final answer text ("pong") matching what the CLI itself returned.
// That hand run also surfaced and closed a real bug in the host-exposure
// checker (content-vs-stdout trailing-whitespace normalization) that no
// synthetic fixture had exercised -- see host-exposure-checker.mjs's
// "Self-caught... against a REAL live invocation" note.
//
// Scope, stated honestly: only 'always-on' and 'deterministic-only' arms
// are supported. 'automatic' is NOT yet supported -- its expected
// directive_fired depends on whether Tier 1 found a real hit, which this
// orchestrator does not yet compute independently before the invocation
// (it would need to run the exact same zero-hit check the hook performs,
// ahead of time, to know what to expect -- a real but separate piece of
// work, named here rather than guessed at). Requesting 'automatic' throws.
//
// The real invocation costs real money (verified: ~$0.11-0.14 for a
// trivial one-word prompt on this account). runTrial() DOES spawn for
// real when called -- callers control cost by controlling how often they
// call it, never by a hidden mock. The test suite for this module does
// NOT spawn by default; its one real-spawn test is gated behind
// RUN_REAL_CLAUDE_TRIAL=1, exactly per Hale's allowance ("even if its
// model-spawn test is conditionally skipped until the real run").
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { captureCursor, checkTrialWindow } from './trial-window-join-checker.mjs';
import { checkHostExposureClaudeCode } from './host-exposure-checker.mjs';
import { fetchPluginInventory, computeDisableAllOverlay, verifyOverlayApplied } from './invocation-plugin-overlay.mjs';

const SUPPORTED_ARMS = new Set(['always-on', 'deterministic-only']);

// Mirrors retrieve-context-hook.mjs's real inline directive template
// EXACTLY -- verified byte-for-byte against a real invocation this
// iteration, not guessed at. If the hook's template ever changes, this
// must be updated to match (there is no exported function to import
// instead; the template lives inline in the hook's main()).
function realDirectiveTemplate({ why, shardCount, unitsTotal }) {
  return `CORE reasoning escalation required: ${why} Follow the Tier 3 retrieval protocol and inspect all ${shardCount} shard(s) covering ${unitsTotal} active units with select-relevant-units.mjs; reason over each shard using the current prompt before concluding no relevant memory exists.\n`;
}

/**
 * deriveExpectedPackAndDirective — independently computes what the hook
 * SHOULD emit for this exact prompt/store/arm, using the real exported
 * retrieval functions -- never reads the transcript to find out.
 */
async function deriveExpectedPackAndDirective(prompt, storeDir, arm, coreRoot) {
  const { buildRetrievalTrace } = await import(join(coreRoot, 'scripts', 'retrieve-context.mjs'));
  const { selectCandidates } = await import(join(coreRoot, 'scripts', 'select-relevant-units.mjs'));
  const trace = buildRetrievalTrace(prompt, storeDir, { topN: 3, byteCap: 2048 });
  const packText = trace.pack && trace.pack.text ? trace.pack.text : '';
  const zeroHit = (trace.stages?.final || []).length === 0;
  const shouldEmitDirective = arm === 'always-on' ? true : arm === 'deterministic-only' ? false : zeroHit;
  let directiveText = '';
  if (shouldEmitDirective) {
    const shards = selectCandidates(prompt, storeDir, { shardSize: 80 });
    if (shards.length) {
      const why = zeroHit ? 'Tier 1 found no lexical context.' : `CORE_REASONING_ARM=${arm} forces escalation regardless of Tier 1 result.`;
      directiveText = realDirectiveTemplate({ why, shardCount: shards.length, unitsTotal: shards[0].units_total });
    }
  }
  return { packText, directiveText, expectedDirectiveFired: directiveText !== '' };
}

/**
 * runClaudeSyntheticTrial — the real, rerunnable, fail-closed vertical
 * slice. Spawns a real authenticated `claude -p` invocation -- costs real
 * money every call.
 *
 * @param {object} opts
 * @param {string} opts.storeDir              a fresh decoy project dir with
 *   `_memories/` already populated (content-only, non-leaking -- the
 *   caller's responsibility per Hale's step 1; validated present here)
 * @param {string} opts.candidatePluginDir    the exact candidate's
 *   `plugins/core` directory (passed to --plugin-dir)
 * @param {string} opts.candidateRepoRoot      the candidate's repo root
 *   (unused by the overlay technique directly, kept for envelope identity)
 * @param {string} opts.expectedProducerVersion
 * @param {string} opts.expectedProducerSha
 * @param {string} opts.prompt
 * @param {string} opts.arm                    'always-on' | 'deterministic-only'
 * @param {string} opts.date                   YYYY-MM-DD for the trial's log files
 * @param {number} [opts.timeoutMs]             defaults to 60000
 * @returns {object} one fail-closed evidence envelope: always has `ok` and
 *   exactly one `spoilReason` when `ok:false`; never partial-success.
 */
export async function runClaudeSyntheticTrial(opts) {
  const { storeDir, candidatePluginDir, candidateRepoRoot, expectedProducerVersion, expectedProducerSha, prompt, arm, date, timeoutMs = 60000 } = opts || {};

  if (!SUPPORTED_ARMS.has(arm)) {
    return { ok: false, spoilReason: 'UNSUPPORTED_ARM', detail: `arm must be one of ${[...SUPPORTED_ARMS].join('/')} (automatic is not yet supported)`, arm };
  }
  if (!storeDir || !existsSync(join(storeDir, '_memories'))) {
    return { ok: false, spoilReason: 'CORPUS_MISSING', storeDir };
  }
  // Self-caught (2026-07-20) against the first real gated run of this exact
  // scaffold: macOS symlinks /var -> /private/var (mkdtempSync's tmpdir()
  // return value never carries the /private prefix), but Claude Code
  // resolves the CANONICAL path when computing its own project slug for the
  // transcript directory. Using the unresolved storeDir as `cwd` produced a
  // transcript the resolver could never find (TRANSCRIPT_NOT_RESOLVED) --
  // resolving to the real path here keeps every downstream slug computation
  // consistent with what the harness itself actually used.
  const realStoreDir = realpathSync(storeDir);
  if (!candidatePluginDir || !existsSync(candidatePluginDir)) {
    return { ok: false, spoilReason: 'CANDIDATE_PLUGIN_DIR_MISSING', candidatePluginDir };
  }
  if (!prompt || !date) {
    return { ok: false, spoilReason: 'MISSING_REQUIRED_INPUT', detail: 'prompt and date are required' };
  }

  // Step 2 (candidate identity): baseline inventory, derive the
  // disable-everything-except-candidate overlay FROM it, resolve with the
  // overlay applied, verify it actually took effect.
  const candidateId = 'core@inline';
  const baseline = fetchPluginInventory({ timeoutMs });
  if (!baseline.ok) return { ok: false, spoilReason: 'PLUGIN_INVENTORY_FAILED', detail: baseline };
  const overlay = computeDisableAllOverlay(baseline.inventory, candidateId);
  const overlayJson = JSON.stringify(overlay);
  const resolved = fetchPluginInventory({ settingsOverlay: overlayJson, pluginDir: candidatePluginDir, timeoutMs });
  if (!resolved.ok) return { ok: false, spoilReason: 'PLUGIN_INVENTORY_FAILED', detail: resolved };
  const overlayCheck = verifyOverlayApplied(baseline.inventory, resolved.inventory, candidateId, candidatePluginDir);
  if (!overlayCheck.ok) return { ok: false, spoilReason: `CANDIDATE_IDENTITY_${overlayCheck.reason}`, detail: overlayCheck };

  // Step 3 (real invocation) + step 4 (invocation-local cursors). Every
  // storeDir use from here on is the REAL (symlink-resolved) path, so the
  // harness's own internal slug computation and this module's stay
  // consistent.
  const retrievalBefore = captureCursor(realStoreDir, date, 'retrieval-log.jsonl');
  const outcomeBefore = captureCursor(realStoreDir, date, 'outcome-log.jsonl');
  const startedAt = Date.now();
  const spawnResult = spawnSync('claude', ['--settings', overlayJson, '--plugin-dir', candidatePluginDir, '-p', prompt, '--output-format', 'json'], {
    cwd: realStoreDir,
    env: { ...process.env, CORE_REASONING_ARM: arm },
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  const wallTimeMs = Date.now() - startedAt;
  if (spawnResult.error) return { ok: false, spoilReason: 'INVOCATION_SPAWN_FAILED', detail: spawnResult.error.message };
  let cliResult;
  try { cliResult = JSON.parse(spawnResult.stdout); } catch {
    return { ok: false, spoilReason: 'INVOCATION_OUTPUT_NOT_JSON', stdout: String(spawnResult.stdout || '').slice(0, 2000), stderr: String(spawnResult.stderr || '').slice(0, 2000) };
  }
  if (cliResult.is_error || !cliResult.session_id) {
    return { ok: false, spoilReason: 'INVOCATION_FAILED', detail: cliResult };
  }
  const retrievalAfter = captureCursor(realStoreDir, date, 'retrieval-log.jsonl');
  const outcomeAfter = captureCursor(realStoreDir, date, 'outcome-log.jsonl');

  // Step 4 (join).
  const coreSkillRoot = join(candidatePluginDir, 'skills', 'core');
  const { packText, directiveText, expectedDirectiveFired } = await deriveExpectedPackAndDirective(prompt, realStoreDir, arm, coreSkillRoot);
  const joinResult = checkTrialWindow(realStoreDir, {
    date,
    retrievalWindow: { before: retrievalBefore, after: retrievalAfter },
    outcomeWindow: { before: outcomeBefore, after: outcomeAfter },
    expectedArm: arm,
    expectedDirectiveFired,
    expectedHarness: 'claude-code',
    expectedSessionId: cliResult.session_id,
    expectedProducerVersion,
    expectedProducerSha,
  });
  if (!joinResult.ok) return { ok: false, spoilReason: `JOIN_${joinResult.reason}`, detail: joinResult };

  // Step 5 (exposure) -- independently derived pack/directive, never
  // transcript content copied into expected inputs.
  const { resolveTranscript } = await import(join(coreSkillRoot, 'scripts', 'read-transcript.mjs'));
  const { path: transcriptPath } = resolveTranscript('claude-code', { cwd: realStoreDir, sessionId: cliResult.session_id });
  if (!transcriptPath) return { ok: false, spoilReason: 'TRANSCRIPT_NOT_RESOLVED' };
  const exposure = checkHostExposureClaudeCode(transcriptPath, {
    expectedPromptId: joinResult.outcome.answer_turn_id,
    expectedPackText: packText,
    expectedDirectiveText: directiveText,
  });
  if (!exposure.ok) return { ok: false, spoilReason: `EXPOSURE_${exposure.reason}`, detail: exposure };

  // Step 6: one fail-closed raw evidence envelope.
  return {
    ok: true,
    corpus: { storeDir, realStoreDir, unitCount: readdirSync(join(realStoreDir, '_memories')).filter((f) => f.endsWith('.md')).length },
    candidateIdentity: { pluginDir: candidatePluginDir, repoRoot: candidateRepoRoot, resolvedInventoryEntry: overlayCheck.candidate },
    invocation: {
      sessionId: cliResult.session_id,
      arm,
      exitCode: spawnResult.status,
      wallTimeMs,
      totalCostUsd: cliResult.total_cost_usd,
      stderr: String(spawnResult.stderr || '').slice(0, 2000),
      finalResultField: cliResult.result,
    },
    join: joinResult,
    exposure,
    hashes: { packSha256: exposure.packSha256, injectedContextHash: exposure.injectedContextHash, finalAnswerHash: exposure.finalAnswerHash },
    finalAnswerText: exposure.finalAnswerText,
  };
}
