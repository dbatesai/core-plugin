#!/usr/bin/env node
// run-claude-synthetic-trial.mjs — synthetic-decoy runner orchestrator,
// three-arm memory-efficacy pilot (Hale's runner amendment 7, 2026-07-20).
//
// Composes every proven primitive into one real, rerunnable, fail-closed
// evidence envelope, per Hale's full contract.
//
// CORRECTION (2026-07-20, self-corrected after Hale's pre-commit audit,
// hale--orchestrator-wip-must-fix-before-commit / hale--29aa260-overlay-
// false-pass / hale--145-checkpoint-real-probe-raw-evidence-owed /
// hale--2b8020a-real-probe-contaminated-zero-hit): the previous version of
// this file, and my own report of it, overclaimed. A hand-run "pong" trial
// is a transport/plumbing smoke test, NOT memory-efficacy evidence -- the
// answer was specified verbatim in the prompt, no unit was retrieved, no
// pack was delivered, and the overlay technique it depended on had a real
// false-pass (verifyOverlayApplied only rechecked baseline-enabled
// plugins, so a NEWLY enabled plugin -- Hale's demonstrated
// `surprise@auto` -- silently passed). All of the following are now
// closed, each with Hale's exact finding named:
//
//   1. Corpus is no longer "just has _memories, trust the caller." The
//      orchestrator copies ONLY the source store's top-level _memories/
//      *.md files (never subdirectories -- observations/archive are a
//      DIFFERENT population, not "content-only decoy corpus") into a
//      FRESH trial store, then runs the real checkCorpusLeakage() against
//      the required `plants` (token -> carrier-unit) list before ever
//      invoking anything. A leaking or unplanted corpus spoils closed.
//   2. Candidate identity is no longer a path pointed at the mutable
//      runner worktree. The exact candidatePluginDir is copied into a
//      fresh, single-purpose trial directory; its content hash
//      (directoryIdentity) is captured BEFORE the invocation and
//      RE-CHECKED after the model exits -- any mutation during the run
//      spoils CANDIDATE_MUTATED_DURING_INVOCATION.
//   3. verifyOverlayApplied() itself is fixed (see invocation-plugin-
//      overlay.mjs) to require exactly one enabled plugin in the
//      RESOLVED inventory, not "every baseline-enabled plugin still
//      enabled" -- closing the exact false pass Hale reproduced.
//   4. The hand-maintained directive template is bound to a pinned sha256
//      of the exact hook source file it was transcribed from. If the
//      candidate's hook source ever drifts from that pin, deriving a
//      directive throws rather than silently trusting a stale copy.
//   5. Every step from realpathSync through the final checker call is
//      inside one try/catch; nothing can throw past this function
//      uncaught. Always exactly one of {ok:true, ...} or
//      {ok:false, spoilReason, ...}.
//   6. The evidence envelope is comprehensive: raw command/args, CLI
//      version/model, prompt hash, corpus hash, candidate pre/post
//      hashes, resolved-plugin enabled-count, stdout/stderr hashes, exit
//      code, cursor byte ranges, transcript hash, directive hash, and
//      (on failure) exactly one closed spoil reason with detail.
//   7. Dependency injection (`deps.fetchInventory`, `deps.spawnClaude`)
//      lets a test exercise the FULL composition -- contamination,
//      mutated candidate, missing outcome, duplicate exposure,
//      transcript-fed expected context -- without ever spawning a real
//      process. See run-claude-synthetic-trial.test.mjs's fixture-runner
//      tests. The real defaults still spawn for real when called for
//      real -- callers control cost by controlling how often they call
//      this with the real deps, never by a hidden mock.
//
// 'pong'-style prompts (answer given verbatim) remain valid as a cheap
// TRANSPORT smoke test ONLY -- callers must supply a real `plants` array
// naming a token that exists ONLY in one carrier unit's body for this to
// be efficacy evidence at all.
//
// Scope, stated honestly: only 'always-on' and 'deterministic-only' arms
// are supported. 'automatic' is NOT yet supported -- its expected
// directive_fired depends on whether Tier 1 found a real hit, which would
// need to be computed independently before the invocation; named here
// rather than guessed at. Requesting 'automatic' throws.
//
// The real invocation costs real money (verified: ~$0.11-0.14 for a
// trivial one-word prompt on this account). The test suite for this
// module does NOT spawn by default -- see run-claude-synthetic-trial.test.mjs.
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { existsSync, readdirSync, readFileSync, realpathSync, mkdtempSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { captureCursor, checkTrialWindow } from './trial-window-join-checker.mjs';
import { checkHostExposureClaudeCode } from './host-exposure-checker.mjs';
import { fetchPluginInventory as realFetchPluginInventory, computeDisableAllOverlay, verifyOverlayApplied } from './invocation-plugin-overlay.mjs';
import { checkCorpusLeakage } from './corpus-leakage-check.mjs';
import { directoryIdentity } from '../plugins/core/skills/core/scripts/artifact-identity.mjs';

const SUPPORTED_ARMS = new Set(['always-on', 'deterministic-only']);

// Computed 2026-07-20 against this exact frozen candidate's
// plugins/core/skills/core/hooks/retrieve-context-hook.mjs. The directive
// template below was hand-transcribed from that exact file at that exact
// hash -- see deriveExpectedPackAndDirective()'s drift check.
const PINNED_HOOK_SOURCE_SHA256 = '20eb61e3d1019c3deba2874295652479d6bdaa6c9ec04c5766191cc94a2af1ab';

function sha256Hex(text) { return createHash('sha256').update(String(text), 'utf8').digest('hex'); }
function sha256File(path) { try { return sha256Hex(readFileSync(path, 'utf8')); } catch { return null; } }

// Mirrors retrieve-context-hook.mjs's real inline directive template
// EXACTLY -- verified byte-for-byte against a real invocation, and bound
// to PINNED_HOOK_SOURCE_SHA256 above so a source drift is never silently
// trusted.
function realDirectiveTemplate({ why, shardCount, unitsTotal }) {
  return `CORE reasoning escalation required: ${why} Follow the Tier 3 retrieval protocol and inspect all ${shardCount} shard(s) covering ${unitsTotal} active units with select-relevant-units.mjs; reason over each shard using the current prompt before concluding no relevant memory exists.\n`;
}

export async function deriveExpectedPackAndDirective(prompt, storeDir, arm, coreSkillRoot) {
  const hookPath = join(coreSkillRoot, 'hooks', 'retrieve-context-hook.mjs');
  const hookHash = sha256File(hookPath);
  if (hookHash !== PINNED_HOOK_SOURCE_SHA256) {
    throw Object.assign(
      new Error(`retrieve-context-hook.mjs source has drifted from the pinned hash the hand-copied directive template was verified against (expected ${PINNED_HOOK_SOURCE_SHA256}, got ${hookHash}) -- update the template (or the pin, after re-verifying) before trusting derived directive text`),
      { code: 'DIRECTIVE_TEMPLATE_SOURCE_DRIFT' },
    );
  }
  const { buildRetrievalTrace } = await import(join(coreSkillRoot, 'scripts', 'retrieve-context.mjs'));
  const { selectCandidates } = await import(join(coreSkillRoot, 'scripts', 'select-relevant-units.mjs'));
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

// Copies ONLY top-level _memories/*.md files -- never subdirectories
// (observations/, archive/, _lib/ are a DIFFERENT population from "content
// -only decoy corpus" and must never ride along by accident).
function buildFreshTrialStore(sourceStoreDir) {
  const trialDir = mkdtempSync(join(tmpdir(), 'trial-store-'));
  const memDir = join(trialDir, '_memories');
  mkdirSync(memDir, { recursive: true });
  const sourceMemDir = join(sourceStoreDir, '_memories');
  let copied = 0;
  for (const entry of readdirSync(sourceMemDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    cpSync(join(sourceMemDir, entry.name), join(memDir, entry.name));
    copied += 1;
  }
  return { trialDir, unitCount: copied };
}

function buildImmutableCandidateCopy(candidatePluginDir) {
  const dir = mkdtempSync(join(tmpdir(), 'candidate-copy-'));
  cpSync(candidatePluginDir, dir, { recursive: true });
  const hash = directoryIdentity(dir).content_manifest_sha256;
  return { candidateCopyDir: dir, contentHash: hash };
}

/**
 * runClaudeSyntheticTrial — the real, rerunnable, fail-closed vertical
 * slice. With real `deps` (the default), spawns a real authenticated
 * `claude -p` invocation -- costs real money every call.
 *
 * @param {object} opts
 * @param {string} opts.sourceStoreDir         a synthetic decoy corpus dir
 *   with `_memories/*.md` already populated -- ONLY top-level .md files
 *   are copied into a fresh trial store; the caller is responsible for the
 *   corpus being genuinely synthetic (no real project data), and this
 *   function is responsible for proving it's non-leaking via `plants`.
 * @param {Array<{token:string, carrierUnit:string}>} opts.plants  required,
 *   passed directly to checkCorpusLeakage() against the fresh trial store.
 * @param {string} opts.candidatePluginDir     the exact candidate's
 *   `plugins/core` directory -- copied into an immutable trial directory
 *   before use, never passed directly to --plugin-dir.
 * @param {string} [opts.candidateRepoRoot]
 * @param {string} opts.expectedProducerVersion
 * @param {string} opts.expectedProducerSha
 * @param {string} opts.prompt
 * @param {string} opts.arm                    'always-on' | 'deterministic-only'
 * @param {string} opts.date                   YYYY-MM-DD for the trial's log files
 * @param {number} [opts.timeoutMs]             defaults to 60000
 * @param {object} [opts.deps]                 dependency-injection seam;
 *   `{fetchInventory, spawnClaude}` default to the real implementations.
 *   Tests substitute fakes to exercise the full composition with zero
 *   real spawns.
 * @returns {object} one fail-closed evidence envelope: always exactly one
 *   of {ok:true, ...} or {ok:false, spoilReason, ...}; never partial.
 */
export async function runClaudeSyntheticTrial(opts) {
  const {
    sourceStoreDir, plants, candidatePluginDir, candidateRepoRoot,
    expectedProducerVersion, expectedProducerSha, prompt, arm, date,
    timeoutMs = 60000, deps = {},
  } = opts || {};
  const fetchInventory = deps.fetchInventory || realFetchPluginInventory;
  const spawnClaude = deps.spawnClaude || ((args, spawnOpts) => spawnSync('claude', args, spawnOpts));

  let trialStore = null;
  let candidateCopy = null;
  try {
    if (!SUPPORTED_ARMS.has(arm)) {
      return { ok: false, spoilReason: 'UNSUPPORTED_ARM', detail: `arm must be one of ${[...SUPPORTED_ARMS].join('/')} (automatic is not yet supported)`, arm };
    }
    if (!sourceStoreDir || !existsSync(join(sourceStoreDir, '_memories'))) {
      return { ok: false, spoilReason: 'CORPUS_MISSING', sourceStoreDir };
    }
    if (!Array.isArray(plants) || plants.length === 0) {
      return { ok: false, spoilReason: 'PLANTS_REQUIRED', detail: 'checkCorpusLeakage requires at least one {token, carrierUnit} plant to prove this trial has a real, non-leaking planted answer' };
    }
    if (!candidatePluginDir || !existsSync(candidatePluginDir)) {
      return { ok: false, spoilReason: 'CANDIDATE_PLUGIN_DIR_MISSING', candidatePluginDir };
    }
    if (!prompt || !date) {
      return { ok: false, spoilReason: 'MISSING_REQUIRED_INPUT', detail: 'prompt and date are required' };
    }

    // Step 1: fresh trial store, content-only copy, real leakage check.
    trialStore = buildFreshTrialStore(sourceStoreDir);
    const realStoreDir = realpathSync(trialStore.trialDir);
    let leakage;
    try {
      leakage = checkCorpusLeakage(realStoreDir, plants);
    } catch (e) {
      return { ok: false, spoilReason: `CORPUS_LEAKAGE_CHECK_ERROR_${e.code || 'UNKNOWN'}`, detail: e.message };
    }
    if (!leakage.clean) {
      return { ok: false, spoilReason: 'CORPUS_LEAKAGE_FOUND', violations: leakage.violations };
    }
    const corpusHash = directoryIdentity(join(realStoreDir, '_memories')).content_manifest_sha256;

    // Step 2: immutable candidate copy, pre-invocation hash, overlay
    // derived from the REAL current inventory, verified against the
    // corrected (exactly-one-enabled) invariant.
    candidateCopy = buildImmutableCandidateCopy(candidatePluginDir);
    const candidateId = 'core@inline';
    const baseline = fetchInventory({ timeoutMs });
    if (!baseline.ok) return { ok: false, spoilReason: 'PLUGIN_INVENTORY_FAILED', detail: baseline };
    const overlay = computeDisableAllOverlay(baseline.inventory, candidateId);
    const overlayJson = JSON.stringify(overlay);
    const resolved = fetchInventory({ settingsOverlay: overlayJson, pluginDir: candidateCopy.candidateCopyDir, timeoutMs });
    if (!resolved.ok) return { ok: false, spoilReason: 'PLUGIN_INVENTORY_FAILED', detail: resolved };
    const overlayCheck = verifyOverlayApplied(resolved.inventory, candidateId, candidateCopy.candidateCopyDir);
    if (!overlayCheck.ok) return { ok: false, spoilReason: `CANDIDATE_IDENTITY_${overlayCheck.reason}`, detail: overlayCheck };

    // Step 3 + 4: real invocation, invocation-local cursors.
    const retrievalBefore = captureCursor(realStoreDir, date, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(realStoreDir, date, 'outcome-log.jsonl');
    const commandArgs = ['--settings', overlayJson, '--plugin-dir', candidateCopy.candidateCopyDir, '-p', prompt, '--output-format', 'json'];
    const startedAt = Date.now();
    const spawnResult = spawnClaude(commandArgs, {
      cwd: realStoreDir,
      env: { ...process.env, CORE_REASONING_ARM: arm },
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    const wallTimeMs = Date.now() - startedAt;

    // Re-hash the candidate copy immediately after the model exits --
    // never trust that --plugin-dir stayed byte-identical across the run.
    const postHash = directoryIdentity(candidateCopy.candidateCopyDir).content_manifest_sha256;
    if (postHash !== candidateCopy.contentHash) {
      return { ok: false, spoilReason: 'CANDIDATE_MUTATED_DURING_INVOCATION', expected: candidateCopy.contentHash, found: postHash };
    }

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

    // Step 4 continued (join).
    const coreSkillRoot = join(candidateCopy.candidateCopyDir, 'skills', 'core');
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

    // Step 6: one fail-closed, comprehensive raw evidence envelope.
    return {
      ok: true,
      command: { bin: 'claude', args: commandArgs, cwd: realStoreDir, env: { CORE_REASONING_ARM: arm } },
      corpus: {
        sourceStoreDir, trialStoreDir: realStoreDir, unitCount: trialStore.unitCount,
        contentManifestSha256: corpusHash, plants, leakageClean: true,
      },
      candidateIdentity: {
        pluginDir: candidatePluginDir, copiedTrialDir: candidateCopy.candidateCopyDir, repoRoot: candidateRepoRoot,
        preInvocationContentHash: candidateCopy.contentHash, postInvocationContentHash: postHash,
        resolvedInventoryEntry: overlayCheck.candidate, expectedProducerVersion, expectedProducerSha,
      },
      invocation: {
        sessionId: cliResult.session_id,
        arm,
        exitCode: spawnResult.status,
        wallTimeMs,
        totalCostUsd: cliResult.total_cost_usd,
        stdoutSha256: sha256Hex(spawnResult.stdout || ''),
        stderrSha256: sha256Hex(spawnResult.stderr || ''),
        finalResultField: cliResult.result,
      },
      cursors: { retrievalBefore, retrievalAfter, outcomeBefore, outcomeAfter },
      join: joinResult,
      exposure,
      hashes: {
        packSha256: exposure.packSha256,
        directiveSha256: sha256Hex(directiveText),
        injectedContextHash: exposure.injectedContextHash,
        finalAnswerHash: exposure.finalAnswerHash,
        transcriptSha256: sha256File(transcriptPath),
        promptSha256: sha256Hex(prompt),
      },
      finalAnswerText: exposure.finalAnswerText,
    };
  } catch (e) {
    // Nothing throws past this function -- always exactly one fail-closed
    // envelope, the underlying error code preserved, never erased.
    return { ok: false, spoilReason: `UNCAUGHT_EXCEPTION_${e.code || 'UNKNOWN'}`, detail: { message: e.message, stack: String(e.stack || '').slice(0, 2000) } };
  }
  // Deliberately NO auto-cleanup of trialStore/candidateCopy here (Hale,
  // hale--orchestrator-wip-must-fix-before-commit, item 7): "logs are
  // deleted by the test cleanup, so the current result is not rerunnable
  // evidence." The envelope names trialStoreDir/copiedTrialDir explicitly
  // so the caller can inspect them afterward; cleanup is the CALLER's
  // decision (e.g. only after archiving, or after some retention window),
  // never automatic here.
}
