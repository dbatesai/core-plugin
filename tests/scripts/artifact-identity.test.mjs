/**
 * artifact-identity — Train A blocker 3 acceptance.
 *
 * The bar: identical identity from two CLEAN INDEPENDENT exports,
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

const { treeOid, manifestFromGit, manifestFromDirectory, artifactIdentity, directoryIdentity, diffManifests } =
  await import(pathToFileURL(join(SCRIPTS, 'artifact-identity.mjs')).href);

// Skip everywhere git or repo history isn't available (a packaged install running
// tests outside a clone). CI runs from a full checkout, so the proof runs there.
function gitHead() {
  try { return execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { return null; }
}
const HEAD = gitHead();

test('blocker-3: two independent exports agree — git object database vs extracted archive', { skip: !HEAD }, async () => {
  const { mkdirSync } = await import('node:fs');
  const fromGit = manifestFromGit(REPO, HEAD, 'plugins/core');
  const dir = mkdtempSync(join(tmpdir(), 'artifact-id-'));
  try {
    // Export mechanism B: git archive to a FILE, tar extract — no shell, no pipe.
    // tar runs with cwd-RELATIVE paths: GNU tar (first on PATH in Windows CI)
    // reads a drive-letter argument like C:\… as a remote HOSTNAME ("Cannot
    // connect to C") — keeping every tar argument relative sidesteps the whole
    // drive-colon class on every platform.
    const tarPath = join(dir, 'export.tar');
    const treeDir = join(dir, 'tree');
    mkdirSync(treeDir);
    // -c core.autocrlf=false pins a BYTE-PRESERVING export: on Windows (autocrlf
    // configured) git archive otherwise converts text files to CRLF, and the
    // extracted bytes genuinely differ from the committed blobs. The packet's
    // reproduction command pins the same flag for the same reason.
    execFileSync('git', ['-C', REPO, '-c', 'core.autocrlf=false', 'archive', '-o', tarPath, `${HEAD}:plugins/core`]);
    execFileSync('tar', ['-x', '-f', 'export.tar', '-C', 'tree'], { cwd: dir });
    const fromTree = manifestFromDirectory(treeDir);
    // On divergence, name the first differing file + counts:
    // two unequal hashes alone can't be root-caused from a CI log.
    const diff = diffManifests(fromGit, fromTree);
    assert.equal(fromTree.content_manifest_sha256, fromGit.content_manifest_sha256,
      `content identity must agree across two independent export mechanisms — counts git=${fromGit.file_count} tree=${fromTree.file_count}, first divergence: ${JSON.stringify(diff)}`);
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

// Prove the identity FLOWS end to end — artifact-identity output →
// the receipt's built_artifact_sha256 — through the real CLI seam the freeze step
// uses, with the receipt's shape validation applied to the injected value.
test('blocker-3 end-to-end: the content-manifest identity lands in the shareable receipt intact', { skip: !HEAD }, async () => {
  const { writeFileSync, readFileSync, rmSync: rm } = await import('node:fs');
  const { runHarness } = await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);
  const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
  const dir = mkdtempSync(join(tmpdir(), 'id-e2e-'));
  try {
    const identity = artifactIdentity(REPO, HEAD, 'plugins/core');
    const goldPath = join(dir, 'gold.json');
    writeFileSync(goldPath, JSON.stringify({ queries: [
      { id: 'q1', query: 'omega speedmaster', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
    ] }));
    const report = await runHarness(FIXT, goldPath);
    const reportPath = join(dir, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));
    const outPath = join(dir, 'receipt.json');
    execFileSync(process.execPath, [join(SCRIPTS, 'aggregate-receipt.mjs'), reportPath,
      '--artifact-sha', identity.content_manifest_sha256, '--out', outPath]);
    const receipt = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(receipt.source.built_artifact_sha256, identity.content_manifest_sha256,
      'the receipt carries the content-manifest identity, byte-identical');
    // And a NON-manifest value (the old tar-hash ambiguity, or garbage) refuses:
    assert.throws(() => execFileSync(process.execPath, [join(SCRIPTS, 'aggregate-receipt.mjs'), reportPath,
      '--artifact-sha', 'not-a-sha', '--out', join(dir, 'nope.json')]), (e) => e.status === 2);
  } finally { rm(dir, { recursive: true, force: true }); }
});

test('CLI two-arg form works without --subdir (c5 regression, 2026-07-17)', () => {
  const out = execFileSync(process.execPath,
    [join(SCRIPTS, 'artifact-identity.mjs'), REPO, 'HEAD'], { encoding: 'utf8' });
  assert.match(out, /content_manifest_sha256/);
});

// K17: "mode-blind" — a --dir export's output carried
// no field naming which computation path produced it (git object database vs
// filesystem tree) and no record of which directory, unlike git-mode's
// self-describing ref/subdir/tree_oid. A saved JSON blob from one mode couldn't
// be told apart from the other except by which fields happened to be absent.
//
// Re-audited 2026-07-19: the first fix's `dir` field (the canonicalized
// absolute local path) fails CORE's own refusal-scan boundary — a
// machine-local path is not content identity and must never appear in a
// publishable identity block. `mode` alone is now the self-describing field;
// `dir` must be ABSENT and the reproduce command must stay location-neutral.
test('K17: git-mode identity self-describes its mode', { skip: !HEAD }, () => {
  const out = artifactIdentity(REPO, HEAD, 'plugins/core');
  assert.equal(out.mode, 'git');
  assert.equal(out.ref, HEAD);
});

test('K17: directory-mode identity self-describes its mode without leaking the local path', { skip: !HEAD }, async () => {
  const { mkdtempSync: mktmp, mkdirSync, rmSync: rm } = await import('node:fs');
  const dir = mktmp(join(tmpdir(), 'ai-k17-'));
  const treeDir = join(dir, 'tree');
  mkdirSync(treeDir, { recursive: true });
  try {
    // Windows-latest tar parses ANY argument shaped like `C:...` as SSH-style
    // remote-host syntax (the exact bug metrics-package.mjs's zipStaging()
    // already fixed once) -- this applies to -C, not just -f. Mirror the
    // file's own pre-existing working test (line ~51): cwd into `dir` and
    // pass relative names ('e.tar', 'tree') to every tar argument, never an
    // absolute Windows path. -c core.autocrlf=false pins byte-preservation on
    // an autocrlf-configured Windows runner, same reason as the sibling test.
    execFileSync('git', ['-C', REPO, '-c', 'core.autocrlf=false', 'archive', '-o', join(dir, 'e.tar'), `${HEAD}:plugins/core`]);
    execFileSync('tar', ['-x', '-f', 'e.tar', '-C', 'tree'], { cwd: dir });
    const out = directoryIdentity(treeDir);
    assert.equal(out.mode, 'directory');
    assert.ok(!('dir' in out), 'the local absolute directory path must NOT appear in the identity block (K17 re-audit, refusal-scan boundary)');
    assert.match(out.content_manifest_sha256, /^[0-9a-f]{64}$/);
    assert.equal(out.reproduce.content_manifest, 'node artifact-identity.mjs --dir <dir>',
      'the reproduce command must stay location-neutral, never the real interpolated path');
    // The two modes must never be shape-ambiguous: a consumer reading `mode`
    // alone must be able to tell which computation path produced this blob.
    const gitOut = artifactIdentity(REPO, HEAD, 'plugins/core');
    assert.notEqual(out.mode, gitOut.mode);
  } finally { rm(dir, { recursive: true, force: true }); }
});

test('K17: CLI --dir output prints the mode, never the local path', { skip: !HEAD }, async () => {
  const { mkdtempSync: mktmp, mkdirSync, rmSync: rm } = await import('node:fs');
  const dir = mktmp(join(tmpdir(), 'ai-k17-cli-'));
  const treeDir = join(dir, 'tree');
  mkdirSync(treeDir, { recursive: true });
  try {
    execFileSync('git', ['-C', REPO, '-c', 'core.autocrlf=false', 'archive', '-o', join(dir, 'e.tar'), `${HEAD}:plugins/core`]);
    execFileSync('tar', ['-x', '-f', 'e.tar', '-C', 'tree'], { cwd: dir });
    const out = execFileSync(process.execPath, [join(SCRIPTS, 'artifact-identity.mjs'), '--dir', treeDir], { encoding: 'utf8' });
    assert.match(out, /^mode directory$/m, 'the human-readable --dir output must name its own mode');
    assert.ok(!out.includes(treeDir), 'the human-readable --dir output must not leak the local absolute path');
    const json = execFileSync(process.execPath, [join(SCRIPTS, 'artifact-identity.mjs'), '--dir', treeDir, '--json'], { encoding: 'utf8' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.mode, 'directory');
    assert.ok(!('dir' in parsed), 'the JSON --dir output must not carry a dir field with the local path');
  } finally { rm(dir, { recursive: true, force: true }); }
});
