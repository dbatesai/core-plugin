/**
 * verify-release-identity.test.mjs — the embedded-source-SHA gate.
 *
 * The manifests carry `source_sha`, the commit a release packages. Two ways that
 * claim goes wrong, and one test each:
 *
 *   source mode    — the committed stamp names a commit that is not the release
 *                    commit's parent (wrong), or names the right commit while
 *                    development has moved past it (stale mid-development).
 *   installed mode — an installed cache's manifest reports a different
 *                    source_sha/version/build than the candidate it claims to be.
 *
 * Fixtures are throwaway git repos built commit by commit, so the expected
 * parent SHA is known exactly rather than asserted against repo history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'release', 'verify-release-identity.mjs');

const CLAUDE_REL = join('plugins', 'core', '.claude-plugin', 'plugin.json');
const CODEX_REL = join('plugins', 'core', '.codex-plugin', 'plugin.json');
const SHIPPED_REL = join('plugins', 'core', 'skills', 'core', 'SKILL.md');

const git = (repo, args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'release-identity-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'test']);
  return dir;
}

/** Write both harness manifests into a repo working tree. */
function stampSource(repo, { version, build, sourceSha }) {
  mkdirSync(join(repo, dirname(CLAUDE_REL)), { recursive: true });
  mkdirSync(join(repo, dirname(CODEX_REL)), { recursive: true });
  writeFileSync(join(repo, CLAUDE_REL),
    JSON.stringify({ name: 'core', version, build, source_sha: sourceSha }, null, 2) + '\n');
  writeFileSync(join(repo, CODEX_REL),
    JSON.stringify({ name: 'core', version, source_sha: sourceSha }, null, 2) + '\n');
}

/** Write both harness manifests into an installed plugin root. */
function stampInstalled(root, { version, build, sourceSha }) {
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, '.codex-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'core', version, build, source_sha: sourceSha }, null, 2) + '\n');
  writeFileSync(join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'core', version, source_sha: sourceSha }, null, 2) + '\n');
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function run(args) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/**
 * A repo whose tip is a release commit: the bump commit stamps the version and
 * `source_sha`, and the SHA it stamps is the commit that bump packages — its own
 * parent, captured before the bump existed.
 */
function repoAtReleasePoint({ stamp } = {}) {
  const repo = newRepo();
  stampSource(repo, { version: '1.0.0', build: '20260101.1', sourceSha: '0'.repeat(40) });
  mkdirSync(join(repo, dirname(SHIPPED_REL)), { recursive: true });
  writeFileSync(join(repo, SHIPPED_REL), '# skill\n');
  writeFileSync(join(repo, 'README.md'), 'source\n');
  const packaged = commit(repo, 'source commit the release packages');
  stampSource(repo, { version: '1.1.0', build: '20260102.1', sourceSha: stamp ?? packaged });
  const release = commit(repo, 'release 1.1.0');
  return { repo, packaged, release };
}

test('source mode: a release commit whose stamp names its own parent is release-fresh', () => {
  const { repo, packaged } = repoAtReleasePoint();
  try {
    const { code, out } = run(['--source', repo]);
    assert.equal(code, 0, `expected release-fresh, got exit ${code}:\n${out}`);
    assert.match(out, /release-fresh/);
    assert.ok(out.includes(packaged), `verdict should name the packaged commit:\n${out}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('source mode: a commit that changes the packaged tree is stale mid-development, not a failure', () => {
  const { repo } = repoAtReleasePoint();
  try {
    writeFileSync(join(repo, SHIPPED_REL), '# skill\ndevelopment continues\n');
    commit(repo, 'ordinary development commit inside the packaged tree');

    const { code, out } = run(['--source', repo]);
    assert.equal(code, 3, `expected the distinct stale exit code, got ${code}:\n${out}`);
    assert.match(out, /stale/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('source mode: a commit that ships no different bytes is still the same release', () => {
  const { repo, packaged } = repoAtReleasePoint();
  try {
    // The release merge onto another branch, and any change outside the shipped
    // subtree: the package is byte-identical, so the stamp still describes it.
    writeFileSync(join(repo, 'README.md'), 'workshop notes, not shipped\n');
    commit(repo, 'change outside the packaged tree');

    const { code, out } = run(['--source', repo]);
    assert.equal(code, 0, `unchanged shipped bytes must stay release-fresh, got exit ${code}:\n${out}`);
    assert.match(out, /release-fresh/);
    assert.ok(out.includes(packaged), `verdict should still name the packaged commit:\n${out}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('source mode: a stamp naming a commit other than the release parent fails', () => {
  const { repo } = repoAtReleasePoint({ stamp: 'f'.repeat(40) });
  try {
    const { code, out } = run(['--source', repo]);
    assert.equal(code, 1, `a wrong stamp must fail, got exit ${code}:\n${out}`);
    assert.match(out, /source_sha/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('source mode: harness manifests stamping different commits fail', () => {
  const { repo, packaged } = repoAtReleasePoint();
  try {
    writeFileSync(join(repo, CODEX_REL),
      JSON.stringify({ name: 'core', version: '1.1.0', source_sha: 'a'.repeat(40) }, null, 2) + '\n');
    commit(repo, 'codex manifest drifts');

    const { code, out } = run(['--source', repo]);
    assert.equal(code, 1, `harness disagreement must fail, got exit ${code}:\n${out}`);
    assert.ok(out.includes('codex'), `verdict should name the disagreeing harness:\n${out}`);
    assert.ok(!out.includes(`release-fresh ${packaged}`));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A fix lands after the bump and the stamp moves forward to it.
function repoWithLaterStamp({ fixInsidePackage = false } = {}) {
  const { repo, release } = repoAtReleasePoint();
  if (fixInsidePackage) writeFileSync(join(repo, SHIPPED_REL), '# skill\nfix after the bump\n');
  else writeFileSync(join(repo, 'README.md'), 'test-only fix after the bump\n');
  const fix = commit(repo, 'fix after the bump');
  stampSource(repo, { version: '1.1.0', build: '20260102.1', sourceSha: fix });
  commit(repo, 're-stamp to the fix');
  return { repo, release, fix };
}

test('source mode: a stamp moved forward to a later commit that packages the same bytes is release-fresh', () => {
  const { repo } = repoWithLaterStamp();
  try {
    const { code, out } = run(['--source', repo]);
    assert.equal(code, 0, `a test-only fix after the bump must not fail the gate, got exit ${code}:\n${out}`);
    assert.match(out, /release-fresh/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('source mode: a stamp moved forward to a commit that changed the packaged bytes fails', () => {
  const { repo } = repoWithLaterStamp({ fixInsidePackage: true });
  try {
    const { code, out } = run(['--source', repo]);
    assert.equal(code, 1, `a stamp naming different packaged bytes must fail, got exit ${code}:\n${out}`);
    assert.match(out, /packaging the release's bytes/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('source mode: a stamp naming a commit that is not on the way to the ref fails even when its bytes match', () => {
  const { repo, release } = repoAtReleasePoint();
  try {
    git(repo, ['checkout', '-q', '-b', 'side', release]);
    writeFileSync(join(repo, 'README.md'), 'side branch\n');
    const side = commit(repo, 'side branch commit, same packaged bytes');
    git(repo, ['checkout', '-q', 'main']);
    stampSource(repo, { version: '1.1.0', build: '20260102.1', sourceSha: side });
    commit(repo, 'stamp names a commit from another branch');
    const { code, out } = run(['--source', repo]);
    assert.equal(code, 1, `got exit ${code}:\n${out}`);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('source mode: after a moved-forward stamp, a later change inside the package is stale, not fresh', () => {
  const { repo } = repoWithLaterStamp();
  try {
    writeFileSync(join(repo, SHIPPED_REL), '# skill\ndevelopment continues\n');
    commit(repo, 'ordinary development commit inside the packaged tree');
    const { code } = run(['--source', repo]);
    assert.equal(code, 3);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('installed mode: a cache matching the expected candidate passes', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-match-'));
  try {
    stampInstalled(root, { version: '1.1.0', build: '20260102.1', sourceSha: 'b'.repeat(40) });
    const { code, out } = run(['--installed', root, '--expect-sha', 'b'.repeat(40),
      '--expect-version', '1.1.0', '--expect-build', '20260102.1']);
    assert.equal(code, 0, `expected a pass, got exit ${code}:\n${out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed mode: a stale cache fails the gate', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-stale-'));
  try {
    stampInstalled(root, { version: '1.0.0', build: '20260101.1', sourceSha: '0'.repeat(40) });
    const { code, out } = run(['--installed', root, '--expect-sha', 'b'.repeat(40),
      '--expect-version', '1.1.0', '--expect-build', '20260102.1']);
    assert.notEqual(code, 0, `a stale installed cache must not pass:\n${out}`);
    assert.match(out, /source_sha/);
    assert.match(out, /version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed mode: expectations read from the source repo catch a cache built from an older candidate', () => {
  const { repo, packaged } = repoAtReleasePoint();
  const root = mkdtempSync(join(tmpdir(), 'installed-derived-'));
  try {
    stampInstalled(root, { version: '1.0.0', build: '20260101.1', sourceSha: '0'.repeat(40) });
    const stale = run(['--installed', root, '--source', repo]);
    assert.notEqual(stale.code, 0, `derived expectations must reject the older cache:\n${stale.out}`);

    stampInstalled(root, { version: '1.1.0', build: '20260102.1', sourceSha: packaged });
    const fresh = run(['--installed', root, '--source', repo]);
    assert.equal(fresh.code, 0, `the exact candidate must pass:\n${fresh.out}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed mode: a root with no manifest is indeterminate, not a pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'installed-empty-'));
  try {
    const { code, out } = run(['--installed', root, '--expect-sha', 'b'.repeat(40)]);
    assert.equal(code, 2, `a missing manifest must be indeterminate, got exit ${code}:\n${out}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
