/**
 * artifact-identity.mjs — deterministic release-artifact identity.
 *
 * Why not hash an archive: with
 * `git archive <sha>:plugins/core | shasum`, tar embeds invocation-time
 * metadata — same content, different bytes every run. An identity nobody can
 * reproduce is not an identity.
 *
 * Two identities, both content-only, both reproducible from a clean clone:
 *
 *   1. tree_oid — the Git tree object id of the subtree at the commit
 *      (`git rev-parse <ref>:<subdir>`). Commit-anchored, byte-exact, and
 *      verifiable by anyone with the repository in one command.
 *   2. content_manifest_sha256 — sha256 over the sorted manifest
 *      `<relpath>:<sha256(file bytes)>` of every file in the subtree. Computable
 *      WITHOUT git from any export of the tree (an extracted archive, a
 *      packaged install), so the identity survives across export mechanisms —
 *      the bar: two clean INDEPENDENT exports must agree.
 *
 * The freeze step publishes both plus the exact reproduction commands; the
 * packet's `built_artifact_sha256` slot carries the content manifest hash.
 *
 * Ships with the plugin by design; .mjs only. Uses `git` via
 * execFileSync for the repo-side computation only; the directory-side
 * computation (`fromDirectory`) is pure filesystem.
 *
 * CLI:
 *   node artifact-identity.mjs <repo> <ref> [--subdir plugins/core] [--json]
 *   node artifact-identity.mjs --dir <extracted-tree> [--json]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The Git tree object id of <ref>:<subdir> — one-command verification for anyone with the repo. */
export function treeOid(repo, ref, subdir) {
  return git(repo, ['rev-parse', `${ref}:${subdir}`]).trim();
}

function manifestHash(entries) {
  // entries: [{relpath (forward slashes), hash}] — sorted by relpath, joined LF.
  const sorted = entries.sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
  const manifest = sorted.map(e => `${e.relpath}:${e.hash}`).join('\n');
  // entries ship in the result so a divergence between two exports can name the
  // first differing file instead of just two unequal hashes.
  return { content_manifest_sha256: sha256(manifest), file_count: sorted.length, entries: sorted };
}

/**
 * diffManifests — first divergence between two manifest results, for diagnostics:
 * files present in one but not the other, or the first relpath whose hash differs.
 * Returns null when identical.
 */
export function diffManifests(a, b) {
  const byPath = new Map(a.entries.map(e => [e.relpath, e.hash]));
  for (const e of b.entries) {
    if (!byPath.has(e.relpath)) return { relpath: e.relpath, in: 'b-only' };
    if (byPath.get(e.relpath) !== e.hash) return { relpath: e.relpath, hashA: byPath.get(e.relpath), hashB: e.hash };
    byPath.delete(e.relpath);
  }
  const leftover = byPath.keys().next();
  if (!leftover.done) return { relpath: leftover.value, in: 'a-only' };
  return null;
}

/** Content manifest computed FROM THE GIT OBJECT DATABASE (no working tree, no tar). */
export function manifestFromGit(repo, ref, subdir) {
  const listing = git(repo, ['ls-tree', '-r', '-z', `${ref}:${subdir}`]);
  const entries = [];
  for (const rec of listing.split('\0')) {
    if (!rec) continue;
    // "<mode> <type> <oid>\t<path>"
    const tab = rec.indexOf('\t');
    const [, type, oid] = rec.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue;
    const relpath = rec.slice(tab + 1);
    const content = execFileSync('git', ['-C', repo, 'cat-file', 'blob', oid], { maxBuffer: 64 * 1024 * 1024 });
    entries.push({ relpath, hash: sha256(content) });
  }
  return manifestHash(entries);
}

/** Content manifest computed FROM A FILESYSTEM TREE (an extracted archive, a packaged install). */
export function manifestFromDirectory(dir) {
  const root = realpathSync(dir);
  const entries = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) entries.push({ relpath: relative(root, p).split(sep).join('/'), hash: sha256(readFileSync(p)) });
    }
  };
  walk(root);
  return manifestHash(entries);
}

/** Full identity block for a frozen candidate — what the packet publishes. */
export function artifactIdentity(repo, ref, subdir = 'plugins/core') {
  const oid = treeOid(repo, ref, subdir);
  const { content_manifest_sha256, file_count } = manifestFromGit(repo, ref, subdir);
  return {
    mode: 'git', // K17: mode-blind — see directoryIdentity below
    ref,
    subdir,
    tree_oid: oid,
    content_manifest_sha256,
    file_count,
    reproduce: {
      tree_oid: `git rev-parse ${ref}:${subdir}`,
      content_manifest: `node artifact-identity.mjs <repo> ${ref} --subdir ${subdir}`,
      // The export MUST be byte-preserving: on an autocrlf-configured machine
      // (Windows default) a bare `git archive` converts text files to CRLF and
      // the manifest genuinely differs from the committed blobs.
      from_any_export: `git -c core.autocrlf=false archive -o export.tar ${ref}:${subdir} && tar -x -f export.tar -C <dir> && node artifact-identity.mjs --dir <dir>`,
    },
  };
}

/**
 * K17: "mode-blind" — the
 * CLI's --dir output was a bare manifestHash() result with no field naming
 * which computation path produced it. The first fix added a `mode` field but
 * also embedded the canonical absolute local directory in `dir` and in
 * `reproduce.content_manifest` — a review re-audit demonstrated this fails
 * CORE's OWN refusal-scan boundary (aggregate-receipt.mjs's isPathShaped):
 * a machine-local path is not part of the content identity, varies by
 * machine, and is exactly the kind of non-reconstructive-evidence violation
 * that boundary exists to catch. Fixed: `mode` alone makes the output
 * self-describing without publishing the local filesystem layout; the
 * reproduce command uses a location-neutral `<dir>` placeholder.
 */
export function directoryIdentity(dir) {
  const { content_manifest_sha256, file_count } = manifestFromDirectory(dir);
  return {
    mode: 'directory',
    content_manifest_sha256,
    file_count,
    reproduce: {
      content_manifest: 'node artifact-identity.mjs --dir <dir>',
    },
  };
}

function main(argv) {
  const dirIdx = argv.indexOf('--dir');
  const json = argv.includes('--json');
  if (dirIdx >= 0) {
    const out = directoryIdentity(argv[dirIdx + 1]);
    process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n'
      : `mode ${out.mode}\ncontent_manifest_sha256 ${out.content_manifest_sha256} (${out.file_count} files)\n`);
    return 0;
  }
  const subIdx = argv.indexOf('--subdir');
  // Positionals = non-flag args that are not --subdir's value. The `subIdx >= 0`
  // guard matters: without it, with NO --subdir the filter would compare
  // against argv[0] — silently dropping the repo argument, so the documented
  // two-arg form would always print usage.
  const [repo, ref] = argv.filter((a, i) => !a.startsWith('--') && !(subIdx >= 0 && i === subIdx + 1));
  if (!repo || !ref) {
    process.stderr.write('usage: artifact-identity.mjs <repo> <ref> [--subdir plugins/core] [--json] | --dir <tree>\n');
    return 2;
  }
  const subdir = subIdx >= 0 ? argv[subIdx + 1] : 'plugins/core';
  let out;
  try { out = artifactIdentity(repo, ref, subdir); }
  catch (e) { process.stderr.write(`artifact-identity: ${e.message}\n`); return 1; }
  process.stdout.write(json ? JSON.stringify(out, null, 2) + '\n'
    : `mode ${out.mode}\ntree_oid ${out.tree_oid}\ncontent_manifest_sha256 ${out.content_manifest_sha256} (${out.file_count} files)\nreproduce: ${out.reproduce.tree_oid}\n`);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
