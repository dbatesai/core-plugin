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
// This module builds the isolated home's FILESYSTEM SCAFFOLDING: a fresh
// temp HOME containing only the one candidate's packaged plugin content,
// laid out at the same cache path shape Hale's own successful installed
// proof used (`~/.claude/plugins/cache/<marketplace>/core/<version>/`).
//
// Scope, stated honestly: this proves isolation and correct content at the
// filesystem level (tested below). It does NOT yet prove a real spawned
// `claude`/`codex` CLI process actually discovers and fires this install --
// that requires wiring the harness's own plugin-registration metadata
// (settings.json / marketplace registration), which needs verification
// against a real host before this primitive can replace Hale's manual
// installed-proof technique. Named explicitly as the next step, not
// silently assumed done.

import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * @returns {{homeDir: string, cacheDir: string, env: object, cleanup: function}}
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

  const homeDir = mkdtempSync(join(tmpdir(), `pilot-home-${harness}-`));
  const mp = marketplaceName || `core-pilot-${process.pid}-${Date.now() % 100000}`;

  const cacheDir = harness === 'claude'
    ? join(homeDir, '.claude', 'plugins', 'cache', mp, 'core', version)
    : join(homeDir, '.codex', 'plugins', 'cache', mp, 'core', version);

  mkdirSync(cacheDir, { recursive: true });
  cpSync(candidatePluginDir, cacheDir, { recursive: true });

  const env = harness === 'claude'
    ? { HOME: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude') }
    : { HOME: homeDir, CODEX_HOME: join(homeDir, '.codex') };

  const cleanup = () => rmSync(homeDir, { recursive: true, force: true });

  return { homeDir, cacheDir, env, cleanup };
}

/**
 * verifyIsolation — a fresh isolated home must contain exactly one
 * candidate's content and nothing from any other install (no other
 * marketplace/version directory anywhere under its plugin cache root).
 * This is the mechanical proof for "no persistent stable hook can fire" --
 * if the isolated home's cache root has only the one expected version
 * directory, there is nothing else present that could fire.
 */
export function verifyIsolation({ homeDir, harness, version }) {
  const cacheRoot = harness === 'claude'
    ? join(homeDir, '.claude', 'plugins', 'cache')
    : join(homeDir, '.codex', 'plugins', 'cache');
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return; // marketplace/core/<version> is 3 levels deep
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name === version) found.push(join(dir, e.name));
        else walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(cacheRoot, 0);
  const otherVersions = [];
  const findAllVersionDirs = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = join(dir, e.name);
      if (/^\d+\.\d+\.\d+/.test(e.name)) {
        if (e.name !== version) otherVersions.push(full);
      } else {
        findAllVersionDirs(full, depth + 1);
      }
    }
  };
  findAllVersionDirs(cacheRoot, 0);
  return { isolated: found.length === 1 && otherVersions.length === 0, expectedFound: found, otherVersionsPresent: otherVersions };
}
