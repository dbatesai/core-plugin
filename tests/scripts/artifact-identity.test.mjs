/**
 * artifact-identity — Train A blocker 3 acceptance (Hale verdict §3).
 *
 * The bar (Hale round 6): identical identity from two CLEAN INDEPENDENT exports,
 * not one repeated local command. Export path A reads the git object database
 * (ls-tree + cat-file, no working tree); export path B extracts a `git archive`
 * tarball and hashes the filesystem tree. The old tar-byte hash differed run to
 * run; the content identity must agree across BOTH mechanisms and repeated runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const { treeOid, manifestFromGit, manifestFromDirectory, artifactIdentity } =
  await import(pathToFileURL(join(SCRIPTS, 'artifact-identity.mjs')).href);

// Skip everywhere git or repo history isn't available (a packaged install running
// tests outside a clone). CI runs from a full checkout, so the proof runs there.
function gitHead() {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const HEAD = gitHead();

test('blocker-3: two independent exports agree — git object database vs extracted archive', { skip: !HEAD }, () => {
  const fromGit = manifestFromGit(REPO, HEAD, 'plugins/core');
  const dir = mkdtempSync(join(tmpdir(), 'artifact-id-'));
  try {
    // Export mechanism B: git archive → extract → hash the filesystem tree.
    execFileSync('bash', ['-c',
      `git -C ${JSON.stringify(REPO)} archive ${HEAD}:plugins/core | tar -x -C ${JSON.stringify(dir)}`]);
    const fromTree = manifestFromDirectory(dir);
    assert.equal(fromTree.content_manifest_sha256, fromGit.content_manifest_sha256,
      'content identity agrees across two independent export mechanisms');
    assert.equal(fromTree.file_count, fromGit.file_count);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('blocker-3: identity is stable across repeated runs and anchored to the tree OID', { skip: !HEAD }, () => {
  const a = artifactIdentity(REPO, HEAD, 'plugins/core');
  const b = artifactIdentity(REPO, HEAD, 'plugins/core');
  assert.equal(a.content_manifest_sha256, b.content_manifest_sha256, 'no invocation-time variance (the tar-byte defect)');
  assert.equal(a.tree_oid, b.tree_oid);
  assert.equal(a.tree_oid, treeOid(REPO, HEAD, 'plugins/core'));
  assert.match(a.tree_oid, /^[0-9a-f]{40}$/);
  assert.match(a.content_manifest_sha256, /^[0-9a-f]{64}$/);
  assert.ok(a.reproduce.tree_oid.includes('git rev-parse'), 'exact reproduction command published');
});

test('blocker-3: different subtrees yield different identities (the hash is content, not ritual)', { skip: !HEAD }, () => {
  const core = manifestFromGit(REPO, HEAD, 'plugins/core');
  const tests = manifestFromGit(REPO, HEAD, 'tests');
  assert.notEqual(core.content_manifest_sha256, tests.content_manifest_sha256);
});
