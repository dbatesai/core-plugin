import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SCRIPTS = join(PILOT, '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const { runClaudeSyntheticTrial, deriveExpectedPackAndDirective } = await import(pathToFileURL(join(PILOT, 'run-claude-synthetic-trial.mjs')).href);
const { EXPECTED_USER_PROMPT_SUBMIT_COMMAND, EXPECTED_STOP_COMMAND } = await import(pathToFileURL(join(PILOT, 'host-exposure-checker.mjs')).href);
const { recordRetrievalEvent } = await import(pathToFileURL(join(CORE_SCRIPTS, 'record-retrieval-event.mjs')).href);
const { recordRetrievalOutcome } = await import(pathToFileURL(join(CORE_SCRIPTS, 'record-retrieval-outcome.mjs')).href);
const { mapProjectPathToSlug } = await import(pathToFileURL(join(CORE_SCRIPTS, 'project-slug.mjs')).href);

const REAL_CANDIDATE_PLUGIN_DIR = join(PILOT, '..', 'plugins', 'core');
const REAL_REPO_ROOT = join(PILOT, '..');
const REAL_CORE_SKILL_ROOT = join(REAL_CANDIDATE_PLUGIN_DIR, 'skills', 'core');
const REAL_REPO_HEAD_SHA = execFileSync('git', ['-C', REAL_REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const HARNESS = 'claude-code';
const PRODUCER_VERSION = '3.12.1-pilot.1';
const PRODUCER_SHA = 'fc8a23ad99bbc1d082f4ebed4388093a53c9fc47';
// Hale, hale--55f1222-closure-rejected: model is now mandatory, and the
// fixture transcript's observed message.model must genuinely match what
// the trial requests -- FIXTURE_MODEL is used as BOTH the requested
// `model` opt and the fixture's message.model so the match is exact
// (never relying on the orchestrator's substring-based alias tolerance).
const FIXTURE_MODEL = 'claude-sonnet-5-fixture';
const FIXTURE_CLI_VERSION = '2.1.215-fixture';

function decoyStore() {
  const dir = mkdtempSync(join(tmpdir(), 'source-store-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  writeFileSync(join(dir, '_memories', 'dc-1-carrier.md'), '---\nid: dc-1-carrier\ntype: decision\nstatus: active\ntopics: [probe]\n---\n\n# Carrier unit\n\nThe blue orchard proof codename is cobalt.\n');
  return dir;
}
const PLANTS = [{ token: 'cobalt', carrierUnit: 'dc-1-carrier.md' }];

// ---------------------------------------------------------------------
// Cheap, no-spawn validation tests.
// ---------------------------------------------------------------------

test('spoil: UNSUPPORTED_ARM for automatic (not yet supported, named explicitly)', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'automatic', date: '2026-07-20' });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'UNSUPPORTED_ARM');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CORPUS_MISSING when sourceStoreDir has no _memories directory', async () => {
  const store = mkdtempSync(join(tmpdir(), 'source-store-empty-'));
  try {
    const result = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CORPUS_MISSING');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: PLANTS_REQUIRED when plants is missing or empty', async () => {
  const store = decoyStore();
  try {
    const r1 = await runClaudeSyntheticTrial({ sourceStoreDir: store, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(r1.ok, false);
    assert.equal(r1.spoilReason, 'PLANTS_REQUIRED');
    const r2 = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: [], candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(r2.ok, false);
    assert.equal(r2.spoilReason, 'PLANTS_REQUIRED');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CANDIDATE_PLUGIN_DIR_MISSING for a nonexistent candidate path', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: '/definitely/does/not/exist', prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_PLUGIN_DIR_MISSING');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: MISSING_REQUIRED_INPUT when prompt or date are absent', async () => {
  const store = decoyStore();
  try {
    const r1 = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(r1.ok, false);
    assert.equal(r1.spoilReason, 'MISSING_REQUIRED_INPUT');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// Real corpus, but the plant's token isn't actually in the carrier body --
// checkCorpusLeakage() itself throws CARRIER_MISSING_TOKEN; the orchestrator
// must convert that into a spoil, not let it escape uncaught.
test('spoil: a corpus with no real planted answer fails closed via the real leakage checker, not silently', async () => {
  const store = mkdtempSync(join(tmpdir(), 'source-store-noplant-'));
  mkdirSync(join(store, '_memories'), { recursive: true });
  writeFileSync(join(store, '_memories', 'dc-1-carrier.md'), '---\nid: dc-1-carrier\ntype: decision\nstatus: active\ntopics: [probe]\n---\n\n# Carrier unit\n\nNothing relevant here.\n');
  try {
    const result = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA, prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(result.ok, false);
    assert.match(result.spoilReason, /^CORPUS_LEAKAGE_CHECK_ERROR_/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// A leaking corpus (the token also appears in a sibling unit's body) must
// spoil CORPUS_LEAKAGE_FOUND -- the real checkCorpusLeakage() catching a
// real contamination case, wired all the way through the orchestrator.
test('spoil: CORPUS_LEAKAGE_FOUND when a decoy unit leaks the planted token', async () => {
  const store = decoyStore();
  writeFileSync(join(store, '_memories', 'dc-2-decoy.md'), '---\nid: dc-2-decoy\ntype: decision\nstatus: active\ntopics: [probe]\n---\n\n# Decoy\n\nAlso mentions cobalt by accident.\n');
  try {
    const result = await runClaudeSyntheticTrial({ sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA, prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CORPUS_LEAKAGE_FOUND');
    assert.ok(result.violations.some((v) => v.unit === 'dc-2-decoy.md'));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// A subdirectory under _memories (observations/, archive/, _lib/) must never
// ride into the trial store. Hale, hale--ea8ed8a-106-green-two-executable-
// falsifiers: the previous version of this test pointed at a MISSING
// candidate dir, so validation failed BEFORE corpus construction ever ran
// -- it proved nothing about copying. This version uses the REAL candidate
// dir (so corpus construction genuinely happens) and forces a fast,
// deterministic failure AFTER it via a DI fetchInventory that fails
// immediately -- then inspects the RETAINED trial store's actual file
// list (via the failure envelope's retainedArtifacts, never auto-deleted)
// to prove the subdirectory was excluded, not just that nothing crashed.
test('corpus copy is content-only: a subdirectory under _memories is genuinely excluded from the retained trial store', async () => {
  const store = decoyStore();
  mkdirSync(join(store, '_memories', 'observations', '2026-07'), { recursive: true });
  writeFileSync(join(store, '_memories', 'observations', '2026-07', 'obs-should-not-copy.md'), 'cobalt should never leak in from a subdirectory');
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR,
      candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'irrelevant', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: () => ({ ok: false, reason: 'FORCED_FOR_TEST' }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'PLUGIN_INVENTORY_FAILED');
    const trialStoreDir = result.retainedArtifacts?.trialStoreDir;
    assert.ok(trialStoreDir, 'the spoil envelope must retain the trial store path');
    const { readdirSync } = await import('node:fs');
    const copiedFiles = readdirSync(join(trialStoreDir, '_memories'));
    assert.deepEqual(copiedFiles.sort(), ['dc-1-carrier.md']);
    assert.ok(!copiedFiles.includes('observations'));
    rmSync(trialStoreDir, { recursive: true, force: true });
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------
// Dependency-injection fixture-runner tests: exercise the FULL
// composition (corpus -> inventory -> spawn result -> join -> exposure ->
// envelope) with zero real spawns. Hale,
// hale--orchestrator-wip-must-fix-before-commit, item 8.
// ---------------------------------------------------------------------

// Echoes back whatever pluginDir the orchestrator actually generated (a
// fresh mkdtempSync path it can't be told in advance) as the sole enabled
// candidate; the baseline call (no pluginDir) reports nothing enabled.
function fakeFetchInventory({ pluginDir } = {}) {
  if (pluginDir) return { ok: true, inventory: [{ id: 'core@inline', enabled: true, installPath: pluginDir }] };
  return { ok: true, inventory: [] };
}

// Builds a fake `spawnClaude` that, when called, writes REAL-shaped
// retrieval/outcome rows (via the real producer functions) and a REAL-
// shaped Claude Code transcript (matching the verified schema in
// host-exposure-checker.mjs) into the exact cwd/session the orchestrator
// gives it, then returns a realistic CLI JSON result. No process is ever
// spawned -- this fixture is the "spawn result" the DI seam exists for.
function makeFixtureSpawn({ sessionId, promptId, packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds = [], deliveredUnitIds = rankedUnitIds, includeToolUse = false, omitModel = false, omitVersion = false }) {
  return (args, spawnOpts) => {
    const cwd = spawnOpts.cwd;
    // Hale, hale--6e4e086-stop-and-telemetry-hold / hale--0255-a5ee4c9-and-
    // sha-wip-disposition item 3: the JOINED retrieval row is cross-checked
    // against the independently recomputed selection -- units_retrieved
    // against the RANKED set, selected_count against the DELIVERED
    // (byte-cap-accepted) count, matching the real hook's own two
    // different source fields (trace.stages.final vs trace.pack.accepted).
    const retrieval = recordRetrievalEvent(cwd, {
      trigger: 'per-turn-hook', mechanism: 'model-free-substrate',
      retrieval_id: `${sessionId}-retrieval`,
      intent_topics: ['fixture'], tier_reached: 1, escalation_path: [1],
      units_retrieved: rankedUnitIds.map((id) => ({ id, tier: 1, source_stage: 'ranked' })),
      result: rankedUnitIds.length === 0 ? 'no-hit' : 'hit',
      candidate_count: rankedUnitIds.length, selected_count: deliveredUnitIds.length, context_pack_token_estimate: 0,
      requested_arm: arm, directive_fired: directiveText !== '',
    }, { today: date });
    recordRetrievalOutcome(cwd, {
      retrieval_id: retrieval.record.retrieval_id,
      usefulness_outcome: 'unknown', evidence_authority: 'unobservable',
      harness: HARNESS, session_id: sessionId, answer_turn_id: promptId,
      producer_version: PRODUCER_VERSION, producer_sha: PRODUCER_SHA,
    }, { today: date });

    const slug = mapProjectPathToSlug(cwd);
    const transcriptDir = join(homedir(), '.claude', 'projects', slug);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
    cleanupPaths.push(transcriptPath);
    const fullEmission = (packText && directiveText ? packText + directiveText : packText || directiveText).trimEnd();
    const lines = [
      { type: 'user', promptId, uuid: 'u1', parentUuid: null, version: FIXTURE_CLI_VERSION, message: { role: 'user', content: [{ type: 'text', text: 'fixture prompt' }] } },
      { type: 'attachment', uuid: 'u2', parentUuid: 'u1', version: FIXTURE_CLI_VERSION, attachment: { type: 'hook_success', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', toolUseID: 'tu1', content: fullEmission, stdout: `${fullEmission}\n`, exitCode: 0, command: EXPECTED_USER_PROMPT_SUBMIT_COMMAND } },
      // Hale, hale--paid-run-direct-file-read-confound: the real iteration-
      // 21 transcript showed exactly this shape -- a Bash/Read tool_use
      // block between exposure and the final answer, which is how the
      // model actually saw the planted token. includeToolUse lets a test
      // reproduce that shape to prove the confound gate catches it.
      ...(includeToolUse ? [{ type: 'assistant', uuid: 'utool', parentUuid: 'u2', version: FIXTURE_CLI_VERSION, message: { model: FIXTURE_MODEL, id: 'msgtool', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '_memories/dc-1-carrier.md' } }] } }] : []),
      { type: 'assistant', uuid: 'u3', parentUuid: includeToolUse ? 'utool' : 'u2', version: FIXTURE_CLI_VERSION, message: { model: FIXTURE_MODEL, id: 'msg1', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: answerText }] } },
      // A real completed `-p` invocation always fires the candidate's own
      // Stop hook (answer-close-hook.mjs) too -- host-exposure-checker.mjs
      // now requires it (Hale, hale--b75fecc-paid-run-not-release-evidence).
      { type: 'attachment', uuid: 'u4', parentUuid: 'u3', version: FIXTURE_CLI_VERSION, attachment: { type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', toolUseID: 'tu2', content: '', stdout: '', exitCode: 0, command: EXPECTED_STOP_COMMAND } },
    ];
    // Hale, hale--memory-architecture-advice-18: MODEL_OR_VERSION_NOT_OBSERVED
    // (run-claude-synthetic-trial.mjs) fails closed when either observed
    // value is null, but had zero test coverage -- these two flags let a
    // test reproduce a genuinely absent field instead of just asserting the
    // code exists.
    if (omitModel) { for (const l of lines) { if (l.message) delete l.message.model; } }
    if (omitVersion) { for (const l of lines) delete l.version; }
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    return {
      status: 0, error: null,
      stdout: JSON.stringify({ session_id: sessionId, is_error: false, result: answerText, total_cost_usd: 0 }),
      stderr: '',
    };
  };
}

test('DI composition: a full fixture-driven trial composes to a real ok:true envelope with zero real spawns', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-di-1';
  // Precompute the SAME derivation the orchestrator will run internally --
  // content-based, so computing it against the source store (same file
  // bytes buildFreshTrialStore will copy verbatim) yields an identical
  // result to what the orchestrator derives against its own fresh copy.
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.finalAnswerText, answerText);
    assert.equal(result.invocation.sessionId, sessionId);
    assert.equal(result.corpus.unitCount, 1);
    assert.equal(result.corpus.leakageClean, true);
    assert.equal(result.candidateIdentity.preInvocationContentHash, result.candidateIdentity.postInvocationContentHash);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: CANDIDATE_MUTATED_DURING_INVOCATION fires when the copied candidate changes mid-run', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const { packText, directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const realSpawn = makeFixtureSpawn({ sessionId: 'fixture-session-mutate-1', promptId: 'fixture-prompt-mutate-1', packText, directiveText, answerText: 'cobalt', arm, date, cleanupPaths });
    const mutatingSpawn = (args, spawnOpts) => {
      // Mutate the exact candidate copy dir the orchestrator handed to
      // --plugin-dir before it can re-hash -- args carries
      // `--plugin-dir <dir>` from the orchestrator's real command build.
      const pluginDirIdx = args.indexOf('--plugin-dir');
      const candidateCopyDir = args[pluginDirIdx + 1];
      writeFileSync(join(candidateCopyDir, 'MUTATED-DURING-RUN.txt'), 'tampered');
      return realSpawn(args, spawnOpts);
    };
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude: mutatingSpawn },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_MUTATED_DURING_INVOCATION');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: a missing outcome row (Stop hook never fired) spoils the join, not a silent pass', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'cobalt';
  const sessionId = 'fixture-session-no-outcome-1';
  const { directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    // Same as makeFixtureSpawn but deliberately skips recordRetrievalOutcome
    // -- simulates the Stop hook never firing for this turn.
    const spawnClaude = (args, spawnOpts) => {
      const cwd = spawnOpts.cwd;
      recordRetrievalEvent(cwd, {
        trigger: 'per-turn-hook', mechanism: 'model-free-substrate',
        retrieval_id: `${sessionId}-retrieval`,
        intent_topics: ['fixture'], tier_reached: 1, escalation_path: [1],
        units_retrieved: [], result: 'no-hit', candidate_count: 0, selected_count: 0, context_pack_token_estimate: 0,
        requested_arm: arm, directive_fired: directiveText !== '',
      }, { today: date });
      return { status: 0, error: null, stdout: JSON.stringify({ session_id: sessionId, is_error: false, result: answerText, total_cost_usd: 0 }), stderr: '' };
    };
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'JOIN_NO_OUTCOME_ROWS_IN_WINDOW');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: a duplicate retrieval row inside the trial window spoils contamination, not a silent pick', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'cobalt';
  const sessionId = 'fixture-session-dup-1';
  const { packText, directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const realSpawn = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-dup-1', packText, directiveText, answerText, arm, date, cleanupPaths });
    const spawnClaude = (args, spawnOpts) => {
      // Write a SECOND, unrelated retrieval row into the same window before
      // the real fixture's row lands -- simulates a stray concurrent write.
      recordRetrievalEvent(spawnOpts.cwd, {
        trigger: 'per-turn-hook', mechanism: 'model-free-substrate',
        retrieval_id: 'contaminating-retrieval',
        intent_topics: ['unrelated'], tier_reached: 1, escalation_path: [1],
        units_retrieved: [], result: 'no-hit', candidate_count: 0, selected_count: 0, context_pack_token_estimate: 0,
        requested_arm: arm, directive_fired: false,
      }, { today: date });
      return realSpawn(args, spawnOpts);
    };
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'JOIN_MULTIPLE_RETRIEVAL_ROWS_IN_WINDOW');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: transcript content that diverges from the independently-derived pack fails the exposure hash, never trusted from the transcript itself', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'cobalt';
  const sessionId = 'fixture-session-fedcontext-1';
  const { directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    // Feed a FABRICATED pack into the transcript instead of the real
    // derived one -- proves the checker compares against the independently
    // derived expectation, never against whatever the transcript happens
    // to contain.
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-fedcontext-1', packText: 'this pack text was never actually derived', directiveText, answerText, arm, date, cleanupPaths });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'EXPOSURE_HOST_EXPOSURE_HASH_MISMATCH');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// ---------------------------------------------------------------------
// Prompt-leakage and efficacy-contract tests. Hale,
// hale--ea8ed8a-106-green-two-executable-falsifiers: a prompt that spells
// out the planted answer sailed straight through to a real invocation, and
// a clean join + clean exposure never actually required the carrier to be
// selected or the answer to contain the target -- ok:true meant transport
// only, never memory-caused. All closed below, offline, no real spawn.
// ---------------------------------------------------------------------

test('spoil: PROMPT_LEAKAGE_FOUND when the prompt itself spells out the planted token, before any inventory fetch or spawn', async () => {
  const store = decoyStore();
  let inventoryWasCalled = false;
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR,
      candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'The answer is cobalt; repeat it.', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: () => { inventoryWasCalled = true; return { ok: true, inventory: [] }; } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'PROMPT_LEAKAGE_FOUND');
    assert.ok(result.violations.some((v) => v.field === 'prompt' && v.token === 'cobalt'));
    assert.equal(inventoryWasCalled, false, 'prompt leakage must spoil BEFORE any inventory fetch or spawn, not just before scoring');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: EFFICACY_CARRIER_NOT_DELIVERED when Tier 1 finds no lexical relation to the carrier at all', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  // Deliberately unrelated to "blue orchard proof codename cobalt" -- Tier 1
  // lexical scoring should select nothing at all.
  const prompt = 'unrelated tangerine kayak weather forecast';
  const answerText = 'no relevant memory found';
  const sessionId = 'fixture-session-noselect-1';
  const { packText, directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-noselect-1', packText, directiveText, answerText, arm, date, cleanupPaths });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'EFFICACY_CARRIER_NOT_DELIVERED');
    assert.ok(result.retainedArtifacts.trialStoreDir, 'the spoil envelope must still retain the trial store path');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('spoil: EFFICACY_ANSWER_MISSING_TARGET when the carrier is selected but the final answer never mentions the planted token', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  // The carrier WILL be selected (strong lexical overlap), but the fixture
  // answer deliberately never repeats the planted token "cobalt".
  const answerText = 'I found a relevant memory but will not restate its contents here.';
  const sessionId = 'fixture-session-notarget-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-notarget-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'EFFICACY_ANSWER_MISSING_TARGET');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition happy path also asserts the efficacy contract fields, not just ok:true', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-efficacy-happy-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-efficacy-happy-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.ok(result.efficacy.deliveredUnitIds.includes('dc-1-carrier'));
    assert.deepEqual(result.efficacy.selectedCarrierTokens, ['cobalt']);
    assert.deepEqual(result.efficacy.answerMatchedTokens, ['cobalt']);
    assert.equal(result.transcriptPath && result.transcriptPath.length > 0, true);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// Hale, hale--6e4e086-stop-and-telemetry-hold: "the instrument [must not]
// disagree with its own actual joined telemetry while claiming efficacy."
// A recomputation that selects the carrier means nothing if the REAL
// joined retrieval row logged something else -- this must spoil, not be
// silently overridden by the independent recomputation.
test('spoil: TELEMETRY_SELECTION_MISMATCH when the joined retrieval row disagrees with the independently recomputed selection', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-telemetry-mismatch-1';
  const { packText, directiveText } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    // Deliberately logs a DIFFERENT unit id than the real recomputation
    // (which selects 'dc-1-carrier') -- the recomputation would still
    // "pass" the carrier-selected check if trusted alone; the real joined
    // telemetry must be checked instead, and disagreement must spoil.
    const spawnClaude = makeFixtureSpawn({
      sessionId, promptId: 'fixture-prompt-telemetry-mismatch-1', packText, directiveText, answerText, arm, date, cleanupPaths,
      rankedUnitIds: ['some-other-unit-not-the-carrier'],
    });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'TELEMETRY_SELECTION_MISMATCH');
    assert.deepEqual(result.detail.loggedRankedUnitIds, ['some-other-unit-not-the-carrier']);
    assert.ok(result.detail.recomputedRankedUnitIds.includes('dc-1-carrier'));
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// ---------------------------------------------------------------------
// Product-SHA binding. Hale, hale--b75fecc-paid-run-not-release-evidence /
// hale--memory-architecture-advice--2026-07-20-15: "candidateRepoRoot text
// alone is not proof" -- verifying the candidate's copied content against
// the REAL git object database at an exact commit, not trusting a caller-
// supplied string next to an arbitrary directory.
// ---------------------------------------------------------------------

test('spoil: CANDIDATE_SHA_BINDING_REQUIRED when candidateRepoRoot is missing (SHA binding is mandatory, never optional)', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR,
      expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_SHA_BINDING_REQUIRED');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CANDIDATE_SHA_BINDING_INVALID_SHA for a mutable ref (HEAD) instead of a resolved 40-hex commit', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT,
      expectedCandidateGitSha: 'HEAD',
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_SHA_BINDING_INVALID_SHA');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CANDIDATE_SHA_BINDING_GIT_ERROR for a real-shaped 40-hex SHA that does not resolve in the given repo', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT,
      expectedCandidateGitSha: '0'.repeat(40),
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_SHA_BINDING_GIT_ERROR');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CANDIDATE_SHA_BINDING_MISMATCH when the copied candidate content does not match the real git object database at the given SHA', async () => {
  const store = decoyStore();
  // A syntactically-real directory, but its content has nothing to do with
  // the real commit's plugins/core tree -- the binding check must catch
  // this from content alone, not from any structural assumption.
  const mismatchedCandidateDir = mkdtempSync(join(tmpdir(), 'mismatched-candidate-'));
  writeFileSync(join(mismatchedCandidateDir, 'not-the-real-plugin.txt'), 'this is not plugins/core content');
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: mismatchedCandidateDir, candidateRepoRoot: REAL_REPO_ROOT,
      expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_SHA_BINDING_MISMATCH');
    assert.equal(result.detail.expectedGitSha, REAL_REPO_HEAD_SHA);
    assert.notEqual(result.detail.gitContentHash, result.detail.candidateContentHash);
  } finally {
    rmSync(store, { recursive: true, force: true });
    rmSync(mismatchedCandidateDir, { recursive: true, force: true });
  }
});

test('DI composition: CANDIDATE_SHA_BINDING passes and is recorded in the envelope when the candidate genuinely matches the real commit', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-sha-binding-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-sha-binding-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.candidateIdentity.verifiedCandidateGitSha, REAL_REPO_HEAD_SHA);
    assert.ok(result.candidateIdentity.verifiedCandidateTreeOid);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// ---------------------------------------------------------------------
// Estimand / tool-confound gate. Hale, hale--paid-run-direct-file-read-
// confound: the iteration-21 "efficacy" result was invalidated because
// the model used Bash/Read to open the carrier file directly rather than
// relying on the injected (title-only) pack content, and the orchestrator
// had no way to see or classify that.
// ---------------------------------------------------------------------

test('spoil: UNSUPPORTED_ESTIMAND for a value outside the closed vocabulary, validated before any spawn', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'something-else', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'UNSUPPORTED_ESTIMAND');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: EFFICACY_TOOL_CONFOUND_FOR_HOOK_DELIVERY_ESTIMAND when a tool call appears between exposure and answer under the hook-delivery-only estimand', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-toolconfound-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    // Same shape Hale found in the real iteration-21 transcript: a Read
    // tool_use block sits between the UserPromptSubmit exposure and the
    // terminal answer -- exactly the confound this estimand exists to rule out.
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-toolconfound-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds, includeToolUse: true });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'hook-delivery-only', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'EFFICACY_TOOL_CONFOUND_FOR_HOOK_DELIVERY_ESTIMAND');
    assert.equal(result.detail.toolCallsInTurn.length, 1);
    assert.equal(result.detail.toolCallsInTurn[0].name, 'Read');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: agent-with-tools estimand tolerates tool use but records the confound explicitly in the envelope, never silently', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-toolconfound-2';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-toolconfound-2', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds, includeToolUse: true });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.efficacy.toolMediatedConfoundPossible, true);
    assert.equal(result.efficacy.toolCallsInTurn.length, 1);
    assert.equal(result.efficacy.estimand, 'agent-with-tools');
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// ---------------------------------------------------------------------
// Commit-object identity + observed model/CLI version. Hale,
// hale--sha-wip-tree-object-false-pass / hale--55f1222-closure-rejected /
// hale--wip-visible-confound-still-false-green.
// ---------------------------------------------------------------------

test('spoil: CANDIDATE_SHA_BINDING_NOT_COMMIT for a real 40-hex TREE object OID, not a commit', async () => {
  const store = decoyStore();
  try {
    const treeOid = execFileSync('git', ['-C', REAL_REPO_ROOT, 'rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT,
      expectedCandidateGitSha: treeOid,
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools', model: FIXTURE_MODEL,
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_SHA_BINDING_NOT_COMMIT');
    assert.equal(result.objectType, 'tree');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: MODEL_REQUIRED when model is omitted, validated before any spawn', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      prompt: 'x', arm: 'always-on', date: '2026-07-20', estimand: 'agent-with-tools',
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'MODEL_REQUIRED');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: MODEL_IDENTITY_MISMATCH when the observed transcript model disagrees with what was requested', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-modelmismatch-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-modelmismatch-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools',
      // Deliberately request a DIFFERENT model than the fixture transcript
      // actually shows (FIXTURE_MODEL) -- requested and observed must agree.
      model: 'claude-opus-4-8',
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'MODEL_IDENTITY_MISMATCH');
    assert.equal(result.detail.requestedModel, 'claude-opus-4-8');
    assert.equal(result.detail.observedModel, FIXTURE_MODEL);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// Hale, hale--memory-architecture-advice-18: host-exposure-checker.mjs
// legitimately returns ok:true with a null observedModel/observedCliVersion
// (that checker proves exposure+answer, not identity) -- but for a TRIAL's
// execution-identity proof, an absent observed value must fail closed here
// at the orchestrator boundary, or requested identity could silently stand
// in for unobserved reality. The code (MODEL_OR_VERSION_NOT_OBSERVED) was
// already present but had zero test coverage before this.
test('spoil: MODEL_OR_VERSION_NOT_OBSERVED when the transcript never carries an observed model', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-nomodel-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-nomodel-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds, omitModel: true });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'MODEL_OR_VERSION_NOT_OBSERVED');
    assert.equal(result.detail.observedModel, null);
    assert.equal(result.detail.observedCliVersion, FIXTURE_CLI_VERSION);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('spoil: MODEL_OR_VERSION_NOT_OBSERVED when the transcript never carries an observed CLI version', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-noversion-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-noversion-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds, omitVersion: true });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'MODEL_OR_VERSION_NOT_OBSERVED');
    assert.equal(result.detail.observedModel, FIXTURE_MODEL);
    assert.equal(result.detail.observedCliVersion, null);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

test('DI composition: observed model and CLI version are recorded in the envelope and agree with the request', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  const sessionId = 'fixture-session-modelmatch-1';
  const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
  try {
    const spawnClaude = makeFixtureSpawn({ sessionId, promptId: 'fixture-prompt-modelmatch-1', packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
    const result = await runClaudeSyntheticTrial({
      sourceStoreDir: store, plants: PLANTS,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
      expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
      prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
      deps: { fetchInventory: fakeFetchInventory, spawnClaude },
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.command.requestedModel, FIXTURE_MODEL);
    assert.equal(result.command.observedModel, FIXTURE_MODEL);
    assert.equal(result.command.observedCliVersion, FIXTURE_CLI_VERSION);
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});

// Hale, hale--6676db9-audit-hold-remediation-plan-required: the smallest
// reusable piece of the matched-control design -- proves retrievalHookEnabled
// actually reaches the real hook's own opt-out env var, in both directions,
// and defaults safely when the caller doesn't pass it at all. This is
// plumbing, not the control leg's own validation logic (that's the next,
// separately-scoped piece -- see the design note in the mailbox reply).
test('retrievalHookEnabled sets the real hook opt-out env var explicitly, both directions, and defaults to enabled', async () => {
  const store = decoyStore();
  const cleanupPaths = [];
  const arm = 'deterministic-only';
  const date = '2026-07-20';
  const prompt = 'What is the proof codename?';
  const answerText = 'The proof codename is cobalt.';
  try {
    for (const [label, retrievalHookEnabled] of [['explicit-on', true], ['explicit-off', false], ['default (omitted)', undefined]]) {
      const sessionId = `fixture-session-hookflag-${label.replace(/[^a-z0-9]+/gi, '-')}`;
      const { packText, directiveText, rankedUnitIds, deliveredUnitIds } = await deriveExpectedPackAndDirective(prompt, store, arm, REAL_CORE_SKILL_ROOT);
      const capturedEnvs = [];
      const inner = makeFixtureSpawn({ sessionId, promptId: `${sessionId}-prompt`, packText, directiveText, answerText, arm, date, cleanupPaths, rankedUnitIds, deliveredUnitIds });
      const spawnClaude = (args, spawnOpts) => { capturedEnvs.push(spawnOpts.env); return inner(args, spawnOpts); };
      const result = await runClaudeSyntheticTrial({
        sourceStoreDir: store, plants: PLANTS,
        candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, candidateRepoRoot: REAL_REPO_ROOT, expectedCandidateGitSha: REAL_REPO_HEAD_SHA,
        expectedProducerVersion: PRODUCER_VERSION, expectedProducerSha: PRODUCER_SHA,
        prompt, arm, date, estimand: 'agent-with-tools', model: FIXTURE_MODEL,
        ...(retrievalHookEnabled === undefined ? {} : { retrievalHookEnabled }),
        deps: { fetchInventory: fakeFetchInventory, spawnClaude },
      });
      assert.equal(result.ok, true, `${label}: ${JSON.stringify(result, null, 2)}`);
      const expectEnabled = retrievalHookEnabled !== false; // default true
      assert.equal(capturedEnvs[0].CORE_RETRIEVAL_HOOK, expectEnabled ? '1' : '0', `${label}: real spawn env`);
      assert.equal(result.command.retrievalHookEnabled, expectEnabled, `${label}: recorded in envelope`);
      assert.equal(result.command.env.CORE_RETRIEVAL_HOOK, expectEnabled ? '1' : '0', `${label}: recorded env mirrors real spawn env`);
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
    for (const p of cleanupPaths) { try { rmSync(p, { force: true }); } catch { /* best-effort */ } }
  }
});
