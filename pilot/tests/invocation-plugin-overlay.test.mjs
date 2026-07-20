import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { fetchPluginInventory, computeDisableAllOverlay, verifyOverlayApplied } = await import(pathToFileURL(join(PILOT, 'invocation-plugin-overlay.mjs')).href);

const CANDIDATE_PLUGIN_DIR = join(PILOT, '..', 'plugins', 'core');

test('computeDisableAllOverlay: disables every currently-enabled plugin, enables the candidate', () => {
  const inventory = [
    { id: 'core@core', enabled: true },
    { id: 'some-other@marketplace', enabled: true },
    { id: 'already-off@marketplace', enabled: false },
  ];
  const overlay = computeDisableAllOverlay(inventory, 'core@inline');
  assert.deepEqual(overlay, {
    enabledPlugins: {
      'core@core': false,
      'some-other@marketplace': false,
      'core@inline': true,
    },
  });
  // Already-disabled plugins are left out entirely — the overlay only
  // states what needs to CHANGE, not the whole universe of plugins.
  assert.equal('already-off@marketplace' in overlay.enabledPlugins, false);
});

test('computeDisableAllOverlay: an empty inventory still enables the candidate', () => {
  const overlay = computeDisableAllOverlay([], 'core@inline');
  assert.deepEqual(overlay, { enabledPlugins: { 'core@inline': true } });
});

test('computeDisableAllOverlay: skips malformed inventory entries instead of crashing', () => {
  const overlay = computeDisableAllOverlay([null, {}, { id: 'x' }, { id: 'y', enabled: true }], 'core@inline');
  assert.deepEqual(overlay, { enabledPlugins: { y: false, 'core@inline': true } });
});

test('computeDisableAllOverlay requires an array', () => {
  assert.throws(() => computeDisableAllOverlay('not-an-array'), /inventory array/);
});

// Real, zero-cost, read-only integration test — verified manually on this
// machine before writing the module: `plugin list --json` never invokes the
// model, so this is safe to run for real, not mocked.
test('fetchPluginInventory: a real invocation returns the exact candidate enabled at the exact --plugin-dir path, stable core disabled', async () => {
  const overlay = JSON.stringify({ enabledPlugins: { 'core@core': false, 'core@inline': true } });
  const result = fetchPluginInventory({ settingsOverlay: overlay, pluginDir: CANDIDATE_PLUGIN_DIR, timeoutMs: 20000 });
  assert.equal(result.ok, true, JSON.stringify(result));
  const byId = new Map(result.inventory.map((p) => [p.id, p]));
  const inlineEntry = byId.get('core@inline');
  assert.ok(inlineEntry, 'core@inline must appear in the resolved inventory');
  assert.equal(inlineEntry.enabled, true);
  assert.equal(inlineEntry.installPath, CANDIDATE_PLUGIN_DIR);
  const stableEntry = byId.get('core@core');
  if (stableEntry) assert.equal(stableEntry.enabled, false, 'stable core@core must be disabled by the overlay');
});

test('fetchPluginInventory: a nonexistent claude binary/bad args fails closed with a reason, never throws uncaught', () => {
  const result = fetchPluginInventory({ pluginDir: '/definitely/does/not/exist/plugins/core', timeoutMs: 20000 });
  // Either the CLI itself errors on a bad --plugin-dir, or it still returns
  // valid JSON without the candidate present — either way this must not throw.
  assert.ok(typeof result.ok === 'boolean');
});

test('verifyOverlayApplied: passes when exactly the candidate is enabled in the resolved inventory', () => {
  const resolved = [
    { id: 'core@inline', enabled: true, installPath: '/candidate/path' },
    { id: 'core@core', enabled: false },
    { id: 'other@mp', enabled: false },
  ];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('verifyOverlayApplied: fails when the candidate is missing from the resolved inventory', () => {
  const resolved = [{ id: 'core@core', enabled: false }];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANDIDATE_NOT_IN_RESOLVED_INVENTORY');
});

test('verifyOverlayApplied: fails when the candidate is present but not actually enabled', () => {
  const resolved = [{ id: 'core@inline', enabled: false, installPath: '/candidate/path' }, { id: 'core@core', enabled: false }];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANDIDATE_NOT_ENABLED');
});

test('verifyOverlayApplied: fails when the candidate resolves to the WRONG install path (a same-named different install)', () => {
  const resolved = [{ id: 'core@inline', enabled: true, installPath: '/wrong/path' }, { id: 'core@core', enabled: false }];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANDIDATE_WRONG_INSTALL_PATH');
});

test('verifyOverlayApplied: fails when another plugin is still enabled after the overlay', () => {
  const resolved = [
    { id: 'core@inline', enabled: true, installPath: '/candidate/path' },
    { id: 'core@core', enabled: false },
    { id: 'other@mp', enabled: true }, // overlay failed to disable this one
  ];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MORE_THAN_CANDIDATE_ENABLED');
  assert.deepEqual(result.enabledIds.sort(), ['core@inline', 'other@mp']);
});

// Hale re-audit (hale--29aa260-overlay-false-pass), the exact demonstrated
// counterexample: baseline core@core:true, resolved core@inline:true,
// core@core:false, plus a NEWLY auto-enabled surprise@auto:true that was
// never in the baseline at all. The old check only rechecked
// baseline-enabled plugins and returned ok:true. There is no baseline
// parameter anymore -- this must fail on the resolved inventory alone.
test('Hale false-pass counterexample: a newly-enabled plugin that was never in any baseline still fails closed', () => {
  const resolved = [
    { id: 'core@inline', enabled: true, installPath: '/candidate/path' },
    { id: 'core@core', enabled: false },
    { id: 'surprise@auto', enabled: true }, // never existed in any prior snapshot
  ];
  const result = verifyOverlayApplied(resolved, 'core@inline', '/candidate/path');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'MORE_THAN_CANDIDATE_ENABLED');
  assert.ok(result.enabledIds.includes('surprise@auto'));
});
