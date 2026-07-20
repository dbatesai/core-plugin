import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { runClaudeSyntheticTrial } = await import(pathToFileURL(join(PILOT, 'run-claude-synthetic-trial.mjs')).href);

const REAL_CANDIDATE_PLUGIN_DIR = join(PILOT, '..', 'plugins', 'core');
const REAL_REPO_ROOT = join(PILOT, '..');

function decoyStore() {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-trial-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  writeFileSync(join(dir, '_memories', 'dc-1-probe.md'), '---\nid: dc-1-probe\ntype: decision\nstatus: active\ntopics: [probe]\n---\n\n# Probe unit\n\nA synthetic decoy unit.\n');
  return dir;
}

// Cheap, no-spawn validation tests — every real invocation costs real
// money, so these prove the fail-closed input validation without ever
// touching the CLI.

test('spoil: UNSUPPORTED_ARM for automatic (not yet supported, named explicitly)', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({ storeDir: store, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'automatic', date: '2026-07-20' });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'UNSUPPORTED_ARM');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CORPUS_MISSING when storeDir has no _memories directory', async () => {
  const store = mkdtempSync(join(tmpdir(), 'synthetic-trial-empty-'));
  try {
    const result = await runClaudeSyntheticTrial({ storeDir: store, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'always-on', date: '2026-07-20' });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CORPUS_MISSING');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: CANDIDATE_PLUGIN_DIR_MISSING for a nonexistent candidate path', async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({ storeDir: store, candidatePluginDir: '/definitely/does/not/exist', prompt: 'x', arm: 'always-on', date: '2026-07-20' });
    assert.equal(result.ok, false);
    assert.equal(result.spoilReason, 'CANDIDATE_PLUGIN_DIR_MISSING');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('spoil: MISSING_REQUIRED_INPUT when prompt or date are absent', async () => {
  const store = decoyStore();
  try {
    const r1 = await runClaudeSyntheticTrial({ storeDir: store, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, arm: 'always-on', date: '2026-07-20' });
    assert.equal(r1.ok, false);
    assert.equal(r1.spoilReason, 'MISSING_REQUIRED_INPUT');
    const r2 = await runClaudeSyntheticTrial({ storeDir: store, candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR, prompt: 'x', arm: 'always-on' });
    assert.equal(r2.ok, false);
    assert.equal(r2.spoilReason, 'MISSING_REQUIRED_INPUT');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// Real, cost-incurring, authenticated end-to-end test. Gated behind an
// explicit env var — never runs by default, per Hale's own allowance
// ("even if its model-spawn test is conditionally skipped until the real
// run"). This exact composition was proven by hand this iteration
// (real ok:true through join + exposure, real extracted answer "pong")
// before this scaffold existed; this test exists to make that rerunnable
// without hand-typed commands once someone opts in.
const RUN_REAL = process.env.RUN_REAL_CLAUDE_TRIAL === '1';
test('REAL (gated): a full authenticated always-on trial composes to ok:true end to end', { skip: !RUN_REAL }, async () => {
  const store = decoyStore();
  try {
    const result = await runClaudeSyntheticTrial({
      storeDir: store,
      candidatePluginDir: REAL_CANDIDATE_PLUGIN_DIR,
      candidateRepoRoot: REAL_REPO_ROOT,
      expectedProducerVersion: '3.12.1-pilot.1',
      expectedProducerSha: 'fc8a23ad99bbc1d082f4ebed4388093a53c9fc47',
      prompt: 'Reply with exactly the word: pong',
      arm: 'always-on',
      date: new Date().toISOString().slice(0, 10),
      timeoutMs: 60000,
    });
    assert.equal(result.ok, true, JSON.stringify(result, null, 2));
    assert.equal(result.finalAnswerText, 'pong');
  } finally { rmSync(store, { recursive: true, force: true }); }
});
