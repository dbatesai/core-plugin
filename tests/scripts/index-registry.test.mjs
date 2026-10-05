import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync, realpathSync, renameSync, cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  registerProject, touchProject, readLastActive, defaultCoreDir, recordBootstrap, mutateProjects, readProjects, settleState,
} from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { writeStamp, readManifest, updateManifest } from '../../plugins/core/skills/core/scripts/project-state.mjs';

const REGISTRY_CLI = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/index-registry.mjs', import.meta.url));
const H = 'claude-code';

// Genuinely concurrent child processes (spawnSync would serialize the "race").
function spawnAsync(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000, env: { ...process.env, CORE_HARNESS: H } });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'index-registry-'))));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const paths = (coreDir) => readProjects(coreDir).map((e) => e.path).sort();
const run = (coreDir, args) => spawnSync(process.execPath, [REGISTRY_CLI, ...args, '--core-dir', coreDir],
  { encoding: 'utf8', env: { ...process.env, CORE_HARNESS: H } });

test('register: new, then idempotent; refuses $HOME, ~/.core, and a folder holding registered projects', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'P');
    assert.deepEqual(registerProject(s.coreDir, p), { action: 'new', root: p });
    assert.deepEqual(registerProject(s.coreDir, p), { action: 'registered', root: p });
    assert.deepEqual(paths(s.coreDir), [p]);
    assert.equal(registerProject(s.coreDir, s.home).reason, 'home');
    assert.equal(registerProject(s.coreDir, join(s.coreDir)).reason, 'core-dir');
    const parent = registerProject(s.coreDir, join(s.base, 'Projects'));
    assert.equal(parent.action, 'refuse');
    assert.equal(parent.reason, 'contains-registered');
    assert.deepEqual(paths(s.coreDir), [p], 'nothing registered by a refusal');
  } finally { s.cleanup(); }
});

test('register: a folder inside a registered project asks join-or-new; --confirm-new registers it', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'P');
    registerProject(s.coreDir, p);
    const sub = s.mk('Projects', 'P', 'sub');
    assert.deepEqual(registerProject(s.coreDir, sub), { action: 'ask', parent: p });
    assert.deepEqual(paths(s.coreDir), [p]);
    assert.deepEqual(registerProject(s.coreDir, sub, { confirmNew: true }), { action: 'new', root: sub });
  } finally { s.cleanup(); }
});

test('mutateProjects refuses a non-array projects.json loudly (never silently rebuilds the registry)', () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.coreDir, 'projects.json'), JSON.stringify({ projects: [] }));
    assert.throws(() => mutateProjects(s.coreDir, (e) => e), /not an array/);
  } finally { s.cleanup(); }
});

test('touch writes last-active into the project state; the reader finds it there', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'P');
    registerProject(s.coreDir, p);
    assert.equal(readLastActive(s.coreDir, { root: p, harness: H }), null);
    const r = touchProject(s.coreDir, { root: p, harness: H, when: '2026-09-26T00:00:00Z' });
    assert.ok(existsSync(join(p, '_core', H, 'last-active')));
    assert.deepEqual(r.events.map((e) => e.kind), ['state-created']);
    assert.equal(readLastActive(s.coreDir, { root: p, harness: H }), '2026-09-26T00:00:00Z');
  } finally { s.cleanup(); }
});

test('touch on a moved project re-stamps it and moves the registry entry', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Old');
    registerProject(s.coreDir, p);
    updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Plover' } });
    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved); // startup registers the new path first
    const r = touchProject(s.coreDir, { root: moved, harness: H });
    assert.ok(r.events.some((e) => e.kind === 'state-moved' && e.oldPath === p));
    assert.deepEqual(paths(s.coreDir), [moved], 'the registry follows the move');
    assert.equal(readManifest({ root: moved, harness: H, coreDir: s.coreDir }).agent_name, 'Plover', 'history kept');
  } finally { s.cleanup(); }
});

test('touch on a copy sets the inherited state aside, keeps the original untouched, and mints a new project_id', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Orig');
    registerProject(s.coreDir, p);
    const orig = updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Plover' } });
    const copy = join(s.base, 'Projects', 'Copy');
    cpSync(p, copy, { recursive: true });
    const before = readFileSync(join(p, '_core', H, 'workspace.json'), 'utf8');
    registerProject(s.coreDir, copy);
    const r = touchProject(s.coreDir, { root: copy, harness: H });
    assert.ok(r.events.some((e) => e.kind === 'state-copied'));
    const fresh = updateManifest({ root: copy, harness: H, coreDir: s.coreDir });
    assert.notEqual(fresh.project_id, orig.project_id, 'the copy gets its own project_id');
    assert.equal(fresh.agent_name, undefined, 'the copy starts fresh');
    assert.equal(readFileSync(join(p, '_core', H, 'workspace.json'), 'utf8'), before, 'the original is untouched');
  } finally { s.cleanup(); }
});

test('state-ask: a verified stamp for a path whose parent is gone waits for the user; both answers work', () => {
  for (const decision of ['accept-move', 'fresh']) {
    const s = sandbox();
    try {
      const gone = s.mk('Drive', 'Projects', 'P');
      registerProject(s.coreDir, gone);
      updateManifest({ root: gone, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Plover' } });
      const here = join(s.base, 'P');
      renameSync(gone, here);
      rmSync(join(s.base, 'Drive'), { recursive: true, force: true });
      registerProject(s.coreDir, here);
      assert.throws(()=>touchProject(s.coreDir, { root: here, harness: H }),e=>e.code==='STATE_NO_PROJECT_PLACE'&&e.reason==='ask');
      assert.equal(existsSync(join(s.coreDir,'local')),false);
      const out = settleState(s.coreDir, { root: here, harness: H, decision });
      assert.equal(out.changed, true);
      const m = readManifest({ root: here, harness: H, coreDir: s.coreDir });
      if (decision === 'accept-move') assert.equal(m.agent_name, 'Plover', 'accepting the move keeps the history');
      else assert.equal(m.agent_name, undefined, 'fresh starts over, old state set aside');
    } finally { s.cleanup(); }
  }
});

test('another install\'s valid-looking state is left alone; new local fallback writes are refused', () => {
  const s = sandbox();
  const other = sandbox();
  try {
    const p = s.mk('Shared', 'P');
    registerProject(other.coreDir, p);
    writeStamp({ root: p, harness: H, coreDir: other.coreDir });
    const theirs = readFileSync(join(p, '_core', H, 'stamp'), 'utf8');
    registerProject(s.coreDir, p);
    assert.throws(()=>touchProject(s.coreDir, { root: p, harness: H }),e=>e.code==='STATE_NO_PROJECT_PLACE'&&e.reason==='foreign-install');
    assert.equal(existsSync(join(s.coreDir,'local')),false);
    assert.equal(readFileSync(join(p, '_core', H, 'stamp'), 'utf8'), theirs, 'the other machine\'s stamp is untouched');
    assert.equal(readLastActive(s.coreDir, { root: p, harness: H }),null);
  } finally { s.cleanup(); other.cleanup(); }
});

test('CLI: register, list, touch, last-active, manifest, bootstrap', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'C');
    const reg = run(s.coreDir, ['register', p]);
    assert.equal(reg.status, 0, reg.stderr);
    assert.equal(JSON.parse(reg.stdout).action, 'new');
    assert.equal(run(s.coreDir, ['list']).stdout.trim(), p);
    assert.equal(run(s.coreDir, ['touch', '--root', p, '--when', '2026-09-26T01:00:00Z']).status, 0);
    assert.equal(run(s.coreDir, ['last-active', '--root', p]).stdout.trim(), '2026-09-26T01:00:00Z');
    const m = run(s.coreDir, ['manifest', '--root', p, '--set-json', '{"agent_name":"Plover"}']);
    assert.equal(JSON.parse(m.stdout).agent_name, 'Plover');
    const b = run(s.coreDir, ['bootstrap', '--root', p, '--session-started', '2026-09-26T09:00:00Z']);
    assert.equal(b.status, 0, b.stderr);
    const rec = JSON.parse(readFileSync(join(p, '_core', H, 'last-bootstrap.json'), 'utf8'));
    assert.equal(rec.session_started_at, '2026-09-26T09:00:00Z');
    assert.equal(run(s.coreDir, ['register', s.home]).status, 3, 'a refusal exits 3');
    assert.equal(run(s.coreDir, ['nope']).status, 2);
  } finally { s.cleanup(); }
});

// THE LOST-UPDATE PROOF: concurrent writers through the scripted entrypoint, every
// registration survives. A freehand read-modify-write would lose all but the last.
test('race: 6 concurrent CLI registrations all land; no lost update, no torn file', async () => {
  const s = sandbox();
  try {
    const seed = s.mk('Projects', 'seed');
    registerProject(s.coreDir, seed);
    const dirs = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((n) => s.mk('Projects', n));
    const procs = await Promise.all(dirs.map((d) => spawnAsync([REGISTRY_CLI, 'register', d, '--core-dir', s.coreDir])));
    for (const p of procs) assert.equal(p.status, 0, `register exited 0 (stderr: ${p.stderr})`);
    assert.deepEqual(paths(s.coreDir), [...dirs, seed].sort(), 'all six concurrent registrations + the seed survived');
  } finally { s.cleanup(); }
});

test('race: two concurrent registrations of the SAME folder leave exactly one entry', async () => {
  const s = sandbox();
  try {
    const d = s.mk('Projects', 'same');
    const procs = await Promise.all([1, 2].map(() => spawnAsync([REGISTRY_CLI, 'register', d, '--core-dir', s.coreDir])));
    for (const p of procs) assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(paths(s.coreDir), [d]);
  } finally { s.cleanup(); }
});

test('defaultCoreDir fails closed when the trusted OS-account home is unavailable', () => {
  assert.throws(() => defaultCoreDir({ resolve: () => null }),
    (e) => e.code === 'NO_TRUSTED_HOME',
    'the registry must not fall back to an environment-controlled home');
});

test('the bootstrap record is an atomic, owner-only write in the project state', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'B');
    registerProject(s.coreDir, p);
    const r = recordBootstrap(s.coreDir, { root: p, harness: H, sessionStartedAt: '2026-07-28T09:00:00Z', completedAt: '2026-07-28T09:00:12Z' });
    const file = join(p, '_core', H, 'last-bootstrap.json');
    assert.equal(r.path, file);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      session_started_at: '2026-07-28T09:00:00Z',
      bootstrap_completed_at: '2026-07-28T09:00:12Z',
    });
    // Temp-file + rename, not a truncating write: no sibling temp survives.
    const litter = readdirSync(join(p, '_core', H)).filter((n) => n.startsWith('.'));
    assert.deepEqual(litter, [], `atomic write left temp litter: ${litter.join(', ')}`);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'the bootstrap record is owner-only');
  } finally { s.cleanup(); }
});
