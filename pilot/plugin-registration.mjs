#!/usr/bin/env node
// plugin-registration.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 5, 2026-07-20,
// hale--6246a7a-claude-exposure-pass-vertical-slice-next, step 2: "provision
// /verify one isolated Claude home with the exact frozen candidate
// identity").
//
// isolated-trial-home.mjs already proves filesystem-level isolation and
// content-identity of a copied candidate. It does NOT make Claude Code
// actually RECOGNIZE that copy as an installed, enabled plugin -- its own
// header names this explicitly as the next step, not silently assumed done.
// This is that next step: registering a real, directory-sourced marketplace
// pointing at the candidate's own repo root (which already carries a real
// `.claude-plugin/marketplace.json`, verified present on this worktree) in
// the isolated home's `settings.json`, and enabling the plugin from it --
// the same shape this project's OWN real settings.json already uses for
// its other directory-sourced marketplaces (verified on disk before writing
// this: `extraKnownMarketplaces.<name>.source = {source:'directory',
// path:<repo root>}`, `enabledPlugins["<plugin>@<name>"] = true`).
//
// FEASIBILITY PROBE RESULT (2026-07-20, real bounded spawn, zero API cost):
// a real `claude -p` invocation against a freshly isolated HOME/
// CLAUDE_CONFIG_DIR returns `"result":"Not logged in · Please run /login"`
// with `total_cost_usd:0` -- the interactive session's authentication does
// NOT carry forward into a fresh HOME, and no ANTHROPIC_API_KEY is
// configured as an alternative in this environment. This is a REAL,
// unresolved blocker for any actual model-invoking trial, independent of
// whether this marketplace-registration approach itself is correct -- it is
// a credentials/security decision, not something to route around by copying
// live auth material into a throwaway directory. Named explicitly here so
// the next attempt doesn't have to rediscover it. The registration function
// below is proven at the FILE-CONTENT level only (structural correctness);
// whether Claude Code actually honors a hand-written settings.json this way
// (versus requiring the CLI's own `/plugin install` flow to have run once)
// is still unverified pending an authenticated real spawn.
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * writeMarketplaceRegistration — merges a directory-sourced marketplace
 * registration + plugin enablement into an isolated home's settings.json,
 * preserving any other keys already present (never clobbers unrelated
 * settings).
 *
 * @param {string} homeDir            the isolated home (createIsolatedHome's homeDir)
 * @param {object} opts
 * @param {string} opts.marketplaceName   a unique name for this registration
 * @param {string} opts.candidateRepoRoot the candidate's REPO ROOT (containing
 *   `.claude-plugin/marketplace.json`) -- NOT the `plugins/core` subdirectory
 *   createIsolatedHome's `candidatePluginDir` points at. Required to exist
 *   and actually contain that file; fails loud otherwise, never registers a
 *   marketplace pointing at nothing.
 * @param {string} [opts.pluginName]       defaults to 'core'
 * @returns {{settingsPath: string, key: string}} key is the exact
 *   `enabledPlugins` key written (`"<pluginName>@<marketplaceName>"`)
 */
export function writeMarketplaceRegistration(homeDir, { marketplaceName, candidateRepoRoot, pluginName = 'core' } = {}) {
  if (!homeDir || !existsSync(homeDir)) {
    throw Object.assign(new Error(`homeDir does not exist: ${homeDir}`), { code: 'HOME_DIR_MISSING' });
  }
  if (typeof marketplaceName !== 'string' || !marketplaceName.trim()) {
    throw Object.assign(new Error('marketplaceName is required'), { code: 'MARKETPLACE_NAME_REQUIRED' });
  }
  if (typeof candidateRepoRoot !== 'string' || !candidateRepoRoot.trim()) {
    throw Object.assign(new Error('candidateRepoRoot is required'), { code: 'CANDIDATE_REPO_ROOT_REQUIRED' });
  }
  const marketplaceJsonPath = join(candidateRepoRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(marketplaceJsonPath)) {
    throw Object.assign(
      new Error(`candidateRepoRoot has no .claude-plugin/marketplace.json: ${candidateRepoRoot} -- refusing to register a marketplace pointing at nothing`),
      { code: 'REPO_MARKETPLACE_JSON_MISSING', marketplaceJsonPath },
    );
  }

  const claudeDir = join(homeDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch {
      throw Object.assign(new Error(`existing settings.json at ${settingsPath} is not valid JSON -- refusing to silently overwrite it`), { code: 'SETTINGS_JSON_MALFORMED' });
    }
  }

  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[marketplaceName] = { source: { source: 'directory', path: candidateRepoRoot } };

  settings.enabledPlugins = settings.enabledPlugins || {};
  const key = `${pluginName}@${marketplaceName}`;
  settings.enabledPlugins[key] = true;

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { settingsPath, key };
}
