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
import { checkCorpusLeakage, checkStringsForLeakage, resolveCarrierIds } from './corpus-leakage-check.mjs';
import { directoryIdentity, manifestFromGit, treeOid } from '../plugins/core/skills/core/scripts/artifact-identity.mjs';

const SUPPORTED_ARMS = new Set(['always-on', 'deterministic-only']);
// Hale, hale--paid-run-direct-file-read-confound: preregistered, mutually
// exclusive estimands -- 'do not relabel one as the other.'
const ESTIMANDS = new Set(['hook-delivery-only', 'agent-with-tools']);

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
  // Hale, hale--0255-a5ee4c9-and-sha-wip-disposition item 3: "distinguish
  // ranked from delivered under the byte cap." The shipped hook logs
  // units_retrieved from trace.stages.final (every RANKED candidate,
  // whether or not it survived the byte cap) but selected_count from
  // trace.pack.accepted.length (what actually made it into the delivered
  // pack). Conflating them let the earlier telemetry-authority check
  // compare two genuinely different populations. rankedUnitIds mirrors
  // units_retrieved; deliveredUnitIds mirrors what's actually in packText
  // -- only a unit in deliveredUnitIds can have influenced the model via
  // the injected content at all.
  const rankedUnitIds = (trace.stages?.final || []).map((u) => u.id);
  const deliveredUnitIds = (trace.pack?.accepted || []).map((u) => u.id);
  const zeroHit = rankedUnitIds.length === 0;
  const shouldEmitDirective = arm === 'always-on' ? true : arm === 'deterministic-only' ? false : zeroHit;
  let directiveText = '';
  if (shouldEmitDirective) {
    const shards = selectCandidates(prompt, storeDir, { shardSize: 80 });
    if (shards.length) {
      const why = zeroHit ? 'Tier 1 found no lexical context.' : `CORE_REASONING_ARM=${arm} forces escalation regardless of Tier 1 result.`;
      directiveText = realDirectiveTemplate({ why, shardCount: shards.length, unitsTotal: shards[0].units_total });
    }
  }
  return { packText, directiveText, expectedDirectiveFired: directiveText !== '', rankedUnitIds, deliveredUnitIds };
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
    sourceStoreDir, plants, candidatePluginDir, candidateRepoRoot, expectedCandidateGitSha,
    expectedProducerVersion, expectedProducerSha, prompt, arm, date, model, estimand,
    timeoutMs = 60000, deps = {},
  } = opts || {};
  const fetchInventory = deps.fetchInventory || realFetchPluginInventory;
  const spawnClaude = deps.spawnClaude || ((args, spawnOpts) => spawnSync('claude', args, spawnOpts));

  let trialStore = null;
  let candidateCopy = null;
  // Hale, hale--ea8ed8a-106-green-two-executable-falsifiers: "failure
  // envelopes after store/candidate creation retain temp artifacts but omit
  // their paths, leaving unauditable orphan evidence." Every spoil from
  // Step 1 onward routes through this so a failed run's on-disk artifacts
  // (which are NEVER auto-deleted, per item 7 of the earlier critique) stay
  // pointed-to, not just present.
  const spoil = (reason, extra = {}) => ({
    ok: false, spoilReason: reason, ...extra,
    retainedArtifacts: { trialStoreDir: trialStore?.trialDir || null, candidateCopyDir: candidateCopy?.candidateCopyDir || null },
  });
  try {
    if (!SUPPORTED_ARMS.has(arm)) {
      return { ok: false, spoilReason: 'UNSUPPORTED_ARM', detail: `arm must be one of ${[...SUPPORTED_ARMS].join('/')} (automatic is not yet supported)`, arm };
    }
    // Hale, hale--paid-run-direct-file-read-confound: validated up front
    // (never after a paid invocation) so an unsupported estimand can't
    // spend real money before being caught.
    if (!ESTIMANDS.has(estimand)) {
      return { ok: false, spoilReason: 'UNSUPPORTED_ESTIMAND', detail: `estimand must be one of ${[...ESTIMANDS].join('/')}`, estimand };
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
    // Hale, hale--sha-wip-executable-0-of-2 / hale--0255-a5ee4c9-and-sha-wip-
    // disposition: "expectedCandidateGitSha cannot be optional for an
    // evidence-producing ok:true... require a resolved immutable 40-hex
    // commit, not HEAD, a branch, or another mutable ref." Every prior real
    // trial (including the iteration-21 result) used an unverified
    // candidate; this closes that gap unconditionally, not just when a
    // caller happens to opt in. A mutable ref (HEAD, a branch name) fails
    // the shape check below before git ever resolves it -- no ref
    // resolution step exists that could accidentally accept one.
    if (!candidateRepoRoot) {
      return { ok: false, spoilReason: 'CANDIDATE_SHA_BINDING_REQUIRED', detail: 'candidateRepoRoot is required for every evidence-producing run' };
    }
    if (typeof expectedCandidateGitSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedCandidateGitSha)) {
      return { ok: false, spoilReason: 'CANDIDATE_SHA_BINDING_INVALID_SHA', detail: 'expectedCandidateGitSha must be a resolved 40-lowercase-hex commit, not HEAD, a branch, or any other mutable ref', received: expectedCandidateGitSha };
    }

    // Step 1: fresh trial store, content-only copy, real leakage check.
    trialStore = buildFreshTrialStore(sourceStoreDir);
    const realStoreDir = realpathSync(trialStore.trialDir);
    let leakage;
    try {
      leakage = checkCorpusLeakage(realStoreDir, plants);
    } catch (e) {
      return spoil(`CORPUS_LEAKAGE_CHECK_ERROR_${e.code || 'UNKNOWN'}`, { detail: e.message });
    }
    if (!leakage.clean) {
      return spoil('CORPUS_LEAKAGE_FOUND', { violations: leakage.violations });
    }
    const corpusHash = directoryIdentity(join(realStoreDir, '_memories')).content_manifest_sha256;

    // Hale, hale--ea8ed8a-106-green-two-executable-falsifiers: checkCorpusLeakage
    // only ever looked at the corpus files -- a prompt that spells out the
    // planted answer itself (e.g. "The answer is cobalt; repeat it.") sailed
    // straight through to a real model invocation. The prompt is a surface the
    // model sees independent of the corpus; it must be checked before ANY
    // inventory fetch or spawn, not just before the answer is scored.
    const promptLeakage = checkStringsForLeakage({ prompt }, plants.map((p) => p.token));
    if (!promptLeakage.clean) {
      return spoil('PROMPT_LEAKAGE_FOUND', { violations: promptLeakage.violations });
    }
    // Resolve each plant's carrier to its real frontmatter id now, while
    // realStoreDir is at hand -- needed later (Step 6) to cross-reference
    // against the retrieval trace's selected unit ids, which are always
    // id-keyed regardless of how the caller referenced the carrier.
    let carrierIdsByToken;
    try {
      carrierIdsByToken = resolveCarrierIds(realStoreDir, plants);
    } catch (e) {
      return spoil(`CARRIER_ID_RESOLUTION_ERROR_${e.code || 'UNKNOWN'}`, { detail: e.message });
    }

    // Step 2: immutable candidate copy, pre-invocation hash, overlay
    // derived from the REAL current inventory, verified against the
    // corrected (exactly-one-enabled) invariant.
    candidateCopy = buildImmutableCandidateCopy(candidatePluginDir);

    // Hale, hale--b75fecc-paid-run-not-release-evidence /
    // hale--sha-wip-executable-0-of-2: "candidateRepoRoot text alone is not
    // proof" -- verify the copied candidate's content hash against the
    // REAL git object database at the exact resolved commit (already
    // required and shape-validated above), never a working tree, tar, or
    // trusted string. manifestFromGit uses the SAME manifest algorithm
    // directoryIdentity already uses, so the two are directly comparable.
    let gitManifest;
    try {
      gitManifest = manifestFromGit(candidateRepoRoot, expectedCandidateGitSha, 'plugins/core');
    } catch (e) {
      return spoil('CANDIDATE_SHA_BINDING_GIT_ERROR', { detail: e.message });
    }
    if (gitManifest.content_manifest_sha256 !== candidateCopy.contentHash) {
      return spoil('CANDIDATE_SHA_BINDING_MISMATCH', {
        detail: { expectedGitSha: expectedCandidateGitSha, gitContentHash: gitManifest.content_manifest_sha256, candidateContentHash: candidateCopy.contentHash },
      });
    }
    let verifiedCandidateTreeOid;
    try {
      verifiedCandidateTreeOid = treeOid(candidateRepoRoot, expectedCandidateGitSha, 'plugins/core');
    } catch (e) {
      return spoil('CANDIDATE_SHA_BINDING_GIT_ERROR', { detail: e.message });
    }
    const verifiedCandidateGitSha = expectedCandidateGitSha;

    const candidateId = 'core@inline';
    const baseline = fetchInventory({ timeoutMs });
    if (!baseline.ok) return spoil('PLUGIN_INVENTORY_FAILED', { detail: baseline });
    const overlay = computeDisableAllOverlay(baseline.inventory, candidateId);
    const overlayJson = JSON.stringify(overlay);
    const resolved = fetchInventory({ settingsOverlay: overlayJson, pluginDir: candidateCopy.candidateCopyDir, timeoutMs });
    if (!resolved.ok) return spoil('PLUGIN_INVENTORY_FAILED', { detail: resolved });
    const overlayCheck = verifyOverlayApplied(resolved.inventory, candidateId, candidateCopy.candidateCopyDir);
    if (!overlayCheck.ok) return spoil(`CANDIDATE_IDENTITY_${overlayCheck.reason}`, { detail: overlayCheck });

    // Step 3 + 4: real invocation, invocation-local cursors.
    const retrievalBefore = captureCursor(realStoreDir, date, 'retrieval-log.jsonl');
    const outcomeBefore = captureCursor(realStoreDir, date, 'outcome-log.jsonl');
    // Hale, hale--9561fcd-gated-transcript-contamination-hold: the overlay
    // technique isolates PLUGIN enablement only. A real gated run showed a
    // user-level PreToolUse:Skill hook (bash ~/.claude/hooks/pre-tool-
    // memory.sh, global memory index injection) firing from the untouched
    // user-global settings.json. --setting-sources excludes 'user' so only
    // the trial's own project/local settings apply -- verified directly on
    // this machine: --help lists it as 'Comma-separated list of setting
    // sources to load (user, project, local)'. host-exposure-checker.mjs's
    // UNEXPECTED_HOOK_ACTIVITY check is the transcript-side second layer in
    // case this flag alone doesn't fully hold.
    // Hale, hale--b75fecc-paid-run-not-release-evidence: "report actual CLI
    // version/model identity; the real envelope currently shows
    // cliModel:null." The real `-p --output-format json` result has no
    // model field to read back (verified against iteration 21's actual
    // output) -- the only honest way to KNOW the model is to name it on
    // the invocation via --model, then record what was REQUESTED (never
    // fabricate a "reported" value the CLI doesn't actually return).
    // Hale, hale--paid-run-direct-file-read-confound: for the
    // 'hook-delivery-only' estimand, tools are structurally disabled
    // (--tools "" -- verified live via `claude --help`: "Use \"\" to
    // disable all tools") so the model CANNOT Bash/Read its way to the
    // planted token independent of the injected pack. This is the root-
    // cause fix; the toolCallsInTurn transcript check above is the second
    // layer in case the flag alone doesn't fully hold, same pattern as
    // --setting-sources + UNEXPECTED_HOOK_ACTIVITY.
    const commandArgs = [
      '--settings', overlayJson, '--setting-sources', 'project,local', '--plugin-dir', candidateCopy.candidateCopyDir,
      ...(model ? ['--model', model] : []),
      ...(estimand === 'hook-delivery-only' ? ['--tools', ''] : []),
      '-p', prompt, '--output-format', 'json',
    ];
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
      return spoil('CANDIDATE_MUTATED_DURING_INVOCATION', { expected: candidateCopy.contentHash, found: postHash });
    }

    if (spawnResult.error) return spoil('INVOCATION_SPAWN_FAILED', { detail: spawnResult.error.message });
    let cliResult;
    try { cliResult = JSON.parse(spawnResult.stdout); } catch {
      return spoil('INVOCATION_OUTPUT_NOT_JSON', { stdout: String(spawnResult.stdout || '').slice(0, 2000), stderr: String(spawnResult.stderr || '').slice(0, 2000) });
    }
    if (cliResult.is_error || !cliResult.session_id) {
      return spoil('INVOCATION_FAILED', { detail: cliResult });
    }
    const retrievalAfter = captureCursor(realStoreDir, date, 'retrieval-log.jsonl');
    const outcomeAfter = captureCursor(realStoreDir, date, 'outcome-log.jsonl');

    // Step 4 continued (join).
    const coreSkillRoot = join(candidateCopy.candidateCopyDir, 'skills', 'core');
    const { packText, directiveText, expectedDirectiveFired, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, realStoreDir, arm, coreSkillRoot);
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
    if (!joinResult.ok) return spoil(`JOIN_${joinResult.reason}`, { detail: joinResult });

    // Step 5 (exposure) -- independently derived pack/directive, never
    // transcript content copied into expected inputs.
    const { resolveTranscript } = await import(join(coreSkillRoot, 'scripts', 'read-transcript.mjs'));
    const { path: transcriptPath } = resolveTranscript('claude-code', { cwd: realStoreDir, sessionId: cliResult.session_id });
    if (!transcriptPath) return spoil('TRANSCRIPT_NOT_RESOLVED');
    const exposure = checkHostExposureClaudeCode(transcriptPath, {
      expectedPromptId: joinResult.outcome.answer_turn_id,
      expectedPackText: packText,
      expectedDirectiveText: directiveText,
    });
    if (!exposure.ok) return spoil(`EXPOSURE_${exposure.reason}`, { detail: exposure });

    // Step 6: the efficacy contract. Hale, hale--ea8ed8a-106-green-two-
    // executable-falsifiers: "the green suite's own DI fixture writes
    // units_retrieved: [], selected_count: 0, result: 'no-hit' -- ok:true
    // still means composition/transport, not carrier retrieval or a
    // memory-caused answer." A trial only counts as EFFICACY evidence (not
    // just a clean transport run) when the designated carrier was actually
    // among the units Tier 1 selected, AND the final answer actually
    // contains a planted token -- neither is inferable from a clean join +
    // clean exposure alone.
    //
    // Hale, hale--6e4e086-stop-and-telemetry-hold: "the efficacy oracle
    // currently trusts an after-the-fact retrieval recomputation... make
    // joinResult.retrieval.units_retrieved authoritative and require it to
    // agree with the independently recomputed selection. A disagreement
    // must spoil, not be hidden." Without this, the instrument could
    // recompute a carrier hit while the REAL joined telemetry row logged
    // something else (or nothing) -- exactly what the committed happy
    // fixture had been doing.
    //
    // Hale, hale--0255-a5ee4c9-and-sha-wip-disposition item 3: the shipped
    // hook logs units_retrieved from the RANKED set (trace.stages.final)
    // but selected_count from the DELIVERED set (trace.pack.accepted) --
    // conflating them (as an earlier version here did) compares two
    // different populations and either false-spoils whenever the cap
    // excludes something, or silently accepts a mismatch when it doesn't.
    // Each logged field is now checked against its OWN correct population.
    const loggedRankedUnitIds = (joinResult.retrieval.units_retrieved || []).map((u) => u.id);
    const loggedSelectedCount = joinResult.retrieval.selected_count;
    const sortedLoggedRanked = [...loggedRankedUnitIds].sort();
    const sortedRecomputedRanked = [...rankedUnitIds].sort();
    const rankedIdsAgree = sortedLoggedRanked.length === sortedRecomputedRanked.length && sortedLoggedRanked.every((id, i) => id === sortedRecomputedRanked[i]);
    if (!rankedIdsAgree || loggedSelectedCount !== deliveredUnitIds.length) {
      return spoil('TELEMETRY_SELECTION_MISMATCH', {
        detail: {
          loggedRankedUnitIds, recomputedRankedUnitIds: rankedUnitIds,
          loggedSelectedCount, recomputedDeliveredCount: deliveredUnitIds.length,
        },
      });
    }

    // Hale, hale--paid-run-direct-file-read-confound: buildFinalContextPack
    // emits ID + title only, never body content -- a carrier that is only
    // RANKED (not DELIVERED, i.e. cap-excluded from trace.pack.accepted)
    // never appears in the injected content at all, so crediting it toward
    // efficacy would credit something the model was never shown. Only a
    // carrier actually in deliveredUnitIds can count.
    const selectedCarrierTokens = plants
      .map((p) => p.token)
      .filter((token) => deliveredUnitIds.includes(carrierIdsByToken.get(token)));
    if (selectedCarrierTokens.length === 0) {
      return spoil('EFFICACY_CARRIER_NOT_DELIVERED', { detail: { deliveredUnitIds, rankedUnitIds, expectedCarrierIds: [...carrierIdsByToken.values()] } });
    }
    // The delivered pack is title/breadcrumb only (id + H1), never the
    // carrier's body -- so the injected content itself must actually
    // contain the carrier's emitted line before the final answer is even
    // consulted. This does NOT by itself prove the answer came from that
    // content rather than a tool call (see the tool-call classification
    // below); it only proves the carrier was genuinely delivered.
    const deliveredCarrierIdsInPack = selectedCarrierTokens.map((token) => carrierIdsByToken.get(token));
    const packMissingCarrierId = deliveredCarrierIdsInPack.find((id) => !packText.includes(id));
    if (packMissingCarrierId) {
      return spoil('EFFICACY_CARRIER_NOT_IN_INJECTED_CONTENT', { detail: { packText, missingCarrierId: packMissingCarrierId } });
    }
    const answerMatchedTokens = selectedCarrierTokens.filter((token) =>
      String(exposure.finalAnswerText || '').toLowerCase().includes(String(token).toLowerCase()));
    if (answerMatchedTokens.length === 0) {
      return spoil('EFFICACY_ANSWER_MISSING_TARGET', { detail: { finalAnswerText: exposure.finalAnswerText, expectedAnyOf: selectedCarrierTokens } });
    }

    // Hale, hale--paid-run-direct-file-read-confound: the iteration-21
    // "efficacy" result was invalidated by exactly this gap -- the model
    // used Bash/Read to open the carrier file directly rather than relying
    // on the injected (title-only) content, and the orchestrator had no
    // way to see that, or to distinguish it from real pack-delivery
    // efficacy. "One successful treatment run is not causal evidence" for
    // either estimand -- this closes the VISIBILITY gap (never silently
    // credit a tool-mediated answer as hook-delivery), not the full causal
    // design (a matched no-tools-vs-tools control arm remains unbuilt,
    // named honestly below rather than faked).
    //
    // Two estimands, preregistered per-call, never inferred or relabeled:
    //   'hook-delivery-only' -- proves the INJECTED PACK caused the answer.
    //     Tools are structurally disabled (--tools "", verified live via
    //     `claude --help`: "Use \"\" to disable all tools"). Since the real
    //     product's buildFinalContextPack() never emits body content (only
    //     id + title), this estimand can only ever succeed for a query
    //     answerable from the TITLE/ID alone -- body-fact recall is
    //     structurally out of reach for it, by product design, not a test
    //     gap. Any tool_use appearing anyway (the flag failing to hold)
    //     spoils closed rather than being silently absorbed.
    //   'agent-with-tools' -- proves an end-to-end agent (memory hint plus
    //     unrestricted tools) can recall the target. Tool use is expected
    //     and does not spoil, but the confound is recorded explicitly in
    //     the envelope so a caller can never mistake this for hook-delivery
    //     evidence. A matched tools-enabled CONTROL run (same prompt, no
    //     memory pack) is required to make this causal and is NOT built
    //     here -- named as the explicit next gap, not implied as done.
    const toolCallsInTurn = exposure.toolCallsInTurn || [];
    if (estimand === 'hook-delivery-only' && toolCallsInTurn.length > 0) {
      return spoil('EFFICACY_TOOL_CONFOUND_FOR_HOOK_DELIVERY_ESTIMAND', {
        detail: { toolCallsInTurn, note: 'the --tools "" restriction did not hold -- verified from the transcript, never trusted from the flag alone' },
      });
    }

    // Step 7: one fail-closed, comprehensive raw evidence envelope.
    return {
      ok: true,
      command: {
        bin: 'claude', args: commandArgs, cwd: realStoreDir, env: { CORE_REASONING_ARM: arm },
        requestedModel: model || null, reportedModel: cliResult.model || null,
      },
      corpus: {
        sourceStoreDir, trialStoreDir: realStoreDir, unitCount: trialStore.unitCount,
        contentManifestSha256: corpusHash, plants, leakageClean: true, promptLeakageClean: true,
      },
      candidateIdentity: {
        pluginDir: candidatePluginDir, copiedTrialDir: candidateCopy.candidateCopyDir, repoRoot: candidateRepoRoot,
        preInvocationContentHash: candidateCopy.contentHash, postInvocationContentHash: postHash,
        resolvedInventoryEntry: overlayCheck.candidate, resolvedInventory: overlayCheck.resolvedInventory,
        resolvedEnabledCount: 1, expectedProducerVersion, expectedProducerSha,
        verifiedCandidateGitSha, verifiedCandidateTreeOid,
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
      efficacy: {
        estimand, rankedUnitIds, deliveredUnitIds, selectedCarrierTokens, answerMatchedTokens,
        toolCallsInTurn,
        // 'hook-delivery-only' + a nonzero toolCallsInTurn is already
        // impossible above (it spoils before reaching here); this field
        // exists so an 'agent-with-tools' envelope is never mistaken for
        // clean hook-delivery evidence just because ok:true.
        toolMediatedConfoundPossible: estimand === 'agent-with-tools' && toolCallsInTurn.length > 0,
      },
      hashes: {
        packSha256: exposure.packSha256,
        directiveSha256: sha256Hex(directiveText),
        injectedContextHash: exposure.injectedContextHash,
        finalAnswerHash: exposure.finalAnswerHash,
        transcriptSha256: sha256File(transcriptPath),
        promptSha256: sha256Hex(prompt),
      },
      transcriptPath,
      finalAnswerText: exposure.finalAnswerText,
    };
  } catch (e) {
    // Nothing throws past this function -- always exactly one fail-closed
    // envelope, the underlying error code preserved, never erased. Hale,
    // hale--ea8ed8a-106-green-two-executable-falsifiers: a failure after
    // store/candidate creation used to omit their paths entirely, leaving
    // unauditable orphan temp artifacts on disk with no pointer to them --
    // retain whatever was actually created so a failed run stays inspectable.
    return {
      ok: false, spoilReason: `UNCAUGHT_EXCEPTION_${e.code || 'UNKNOWN'}`,
      detail: { message: e.message, stack: String(e.stack || '').slice(0, 2000) },
      retainedArtifacts: {
        trialStoreDir: trialStore?.trialDir || null,
        candidateCopyDir: candidateCopy?.candidateCopyDir || null,
      },
    };
  }
  // Deliberately NO auto-cleanup of trialStore/candidateCopy here (Hale,
  // hale--orchestrator-wip-must-fix-before-commit, item 7): "logs are
  // deleted by the test cleanup, so the current result is not rerunnable
  // evidence." The envelope names trialStoreDir/copiedTrialDir explicitly
  // so the caller can inspect them afterward; cleanup is the CALLER's
  // decision (e.g. only after archiving, or after some retention window),
  // never automatic here.
}
