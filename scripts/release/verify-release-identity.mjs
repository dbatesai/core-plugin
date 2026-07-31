/**
 * verify-release-identity.mjs — does the embedded source_sha still name the
 * source it claims?
 *
 * Both harness manifests carry `source_sha`: the commit a release packages,
 * stamped by the version bump as the bump commit's own parent. That stamp is
 * only true at one point in history, so two questions need separate answers:
 *
 *   --source     Is the committed stamp correct for this ref? At the release
 *                commit the stamp must equal that commit's parent. It stays
 *                fresh for as long as the packaged tree is byte-identical to
 *                that commit's — a merge that carries the release onto another
 *                branch changes no shipped bytes and is still the same release.
 *                Once the packaged tree moves, the stamp names a source the
 *                package no longer matches: a distinct state, reported with its
 *                own exit code so a release gate can refuse it while ordinary
 *                development ignores it.
 *
 *   --installed  Does an installed plugin cache carry the identity of the
 *                candidate it is supposed to be? Compares source_sha, version,
 *                and build against explicit expectations, or against a source
 *                repo's committed manifests.
 *
 * Exit codes:
 *   0 — identity holds
 *   1 — mismatch
 *   2 — indeterminate (manifest or history unreadable); never treated as a pass
 *   3 — source mode only: stamp correct for the release, stale for this ref
 *
 * Dependency-free; `git` is used through execFileSync for source mode only.
 *
 * CLI:
 *   node verify-release-identity.mjs --source <repo-root> [--ref <ref>]
 *   node verify-release-identity.mjs --installed <plugin-root> --expect-sha <sha>
 *        [--expect-version <v>] [--expect-build <b>]
 *   node verify-release-identity.mjs --installed <plugin-root> --source <repo-root>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCliEntry } from '../../plugins/core/skills/core/scripts/cli-entry.mjs';

const PACKAGED_SUBDIR = 'plugins/core';
const CLAUDE_REL = `${PACKAGED_SUBDIR}/.claude-plugin/plugin.json`;
const CODEX_REL = `${PACKAGED_SUBDIR}/.codex-plugin/plugin.json`;

const OK = 0;
const MISMATCH = 1;
const INDETERMINATE = 2;
const STALE = 3;

function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Committed file content at a ref, or null when the path does not exist there. */
function showAt(repo, ref, relPath) {
  try { return git(repo, ['show', `${ref}:${relPath}`]); } catch { return null; }
}

function parseManifest(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * True when two SHAs name the same commit. A short SHA of at least 7 hex
 * characters is accepted as a prefix of the full one, matching how release
 * candidates are quoted by hand.
 */
function shaMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 7 && /^[0-9a-f]+$/.test(short) && long.startsWith(short);
}

/**
 * The commit that introduced the version currently at `ref`, plus that commit's
 * first parent — the commit a correctly stamped release packages.
 */
function releasePoint(repo, ref) {
  let commits;
  try {
    commits = git(repo, ['log', '--format=%H', ref, '--', CLAUDE_REL]).split('\n').filter(Boolean);
  } catch {
    return null;
  }
  const versionAt = (commit) => {
    const manifest = parseManifest(showAt(repo, commit, CLAUDE_REL) ?? '');
    return manifest ? manifest.version : null;
  };
  for (const commit of commits) {
    let parents;
    try { parents = git(repo, ['rev-list', '--parents', '-n', '1', commit]).split(/\s+/).slice(1); } catch { return null; }
    const parent = parents[0] ?? null;
    if (versionAt(commit) !== (parent ? versionAt(parent) : null)) {
      return { release: commit, parent };
    }
  }
  return null;
}

function verifySource(repo, ref, log) {
  const claudeText = showAt(repo, ref, CLAUDE_REL);
  const codexText = showAt(repo, ref, CODEX_REL);
  const claude = parseManifest(claudeText ?? '');
  const codex = parseManifest(codexText ?? '');
  if (!claude) { log(`indeterminate: no readable ${CLAUDE_REL} at ${ref}`); return INDETERMINATE; }
  if (!codex) { log(`indeterminate: no readable ${CODEX_REL} at ${ref}`); return INDETERMINATE; }

  if (!claude.source_sha) { log(`mismatch: ${CLAUDE_REL} carries no source_sha`); return MISMATCH; }
  if (claude.source_sha !== codex.source_sha) {
    log(`mismatch: claude manifest stamps source_sha ${claude.source_sha}, codex manifest stamps ${codex.source_sha}`);
    return MISMATCH;
  }
  if (claude.version !== codex.version) {
    log(`mismatch: claude manifest reports version ${claude.version}, codex manifest reports ${codex.version}`);
    return MISMATCH;
  }

  const point = releasePoint(repo, ref);
  if (!point || !point.parent) {
    log(`indeterminate: cannot locate the commit that introduced version ${claude.version} and its parent`);
    return INDETERMINATE;
  }
  if (!shaMatches(claude.source_sha, point.parent)) {
    log(`mismatch: source_sha ${claude.source_sha} is not the release commit's parent ${point.parent}`);
    log(`  release commit ${point.release} introduced version ${claude.version}`);
    return MISMATCH;
  }

  // Freshness is a property of the shipped bytes, not of commit distance: the
  // stamp still describes the package for as long as the packaged subtree is
  // the one the release commit produced.
  const packagedTree = (commit) => {
    try { return git(repo, ['rev-parse', `${commit}:${PACKAGED_SUBDIR}`]); } catch { return null; }
  };
  const atRef = packagedTree(ref);
  const atRelease = packagedTree(point.release);
  if (!atRef || !atRelease) {
    log(`indeterminate: cannot read the ${PACKAGED_SUBDIR} tree at ${ref} or ${point.release}`);
    return INDETERMINATE;
  }
  if (atRef === atRelease) {
    log(`release-fresh ${point.parent} — version ${claude.version} build ${claude.build ?? 'unset'} packages this commit`);
    log(`  packaged tree ${atRef} unchanged since release commit ${point.release}`);
    return OK;
  }

  let ahead = '?';
  try { ahead = git(repo, ['rev-list', '--count', `${point.release}..${ref}`, '--', PACKAGED_SUBDIR]); } catch { /* count stays unknown */ }
  log(`stale: source_sha ${claude.source_sha} names the source of version ${claude.version}, but ${PACKAGED_SUBDIR} has moved ${ahead} commit(s) past release commit ${point.release}`);
  return STALE;
}

/** The directory holding `.claude-plugin/`, given either it or a repo root. */
function installedRoot(root) {
  if (existsSync(join(root, '.claude-plugin', 'plugin.json'))) return root;
  const packaged = join(root, 'plugins', 'core');
  if (existsSync(join(packaged, '.claude-plugin', 'plugin.json'))) return packaged;
  return null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function verifyInstalled(root, expected, log) {
  const base = installedRoot(root);
  if (!base) { log(`indeterminate: no .claude-plugin/plugin.json under ${root}`); return INDETERMINATE; }

  const claude = readJson(join(base, '.claude-plugin', 'plugin.json'));
  if (!claude) { log(`indeterminate: unreadable .claude-plugin/plugin.json under ${base}`); return INDETERMINATE; }
  const codexPath = join(base, '.codex-plugin', 'plugin.json');
  const codex = existsSync(codexPath) ? readJson(codexPath) : null;

  const problems = [];
  if (codex) {
    if (claude.source_sha !== codex.source_sha) {
      problems.push(`codex manifest stamps source_sha ${codex.source_sha}, claude manifest stamps ${claude.source_sha}`);
    }
    if (claude.version !== codex.version) {
      problems.push(`codex manifest reports version ${codex.version}, claude manifest reports ${claude.version}`);
    }
  }
  if (expected.sha && !shaMatches(claude.source_sha, expected.sha)) {
    problems.push(`installed source_sha ${claude.source_sha ?? 'unset'} is not the expected candidate ${expected.sha}`);
  }
  if (expected.version && claude.version !== expected.version) {
    problems.push(`installed version ${claude.version ?? 'unset'} is not the expected version ${expected.version}`);
  }
  if (expected.build && claude.build !== expected.build) {
    problems.push(`installed build ${claude.build ?? 'unset'} is not the expected build ${expected.build}`);
  }

  if (problems.length) {
    for (const p of problems) log(`mismatch: ${p}`);
    return MISMATCH;
  }
  log(`installed identity holds: source_sha ${claude.source_sha} version ${claude.version} build ${claude.build ?? 'unset'}`);
  return OK;
}

/** Expectations taken from a source repo's committed manifests at `ref`. */
function expectationsFromSource(repo, ref, log) {
  const claude = parseManifest(showAt(repo, ref, CLAUDE_REL) ?? '');
  if (!claude) { log(`indeterminate: no readable ${CLAUDE_REL} at ${ref}`); return null; }
  return { sha: claude.source_sha, version: claude.version, build: claude.build };
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const log = (line) => process.stdout.write(`${line}\n`);
  const source = flag(argv, '--source');
  const installed = flag(argv, '--installed');
  const ref = flag(argv, '--ref') ?? 'HEAD';

  if (!source && !installed) {
    process.stderr.write('usage: verify-release-identity.mjs --source <repo-root> [--ref <ref>]\n'
      + '       verify-release-identity.mjs --installed <plugin-root> --expect-sha <sha> [--expect-version <v>] [--expect-build <b>]\n'
      + '       verify-release-identity.mjs --installed <plugin-root> --source <repo-root>\n');
    return INDETERMINATE;
  }

  if (installed) {
    let expected = {
      sha: flag(argv, '--expect-sha'),
      version: flag(argv, '--expect-version'),
      build: flag(argv, '--expect-build'),
    };
    if (source && !expected.sha) {
      const derived = expectationsFromSource(source, ref, log);
      if (!derived) return INDETERMINATE;
      expected = derived;
    }
    if (!expected.sha) { log('indeterminate: no expected candidate given'); return INDETERMINATE; }
    return verifyInstalled(installed, expected, log);
  }

  return verifySource(source, ref, log);
}

if (isCliEntry(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
