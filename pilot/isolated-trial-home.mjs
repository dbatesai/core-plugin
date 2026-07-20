#!/usr/bin/env node
// isolated-trial-home.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 2, 2026-07-20).
//
// Hale's own installed proof against candidate 6dc12a3 demonstrated a global
// CLI plugin-enable override is NOT sufficient isolation: a persistent
// stable-install hook still fired during the Codex trial and produced a
// second, un-joined retrieval row alongside the candidate's row -- spoiling
// the trial. Each trial needs its own filesystem-isolated home so no other
// installed plugin version (stable or a different candidate) can fire.
//
// Second re-audit (hale--cb2-filesystem-isolation-narrow-hold): the first
// verifyIsolation() only checked that a directory NAMED like the version
// existed somewhere under the cache root -- it never confirmed the content
// there was actually the candidate. Two demonstrated false passes: (1)
// copying the real candidate under a WRONG caller-supplied version number
// still reported isolated:true; (2) renaming the required .../core/<version>
// path segment to .../not-core/<version> still reported isolated:true.
// Fixed below: the exact expected path is checked directly (not searched
// for), its copied manifest must name === 'core' and the requested version,
// and its content is hashed against the source candidate via the project's
// own artifact-identity.mjs directory-mode manifest -- byte-identical or it
// fails, not name-matched.
//
// Scope, stated honestly: this proves isolation and content correctness at
// the filesystem level (tested below). It does NOT yet prove a real spawned
// `claude`/`codex` CLI process actually discovers and fires this install --
// that requires wiring the harness's own plugin-registration metadata
// (settings.json / marketplace registration), which needs verification
// against a real host before this primitive can replace Hale's manual
// installed-proof technique. Named explicitly as the next step, not
// silently assumed done.

import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep, isAbsolute } from 'node:path';
import { directoryIdentity } from '../plugins/core/skills/core/scripts/artifact-identity.mjs';

/**
 * A caller-supplied path COMPONENT (never a full path) must not be able to
 * traverse directories or escape the intended cache root. Rejects anything
 * containing a path separator, a leading dot-dot, or a null byte.
 */
function sanitizePathComponent(value, label) {
  if (typeof value !== 'string' || !value || /[/\\]/.test(value) || value === '.' || value === '..' || value.includes('\0')) {
    throw Object.assign(new Error(`${label} must be a single safe path component, got ${JSON.stringify(value)}`), { code: 'UNSAFE_PATH_COMPONENT' });
  }
  return value;
}

/**
 * createIsolatedHome — build a fresh, single-purpose HOME directory
 * containing exactly one plugin install (the given candidate), at the
 * marketplace-cache path shape real installs use.
 *
 * @param {object} opts
 * @param {string} opts.harness       'claude' | 'codex'
 * @param {string} opts.candidatePluginDir  path to the candidate's
 *   `plugins/core` directory (the packaged content to install)
 * @param {string} opts.version       the candidate's stamped version
 *   (e.g. "3.12.1-pilot.1") -- used for the cache path, matching the
 *   real installed layout so nothing about the trial's plumbing differs
 *   from what a real user's install would look like.
 * @param {string} [opts.marketplaceName]  defaults to a unique per-call
 *   name so concurrent trials (even for the same candidate) never share
 *   a cache path and never collide.
 * @returns {{homeDir: string, cacheDir: string, marketplaceName: string,
 *   sourceContentHash: string, env: object, cleanup: function}}
 *   sourceContentHash is captured from candidatePluginDir BEFORE the copy
 *   happens (Hale re-audit, hale--1346f5e-partial-pass-two-fail-open-edges,
 *   false pass 2: passing `sourceCandidateDir: cacheDir` to verifyIsolation
 *   made it compare the installed directory to itself and trivially pass --
 *   "requiring the argument did not make it an independent source of
 *   truth." Capturing the hash here, before cpSync ever runs, means there
 *   is no live directory reference for a caller to alias back to the
 *   installed copy -- the oracle is fixed at copy time, not re-derivable
 *   from anything verifyIsolation is given afterward.
 */
export function createIsolatedHome({ harness, candidatePluginDir, version, marketplaceName } = {}) {
  if (harness !== 'claude' && harness !== 'codex') {
    throw Object.assign(new Error(`harness must be 'claude' or 'codex', got ${JSON.stringify(harness)}`), { code: 'INVALID_HARNESS' });
  }
  if (!candidatePluginDir || !existsSync(candidatePluginDir)) {
    throw Object.assign(new Error(`candidatePluginDir does not exist: ${candidatePluginDir}`), { code: 'CANDIDATE_DIR_MISSING' });
  }
  if (!version) {
    throw Object.assign(new Error('version is required (the candidate manifest version, used in the cache path)'), { code: 'VERSION_REQUIRED' });
  }
  sanitizePathComponent(version, 'version');
  const mp = marketplaceName
    ? sanitizePathComponent(marketplaceName, 'marketplaceName')
    : `core-pilot-${process.pid}-${Date.now() % 100000}`;

  // Captured BEFORE cpSync -- this is the independent oracle, not a
  // pointer verifyIsolation could be tricked into re-deriving from the
  // installed copy itself.
  const sourceContentHash = directoryIdentity(candidatePluginDir).content_manifest_sha256;

  const homeDir = mkdtempSync(join(tmpdir(), `pilot-home-${harness}-`));
  const cacheDir = harness === 'claude'
    ? join(homeDir, '.claude', 'plugins', 'cache', mp, 'core', version)
    : join(homeDir, '.codex', 'plugins', 'cache', mp, 'core', version);

  mkdirSync(cacheDir, { recursive: true });
  cpSync(candidatePluginDir, cacheDir, { recursive: true });

  const env = harness === 'claude'
    ? { HOME: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude') }
    : { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') };

  const cleanup = () => rmSync(homeDir, { recursive: true, force: true });

  return { homeDir, cacheDir, marketplaceName: mp, sourceContentHash, env, cleanup };
}

/**
 * verifyIsolation — proves BOTH that the exact expected candidate is
 * installed AND that nothing else could possibly fire.
 *
 * @param {object} opts
 * @param {string} opts.homeDir              the isolated home to inspect
 * @param {string} opts.harness              'claude' | 'codex'
 * @param {string} opts.version              the requested version
 * @param {string} opts.cacheDir             the exact expected install path
 *   (createIsolatedHome's own return value -- never re-derived by search)
 * @param {string} opts.expectedSourceHash   REQUIRED: the source candidate's
 *   content_manifest_sha256, captured by createIsolatedHome BEFORE the
 *   copy happened. Hale re-audit (hale--1346f5e-partial-pass-two-fail-
 *   open-edges, false pass 2): an earlier version took a live
 *   `sourceCandidateDir` path and re-hashed it at verify time -- passing
 *   `sourceCandidateDir: cacheDir` made the check compare the installed
 *   directory to itself and trivially pass. "Requiring the argument did
 *   not make it an independent source of truth." A pre-captured hash
 *   string has no live directory for a caller to alias back to the
 *   installed copy; the oracle is fixed before verifyIsolation ever runs.
 *   Also required (unchanged from the prior re-audit): omitting it must
 *   fail closed, never silently report isolated:true.
 */
export function verifyIsolation({ homeDir, harness, version, cacheDir, expectedSourceHash }) {
  if (!expectedSourceHash) {
    throw Object.assign(new Error('expectedSourceHash is required -- verifyIsolation cannot prove content identity without it, and a missing proof must never silently report isolated:true'), { code: 'SOURCE_HASH_REQUIRED' });
  }

  // 0. cacheDir must actually SIT UNDER homeDir at the expected relative
  //    shape (.claude|.codex/plugins/cache/<mp>/core/<version>) -- Hale
  //    re-audit: passing the real source directory itself as cacheDir
  //    (with an unrelated, empty homeDir) made every later check pass
  //    trivially (manifest/hash match themselves; the empty home scan
  //    found no competitors) without cacheDir ever having been INSTALLED
  //    anywhere. The relative shape can't be satisfied by an arbitrary
  //    absolute path elsewhere on disk, only by a real install under this
  //    specific isolated home.
  const cachePrefix = harness === 'claude'
    ? ['.claude', 'plugins', 'cache'] : ['.codex', 'plugins', 'cache'];
  const rel = relative(homeDir, cacheDir);
  const relParts = rel.split(sep);
  const shapeOk = !rel.startsWith('..') && !isAbsolute(rel)
    && relParts.length === cachePrefix.length + 3
    && cachePrefix.every((seg, i) => relParts[i] === seg)
    && relParts[cachePrefix.length + 1] === 'core'
    && relParts[cachePrefix.length + 2] === version;
  if (!shapeOk) {
    return { isolated: false, reason: 'CACHE_PATH_NOT_UNDER_HOME', homeDir, cacheDir, expectedRelativeShape: `${cachePrefix.join('/')}/<marketplace>/core/${version}` };
  }

  const manifestPath = harness === 'claude'
    ? join(cacheDir, '.claude-plugin', 'plugin.json')
    : join(cacheDir, '.codex-plugin', 'plugin.json');

  // 1. The EXACT expected path must exist -- never searched for by name.
  if (!existsSync(cacheDir) || !existsSync(manifestPath)) {
    return { isolated: false, reason: 'EXPECTED_PATH_MISSING', expectedPath: cacheDir };
  }

  // 2. The manifest actually installed there must claim to BE this plugin
  //    at this version -- not just live at a correctly-named directory.
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) {
    return { isolated: false, reason: 'MANIFEST_UNREADABLE', error: e.message };
  }
  if (manifest.name !== 'core' || manifest.version !== version) {
    return { isolated: false, reason: 'MANIFEST_IDENTITY_MISMATCH', found: { name: manifest.name, version: manifest.version }, expectedVersion: version };
  }

  // 3. Content must be byte-identical to the real source candidate -- the
  //    false pass Hale demonstrated (real content copied under a WRONG
  //    version number) is caught here even though checks 1-2 would pass a
  //    version that happens to match a mislabeled copy of something else.
  const installed = directoryIdentity(cacheDir);
  if (installed.content_manifest_sha256 !== expectedSourceHash) {
    return {
      isolated: false, reason: 'CONTENT_MISMATCH',
      installedHash: installed.content_manifest_sha256, sourceHash: expectedSourceHash,
    };
  }

  // 4. Nothing ELSE under the cache root may be present -- any other
  //    version-shaped directory anywhere is a leftover install that could
  //    fire (Hale's original installed-proof failure: a persistent stable
  //    hook alongside the candidate).
  const cacheRoot = harness === 'claude'
    ? join(homeDir, '.claude', 'plugins', 'cache')
    : join(homeDir, '.codex', 'plugins', 'cache');
  const otherVersions = [];
  const findAllVersionDirs = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (/^\d+\.\d+\.\d+/.test(e.name)) {
        if (e.name !== version || full !== cacheDir) otherVersions.push(full);
      } else {
        findAllVersionDirs(full, depth + 1);
      }
    }
  };
  findAllVersionDirs(cacheRoot, 0);
  if (otherVersions.length > 0) {
    return { isolated: false, reason: 'OTHER_VERSIONS_PRESENT', otherVersionsPresent: otherVersions };
  }

  return { isolated: true };
}
