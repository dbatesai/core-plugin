import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createIsolatedHome, verifyIsolation } = await import(pathToFileURL(join(PILOT, 'isolated-trial-home.mjs')).href);

function fakeCandidateDir(seed = 'x') {
  const dir = mkdtempSync(join(tmpdir(), 'fake-candidate-'));
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'core'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'core', version: '3.12.1-pilot.1' }));
  writeFileSync(join(dir, 'skills', 'core', 'marker.txt'), `content-${seed}`);
  return dir;
}

test('createIsolatedHome rejects an invalid harness name', () => {
  assert.throws(() => createIsolatedHome({ harness: 'gemini', candidatePluginDir: '/tmp', version: '1.0.0' }), (e) => e.code === 'INVALID_HARNESS');
});

test('createIsolatedHome rejects a missing candidate directory', () => {
  assert.throws(() => createIsolatedHome({ harness: 'claude', candidatePluginDir: '/definitely/does/not/exist', version: '1.0.0' }), (e) => e.code === 'CANDIDATE_DIR_MISSING');
});

// Hale re-audit amendment: caller-supplied version/marketplaceName become
// path components and must not be able to traverse directories.
test('createIsolatedHome rejects a path-traversal version or marketplaceName', () => {
  const candidate = fakeCandidateDir();
  assert.throws(() => createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '../../etc' }), (e) => e.code === 'UNSAFE_PATH_COMPONENT');
  assert.throws(() => createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1', marketplaceName: '../escape' }), (e) => e.code === 'UNSAFE_PATH_COMPONENT');
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

test('verifyIsolation reports isolated:true for a freshly-created single-candidate home with matching content', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cacheDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir, sourceCandidateDir: candidate });
    assert.equal(result.isolated, true, JSON.stringify(result));
  } finally { cleanup(); }
});

// Negative control: exactly the failure mode Hale's real installed proof
// found — a second, different-version install present alongside the
// candidate.
test('verifyIsolation reports isolated:false when a second version is present (the exact failure Hale found)', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cacheDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    const stableDir = cacheDir.replace('3.12.1-pilot.1', '3.12.0');
    mkdirSync(stableDir, { recursive: true });
    writeFileSync(join(stableDir, 'marker.txt'), 'stable install leftover');
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir, sourceCandidateDir: candidate });
    assert.equal(result.isolated, false);
    assert.equal(result.reason, 'OTHER_VERSIONS_PRESENT');
  } finally { cleanup(); }
});

// Hale re-audit false pass 1 (cb2-filesystem-isolation-narrow-hold): real
// content copied under a WRONG caller-supplied version number still
// reported isolated:true because the old check only matched a directory
// NAME. Content identity comparison against the real source must catch
// this even when the manifest's own version field is internally consistent
// with the path (i.e., simulate a genuinely mislabeled cache: the manifest
// on disk says one version, the directory is named the same wrong version,
// but the actual content differs from the true source candidate).
test('verifyIsolation catches content that does not match the source candidate, even when the path/manifest version agree with each other', () => {
  const realCandidate = fakeCandidateDir('real');
  const differentCandidate = fakeCandidateDir('different'); // same manifest version, different marker content
  // Manually build a cache dir the way createIsolatedHome would, but seed
  // it with the WRONG candidate's content under the requested version.
  const homeDir = mkdtempSync(join(tmpdir(), 'pilot-home-claude-'));
  const cacheDir = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'core', '3.12.1-pilot.1');
  mkdirSync(cacheDir, { recursive: true });
  cpSync(differentCandidate, cacheDir, { recursive: true });
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir, sourceCandidateDir: realCandidate });
    assert.equal(result.isolated, false);
    assert.equal(result.reason, 'CONTENT_MISMATCH');
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

// Hale re-audit false pass 2: renaming the required .../core/<version> path
// segment to .../not-core/<version> still reported isolated:true because
// the old check searched broadly for ANY directory named like the version.
// The new check looks at the EXACT expected path only.
test('verifyIsolation fails when the candidate sits at the wrong path shape (e.g. .../not-core/<version> instead of .../core/<version>)', () => {
  const candidate = fakeCandidateDir();
  const homeDir = mkdtempSync(join(tmpdir(), 'pilot-home-claude-'));
  const wrongShapeDir = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'not-core', '3.12.1-pilot.1');
  mkdirSync(wrongShapeDir, { recursive: true });
  cpSync(candidate, wrongShapeDir, { recursive: true });
  // Caller asks verifyIsolation to check the CORRECT expected path shape,
  // which is absent -- the content sitting at the wrong shape must not
  // count.
  const expectedCacheDir = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'core', '3.12.1-pilot.1');
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir: expectedCacheDir, sourceCandidateDir: candidate });
    assert.equal(result.isolated, false);
    assert.equal(result.reason, 'EXPECTED_PATH_MISSING');
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

test('verifyIsolation fails when the installed manifest claims a different name/version than requested', () => {
  const candidate = fakeCandidateDir();
  const homeDir = mkdtempSync(join(tmpdir(), 'pilot-home-claude-'));
  const cacheDir = join(homeDir, '.claude', 'plugins', 'cache', 'mp', 'core', '3.12.1-pilot.1');
  mkdirSync(cacheDir, { recursive: true });
  cpSync(candidate, cacheDir, { recursive: true });
  // Overwrite the manifest with a mismatched version, content otherwise identical.
  writeFileSync(join(cacheDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'core', version: '9.9.9' }));
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir, sourceCandidateDir: candidate });
    assert.equal(result.isolated, false);
    assert.equal(result.reason, 'MANIFEST_IDENTITY_MISMATCH');
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

// Hale re-audit (hale--4fa-f624-narrow-pass-new-falsifiers), false pass:
// "Omit sourceCandidateDir while passing an otherwise normal isolated
// home. verifyIsolation() returns isolated: true without performing the
// promised content comparison." A missing proof must fail closed, not
// pass by omission.
test('verifyIsolation requires sourceCandidateDir — omitting it must throw, never silently pass', () => {
  const candidate = fakeCandidateDir();
  const { homeDir, cacheDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: candidate, version: '3.12.1-pilot.1' });
  try {
    assert.throws(
      () => verifyIsolation({ homeDir, harness: 'claude', version: '3.12.1-pilot.1', cacheDir }),
      (e) => e.code === 'SOURCE_CANDIDATE_REQUIRED',
    );
  } finally { cleanup(); }
});

// Hale re-audit, false pass: "Pass the real source directory itself as
// cacheDir while homeDir is an unrelated empty directory. Manifest and
// hashes match, the empty home scan finds no competitors, and
// verifyIsolation() returns isolated: true." cacheDir must actually sit
// under homeDir at the expected relative shape, not just point at
// something that happens to satisfy the later checks trivially.
test('verifyIsolation rejects a cacheDir that is not actually under the given homeDir', () => {
  const candidate = fakeCandidateDir();
  const unrelatedEmptyHome = mkdtempSync(join(tmpdir(), 'pilot-home-unrelated-'));
  try {
    // cacheDir = the real source directory itself, nothing to do with
    // unrelatedEmptyHome at all.
    const result = verifyIsolation({ homeDir: unrelatedEmptyHome, harness: 'claude', version: '3.12.1-pilot.1', cacheDir: candidate, sourceCandidateDir: candidate });
    assert.equal(result.isolated, false);
    assert.equal(result.reason, 'CACHE_PATH_NOT_UNDER_HOME');
  } finally { rmSync(unrelatedEmptyHome, { recursive: true, force: true }); }
});

// End-to-end smoke: the real frozen candidate, through the real
// createIsolatedHome + verifyIsolation pair, preserved as an executable
// test/receipt per Hale's explicit ask -- not just a one-off manual run.
//
// Hale re-audit (hale--4fa-f624-narrow-pass-new-falsifiers): the prior
// version hard-coded a DIFFERENT worktree's absolute path
// (/private/tmp/core-plugin-pilot-48a87f6) and silently returned as a
// passing test when that path was absent -- an environment difference
// could make the smoke never actually execute while still reporting
// green. This branch (pilot-runner-6dc12a3) IS checked out at the frozen
// candidate itself, so its own repo-relative plugins/core IS the real
// candidate content -- no cross-worktree reference, no absent-path skip.
test('smoke: createIsolatedHome + verifyIsolation against this worktree\'s own frozen candidate content', () => {
  const REAL_CANDIDATE = join(PILOT, '..', 'plugins', 'core');
  const manifest = JSON.parse(readFileSync(join(REAL_CANDIDATE, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.ok(manifest.version, 'this worktree\'s own plugins/core must be a real, readable candidate manifest');
  const { homeDir, cacheDir, cleanup } = createIsolatedHome({ harness: 'claude', candidatePluginDir: REAL_CANDIDATE, version: manifest.version });
  try {
    const result = verifyIsolation({ homeDir, harness: 'claude', version: manifest.version, cacheDir, sourceCandidateDir: REAL_CANDIDATE });
    assert.equal(result.isolated, true, JSON.stringify(result));
  } finally { cleanup(); }
});
