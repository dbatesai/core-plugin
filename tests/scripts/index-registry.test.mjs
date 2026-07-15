import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Genuinely concurrent child processes (spawnSync would serialize the "race").
function spawnAsync(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000 });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}
import {
  addWorkspace, updateWorkspace, removeWorkspace, touchWorkspace, readLastActive, mutateIndex,
} from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { checkFork } from '../../plugins/core/skills/core/scripts/workspace-fork-check.mjs';

const REGISTRY_CLI = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/index-registry.mjs', import.meta.url));
const FORK_CLI = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/workspace-fork-check.mjs', import.meta.url));

function setup(entries = []) {
  const coreDir = mkdtempSync(join(tmpdir(), 'index-registry-'));
  writeFileSync(join(coreDir, 'index.json'), JSON.stringify(entries, null, 2) + '\n');
  return coreDir;
}
const readIdx = (coreDir) => JSON.parse(readFileSync(join(coreDir, 'index.json'), 'utf8'));

test('add/update/remove roundtrip; duplicate add refuses', () => {
  const coreDir = setup();
  addWorkspace(coreDir, { workspace_id: 'a', name: 'A', path: '/p/a' });
  assert.throws(() => addWorkspace(coreDir, { workspace_id: 'a', name: 'dup', path: '/p/dup' }), /already registered/);
  updateWorkspace(coreDir, 'a', { name: 'A2' });
  assert.equal(readIdx(coreDir)[0].name, 'A2');
  removeWorkspace(coreDir, 'a');
  assert.equal(readIdx(coreDir).length, 0);
  assert.throws(() => updateWorkspace(coreDir, 'ghost', {}), /unknown id/);
  rmSync(coreDir, { recursive: true, force: true });
});

test('touch writes the per-workspace last-active file; reader falls back to the index field', () => {
  const coreDir = setup([{ workspace_id: 'w', name: 'W', path: '/p/w', last_active: '2026-01-01T00:00:00Z' }]);
  // No per-workspace file yet → tolerant fallback to the index.json field.
  assert.equal(readLastActive(coreDir, 'w'), '2026-01-01T00:00:00Z');
  touchWorkspace(coreDir, 'w', '2026-07-14T00:00:00Z');
  assert.ok(existsSync(join(coreDir, 'workspaces', 'w', 'last-active')));
  assert.equal(readLastActive(coreDir, 'w'), '2026-07-14T00:00:00Z', 'per-workspace file wins over the index field');
  assert.equal(readLastActive(coreDir, 'nope'), null);
  rmSync(coreDir, { recursive: true, force: true });
});

test('mutateIndex refuses a non-array index.json loudly (never silently rebuilds the registry)', () => {
  const coreDir = setup();
  writeFileSync(join(coreDir, 'index.json'), JSON.stringify({ workspaces: [] }));
  assert.throws(() => addWorkspace(coreDir, { workspace_id: 'x' }), /not an array/);
  rmSync(coreDir, { recursive: true, force: true });
});

test('CLI: add, update, touch, last-active, remove', () => {
  const coreDir = setup();
  const run = (args) => spawnSync(process.execPath, [REGISTRY_CLI, ...args, '--core-dir', coreDir], { encoding: 'utf8' });
  assert.equal(run(['add', '--json', '{"workspace_id":"c","name":"C","path":"/p/c"}']).status, 0);
  assert.equal(run(['update', 'c', '--json', '{"name":"C2"}']).status, 0);
  assert.equal(run(['touch', 'c', '--when', '2026-07-14T01:00:00Z']).status, 0);
  const la = run(['last-active', 'c']);
  assert.equal(la.stdout.trim(), '2026-07-14T01:00:00Z');
  assert.equal(run(['remove', 'c']).status, 0);
  assert.equal(readIdx(coreDir).length, 0);
  const bad = run(['add', '--json', 'not json']);
  assert.equal(bad.status, 1);
  rmSync(coreDir, { recursive: true, force: true });
});

// THE LOST-UPDATE PROOF (the spec's verification bar): concurrent writers through
// the scripted entrypoint, every mutation survives. The old freehand read-modify-
// write pattern would lose all but the last writer here.
test('race: 6 concurrent CLI adds all land; no lost update, no torn file', async () => {
  const coreDir = setup([{ workspace_id: 'seed', name: 'S', path: '/p/s' }]);
  const ids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
  const procs = await Promise.all(ids.map(id => spawnAsync([
    REGISTRY_CLI, 'add', '--json', JSON.stringify({ workspace_id: id, name: id, path: `/p/${id}` }),
    '--core-dir', coreDir,
  ])));
  for (const p of procs) assert.equal(p.status, 0, `add exited 0 (stderr: ${p.stderr})`);
  const got = readIdx(coreDir).map(e => e.workspace_id).sort();
  assert.deepEqual(got, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'seed'], 'all six concurrent adds + the seed survived');
  rmSync(coreDir, { recursive: true, force: true });
});

test('race: concurrent add + update both survive (the exact lose-update hazard from the spec)', async () => {
  const coreDir = setup([{ workspace_id: 'w', name: 'W', path: '/p/w' }]);
  const [add, upd] = await Promise.all([
    spawnAsync([REGISTRY_CLI, 'add', '--json', '{"workspace_id":"new","name":"New","path":"/p/new"}', '--core-dir', coreDir]),
    spawnAsync([REGISTRY_CLI, 'update', 'w', '--json', '{"name":"W-renamed"}', '--core-dir', coreDir]),
  ]);
  assert.equal(add.status, 0, add.stderr);
  assert.equal(upd.status, 0, upd.stderr);
  const idx = readIdx(coreDir);
  assert.ok(idx.find(e => e.workspace_id === 'new'), 'add survived');
  assert.equal(idx.find(e => e.workspace_id === 'w').name, 'W-renamed', 'update survived');
  rmSync(coreDir, { recursive: true, force: true });
});

// Finding 4 from the adversarial pass: two concurrent forks of same-basename copies
// used to both compute the same collision-resolved id. With the decide inside the
// lock they mint distinct ids.
test('race: two concurrent forks of same-basename copies mint DISTINCT ids', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-race-'));
  const coreDir = join(root, 'core'); mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, 'index.json'), JSON.stringify([
    { workspace_id: 'src', name: 'Src', path: join(root, 'elsewhere') },
  ], null, 2) + '\n');
  const mkCopy = (n) => {
    const cwd = join(root, `copyroot${n}`, 'proj');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'workspace.json'), JSON.stringify({ workspace_id: 'src', name: 'Src' }));
    return cwd;
  };
  const [cwd1, cwd2] = [mkCopy(1), mkCopy(2)];
  const [p1, p2] = await Promise.all([
    spawnAsync([FORK_CLI, '--cwd', cwd1, '--core-dir', coreDir]),
    spawnAsync([FORK_CLI, '--cwd', cwd2, '--core-dir', coreDir]),
  ]);
  assert.equal(p1.status, 0, p1.stderr);
  assert.equal(p2.status, 0, p2.stderr);
  const idx = readIdx(coreDir);
  const forkedIds = idx.map(e => e.workspace_id).filter(id => id.startsWith('proj'));
  assert.equal(forkedIds.length, 2, 'both forks registered');
  assert.equal(new Set(forkedIds).size, 2, `ids are distinct: ${forkedIds.join(', ')}`);
  for (const id of forkedIds) {
    assert.ok(existsSync(join(coreDir, 'workspaces', id, 'workspace.json')), `meta dir exists for ${id} (index entry implies meta dir)`);
    assert.ok(existsSync(join(coreDir, 'workspaces', id, 'last-active')), `per-workspace last-active written for ${id}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test('checkFork registry entry carries no last_active field (moved to the per-workspace file)', () => {
  const root = mkdtempSync(join(tmpdir(), 'fork-la-'));
  const coreDir = join(root, 'core'); mkdirSync(coreDir, { recursive: true });
  writeFileSync(join(coreDir, 'index.json'), JSON.stringify([
    { workspace_id: 'src', name: 'Src', path: join(root, 'elsewhere') },
  ], null, 2) + '\n');
  const cwd = join(root, 'projx'); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'workspace.json'), JSON.stringify({ workspace_id: 'src', name: 'Src' }));
  const r = checkFork({ cwd, coreDir });
  assert.equal(r.action, 'forked');
  const entry = readIdx(coreDir).find(e => e.workspace_id === r.new_id);
  assert.ok(entry, 'forked entry registered');
  assert.ok(!('last_active' in entry), 'no last_active field written to the shared registry');
  assert.equal(readLastActive(coreDir, r.new_id).length > 0, true, 'per-workspace last-active readable');
  rmSync(root, { recursive: true, force: true });
});
