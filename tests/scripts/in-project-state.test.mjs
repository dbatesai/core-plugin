// End-to-end guarantees for per-project state living in <project>/.core/<harness>/:
// auto-close eligibility, two harnesses on one folder, migration apply, git hygiene,
// cross-machine locks, and the no-hand-built-path gate. Every test runs in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, chmodSync, statSync, utimesSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveRegisteredRoot } from '../../plugins/core/skills/core/scripts/close-pass.mjs';
import { registerProject, touchProject, recordBootstrap, readBootstrapRecord } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { readManifest, updateManifest, ensureInstallIdentity, classifyStamp, stateDir, writeSignedFile, writePinSigned, readRegisteredRoots, registryEntryPath } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { checkMetricsDisclosure, NOTICE_TEXT, NOTICE_VERSION } from '../../plugins/core/skills/core/scripts/metrics-disclosure.mjs';
import { applyMigration, checkLegacyDrift } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';
import { operationalMetricsDir } from '../../plugins/core/skills/core/scripts/log-event.mjs';
import { appendRows } from '../../plugins/core/skills/core/scripts/capability-history.mjs';
import { acquireFileLock, inspectFileLock, releaseFileLock } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));
const HOOKS = fileURLToPath(new URL('../../plugins/core/skills/core/hooks/', import.meta.url));
const REGISTRY_CLI = join(SCRIPTS, 'index-registry.mjs');
const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'in-project-state-'))));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const git = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
function spawnAsync(args, env = {}) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000, env: { ...process.env, ...env } });
    let stderr = '';
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status) => res({ status, stderr }));
  });
}

// ---------- spec test 4: auto-close eligibility ----------

test('auto-close resolves only registered projects: a plain subfolder closes its project; a nested .git or a planted .core closes nothing', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'P');
    registerProject(s.coreDir, p);
    const indexPath = join(s.coreDir, 'projects.json');
    assert.equal(resolveRegisteredRoot(p, { indexPath }), p);
    assert.equal(resolveRegisteredRoot(s.mk('Projects', 'P', 'notes', 'deep'), { indexPath }), p, 'a plain subfolder closes its project');
    const wt = s.mk('Projects', 'P', '.claude', 'worktrees', 'agent-1');
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n');
    assert.equal(resolveRegisteredRoot(wt, { indexPath }), null, 'a worktree inside the project is its own boundary');
    const vendored = s.mk('Projects', 'P', 'vendor', 'lib');
    mkdirSync(join(vendored, '.git'));
    assert.equal(resolveRegisteredRoot(join(vendored), { indexPath }), null, 'a vendored clone gets no close');
    const hostile = s.mk('Downloads', 'clone');
    mkdirSync(join(hostile, '.core', 'claude-code'), { recursive: true });
    mkdirSync(join(hostile, '_memories'));
    writeFileSync(join(hostile, '.core', 'claude-code', 'workspace.json'), '{"agent_name":"x"}');
    assert.equal(resolveRegisteredRoot(hostile, { indexPath }), null, 'a .core/ folder is never registration');
  } finally { s.cleanup(); }
});

// ---------- spec test 5: two harnesses, one folder ----------

test('two harnesses on one folder at once keep separate subfolders, names and records', async () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Shared');
    registerProject(s.coreDir, p);
    const run = (harness) => [
      spawnAsync([REGISTRY_CLI, 'touch', '--root', p, '--harness', harness, '--core-dir', s.coreDir]),
      spawnAsync([REGISTRY_CLI, 'manifest', '--root', p, '--harness', harness, '--set-json', JSON.stringify({ agent_name: `name-${harness}` }), '--core-dir', s.coreDir]),
      spawnAsync([REGISTRY_CLI, 'bootstrap', '--root', p, '--harness', harness, '--session-started', `2026-09-26T00:00:00Z-${harness}`, '--core-dir', s.coreDir]),
    ];
    const results = await Promise.all([...run('claude-code'), ...run('codex')]);
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readdirSync(join(p, '.core')).sort(), ['.gitignore', 'claude-code', 'codex']);
    for (const h of ['claude-code', 'codex']) {
      assert.equal(readManifest({ root: p, harness: h, coreDir: s.coreDir }).agent_name, `name-${h}`);
      const rec = JSON.parse(readFileSync(join(p, '.core', h, 'last-bootstrap.json'), 'utf8'));
      assert.equal(rec.session_started_at, `2026-09-26T00:00:00Z-${h}`, `${h}'s bootstrap record is its own`);
      assert.ok(existsSync(join(p, '.core', h, 'last-active')));
    }
  } finally { s.cleanup(); }
});

// ---------- spec test 6: migration apply ----------

function legacyWorkspace(s, id, { path, files = {}, lastActive = null }) {
  const dir = join(s.coreDir, 'workspaces', id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (lastActive) writeFileSync(join(dir, 'last-active'), lastActive + '\n');
  return { workspace_id: id, name: id, path };
}

function migrationFixture() {
  const s = sandbox();
  const p = s.mk('Projects', 'Legacy');
  const index = [
    legacyWorkspace(s, 'legacy', { path: p, lastActive: '2026-09-20T00:00:00Z', files: {
      'workspace.json': JSON.stringify({ workspace_id: 'legacy', agent_name: 'Plover' }),
      'capability-history.jsonl': '{"row":1}\n',
      'metrics/classified/2026-09-01.jsonl': '{"state":"tier-0-win"}\n',
      'metrics/storage-path.txt': join(p, '_metrics'),
      'hot-section-draft.md': 'draft\n',
      'capability-history.lock.g3.done': '{}',
    } }),
    legacyWorkspace(s, 'legacy-old', { path: p, lastActive: '2026-01-01T00:00:00Z', files: {
      'workspace.json': JSON.stringify({ workspace_id: 'legacy-old', agent_name: 'Old' }),
      'notes.md': 'older duplicate\n',
    } }),
    legacyWorkspace(s, 'legacy-codex', { path: p, files: {
      'workspace.json': JSON.stringify({ workspace_id: 'legacy-codex', agent_name: 'Finch' }),
    } }),
  ];
  writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index, null, 2));
  writeFileSync(join(p, 'workspace.json'), JSON.stringify({ workspace_id: 'legacy', metrics_enabled: false }));
  const table = { version: 1, entries: {
    legacy: { harness: 'claude-code', evidence: 'fixture' },
    'legacy-old': { harness: 'claude-code', evidence: 'fixture' },
    'legacy-codex': { harness: 'codex', evidence: 'fixture' },
  } };
  return { s, p, table };
}

test('migration copies every legacy byte, verifies it, and a re-run is a no-op', () => {
  const { s, p, table } = migrationFixture();
  try {
    const before = new Map();
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else before.set(f, sha(f)); } };
    walk(join(s.coreDir, 'workspaces'));

    const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(r.status, 'migrated');
    assert.equal(r.live, 'legacy', 'the pointer names the live duplicate');
    assert.deepEqual(r.superseded, ['legacy-old']);

    const receipt = JSON.parse(readFileSync(join(p, '.core', 'claude-code', 'migrated-from.json'), 'utf8'));
    assert.equal(receipt.complete, true);
    const copiedHashes = new Set(receipt.files.map((f) => f.sha256));
    for (const f of receipt.files) assert.equal(sha(f.to), f.sha256, `copy verified: ${f.to}`);
    for (const [f, h] of before) {
      if (/\.lock|last-active$/.test(f) && !copiedHashes.has(h)) continue;
      if (f.includes('legacy-codex')) continue; // another harness's workspace, not this run's
      assert.ok(copiedHashes.has(h), `source byte-for-byte present in the migrated state: ${f}`);
    }
    for (const [f, h] of before) assert.equal(sha(f), h, `the legacy source is untouched: ${f}`);

    const m = readManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(m.project_id, 'legacy', 'the old workspace id carries on as project_id');
    assert.equal(m.agent_name, 'Plover');
    assert.equal(m.metrics_enabled, false, "the pointer's opt-out carries into the manifest");
    assert.equal(readFileSync(join(operationalMetricsDir(p, { home: s.home, env: { CORE_HARNESS: 'claude-code' } }), 'classified', '2026-09-01.jsonl'), 'utf8'), '{"state":"tier-0-win"}\n');
    assert.ok(existsSync(join(p, '.core', 'claude-code', 'superseded', 'legacy-old', 'notes.md')), 'the duplicate is kept, not live');

    const again = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(again.status, 'already-migrated');
    assert.equal(again.files, 0, 'a re-run copies nothing');
  } finally { s.cleanup(); }
});

test('the old pointer, MOVED.md and the index marks wait until every harness on the path has migrated', () => {
  const { s, p, table } = migrationFixture();
  try {
    const pointerBefore = readFileSync(join(p, 'workspace.json'), 'utf8');
    const first = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(first.released, false, 'codex has not migrated yet');
    assert.equal(readFileSync(join(p, 'workspace.json'), 'utf8'), pointerBefore, 'an older Codex still finds its pointer');
    assert.equal(existsSync(join(s.coreDir, 'workspaces', 'legacy', 'MOVED.md')), false);
    assert.ok(!JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8')).some((e) => e.migrated));

    const second = applyMigration({ root: p, harness: 'codex', coreDir: s.coreDir, table });
    assert.equal(second.status, 'migrated');
    assert.equal(second.released, true);
    assert.equal(readManifest({ root: p, harness: 'codex', coreDir: s.coreDir }).agent_name, 'Finch');
    for (const id of ['legacy', 'legacy-old', 'legacy-codex']) {
      assert.ok(existsSync(join(s.coreDir, 'workspaces', id, 'MOVED.md')), `${id} carries MOVED.md`);
      assert.ok(existsSync(join(s.coreDir, 'workspaces', id, 'workspace.json')), `${id} is kept, never deleted`);
    }
    assert.match(readFileSync(join(p, 'workspace.json'), 'utf8'), /"moved"/, 'the pointer becomes a moved note');
    assert.ok(JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8')).every((e) => e.migrated), 'index entries marked migrated');
    const manifest = JSON.parse(readFileSync(join(s.coreDir, 'migration-manifest.json'), 'utf8'));
    assert.ok(manifest.entries.filter((e) => e.path === p).every((e) => e.migrated_at));
  } finally { s.cleanup(); }
});

test('a git-tracked root pointer is left alone even after every harness has migrated', () => {
  const { s, p, table } = migrationFixture();
  try {
    assert.equal(git(p, 'init', '-q').status, 0);
    git(p, 'add', 'workspace.json');
    const before = readFileSync(join(p, 'workspace.json'), 'utf8');
    applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    const r = applyMigration({ root: p, harness: 'codex', coreDir: s.coreDir, table });
    assert.equal(r.released, true);
    assert.equal(readFileSync(join(p, 'workspace.json'), 'utf8'), before, 'tracked pointer untouched');
  } finally { s.cleanup(); }
});

test('a migration interrupted mid-copy leaves no receipt, and the next run completes it', { skip: isWin || isRoot }, () => {
  const { s, p, table } = migrationFixture();
  const blocker = join(s.coreDir, 'workspaces', 'legacy', 'hot-section-draft.md');
  try {
    chmodSync(blocker, 0o000);
    assert.throws(() => applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table }), /EACCES|EPERM/);
    assert.equal(existsSync(join(p, '.core', 'claude-code', 'migrated-from.json')), false, 'no receipt after an interrupted copy');
    chmodSync(blocker, 0o644);
    const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(r.status, 'migrated');
    const receipt = JSON.parse(readFileSync(join(p, '.core', 'claude-code', 'migrated-from.json'), 'utf8'));
    for (const f of receipt.files) assert.equal(sha(f.to), f.sha256);
    assert.ok(receipt.files.some((f) => f.from === blocker));
  } finally { try { chmodSync(blocker, 0o644); } catch { /* gone */ } s.cleanup(); }
});

test('without a table, the running harness claims a sole unlabeled registration; several are held', () => {
  const s = sandbox();
  try {
    const solo = s.mk('Projects', 'Solo');
    const multi = s.mk('Projects', 'Multi');
    const index = [
      legacyWorkspace(s, 'solo', { path: solo, files: { 'workspace.json': '{"workspace_id":"solo"}' } }),
      legacyWorkspace(s, 'multi-a', { path: multi, files: { 'workspace.json': '{"workspace_id":"multi-a"}' } }),
      legacyWorkspace(s, 'multi-b', { path: multi, files: { 'workspace.json': '{"workspace_id":"multi-b"}' } }),
    ];
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index));
    assert.equal(applyMigration({ root: solo, harness: 'codex', coreDir: s.coreDir }).status, 'migrated');
    assert.equal(readManifest({ root: solo, harness: 'codex', coreDir: s.coreDir }).project_id, 'solo');
    const held = applyMigration({ root: multi, harness: 'codex', coreDir: s.coreDir });
    assert.equal(held.status, 'held');
    assert.equal(held.held.length, 2);
    assert.equal(existsSync(join(multi, '.core', 'codex', 'migrated-from.json')), false);
  } finally { s.cleanup(); }
});

test('migration CLI exits 3 for ambiguous legacy registrations and 0 for genuine absence', () => {
  const s = sandbox();
  try {
    const heldRoot = s.mk('Projects', 'Held');
    const absentRoot = s.mk('Projects', 'Absent');
    const index = ['held-a', 'held-b'].map(id => legacyWorkspace(s, id, {
      path: heldRoot, files: { 'workspace.json': JSON.stringify({ workspace_id: id }) },
    }));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index));
    const before = index.map(e => readFileSync(join(s.coreDir, 'workspaces', e.workspace_id, 'workspace.json'), 'utf8'));
    const run = root => spawnSync(process.execPath, [join(SCRIPTS, 'migrate-workspace-state.mjs'),
      '--apply', '--root', root, '--harness', 'codex', '--core-dir', s.coreDir], { encoding: 'utf8' });
    const held = run(heldRoot);
    assert.equal(held.status, 3, `held migration must not return success: ${held.stdout} ${held.stderr}`);
    const report = JSON.parse(held.stdout);
    assert.equal(report.status, 'held');
    assert.equal(report.held.length, 2);
    assert.equal(existsSync(join(heldRoot, '.core', 'codex', 'migrated-from.json')), false);
    for (let i = 0; i < index.length; i++) {
      assert.equal(readFileSync(join(s.coreDir, 'workspaces', index[i].workspace_id, 'workspace.json'), 'utf8'), before[i]);
      assert.equal(existsSync(join(s.coreDir, 'workspaces', index[i].workspace_id, 'MOVED.md')), false);
    }
    const absent = run(absentRoot);
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(JSON.parse(absent.stdout).status, 'nothing-to-migrate');
  } finally { s.cleanup(); }
});

// ---------- spec test 7: .core stays out of git ----------

function exerciseState(s, root) {
  registerProject(s.coreDir, root);
  touchProject(s.coreDir, { root, harness: 'claude-code' });
  recordBootstrap(s.coreDir, { root, harness: 'claude-code', sessionStartedAt: '2026-09-26T00:00:00Z' });
  updateManifest({ root, harness: 'claude-code', coreDir: s.coreDir, fields: { agent_name: 'Plover' } });
  const metrics = operationalMetricsDir(root, { home: s.home, env: { CORE_HARNESS: 'claude-code' } });
  writeFileSync(join(metrics, 'orient-signal.txt'), 'signal\n');
  appendRows({ root, harness: 'claude-code' }, [{ capability_id: 'x', identity_status: 'PASS' }], {}, { home: s.home });
  assert.ok(existsSync(join(root, '.core', 'claude-code', 'capability-history.jsonl')), 'state really is in the project');
}

test('after a session\'s worth of state writes, `git add -A` stages nothing under .core/ (fresh repo and worktree)', () => {
  const s = sandbox();
  try {
    const repo = s.mk('Projects', 'Repo');
    assert.equal(git(repo, 'init', '-q').status, 0);
    if (isWin) git(repo, 'config', 'core.autocrlf', 'true');
    git(repo, 'config', 'user.email', 't@example.com'); git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), 'r\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    exerciseState(s, repo);
    git(repo, 'add', '-A');
    const staged = git(repo, 'status', '--porcelain').stdout.split('\n').filter((l) => l.includes('.core'));
    assert.deepEqual(staged, [], 'nothing under .core/ is addable');
    assert.equal(readFileSync(join(repo, '.core', '.gitignore'), 'utf8'), '*\n');

    const wt = join(s.base, 'Projects', 'Repo-wt');
    assert.equal(git(repo, 'worktree', 'add', '-q', wt).status, 0);
    exerciseState(s, realpathSync(wt));
    git(wt, 'add', '-A');
    assert.deepEqual(git(wt, 'status', '--porcelain').stdout.split('\n').filter((l) => l.includes('.core')), [], 'worktree too');
  } finally { s.cleanup(); }
});

// ---------- spec test 8: cross-machine locks ----------

test('a lock records this install\'s id, not the hostname; another install\'s lock is stale past the ceiling even with a live pid', () => {
  const s = sandbox();
  try {
    const lock = join(s.base, 'x.lock');
    const mine = acquireFileLock(lock, { machine: 'install-a' });
    assert.ok(mine.ok);
    assert.equal(mine.lock.machine, 'install-a');
    assert.notEqual(mine.lock.machine, hostname(), 'the machine field is the install id, stable across hostname changes');
    const later = Date.now() + 31 * 60 * 1000;
    // Same install, live pid: held at ANY age (suspend/revive must not overlap a superseder).
    assert.equal(inspectFileLock(lock, { machine: 'install-a', now: later }).held, true);
    // Another install reading the synced/copied lock: its pid proves nothing here.
    assert.equal(inspectFileLock(lock, { machine: 'install-b', now: Date.now() }).held, true, 'fresh foreign lock still held');
    assert.equal(inspectFileLock(lock, { machine: 'install-b', now: later }).stale, true, 'foreign lock stale past the hard ceiling');
    releaseFileLock(lock, mine.nonce);
  } finally { s.cleanup(); }
});

test('a lock with no machine field keeps the local rule: a live pid is never stolen', () => {
  const s = sandbox();
  try {
    const lock = join(s.base, 'legacy.lock');
    writeFileSync(`${lock}.g1`, JSON.stringify({ pid: process.pid, nonce: 'n', gen: 1 }));
    const old = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(`${lock}.g1`, old, old);
    assert.equal(inspectFileLock(lock, { machine: 'install-b' }).held, true, 'no field → treated as local; live pid holds');
  } finally { s.cleanup(); }
});

test('a lock carried in with a copied folder (foreign install, live local pid) does not stall a write past the ceiling', () => {
  const s = sandbox();
  try {
    const lock = join(s.base, 'carried.lock');
    writeFileSync(`${lock}.g4`, JSON.stringify({ pid: process.pid, machine: 'some-other-install', nonce: 'n', gen: 4 }));
    const old = (Date.now() - 31 * 60 * 1000) / 1000;
    utimesSync(`${lock}.g4`, old, old);
    const got = acquireFileLock(lock, { machine: 'this-install' });
    assert.equal(got.ok, true, 'the carried-in lock is superseded instead of stalling forever');
    assert.equal(got.gen, 5);
    releaseFileLock(lock, got.nonce);
  } finally { s.cleanup(); }
});

// ---------- spec test 9: no hand-built workspace paths ----------

test('no script or hook builds a ~/.core/workspaces path by hand (the migration reader excepted)', () => {
  const offenders = [];
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) { scan(f); continue; }
      if (!f.endsWith('.mjs') || e.name === 'migrate-workspace-state.mjs') continue;
      const src = readFileSync(f, 'utf8');
      if (/['"]workspaces['"]|\.core[/\\]+workspaces|'\.core', 'workspaces'/.test(src.replace(/^\s*(\/\/|\*).*$/gm, ''))) offenders.push(f);
    }
  };
  scan(SCRIPTS); scan(HOOKS);
  assert.deepEqual(offenders, []);
});

test('ensureInstallIdentity keeps the secret owner-only', { skip: isWin }, () => {
  const s = sandbox();
  try {
    ensureInstallIdentity({ coreDir: s.coreDir });
    assert.equal(statSync(join(s.coreDir, 'install-secret')).mode & 0o777, 0o600);
  } finally { s.cleanup(); }
});

test('detectStateHarness: positive signals only; an unrecognized harness gets its own subfolder', async () => {
  const { detectStateHarness } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  assert.equal(detectStateHarness({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectStateHarness({ CLAUDE_PLUGIN_ROOT: '/x' }), 'claude-code');
  assert.equal(detectStateHarness({ CODEX_THREAD_ID: 't' }), 'codex');
  assert.equal(detectStateHarness({ CORE_HARNESS: 'other-harness' }), 'other-harness');
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CORE_HARNESS)/.test(k)) delete process.env[k];
    assert.equal(detectStateHarness({}), 'unknown');
    process.env.CLAUDECODE = '1';
    assert.equal(detectStateHarness({ CORE_METRICS_ENABLED: '1' }), 'claude-code', 'a config-only env falls back to the process env');
  } finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
});

test('metricsEnabled: a root workspace.json can switch capture off but never on', async () => {
  const { metricsEnabled } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const { mkdtempSync, writeFileSync: wf, rmSync: rm } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { join: j } = await import('node:path');
  const home = mkdtempSync(j(td(), 'optout-home-'));
  const project = mkdtempSync(j(td(), 'optout-proj-'));
  try {
    const env = { CLAUDECODE: '1' };
    assert.equal(metricsEnabled({ project, env, home }), true);
    wf(j(project, 'workspace.json'), JSON.stringify({ metrics_enabled: false }));
    assert.equal(metricsEnabled({ project, env, home }), false);
    wf(j(project, 'workspace.json'), JSON.stringify({ metrics_enabled: true, metrics_disclosure_shown: true }));
    assert.equal(metricsEnabled({ project, env, home }), true);
    assert.equal(metricsEnabled({ project, env: { ...env, CORE_METRICS_ENABLED: '0' }, home }), false);
  } finally { rm(home, { recursive: true, force: true }); rm(project, { recursive: true, force: true }); }
});

test('concurrent first writes in a fresh project never set each other aside', async () => {
  for (let round = 0; round < 5; round++) {
    const s = sandbox();
    try {
      const p = s.mk('Projects', `Fresh${round}`);
      registerProject(s.coreDir, p);
      const cmds = [];
      for (let i = 0; i < 4; i++) {
        cmds.push(spawnAsync([REGISTRY_CLI, 'touch', '--root', p, '--harness', 'claude-code', '--core-dir', s.coreDir]));
        cmds.push(spawnAsync([REGISTRY_CLI, 'manifest', '--root', p, '--harness', 'claude-code', '--set-json', JSON.stringify({ [`k${i}`]: i }), '--core-dir', s.coreDir]));
      }
      for (const r of await Promise.all(cmds)) assert.equal(r.status, 0, r.stderr);
      const dir = join(p, '.core', 'claude-code');
      assert.ok(existsSync(join(dir, 'last-active')), 'last-active survived');
      assert.ok(!readdirSync(dir).includes('superseded'), 'nothing was set aside');
      assert.deepEqual(readdirSync(join(p, '.core')).filter((n) => n.startsWith('.creating-')), [], 'no temp folders left');
    } finally { s.cleanup(); }
  }
});


// ---------- signed control files ----------

function signedProject(s) {
  const p = s.mk('Projects', 'Signed');
  registerProject(s.coreDir, p);
  return p;
}
const H = 'claude-code';
const stateFile = (p, name) => join(p, '.core', H, name);

test('a normal write of the manifest and bootstrap record verifies on read, with MAC sidecars beside them', () => {
  const s = sandbox();
  try {
    const p = signedProject(s);
    updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Wren' } });
    recordBootstrap(s.coreDir, { root: p, harness: H, sessionStartedAt: '2026-09-26T10:00:00Z' });
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }).agent_name, 'Wren');
    assert.equal(readBootstrapRecord(s.coreDir, { root: p, harness: H }).session_started_at, '2026-09-26T10:00:00Z');
    assert.ok(existsSync(stateFile(p, 'workspace.json.mac')));
    assert.ok(existsSync(stateFile(p, 'last-bootstrap.json.mac')));
  } finally { s.cleanup(); }
});

test('same-path tamper: edited control files read as absent while the stamp still verifies', () => {
  const s = sandbox();
  try {
    const p = signedProject(s);
    const env = { CORE_HARNESS: H };
    // First contact shows the notice and records it; a second call doesn't.
    assert.equal(checkMetricsDisclosure({ projectDir: p, home: s.home, env }).noticeText, NOTICE_TEXT);
    assert.notEqual(checkMetricsDisclosure({ projectDir: p, home: s.home, env }).noticeText, NOTICE_TEXT);
    recordBootstrap(s.coreDir, { root: p, harness: H, sessionStartedAt: '2026-09-26T10:00:00Z' });

    // Someone edits the files in place: the disclosure flag and the bootstrap marker.
    const m = JSON.parse(readFileSync(stateFile(p, 'workspace.json'), 'utf8'));
    writeFileSync(stateFile(p, 'workspace.json'), JSON.stringify({ ...m, agent_name: 'Mallory', metrics_disclosure_shown: true, metrics_disclosure_version: NOTICE_VERSION }));
    writeFileSync(stateFile(p, 'last-bootstrap.json'), JSON.stringify({ session_started_at: '2026-09-27T09:00:00Z', bootstrap_completed_at: '2026-09-27T09:00:01Z' }));
    assert.equal(classifyStamp({ root: p, harness: H, coreDir: s.coreDir }).status, 'verified', 'the stamp alone is untouched');

    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }), null, 'the tampered manifest reads as absent');
    assert.equal(readBootstrapRecord(s.coreDir, { root: p, harness: H }), null, 'the tampered bootstrap record reads as absent');
    const cli = spawnSync(process.execPath, [REGISTRY_CLI, 'bootstrap-status', '--root', p, '--harness', H, '--core-dir', s.coreDir], { encoding: 'utf8' });
    assert.equal(cli.stdout.trim(), '(none)', 'startup dedup sees no record, so startup runs in full');
    assert.equal(checkMetricsDisclosure({ projectDir: p, home: s.home, env }).noticeText, NOTICE_TEXT, 'the disclosure shows again');
  } finally { s.cleanup(); }
});

test('a force-added .core file that git tracks is ignored, even with a valid MAC', () => {
  const s = sandbox();
  try {
    const p = signedProject(s);
    assert.equal(git(p, 'init', '-q').status, 0);
    updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Wren' } });
    recordBootstrap(s.coreDir, { root: p, harness: H, sessionStartedAt: '2026-09-26T10:00:00Z' });
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }).agent_name, 'Wren');
    assert.equal(git(p, 'add', '-f', '.core/claude-code/workspace.json', '.core/claude-code/workspace.json.mac', '.core/claude-code/last-bootstrap.json').status, 0);
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }), null, 'a tracked manifest reads as absent');
    assert.equal(readBootstrapRecord(s.coreDir, { root: p, harness: H }), null, 'a tracked bootstrap record reads as absent');
  } finally { s.cleanup(); }
});

test('a force-added tracked file still reads as absent when git ls-files itself errors (index unreadable)', { skip: isWin || isRoot }, () => {
  // Regression guard: trackedStateFiles() used to fall back to "nothing
  // tracked" whenever the git spawn failed, so an error mid-check (not just a clean
  // "untracked" answer) would let a force-added, validly-MACed control file be read
  // and trusted. Force-add the files as before, then make `.git/index` unreadable so
  // `git ls-files` itself errors (not merely reports untracked) while the working
  // tree, and the MAC files, stay intact. Both signed reads must still come back null.
  const s = sandbox();
  try {
    const p = signedProject(s);
    assert.equal(git(p, 'init', '-q').status, 0);
    updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Wren' } });
    recordBootstrap(s.coreDir, { root: p, harness: H, sessionStartedAt: '2026-09-26T10:00:00Z' });
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }).agent_name, 'Wren');
    assert.equal(git(p, 'add', '-f', '.core/claude-code/workspace.json', '.core/claude-code/workspace.json.mac', '.core/claude-code/last-bootstrap.json').status, 0);
    const indexFile = join(p, '.git', 'index');
    chmodSync(indexFile, 0o000);
    try {
      assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }), null, 'a tracked manifest reads as absent even when the tracking check itself errors');
      assert.equal(readBootstrapRecord(s.coreDir, { root: p, harness: H }), null, 'a tracked bootstrap record reads as absent even when the tracking check itself errors');
    } finally { chmodSync(indexFile, 0o644); }
  } finally { s.cleanup(); }
});

test('the tracked guard still sees a force-added file under a v4 (prefix-compressed) index and in a nested project', () => {
  const s = sandbox();
  try {
    const repo = s.mk('Repo');
    assert.equal(git(repo, 'init', '-q').status, 0);
    const p = join(repo, 'sub', 'Proj');
    mkdirSync(p, { recursive: true });
    registerProject(s.coreDir, p);
    updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Wren' } });
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }).agent_name, 'Wren', 'untracked: trusted, and no git spawn needed');
    assert.equal(git(repo, 'update-index', '--index-version', '4').status, 0);
    // A neighbour that sorts just before the target ('-' < '/') makes v4 store the target
    // as a suffix of '.core/claude-code', so the prefix never appears as plain bytes.
    mkdirSync(join(p, '.core', 'claude-code-x'), { recursive: true });
    writeFileSync(join(p, '.core', 'claude-code-x', 'f'), 'x');
    assert.equal(git(repo, 'add', '-f', 'sub/Proj/.core/claude-code-x/f', 'sub/Proj/.core/claude-code/workspace.json', 'sub/Proj/.core/claude-code/workspace.json.mac').status, 0);
    assert.ok(!readFileSync(join(repo, '.git', 'index')).includes('.core/claude-code/'), 'the fixture really hides the prefix');
    assert.equal(readManifest({ root: p, harness: H, coreDir: s.coreDir }), null, 'tracked under a v4 index reads as absent');
  } finally { s.cleanup(); }
});

// ---------- old builds after migration ----------

test('old -> new -> old -> new: every line an older build appends reaches the project exactly once', () => {
  const { s, p, table } = migrationFixture();
  try {
    const legacyDir = join(s.coreDir, 'workspaces', 'legacy');
    const legacyLog = join(legacyDir, 'capability-history.jsonl');
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'migrated');
    const receiptFile = stateFile(p, 'migrated-from.json');
    const entry = JSON.parse(readFileSync(receiptFile, 'utf8')).files.find((f) => f.from === legacyLog);
    assert.equal(typeof entry.length, 'number', 'the receipt records each file\'s length');
    const projectLog = entry.to;

    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'unchanged');

    // Old build appends; the new build appends to its own copy meanwhile.
    writeFileSync(legacyLog, '{"row":1}\n{"row":"old-2"}\n');
    writeFileSync(projectLog, readFileSync(projectLog, 'utf8') + '{"row":"new-1"}\n');
    let d = checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir });
    assert.equal(d.status, 'brought-in');
    assert.equal(d.appended.length, 1);
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'unchanged', 'a re-run is a no-op');

    // Old build again: another append, an edited draft, and a brand-new log.
    writeFileSync(legacyLog, '{"row":1}\n{"row":"old-2"}\n{"row":"old-3"}\n');
    writeFileSync(join(legacyDir, 'hot-section-draft.md'), 'edited by the old build\n');
    writeFileSync(join(legacyDir, 'sessions.jsonl'), '{"s":1}\n');
    writeFileSync(projectLog, readFileSync(projectLog, 'utf8') + '{"row":"new-2"}\n');
    d = checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir, now: new Date('2026-09-27T12:00:00Z') });
    assert.equal(d.status, 'brought-in');
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'unchanged', 'a re-run is a no-op');

    const lines = readFileSync(projectLog, 'utf8').trim().split('\n');
    for (const row of ['{"row":1}', '{"row":"old-2"}', '{"row":"old-3"}', '{"row":"new-1"}', '{"row":"new-2"}']) {
      assert.equal(lines.filter((l) => l === row).length, 1, `${row} appears exactly once`);
    }
    assert.equal(lines.length, 5);
    assert.equal(readFileSync(join(p, '.core', H, 'superseded', 'legacy-2026-09-27', 'legacy', 'hot-section-draft.md'), 'utf8'), 'edited by the old build\n');
    assert.equal(readFileSync(join(p, '.core', H, 'hot-section-draft.md'), 'utf8'), 'draft\n', 'the live copy of a non-log file is never overwritten');
    const newLog = JSON.parse(readFileSync(receiptFile, 'utf8')).files.find((f) => f.from === join(legacyDir, 'sessions.jsonl'));
    assert.equal(readFileSync(newLog.to, 'utf8'), '{"s":1}\n', 'a new log arrives whole');
  } finally { s.cleanup(); }
});

test('a manifest whose MAC breaks keeps its opt-out: capture stays off, before and after the next write', async () => {
  const { metricsEnabled } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'OptOut');
    registerProject(s.coreDir, p);
    const env = { CORE_HARNESS: 'claude-code' };
    updateManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir, fields: { metrics_enabled: false } });
    assert.equal(metricsEnabled({ project: p, env, home: s.home }), false);
    const file = join(p, '.core', 'claude-code', 'workspace.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"harness"', '"harness_x": 1, "harness"'));
    assert.equal(metricsEnabled({ project: p, env, home: s.home }), false, 'unverified manifest still opts out');
    updateManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir, fields: { agent_name: 'x' } });
    assert.equal(readManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir }).metrics_enabled, false, 'opt-out carried past the set-aside');
    assert.equal(metricsEnabled({ project: p, env, home: s.home }), false);
  } finally { s.cleanup(); }
});

test('a manifest whose MAC breaks keeps its turn-capture opt-out too, before and after the next write', async () => {
  const { turnCaptureEnabled } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'TurnOptOut');
    registerProject(s.coreDir, p);
    const env = { CORE_HARNESS: 'claude-code' };
    updateManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir, fields: { turn_capture: false } });
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), false);
    const file = join(p, '.core', 'claude-code', 'workspace.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"harness"', '"harness_x": 1, "harness"'));
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), false, 'unverified manifest still opts out');
    updateManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir, fields: { agent_name: 'x' } });
    assert.equal(readManifest({ root: p, harness: 'claude-code', coreDir: s.coreDir }).turn_capture, false, 'opt-out carried past the set-aside');
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), false);
  } finally { s.cleanup(); }
});

// ---------- migration holds: what a receipt may claim, and what half-copied state may do ----------

const RECEIPT_NAME = 'migrated-from.json';

test('a copy that fails part-way keeps every reader and writer out of the half-copied state until a later run finishes it', { skip: isWin || isRoot }, () => {
  const { s, p, table } = migrationFixture();
  const blocker = join(s.coreDir, 'workspaces', 'legacy', 'hot-section-draft.md');
  const inProject = join(p, '.core', H);
  try {
    chmodSync(blocker, 0o000);
    assert.throws(() => applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }), /EACCES|EPERM/);
    assert.ok(existsSync(join(inProject, '.migrating')), 'the marker stays behind');

    const read = stateDir({ root: p, harness: H, coreDir: s.coreDir });
    assert.ok(read === null || (read.status === 'migrating' && !read.dir.startsWith(inProject)), 'a reader is not pointed at the half-copied state');
    assert.equal(stateDir({ root: p, harness: H, coreDir: s.coreDir, forWrite: true }).status, 'migrating', 'a writer is diverted to this machine');
    const touched = touchProject(s.coreDir, { root: p, harness: H });
    assert.ok(!existsSync(join(inProject, 'last-active')), `a writer does not land in it either (${touched.root})`);

    chmodSync(blocker, 0o644);
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    assert.equal(existsSync(join(inProject, '.migrating')), false, 'the marker is gone once the receipt is written');
    assert.equal(stateDir({ root: p, harness: H, coreDir: s.coreDir }).status, 'verified');
  } finally { try { chmodSync(blocker, 0o644); } catch { /* gone */ } s.cleanup(); }
});

test('an unsigned receipt that says complete does not skip the copy or release the old state', () => {
  const { s, p, table } = migrationFixture();
  try {
    const dir = stateDir({ root: p, harness: H, coreDir: s.coreDir, forWrite: true }).dir;
    writeFileSync(join(dir, RECEIPT_NAME), JSON.stringify({ complete: true, files: [] }));
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'receipt-unverified');
    assert.match(r.problems[0], /not signed by this install/);
    assert.equal(existsSync(join(dir, 'capability-history.jsonl')), false, 'nothing was copied over the claim');
    assert.equal(existsSync(join(s.coreDir, 'workspaces', 'legacy', 'MOVED.md')), false, 'the old state was not released');
  } finally { s.cleanup(); }
});

test('a signed receipt whose listed file is gone is not trusted, and is not repaired over', () => {
  const { s, p, table } = migrationFixture();
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const receipt = JSON.parse(readFileSync(stateFile(p, RECEIPT_NAME), 'utf8'));
    const gone = receipt.files.find((f) => f.to.endsWith('hot-section-draft.md')).to;
    rmSync(gone);
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'receipt-unverified');
    assert.ok(r.problems.some((x) => x.startsWith('missing:') && x.endsWith('hot-section-draft.md')));
    assert.equal(existsSync(gone), false, 'the file is not silently re-copied');
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'receipt-unverified');
  } finally { s.cleanup(); }
});

test('a git-tracked receipt is not trusted', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    git(p, 'init', '-q');
    git(p, 'add', '-f', join('.core', H, RECEIPT_NAME));
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'receipt-unverified');
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'receipt-unverified');
  } finally { s.cleanup(); }
});

test('drift never appends to a destination outside the state, whether the receipt is forged or signed', () => {
  const { s, p, table } = migrationFixture();
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
    const outside = join(s.base, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    const before = sha(outside);
    const receipt = JSON.parse(readFileSync(stateFile(p, RECEIPT_NAME), 'utf8'));
    const forged = { ...receipt, files: receipt.files.map((f) => (f.from === legacyLog ? { ...f, to: outside } : f)) };
    const body = JSON.stringify(forged);

    writeFileSync(stateFile(p, RECEIPT_NAME), body);
    writeFileSync(legacyLog, '{"row":1}\n{"row":"old-2"}\n');
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'receipt-unverified');
    assert.equal(sha(outside), before, 'unsigned forgery: the outside file is byte-identical');

    writeSignedFile({ dir: join(p, '.core', H), name: RECEIPT_NAME, body, coreDir: s.coreDir });
    const d = checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir });
    assert.equal(d.status, 'receipt-unverified');
    assert.ok(d.problems.some((x) => x.startsWith('destination outside')));
    assert.equal(sha(outside), before, 'signed but out of bounds: the outside file is byte-identical');
  } finally { s.cleanup(); }
});

test('an unreadable legacy folder stops the migration: no receipt, no release, state fenced, and a later run completes it', { skip: isWin || isRoot }, () => {
  const { s, p, table } = migrationFixture();
  const legacy = join(s.coreDir, 'workspaces', 'legacy');
  const nested = join(legacy, 'metrics', 'classified');
  const inProject = join(p, '.core', H);
  try {
    chmodSync(nested, 0o000);
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'LEGACY_UNREADABLE');
    assert.ok(r.path.startsWith(nested));
    assert.equal(existsSync(join(inProject, RECEIPT_NAME)), false, 'no completion receipt');
    assert.ok(existsSync(join(inProject, '.migrating')), 'the marker stays');
    assert.equal(existsSync(join(legacy, 'MOVED.md')), false, 'the old state is not released');
    assert.equal(stateDir({ root: p, harness: H, coreDir: s.coreDir, forWrite: true }).status, 'migrating');

    chmodSync(nested, 0o755);
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const receipt = JSON.parse(readFileSync(join(inProject, RECEIPT_NAME), 'utf8'));
    assert.ok(receipt.files.some((f) => f.to.endsWith('2026-09-01.jsonl')), 'the once-unreadable log is in the receipt');
  } finally { try { chmodSync(nested, 0o755); } catch { /* gone */ } s.cleanup(); }
});

test('a symlink inside the legacy workspace is refused, and its target is never copied', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  const legacy = join(s.coreDir, 'workspaces', 'legacy');
  try {
    const outside = join(s.base, 'outside-secret.txt');
    writeFileSync(outside, 'not part of the workspace\n');
    symlinkSync(outside, join(legacy, 'linked-secret.txt'));
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'LEGACY_SYMLINK');
    assert.equal(existsSync(join(p, '.core', H, RECEIPT_NAME)), false);
    assert.equal(existsSync(join(legacy, 'MOVED.md')), false);
    const copied = [];
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else copied.push(f); } };
    walk(join(p, '.core'));
    assert.ok(!copied.some((f) => readFileSync(f, 'utf8') === 'not part of the workspace\n'), 'the outside bytes are nowhere in the project state');
  } finally { s.cleanup(); }
});

test('drift refuses to run over a legacy symlink or unreadable folder and leaves the copies and the receipt as they were', { skip: isWin || isRoot }, () => {
  const { s, p, table } = migrationFixture();
  const legacy = join(s.coreDir, 'workspaces', 'legacy');
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const receiptFile = join(p, '.core', H, RECEIPT_NAME);
    const receiptBefore = sha(receiptFile);
    const legacyLog = join(legacy, 'capability-history.jsonl');
    const projectLog = JSON.parse(readFileSync(receiptFile, 'utf8')).files.find((f) => f.from === legacyLog).to;
    const logBefore = sha(projectLog);
    writeFileSync(legacyLog, '{"row":1}\n{"row":"old-2"}\n');
    symlinkSync(join(s.base, 'nowhere'), join(legacy, 'dangling'));
    const d = checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir });
    assert.equal(d.status, 'legacy-held');
    assert.equal(sha(receiptFile), receiptBefore, 'the receipt is untouched');
    assert.equal(sha(projectLog), logBefore, 'nothing was appended before the walk failed');
  } finally { s.cleanup(); }
});

test('drift after an interrupted run never appends the same tail twice, whether the append landed or not', () => {
  const { s, p, table } = migrationFixture();
  try {
    const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const receiptFile = stateFile(p, RECEIPT_NAME);
    const before = JSON.parse(readFileSync(receiptFile, 'utf8'));
    const entry = before.files.find((f) => f.from === legacyLog);
    const original = readFileSync(entry.to, 'utf8');
    const tail = '{"row":"old-2"}\n';
    writeFileSync(legacyLog, original + tail);

    // The state a run that stopped after writing its intent leaves behind.
    const interrupted = () => writeSignedFile({ dir: join(p, '.core', H), name: RECEIPT_NAME, coreDir: s.coreDir, body: JSON.stringify({
      ...before, files: before.files.map((f) => (f.from === legacyLog ? {
        ...f, pending: { from_offset: entry.length, from_length: (original + tail).length, to_offset: original.length, tail_sha: createHash('sha256').update(tail).digest('hex') },
      } : f)),
    }) });

    interrupted(); // the tail reached the project's copy, the receipt was never finished
    writeFileSync(entry.to, original + tail);
    checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir });
    assert.equal(readFileSync(entry.to, 'utf8'), original + tail, 'landed append is not repeated');
    assert.equal(checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir }).status, 'unchanged');

    interrupted(); // stopped before the append landed
    writeFileSync(entry.to, original);
    checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir });
    assert.equal(readFileSync(entry.to, 'utf8'), original + tail, 'an append that never landed happens once');
  } finally { s.cleanup(); }
});

test('a synced project\'s hot state lives in the project and is fenced by the migration marker like any project', () => {
  const s = sandbox();
  try {
    const p = s.mk('Dropbox', 'Projects', 'Synced');
    registerProject(s.coreDir, p);
    const dir = stateDir({ root: p, harness: H, coreDir: s.coreDir, forWrite: true }).dir;
    writeFileSync(join(dir, '.migrating'), 'x\n');
    assert.equal(stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir }), null, 'a reader sees nothing');
    const w = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true });
    assert.equal(w.status, 'migrating');
    rmSync(join(dir, '.migrating'));
    const after = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true });
    assert.notEqual(after.status, 'migrating');
    assert.equal(after.location, 'project', 'once the migration is done, a synced project\'s hot state is in the project');
  } finally { s.cleanup(); }
});

test('the migration CLI exits 3 with its JSON when it could not finish, so startup cannot mistake it for a clean run', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  try {
    symlinkSync(join(s.base, 'nowhere'), join(s.coreDir, 'workspaces', 'legacy', 'dangling'));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify(table));
    const r = spawnSync(process.execPath, [join(SCRIPTS, 'migrate-workspace-state.mjs'), '--apply', '--root', p, '--harness', H, '--core-dir', s.coreDir], { encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.equal(JSON.parse(r.stdout).status, 'legacy-held');
  } finally { s.cleanup(); }
});

test('index-registry path names a file in the project\'s state the way stateDir does, and refuses names that leave it', () => {
  const s = sandbox();
  try {
    const p = signedProject(s);
    const run = (...a) => spawnSync(process.execPath, [REGISTRY_CLI, 'path', '--root', p, '--harness', H, '--core-dir', s.coreDir, ...a], { encoding: 'utf8' });
    const hot = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true }).dir;
    const r = run('--kind', 'hot', '--name', 'capability-state.json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), join(hot, 'capability-state.json'));
    assert.notEqual(run('--kind', 'hot', '--name', '../escape').status, 0);
    assert.notEqual(run('--kind', 'nope').status, 0);
  } finally { s.cleanup(); }
});

test('an index.json entry the migration marked migrated no longer registers its old path', () => {
  const s = sandbox();
  try {
    const live = s.mk('Projects', 'Live');
    const moved = s.mk('Projects', 'OldPlace');
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      { workspace_id: 'live', path: live },
      { workspace_id: 'moved', path: moved, migrated: true, migrated_at: '2026-09-28T00:00:00Z' },
    ]));
    const roots = readRegisteredRoots({ coreDir: s.coreDir });
    assert.ok(roots.has(realpathSync(live)), 'an unmigrated legacy entry still registers');
    assert.ok(!roots.has(realpathSync(moved)), 'a migrated one does not authorize the old path');
  } finally { s.cleanup(); }
});

test('two synced projects whose names differ only by . versus - keep separate local state and metrics pins', () => {
  const s = sandbox();
  try {
    const a = s.mk('Dropbox', 'Projects', 'a.b');
    const b = s.mk('Dropbox', 'Projects', 'a-b');
    registerProject(s.coreDir, a);
    registerProject(s.coreDir, b);
    const hotA = stateDir({ root: a, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true }).dir;
    const hotB = stateDir({ root: b, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true }).dir;
    assert.notEqual(hotA, hotB);
    const dirA = operationalMetricsDir(a, { home: s.home, env: { CORE_HARNESS: H } });
    const dirB = operationalMetricsDir(b, { home: s.home, env: { CORE_HARNESS: H } });
    assert.notEqual(dirA, dirB);
    writeFileSync(join(dirA, 'storage-path.txt'), join(a, '_metrics'));
    assert.notEqual(existsSync(join(dirB, 'storage-path.txt')), true, "B does not inherit A's pin");
  } finally { s.cleanup(); }
});

test('a project-root turn_capture:false still turns capture off when the signed manifest has no such value', async () => {
  const { turnCaptureEnabled } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const s = sandbox();
  try {
    const p = signedProject(s);
    const env = { CORE_HARNESS: H };
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), true, 'default is on');
    writeFileSync(join(p, 'workspace.json'), JSON.stringify({ turn_capture: false }));
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), false);
    writeFileSync(join(p, 'workspace.json'), JSON.stringify({ turn_capture: true }));
    assert.equal(turnCaptureEnabled({ project: p, env, home: s.home }), true, 'the root file can only switch it off');
  } finally { s.cleanup(); }
});

test('a workspace an older install registers after the receipt is copied as a kept duplicate before anything is marked or released', () => {
  const { s, p, table } = migrationFixture();
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    // An older build registers a second workspace for the same folder.
    const late = legacyWorkspace(s, 'legacy-late', { path: p, files: { 'workspace.json': JSON.stringify({ workspace_id: 'legacy-late' }), 'notes-late.md': 'written after migration\n' } });
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([...index, late]));
    const table2 = { ...table, entries: { ...table.entries, 'legacy-late': { harness: H, evidence: 'fixture' } } };

    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table: table2 });
    assert.equal(r.status, 'already-migrated');
    const copied = join(p, '.core', H, 'superseded', 'legacy-late', 'notes-late.md');
    assert.equal(readFileSync(copied, 'utf8'), 'written after migration\n', 'the late data is in the project');
    const receipt = JSON.parse(readFileSync(stateFile(p, RECEIPT_NAME), 'utf8'));
    assert.ok(receipt.superseded.includes('legacy-late'));
    assert.ok(receipt.files.some((f) => f.to === copied), 'the receipt lists it');
    assert.equal(existsSync(join(p, '.core', H, '.migrating')), false);
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table: table2 }).files, 0, 'a further run copies nothing');
  } finally { s.cleanup(); }
});

function interruptedAppend(s, p, table, { toAfter, sourceAfter }) {
  const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
  assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
  const before = JSON.parse(readFileSync(stateFile(p, RECEIPT_NAME), 'utf8'));
  const entry = before.files.find((f) => f.from === legacyLog);
  const original = readFileSync(entry.to, 'utf8');
  const tail = '{"row":"old-2"}\n';
  writeFileSync(legacyLog, original + tail + (sourceAfter || ''));
  writeSignedFile({ dir: join(p, '.core', H), name: RECEIPT_NAME, coreDir: s.coreDir, body: JSON.stringify({
    ...before, files: before.files.map((f) => (f.from === legacyLog ? { ...f, pending: {
      from_offset: entry.length, from_length: (original + tail).length, to_offset: original.length, tail_sha: createHash('sha256').update(tail).digest('hex'),
    } } : f)),
  }) });
  writeFileSync(entry.to, toAfter(original, tail));
  return { legacyLog, entry, original, tail };
}

test('a half-written append is completed once, and a source that grew before the retry adds only its new lines', () => {
  const half = migrationFixture();
  try {
    const { entry, original, tail } = interruptedAppend(half.s, half.p, half.table, { toAfter: (o, t) => o + t.slice(0, 5) });
    checkLegacyDrift({ root: half.p, harness: H, coreDir: half.s.coreDir });
    assert.equal(readFileSync(entry.to, 'utf8'), original + tail, 'the partial tail is replaced by the whole one');
  } finally { half.s.cleanup(); }
  const grown = migrationFixture();
  try {
    const more = '{"row":"old-3"}\n';
    const { entry, original, tail } = interruptedAppend(grown.s, grown.p, grown.table, { toAfter: (o, t) => o + t, sourceAfter: more });
    checkLegacyDrift({ root: grown.p, harness: H, coreDir: grown.s.coreDir });
    assert.equal(readFileSync(entry.to, 'utf8'), original + tail + more, 'the recorded tail is not repeated and the new line arrives once');
  } finally { grown.s.cleanup(); }
});

test('an interrupted append whose destination holds something else is left alone and the legacy bytes are kept aside', () => {
  const { s, p, table } = migrationFixture();
  try {
    const { legacyLog, entry, original } = interruptedAppend(s, p, table, { toAfter: (o) => o + '{"row":"written by the new build"}\n' });
    const d = checkLegacyDrift({ root: p, harness: H, coreDir: s.coreDir, now: new Date('2026-09-28T12:00:00Z') });
    assert.equal(readFileSync(entry.to, 'utf8'), original + '{"row":"written by the new build"}\n', 'the project copy is untouched');
    assert.ok(d.superseded.some((x) => x.from === legacyLog && x.reason === 'unresolved-pending-append'));
  } finally { s.cleanup(); }
});

test('migration signs a carried metrics pin only when it names a place metrics may live', () => {
  for (const [label, target, expectSigned] of [['AppData', 'APPDATA', true], ['elsewhere', 'OUTSIDE', false]]) {
    const { s, p, table } = migrationFixture();
    try {
      const pinned = target === 'APPDATA' ? join(s.home, 'AppData', 'Local', 'core-metrics', 'old-workspace-id') : join(s.base, 'somewhere-else');
      mkdirSync(pinned, { recursive: true });
      writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), pinned);
      assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
      const hot = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir }).dir;
      assert.equal(existsSync(join(hot, 'metrics', 'storage-path.txt.mac')), expectSigned, label);
    } finally { s.cleanup(); }
  }
});

test('a marker write failure during migration blocks completion, not just an immediate read: no receipt, no release, state fenced, and a later run completes it', () => {
  const { s, p, table } = migrationFixture();
  const inProject = join(p, '.core', H);
  try {
    const pinned = join(s.home, 'AppData', 'Local', 'core-metrics', 'old-workspace-id');
    mkdirSync(pinned, { recursive: true });
    writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), pinned);
    // Obstruct the marker's target file before migration runs: a directory in its place makes the
    // marker's atomic rename onto it fail (EISDIR on POSIX, EPERM on NTFS — the assertions below
    // check status/code, not the platform-specific error). Leaving the pin signed with no marker
    // (an earlier, insufficient fix) only protects the very next read — a LATER total pin loss falls
    // through to "never redirected" and reads clean, since no marker was ever actually persisted to
    // catch it. So the migration does not complete at all: same class of failure as an unreadable
    // legacy folder or a symlink, elsewhere in this function.
    const durable = stateDir({ root: p, harness: H, coreDir: s.coreDir, forWrite: true }).dir;
    mkdirSync(join(durable, 'metrics-ever-external.txt'), { recursive: true });
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'METRICS_MARKER_UNPERSISTED');
    assert.equal(existsSync(join(inProject, RECEIPT_NAME)), false, 'no completion receipt');
    assert.ok(existsSync(join(inProject, '.migrating')), 'the marker stays');
    assert.equal(existsSync(join(s.coreDir, 'workspaces', 'legacy', 'MOVED.md')), false, 'the old state is not released');

    rmSync(join(durable, 'metrics-ever-external.txt'), { recursive: true, force: true });
    const retried = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(retried.status, 'migrated', 'a later run, once the obstruction is cleared, completes normally');
    const hot = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir }).dir;
    assert.equal(existsSync(join(hot, 'metrics', 'storage-path.txt.mac')), true, 'the pin is signed on the completed run');
  } finally { s.cleanup(); }
});

test('migration does not sign a carried metrics pin when another project already names the same folder', () => {
  const { s, p, table } = migrationFixture();
  try {
    const other = s.mk('Projects', 'OtherProject');
    registerProject(s.coreDir, other);
    const shared = join(s.home, 'AppData', 'Local', 'core-metrics', 'shared-old');
    mkdirSync(shared, { recursive: true });
    const otherHot = stateDir({ root: other, harness: H, kind: 'hot', coreDir: s.coreDir, forWrite: true }).dir;
    mkdirSync(join(otherHot, 'metrics'), { recursive: true });
    writePinSigned({ dir: join(otherHot, 'metrics'), path: shared, root: other, coreDir: s.coreDir });
    writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), shared);
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    const hot = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir }).dir;
    assert.equal(existsSync(join(hot, 'metrics', 'storage-path.txt.mac')), false, 'left unsigned, so the reader ignores it');
  } finally { s.cleanup(); }
});

test('migration signs a carried metrics pin for neither project when a not-yet-migrated peer names the same folder', () => {
  const { s, p, table } = migrationFixture();
  try {
    const peerPath = s.mk('Projects', 'PeerProject');
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    index.push(legacyWorkspace(s, 'peer', { path: peerPath, files: { 'workspace.json': JSON.stringify({ workspace_id: 'peer' }) } }));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index));
    const table2 = { ...table, entries: { ...table.entries, peer: { harness: H, evidence: 'fixture' } } };
    const shared = join(s.home, 'AppData', 'Local', 'core-metrics', 'shared-old');
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(s.coreDir, 'workspaces', 'peer', 'metrics'), { recursive: true });
    writeFileSync(join(s.coreDir, 'workspaces', 'peer', 'metrics', 'storage-path.txt'), shared);
    writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), shared);
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table: table2 }).status, 'migrated');
    const hot = stateDir({ root: p, harness: H, kind: 'hot', coreDir: s.coreDir }).dir;
    assert.equal(existsSync(join(hot, 'metrics', 'storage-path.txt.mac')), false, 'first to migrate does not take the folder');
  } finally { s.cleanup(); }
});

test('an ambiguous legacy metrics folder is recorded by the migration as history and never routed to, claimed or not', async () => {
  const { initMetrics } = await import('../../plugins/core/skills/core/scripts/metrics-init.mjs');
  const { metricsHistoryFolders } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const { s, p, table } = migrationFixture();
  const savedHome = process.env.HOME;
  try {
    const peerPath = s.mk('Projects', 'PeerProject');
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    index.push(legacyWorkspace(s, 'peer', { path: peerPath, files: { 'workspace.json': JSON.stringify({ workspace_id: 'peer' }) } }));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index));
    const table2 = { ...table, entries: { ...table.entries, peer: { harness: H, evidence: 'fixture' } } };
    const shared = join(s.home, 'AppData', 'Local', 'core-metrics', 'shared-old');
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(s.coreDir, 'workspaces', 'peer', 'metrics'), { recursive: true });
    writeFileSync(join(s.coreDir, 'workspaces', 'peer', 'metrics', 'storage-path.txt'), shared);
    writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), shared);

    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table: table2 });
    assert.equal(r.metrics_held.folder, shared, 'the migration says which folder it held');
    assert.equal(r.metrics_held.also_named_by.length, 1);

    process.env.HOME = s.home;
    const opts = { home: s.home, env: { CORE_HARNESS: H } };
    const init = initMetrics({ projectDir: p, ...opts });
    assert.equal(init.storagePath, join(p, '_metrics'), 'writes go to the project');
    assert.deepEqual(metricsHistoryFolders(p, opts).map((h) => h.folder), [shared], 'named as history');
    writeFileSync(join(shared, '.project-root'), p + '\n');
    assert.equal(initMetrics({ projectDir: p, ...opts }).storagePath, join(p, '_metrics'), 'claiming the folder does not route writes to it');
    assert.deepEqual(metricsHistoryFolders(p, opts).map((h) => h.folder), [shared], 'still history, never a route');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    s.cleanup();
  }
});

// The split-log defect: a Windows OneDrive project whose legacy pin names AppData wrote its
// captured turns to the project before the first /core (hooks new, state not migrated), then to
// AppData after the migration carried the pin over. Both upgrade windows must write to the project,
// and the notice must name AppData as history in the second window.
test('a legacy AppData pin routes no writes in either upgrade window, and the notice matches where rows are written', async () => {
  const { initMetrics } = await import('../../plugins/core/skills/core/scripts/metrics-init.mjs');
  const { captureTurnEvidence, turnCaptureStats } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const { noticeTextFor } = await import('../../plugins/core/skills/core/scripts/metrics-disclosure.mjs');
  const { s, p, table } = migrationFixture();
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = s.home;
    process.env.USERPROFILE = s.home;
    const env = { CORE_HARNESS: H };
    const old = join(s.home, 'AppData', 'Local', 'core-metrics', 'legacy-id');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(s.coreDir, 'workspaces', 'legacy', 'metrics', 'storage-path.txt'), old);
    writeFileSync(join(p, 'workspace.json'), JSON.stringify({ workspace_id: 'legacy' }));
    const row = (text) => captureTurnEvidence(p, { prompt_text: text }, { env });
    const projectRows = () => turnCaptureStats(p, { env }).rows;
    const appDataRows = () => existsSync(join(old, 'turn-capture')) ? readdirSync(join(old, 'turn-capture')).length : 0;

    // Window 1: new hooks, legacy state not migrated.
    assert.equal(row('one').written, true);
    assert.equal(projectRows(), 1);
    assert.equal(appDataRows(), 0);
    assert.ok(noticeTextFor(p, { home: s.home, env }).includes(old), 'the unmigrated legacy pin is read as data, so the notice already names AppData as history');

    // Window 2: after the migration carries the pin over, and after a scaffold.
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    assert.equal(initMetrics({ projectDir: p, home: s.home, env }).ok, true);
    assert.equal(row('two').written, true);
    assert.equal(projectRows(), 2, 'both rows are in the project, in one piece');
    assert.equal(appDataRows(), 0, 'nothing went back to AppData');
    assert.ok(noticeTextFor(p, { home: s.home, env }).includes(old), 'the notice names AppData as where earlier rows are kept');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    s.cleanup();
  }
});

test('a legacy registry entry that spells its folder project_path is still seen by the migrator and the registered-root check', () => {
  const { s, p, table } = migrationFixture();
  try {
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index.map((e) => {
      if (e.workspace_id !== 'legacy') return e;
      const { path, ...rest } = e; // the same entry, older spelling
      // The shape found on a real machine: schema v2, forward slashes, no `path`.
      return { schema_version: 'v2', workspace_id: rest.workspace_id, name: rest.name, project_path: path.replace(/\\/g, '/'), last_active: '2026-07-20T00:00:00Z' };
    })));
    const roots = readRegisteredRoots({ coreDir: s.coreDir });
    assert.ok(roots.has(realpathSync(p)), 'the registered-root check reads project_path');
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'migrated', 'the migrator resolves the entry instead of calling it orphan-gone');
    assert.equal(r.live, 'legacy');
  } finally { s.cleanup(); }
});

test('registryEntryPath prefers path, falls back to project_path, and answers null for neither', () => {
  assert.equal(registryEntryPath({ path: '/a', project_path: '/b' }), '/a');
  assert.equal(registryEntryPath({ project_path: 'C:/Users/x/proj' }), 'C:/Users/x/proj');
  assert.equal(registryEntryPath({ workspace_id: 'w' }), null);
  assert.equal(registryEntryPath(null), null);
});

// A finished migration is recorded in the project; later startups read the record without any
// lock, so one project's startup never waits behind another's on the shared manifest or registry.
test('after a full migration, a startup returns from the project record without taking the close, manifest or registry lock', async () => {
  const { s, p, table } = migrationFixture();
  const { acquireFileLock, releaseFileLock } = await import('../../plugins/core/skills/core/scripts/file-lock.mjs');
  try {
    assert.equal(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table }).status, 'migrated');
    const held = [join(p, '_memories', '_close.lock'), join(s.coreDir, 'migration-manifest.lock'), join(s.coreDir, 'index.lock')]
      .map((f) => ({ f, l: acquireFileLock(f) }));
    try {
      assert.ok(held.every((h) => h.l.ok));
      const t0 = Date.now();
      const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
      assert.deepEqual([r.status, r.fast, r.live], ['already-migrated', true, 'legacy']);
      assert.ok(Date.now() - t0 < 2000, 'no wait on a held lock');
    } finally { for (const h of held) releaseFileLock(h.f, h.l.nonce); }
  } finally { s.cleanup(); }
});

test('a project with nothing to migrate is recorded too, and its next startup is lock-free', async () => {
  const s = sandbox();
  const { acquireFileLock, releaseFileLock } = await import('../../plugins/core/skills/core/scripts/file-lock.mjs');
  try {
    const p = s.mk('Projects', 'Fresh');
    writeFileSync(join(s.coreDir, 'index.json'), '[]');
    assert.equal(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir }).status, 'nothing-to-migrate');
    const m = join(s.coreDir, 'migration-manifest.lock'); const l = acquireFileLock(m);
    try { assert.deepEqual((({ status, fast }) => [status, fast])(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir })), ['nothing-to-migrate', true]); }
    finally { releaseFileLock(m, l.nonce); }
  } finally { s.cleanup(); }
});

test('the record is not used when anything that could give the migration new work changed', () => {
  const { s, p, table } = migrationFixture();
  try {
    applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    const again = () => applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(again().fast, true);
    // a legacy workspace registered later for this path: the full path runs and copies it
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    // (its harness comes from its own workspace.json, so only the registry changed, not the table)
    index.push(legacyWorkspace(s, 'legacy-late', { path: p, files: { 'workspace.json': JSON.stringify({ workspace_id: 'legacy-late', harness: 'claude-code' }), 'late.md': 'late\n' } }));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index, null, 2));
    const late = again();
    assert.equal(late.fast, undefined);
    assert.ok(existsSync(join(p, '.core', 'claude-code', 'superseded', 'legacy-late', 'late.md')), 'the late workspace is copied');
    assert.equal(again().fast, true, 'and the refreshed record is used after');
    // a changed classification table
    table.entries.extra = { harness: 'codex', evidence: 'fixture' };
    assert.equal(again().fast, undefined);
    // a record CORE did not sign
    const rec = join(p, '.core', 'claude-code', 'migration-check.json');
    writeFileSync(rec, readFileSync(rec, 'utf8').replace('"already-migrated"', '"nothing-to-migrate"'));
    assert.equal(again().fast, undefined);
    // an interrupted migration's marker
    again();
    writeFileSync(join(p, '.core', 'claude-code', '.migrating'), 'x\n');
    assert.equal(again().fast, undefined);
  } finally { s.cleanup(); }
});

// The record certifies only what the pass actually classified (Lantern's three counterexamples).
const lateWorkspace = (s, p, harness = 'claude-code') => {
  const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
  index.push(legacyWorkspace(s, 'legacy-late', { path: p, files: { 'workspace.json': JSON.stringify({ workspace_id: 'legacy-late', harness }), 'late.md': 'late\n' } }));
  writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify(index, null, 2));
};

test('a registration that lands after the pass but before its record is never stamped as covered', () => {
  const { s, p, table } = migrationFixture();
  try {
    applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table, beforeRecord: () => lateWorkspace(s, p) });
    const next = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.equal(next.fast, undefined, 'the record names the bytes the pass read, not the later ones');
    assert.ok(existsSync(join(p, '.core', 'claude-code', 'superseded', 'legacy-late', 'late.md')), 'the late workspace is copied');
  } finally { s.cleanup(); }
});

test("a legacy workspace whose own manifest changes its harness invalidates the record, registry and table unchanged", () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Flip');
    const ws = legacyWorkspace(s, 'flip', { path: p, files: { 'workspace.json': JSON.stringify({ workspace_id: 'flip', harness: 'codex' }), 'notes.md': 'evidence\n' } });
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([ws], null, 2));
    assert.equal(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir }).status, 'nothing-to-migrate');
    writeFileSync(join(s.coreDir, 'workspaces', 'flip', 'workspace.json'), JSON.stringify({ workspace_id: 'flip', harness: 'claude-code' }));
    const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    assert.deepEqual([r.status, r.fast], ['migrated', undefined]);
  } finally { s.cleanup(); }
});

test('a registry that could not be read while classifying is never recorded as nothing to migrate', { skip: isWin || isRoot }, () => {
  const { s, p, table } = migrationFixture();
  const index = join(s.coreDir, 'index.json');
  try {
    chmodSync(index, 0o000);   // unreadable while classifying, readable again before the record is written
    try { assert.equal(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table, beforeRecord: () => chmodSync(index, 0o644) }).status, 'nothing-to-migrate'); }
    finally { chmodSync(index, 0o644); }
    const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir, table });
    assert.deepEqual([r.status, r.fast], ['migrated', undefined], 'the evidence is migrated once the registry reads');
  } finally { s.cleanup(); }
});

test('a legacy manifest that changes between being classified and being fingerprinted is never recorded as covered', async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const s = sandbox();
  const orig = fs.readFileSync;
  try {
    const p = s.mk('Projects', 'Race');
    const ws = legacyWorkspace(s, 'race', { path: p, files: { 'workspace.json': JSON.stringify({ workspace_id: 'race', harness: 'codex' }), 'notes.md': 'evidence\n' } });
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([ws], null, 2));
    const target = join(s.coreDir, 'workspaces', 'race', 'workspace.json');
    let flipped = false;
    // The first read of the manifest returns the codex bytes, then a writer flips it on disk.
    fs.readFileSync = function (file, ...rest) {
      const out = orig.call(this, file, ...rest);
      if (!flipped && String(file) === target) { flipped = true; fs.writeFileSync(target, JSON.stringify({ workspace_id: 'race', harness: 'claude-code' })); }
      return out;
    };
    syncBuiltinESMExports();
    try { assert.equal(applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir }).status, 'nothing-to-migrate'); }
    finally { fs.readFileSync = orig; syncBuiltinESMExports(); }
    assert.ok(flipped);
    const r = applyMigration({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    assert.deepEqual([r.status, r.fast], ['migrated', undefined], 'the record named the classified codex bytes, so the flip invalidates it');
  } finally { fs.readFileSync = orig; syncBuiltinESMExports(); s.cleanup(); }
});

// ---------- the legacy source folders themselves must be real folders ----------

const treeOf = (dir) => { const o = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (e.isDirectory()) { o[pre + e.name + '/'] = 'dir'; walk(join(d, e.name), pre + e.name + '/'); } else if (e.isFile()) o[pre + e.name] = readFileSync(join(d, e.name), 'utf8'); else o[pre + e.name] = 'other'; } }; walk(dir, ''); return o; };

test('a legacy workspace folder that is a link is held: nothing is copied into the project and nothing is written where the link leads', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  const legacy = join(s.coreDir, 'workspaces', 'legacy');
  const foreign = join(s.coreDir, '..', 'foreign-legacy');
  try {
    renameSync(legacy, foreign);            // the real content now lives somewhere else…
    symlinkSync(foreign, legacy);           // …and the legacy name is only a link to it
    const before = treeOf(foreign);
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'LEGACY_SYMLINK');
    assert.equal(r.path, legacy);
    assert.deepEqual(treeOf(foreign), before, 'no MOVED note or anything else was written there');
    assert.equal(existsSync(join(p, '.core', H, RECEIPT_NAME)), false, 'no completion receipt');
    assert.equal(existsSync(join(p, '.core', H, '.migrating')), false, 'refused before the marker: the project is as it was');
  } finally { s.cleanup(); }
});

test('a legacy workspaces folder that is itself a link is held before it is listed', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  const ws = join(s.coreDir, 'workspaces');
  const foreign = join(s.coreDir, '..', 'foreign-workspaces');
  try {
    renameSync(ws, foreign);
    symlinkSync(foreign, ws);
    const before = treeOf(foreign);
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'LEGACY_SYMLINK');
    assert.equal(r.path, ws);
    assert.deepEqual(treeOf(foreign), before);
    assert.equal(existsSync(join(p, '.core', H, RECEIPT_NAME)), false);
  } finally { s.cleanup(); }
});

test('a late-registered workspace that is a link is held: the earlier receipt is unchanged, nothing is copied, and nothing is written where the link leads', { skip: isWin }, () => {
  const { s, p, table } = migrationFixture();
  const foreign = join(s.coreDir, '..', 'foreign-late');
  try {
    assert.equal(applyMigration({ root: p, harness: H, coreDir: s.coreDir, table }).status, 'migrated');
    mkdirSync(foreign); writeFileSync(join(foreign, 'workspace.json'), JSON.stringify({ workspace_id: 'legacy-late' })); writeFileSync(join(foreign, 'notes-late.md'), 'FOREIGN\n'); writeFileSync(join(foreign, 'last-active'), '2026-10-01T00:00:00Z\n');
    symlinkSync(foreign, join(s.coreDir, 'workspaces', 'legacy-late'));
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([...index, { workspace_id: 'legacy-late', name: 'legacy-late', path: p }]));
    const table2 = { ...table, entries: { ...table.entries, 'legacy-late': { harness: H, evidence: 'fixture' } } };
    const receiptBefore = readFileSync(stateFile(p, RECEIPT_NAME), 'utf8');
    const before = treeOf(foreign);
    const r = applyMigration({ root: p, harness: H, coreDir: s.coreDir, table: table2 });
    assert.equal(r.status, 'legacy-held');
    assert.equal(r.code, 'LEGACY_SYMLINK');
    assert.deepEqual(treeOf(foreign), before, 'no MOVED note, nothing else');
    assert.equal(readFileSync(stateFile(p, RECEIPT_NAME), 'utf8'), receiptBefore, 'the earlier receipt is byte-identical');
    assert.equal(existsSync(join(p, '.core', H, 'superseded', 'legacy-late')), false, 'nothing foreign was copied in');
    assert.equal(existsSync(join(p, '.core', H, '.migrating')), false, 'refused before the marker');
  } finally { s.cleanup(); }
});

test('a registered workspace name that is a link is never read through while the migration plan is built', { skip: isWin }, async () => {
  const { buildManifest } = await import('../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs');
  const { s, p, table } = migrationFixture();
  const foreign = join(s.coreDir, '..', 'foreign-plan');
  try {
    mkdirSync(foreign); writeFileSync(join(foreign, 'last-active'), '2031-01-01T00:00:00Z\n'); writeFileSync(join(foreign, 'workspace.json'), JSON.stringify({ workspace_id: 'linked', agent_name: 'Foreign' }));
    symlinkSync(foreign, join(s.coreDir, 'workspaces', 'linked'));
    const index = JSON.parse(readFileSync(join(s.coreDir, 'index.json'), 'utf8'));
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([...index, { workspace_id: 'linked', name: 'linked', path: p, last_active: '2026-02-02T00:00:00Z' }]));
    const m = buildManifest({ coreDir: s.coreDir, table });
    const text = JSON.stringify(m);
    assert.doesNotMatch(text, /Foreign/, "the linked workspace's manifest was not read");
    assert.doesNotMatch(text, /2031-01-01/, 'nor its last-active stamp');
  } finally { s.cleanup(); }
});
