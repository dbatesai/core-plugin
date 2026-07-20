#!/usr/bin/env node
// invocation-plugin-overlay.mjs — synthetic-decoy runner primitive, three-arm
// memory-efficacy pilot (Hale's runner amendment 6, 2026-07-20,
// hale--685d9c6-auth-unblock).
//
// plugin-registration.mjs's isolated-HOME approach hit a real, unresolved
// auth blocker (a fresh HOME carries no credentials). Hale verified a
// cleaner unblock that stays on the ALREADY-authenticated host and avoids
// touching credentials entirely: run from a fresh project directory, and
// use an invocation-local `--settings` JSON overlay plus `--plugin-dir` to
// disable every currently-enabled plugin (including stable `core@core`) and
// enable the exact candidate as a session-scoped `core@inline` install.
//
// Verified directly on this machine before writing a line of this module,
// not assumed (zero-cost, read-only, no model invocation):
//
//   claude --settings '{"enabledPlugins":{"core@core":false,"core@inline":true}}' \
//     --plugin-dir <exact candidate plugins/core dir> plugin list --json
//
// returns `core@core` (stable, 3.12.0) with `enabled:false`, and a NEW
// `core@inline` entry (`scope:"session"`, `enabled:true`,
// `installPath:<the exact --plugin-dir path>`) with a note confirming CLI
// flag settings override user settings.json. No cache copy is needed at
// all -- `--plugin-dir` points the harness directly at the candidate's real
// source tree.
//
// Pilot-only tooling. Never ships. Never merges to next/main.

import { spawnSync } from 'node:child_process';

/**
 * fetchPluginInventory — the real, current plugin inventory Claude Code
 * would resolve for an invocation, via the SAME read-only, zero-cost,
 * no-model-invocation command verified above. Never invokes the model.
 *
 * @param {object} [opts]
 * @param {string} [opts.settingsOverlay]  JSON string passed to --settings
 * @param {string} [opts.pluginDir]        path passed to --plugin-dir
 * @param {string} [opts.cwd]              working directory for the spawn
 * @param {number} [opts.timeoutMs]        defaults to 15000
 * @returns {{ok:true, inventory:Array} | {ok:false, reason:<CODE>, ...detail}}
 */
export function fetchPluginInventory({ settingsOverlay, pluginDir, cwd = process.cwd(), timeoutMs = 15000 } = {}) {
  const args = [];
  if (settingsOverlay) args.push('--settings', settingsOverlay);
  if (pluginDir) args.push('--plugin-dir', pluginDir);
  args.push('plugin', 'list', '--json');

  const result = spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) {
    return { ok: false, reason: 'PLUGIN_LIST_SPAWN_FAILED', detail: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'PLUGIN_LIST_NONZERO_EXIT', status: result.status, stderr: String(result.stderr || '').slice(0, 2000) };
  }
  let inventory;
  try { inventory = JSON.parse(result.stdout); } catch {
    return { ok: false, reason: 'PLUGIN_LIST_NOT_JSON', stdout: String(result.stdout || '').slice(0, 2000) };
  }
  if (!Array.isArray(inventory)) {
    return { ok: false, reason: 'PLUGIN_LIST_NOT_ARRAY' };
  }
  return { ok: true, inventory };
}

/**
 * computeDisableAllOverlay — pure function: given a plugin inventory
 * (fetchPluginInventory's shape, or any array of {id, enabled}), returns the
 * `enabledPlugins` overlay object that disables every plugin currently
 * enabled anywhere (any scope) EXCEPT the exact candidate alias, and enables
 * that candidate. Hale's instruction: "generate the overlay from the plugin
 * inventory so every other enabled plugin is false" — never hand-maintained,
 * always derived from the real, current inventory.
 *
 * @param {Array<{id:string, enabled:boolean}>} inventory
 * @param {string} [candidateId]  defaults to 'core@inline'
 * @returns {{enabledPlugins: Record<string, boolean>}}
 */
export function computeDisableAllOverlay(inventory, candidateId = 'core@inline') {
  if (!Array.isArray(inventory)) {
    throw new Error('computeDisableAllOverlay requires an inventory array');
  }
  const enabledPlugins = {};
  for (const p of inventory) {
    if (!p || typeof p.id !== 'string') continue;
    if (p.enabled) enabledPlugins[p.id] = false;
  }
  enabledPlugins[candidateId] = true;
  return { enabledPlugins };
}

/**
 * verifyOverlayApplied — re-fetches the inventory WITH the overlay in
 * effect and confirms it actually did what it claims: the candidate is
 * enabled at the exact expected installPath, and every OTHER plugin that
 * was enabled in the baseline inventory is now disabled. Never trust the
 * overlay's own intent — verify the resolved state.
 *
 * @param {Array<{id, enabled}>} baselineInventory  from fetchPluginInventory
 *   BEFORE the overlay (no --settings/--plugin-dir args)
 * @param {Array<{id, enabled, installPath}>} resolvedInventory  from
 *   fetchPluginInventory WITH the overlay applied
 * @param {string} candidateId
 * @param {string} expectedInstallPath
 */
export function verifyOverlayApplied(baselineInventory, resolvedInventory, candidateId, expectedInstallPath) {
  const resolvedById = new Map(resolvedInventory.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
  const candidate = resolvedById.get(candidateId);
  if (!candidate) {
    return { ok: false, reason: 'CANDIDATE_NOT_IN_RESOLVED_INVENTORY', candidateId };
  }
  if (!candidate.enabled) {
    return { ok: false, reason: 'CANDIDATE_NOT_ENABLED', candidateId };
  }
  if (candidate.installPath !== expectedInstallPath) {
    return { ok: false, reason: 'CANDIDATE_WRONG_INSTALL_PATH', expected: expectedInstallPath, found: candidate.installPath };
  }
  const stillEnabled = [];
  for (const p of baselineInventory) {
    if (!p || typeof p.id !== 'string' || p.id === candidateId) continue;
    if (p.enabled) {
      const resolved = resolvedById.get(p.id);
      if (resolved && resolved.enabled) stillEnabled.push(p.id);
    }
  }
  if (stillEnabled.length > 0) {
    return { ok: false, reason: 'OTHER_PLUGINS_STILL_ENABLED', ids: stillEnabled };
  }
  return { ok: true, candidate, resolvedInventory };
}
