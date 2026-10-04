import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../plugins/core/skills/core/hooks/collab-sync-hook.mjs');
const { runCollabSyncHook, THROTTLE_MS } = await import(pathToFileURL(HOOK).href);

const hot = mkdtempSync(join(tmpdir(), 'collab-hook-hot-'));
const calls = [];
const base = { env: {}, resolveRoot: () => '/proj', findCollab: () => '/collab/scripts', hotDir: () => hot, sync: (root, o) => { calls.push([root, o.collabCli]); return { status: 'ok', items: [] }; } };

test('kill switch, unregistered project and absent collab are named skips that never sync', () => {
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, env: { CORE_COLLAB_SYNC: '0' } }).reason, 'kill-switch');
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, resolveRoot: () => null }).reason, 'unregistered');
  assert.equal(runCollabSyncHook({}, base).reason, 'unregistered');
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, findCollab: () => null }).reason, 'collab-absent');
  assert.equal(calls.length, 0);
});

test('a registered project with collab syncs once, is throttled inside the window, and syncs again after it', () => {
  const t0 = 1_000_000_000_000;
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, now: t0 }).action, 'ran');
  assert.deepEqual(calls.at(-1), ['/proj', '/collab/scripts']);
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, now: t0 + THROTTLE_MS - 1 }).reason, 'throttled');
  assert.equal(runCollabSyncHook({ cwd: '/p' }, { ...base, now: t0 + THROTTLE_MS }).action, 'ran');
  assert.equal(calls.length, 2);
  assert.ok(existsSync(join(hot, 'collab-sync-stamp.json')));
});

test('the hook is registered async on UserPromptSubmit, so a turn never waits on it', () => {
  const h = JSON.parse(readFileSync(resolve(__dirname, '../../plugins/core/hooks/hooks.json'), 'utf8'));
  const entry = h.hooks.UserPromptSubmit.flatMap(g => g.hooks).find(x => x.command.includes('collab-sync-hook.mjs'));
  assert.ok(entry, 'registered');
  assert.equal(entry.async, true);
});

test('cleanup', () => { rmSync(hot, { recursive: true, force: true }); });
