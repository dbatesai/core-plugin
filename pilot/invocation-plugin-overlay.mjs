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
 * effect and confirms the REAL invariant holds over the resolved inventory
 * as a whole: exactly one plugin is enabled, period, and it is the
 * candidate, at the exact expected installPath. Never trust the overlay's
 * own intent — verify the resolved state.
 *
 * Hale re-audit (hale--29aa260-overlay-false-pass): an earlier version only
 * rechecked plugins that were enabled in a BASELINE snapshot -- a plugin
 * newly enabled by something other than this overlay was invisible to that
 * check and passed silently. There is no baseline parameter anymore; the
 * only thing that proves isolation is "is the resolved inventory's enabled
 * set exactly {candidate}," independent of what came before.
 *
 * @param {Array<{id, enabled, installPath}>} resolvedInventory  from
 *   fetchPluginInventory WITH the overlay applied
 * @param {string} candidateId
 * @param {string} expectedInstallPath
 */
export function verifyOverlayApplied(resolvedInventory, candidateId, expectedInstallPath) {
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
  // Hale re-audit (hale--29aa260-overlay-false-pass): the old check only
  // re-verified plugins that were enabled in the BASELINE -- a plugin that
  // was OFF in baseline but got newly, unexpectedly enabled in the resolved
  // inventory (his exact demonstrated counterexample: `surprise@auto`) was
  // never looked at, so it silently passed. The real invariant is over the
  // RESOLVED inventory as a whole: exactly one enabled plugin, period, and
  // it must be the candidate -- not "every previously-enabled plugin is
  // still enabled or not," which says nothing about NEW ones.
  const resolvedEnabled = resolvedInventory.filter((p) => p && typeof p.id === 'string' && p.enabled);
  if (resolvedEnabled.length !== 1 || resolvedEnabled[0].id !== candidateId) {
    return {
      ok: false, reason: 'MORE_THAN_CANDIDATE_ENABLED',
      enabledIds: resolvedEnabled.map((p) => p.id),
    };
  }
  return { ok: true, candidate, resolvedInventory };
}
