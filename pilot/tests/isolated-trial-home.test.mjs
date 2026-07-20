import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createIsolatedHome, verifyIsolation } = await import(pathToFileURL(join(PILOT, 'isolated-trial-home.mjs')).href);

function fakeCandidateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-candidate-'));
  mkdirSync(join(dir, 'skills', 'core'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json').replace('.claude-plugin', 'skills/core'), '{}'); // placeholder, overwritten below
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'core', version: '3.12.1-pilot.1' }));
  return dir;
}

test('createIsolatedHome rejects an invalid harness name', () => {
  assert.throws(() => createIsolatedHome({ harness: 'gemini', candidatePluginDir: '/tmp', version: '1.0.0' }), (e) => e.code === 'INVALID_HARNESS');
});

test('createIsolatedHome rejects a missing candidate directory', () => {
  assert.throws(() => createIsolatedHome({ harness: 'claude', candidatePluginDir: '/definitely/does/not/exist', version: '1.0.0' }), (e) => e.code === 'CANDIDATE_DIR_MISSING');
});

test('createIsolatedHome lays out the cache path exactly like a real Claude install and copies the candidate content', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cacheDir, env, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    assert.match(cacheDir, /\.claude\/plugins\/cache\/[^/]+\/core\/3\.12\.1-pilot\.1$/);
    assert.ok(existsSync(join(cacheDir, '.claude-plugin', 'plugin.json')), 'candidate manifest must be present in the cache dir');
    assert.equal(env.HOME, homeDir);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(homeDir, '.claude'));
  } finally { cleanup(); }
});

test('createIsolatedHome lays out the Codex-shaped cache path', () => {
  const candidate = fakeCandidateDir();
  const { cacheDir, env, cleanup } = createIsolatedHome({ harness: 'codex', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    assert.match(cacheDir, /\.codex\/plugins\/cache\/[^/]+\/core\/3\.12\.1-pilot\.1$/);
    assert.ok(env.CODEX_HOME);
  } finally { cleanup(); }
});

test('cleanup actually removes the isolated home — no leftover state between trials', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  assert.ok(existsSync(homeDir));
  cleanup();
  assert.ok(!existsSync(homeDir), 'isolated home must be fully removed after cleanup');
});

test('two isolated homes for the same candidate never collide (unique marketplace names)', () => {
  const candidate = fakeCandidateDir();
  const a = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  const b = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    assert.notEqual(a.homeDir, b.homeDir);
    assert.notEqual(a.cacheDir, b.cacheDir);
  } finally { a.cleanup(); b.cleanup(); }
});

test('verifyIsolation reports isolated:true for a freshly-created single-candidate home', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1' });
    assert.equal(result.isolated, true);
    assert.equal(result.otherVersionsPresent.length, 0);
  } finally { cleanup(); }
});

// Negative control: exactly the failure mode Hale's real installed proof
// found — a second, different-version install present alongside the
// candidate. verifyIsolation must catch it, not report false isolation.
test('verifyIsolation reports isolated:false when a second version is present (the exact failure Hale found)', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cacheDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    // Simulate a leftover stable install sitting alongside the candidate.
    const stableDir = cacheDir.replace('3.12.1-pilot.1', '3.12.0');
    mkdirSync(stableDir, { recursive: true });
    writeFileSync(join(stableDir, 'marker.txt'), 'stable install leftover');
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1' });
    assert.equal(result.isolated, false, 'a second version present must be detected, not silently missed');
    assert.equal(result.otherVersionsPresent.length, 1);
    assert.match(result.otherVersionsPresent[0], /3\.12\.0$/);
  } finally { cleanup(); }
});
