import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { probe } from '../../plugins/core/skills/core/scripts/capability/target-surface-collab-files-probe.mjs';

const DESCRIPTOR_PATH = join(process.cwd(), 'plugins/core/skills/core/schemas/harness-capability-descriptor.json');

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function git(args, cwd) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Build a real git repo whose `push --dry-run` deterministically fails: origin points at
// a non-existent local path. The repo is otherwise valid (root matches, status parseable).
function repoWithUnpushableRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-files-probe-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
  const bogusRemote = join(dir, 'does-not-exist-remote.git');
  git(['remote', 'add', 'origin', bogusRemote], dir);
  return { dir, bogusRemote };
}

test('M11: a mutation-kind surface with a failed write-proof degrades fail-closed (was a false PASS)', async () => {
  const { dir, bogusRemote } = repoWithUnpushableRemote();
  try {
    const row = await probe({ filesRepo: dir, expectedRemote: bogusRemote });
    assert.equal(row.capability_kind, 'mutation', 'this surface is mutation-kind');
    // Before the fix the unproven push was "corroborating" and identity stayed PASS, so the
    // runner (which gates mutation on identity PASS) would clear a write on a repo we cannot
    // prove we can write to. Fail-closed mutation requires DEGRADED here.
    assert.equal(row.identity_status, 'DEGRADED', 'unproven write on a mutation surface must not be PASS');
    const pushEv = row.evidence.find((e) => e.source === 'git-push-dry-run');
    assert.equal(pushEv.weight, 'conflicting', 'the failed write-proof is the conflicting signal');
    assert.equal(pushEv.value.unproven_code, 'target_surface_write_unproven', 'still documented as unproven, not proven-broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped descriptor no longer bakes in any one install\'s personal repo path or remote', () => {
  const descriptor = JSON.parse(readFileSync(DESCRIPTOR_PATH, 'utf8'));
  assert.equal(descriptor.surfaces.collab_files_repo, null, 'no personal default path ships in the descriptor');
  assert.equal(descriptor.surfaces.collab_files_expected_remote, null, 'no personal default remote ships in the descriptor');
  // Belt-and-suspenders: the raw file must not contain any specific personal
  // github handle or absolute home-directory path baked in as a default.
  const raw = readFileSync(DESCRIPTOR_PATH, 'utf8');
  assert.doesNotMatch(raw, /dbatesai/, 'descriptor must not name a specific personal github handle');
});

test('with nothing configured anywhere (no override, no env var, no descriptor default), the probe reports UNKNOWN — not-applicable, not a silent default to someone\'s personal repo', async () => {
  await withEnv({ CORE_COLLAB_FILES_REPO: undefined, CORE_COLLAB_FILES_EXPECTED_REMOTE: undefined }, async () => {
    const row = await probe({ descriptor: { surfaces: {} } });
    assert.equal(row.identity_status, 'UNKNOWN');
    assert.equal(row.target_surface, null, 'never silently resolves to a default path');
    const configEv = row.evidence.find((e) => e.source === 'config-check');
    assert.ok(configEv, 'records why nothing ran');
    assert.match(configEv.value, /CORE_COLLAB_FILES_REPO/, 'evidence names the env var a user would set');
  });
});

test('CORE_COLLAB_FILES_REPO env var configures the probe per-installation, taking priority over the descriptor default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-files-probe-envvar-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
  try {
    await withEnv({ CORE_COLLAB_FILES_REPO: dir, CORE_COLLAB_FILES_EXPECTED_REMOTE: undefined }, async () => {
      // Descriptor still declares some other (unrelated, non-existent) path — env var must win.
      const row = await probe({ descriptor: { surfaces: { collab_files_repo: '/nonexistent/should-be-overridden' } } });
      assert.equal(row.target_surface, dir, 'env var path used, not the descriptor default');
      const existsEv = row.evidence.find((e) => e.source === 'repo-exists');
      assert.equal(existsEv.value.exists, true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tilde-prefixed CORE_COLLAB_FILES_REPO env var expands against the real homedir, same as the descriptor path did', async () => {
  await withEnv({ CORE_COLLAB_FILES_REPO: '~/this-almost-certainly-does-not-exist-core-probe-test', CORE_COLLAB_FILES_EXPECTED_REMOTE: undefined }, async () => {
    const row = await probe({ descriptor: { surfaces: {} } });
    assert.equal(row.target_surface, join(homedir(), 'this-almost-certainly-does-not-exist-core-probe-test'));
    assert.equal(row.identity_status, 'NOT-YET', 'configured but not yet present on this machine — not ready, not broken');
  });
});

// --- Readiness is not failure, and an unverified destination is not a destination ---

test('a configured surface that has not been scaffolded yet reports NOT-YET, not DEGRADED', async () => {
  const missing = join(tmpdir(), 'collab-files-never-created-12345');
  const row = await probe({ filesRepo: missing, expectedRemote: 'git@example.com:x/y.git' });
  assert.equal(row.identity_status, 'NOT-YET', 'absent-because-not-set-up is not the same as broken');
  assert.equal(row.reason_code, 'target-surface-not-scaffolded');
  assert.notEqual(row.identity_status, 'PASS', 'not-ready is still not a pass');
});

test('a path that exists but is not a git repo is still a real failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-files-notgit-'));
  try {
    const row = await probe({ filesRepo: dir, expectedRemote: 'git@example.com:x/y.git' });
    assert.notEqual(row.identity_status, 'NOT-YET', 'a present-but-wrong surface is not "not ready"');
    assert.notEqual(row.identity_status, 'PASS');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('mutation authority requires a named destination — an unverified remote degrades', async () => {
  // A repo whose push dry-run succeeds but with no expected remote configured: every
  // proof passes and the gate opens onto a destination nobody declared.
  const upstream = mkdtempSync(join(tmpdir(), 'collab-upstream-'));
  const dir = mkdtempSync(join(tmpdir(), 'collab-files-noexp-'));
  try {
    git(['init', '-q', '--bare'], upstream);
    git(['init', '-q'], dir);
    git(['config', 'user.email', 't@t'], dir);
    git(['config', 'user.name', 't'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    git(['remote', 'add', 'origin', upstream], dir);
    const row = await probe({ filesRepo: dir });
    assert.equal(row.identity_status, 'DEGRADED', 'an unnamed destination cannot carry mutation authority');
    const remoteEv = row.evidence.find((e) => e.source === 'git-remote');
    assert.equal(remoteEv.weight, 'conflicting');
    assert.equal(remoteEv.agrees_with_others, false);

    const named = await probe({ filesRepo: dir, expectedRemote: upstream });
    assert.equal(named.identity_status, 'PASS', 'a declared, matching destination passes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  }
});
