import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync,
  cpSync, readdirSync, statSync, chmodSync, existsSync, realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  resolveProjectRoot, classifyRegistration, projectStateDir, ensureStateDir,
  writeStamp, classifyStamp, ensureInstallIdentity, stampHmac, assertHarnessName,
} from '../../plugins/core/skills/core/scripts/project-state.mjs';
// A junction needs no privilege on Windows, and it is what an unprivileged process can plant there.
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';

const isWin = process.platform === 'win32';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

function sandbox() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'pstate-')));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  return { base, home, coreDir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function register(coreDir, paths) {
  writeFileSync(join(coreDir, 'projects.json'), JSON.stringify(paths.map((p) => ({ path: p, last_seen: '2026-09-26T00:00:00Z' }))));
}

function mk(...parts) { const p = join(...parts); mkdirSync(p, { recursive: true }); return p; }

/** Every file under dir with its hash, for byte-identical before/after checks. */
function snapshot(dir, skip = () => false) {
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (skip(p)) continue;
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else out[p] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

// ---------- root resolution (spec test 1) ----------

test('home-repo root: projects under a git-repo $HOME resolve to themselves, never to $HOME', () => {
  const s = sandbox();
  try {
    mk(s.home, '.git');
    const a = mk(s.home, 'Projects', 'A');
    const b = mk(s.home, 'Projects', 'B');
    register(s.coreDir, [a, b]);
    const opts = { home: s.home, coreDir: s.coreDir };
    assert.equal(resolveProjectRoot(a, opts).root, a);
    assert.equal(resolveProjectRoot(b, opts).root, b);
    assert.equal(resolveProjectRoot(mk(a, 'deep', 'er'), opts).root, a);
    const unregistered = resolveProjectRoot(mk(s.home, 'Projects', 'C'), opts);
    assert.equal(unregistered.root, null);
    assert.equal(unregistered.reason, 'home');
  } finally { s.cleanup(); }
});

test('a stray same-name subfolder (the CORE/CORE case) resolves to the registered parent', () => {
  const s = sandbox();
  try {
    const core = mk(s.home, 'Projects', 'CORE');
    register(s.coreDir, [core]);
    const stray = mk(core, 'CORE');
    mk(stray, '_memories');
    assert.equal(resolveProjectRoot(stray, { home: s.home, coreDir: s.coreDir }).root, core);
  } finally { s.cleanup(); }
});

test('the walk stops at a .git boundary: worktrees and nested clones do not inherit the parent', () => {
  const s = sandbox();
  try {
    const p = mk(s.home, 'Projects', 'P');
    register(s.coreDir, [p]);
    const wt = mk(p, '.claude', 'worktrees', 'w1');
    writeFileSync(join(wt, '.git'), 'gitdir: ../../../.git/worktrees/w1\n');
    const vendored = mk(p, 'vendor', 'lib');
    mk(vendored, '.git');
    const opts = { home: s.home, coreDir: s.coreDir };
    const r1 = resolveProjectRoot(mk(wt, 'src'), opts);
    assert.equal(r1.root, null);
    assert.equal(r1.reason, 'git-boundary');
    assert.equal(resolveProjectRoot(vendored, opts).root, null);
  } finally { s.cleanup(); }
});

test('a registered folder that is itself a repo root resolves to itself', () => {
  const s = sandbox();
  try {
    const r = mk(s.home, 'Projects', 'Repo');
    mk(r, '.git');
    register(s.coreDir, [r]);
    assert.equal(resolveProjectRoot(mk(r, 'a'), { home: s.home, coreDir: s.coreDir }).root, r);
  } finally { s.cleanup(); }
});

test('legacy index.json paths still resolve while projects.json is absent', () => {
  const s = sandbox();
  try {
    const p = mk(s.home, 'Projects', 'Old');
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([{ workspace_id: 'old', path: p }]));
    assert.equal(resolveProjectRoot(p, { home: s.home, coreDir: s.coreDir }).root, p);
  } finally { s.cleanup(); }
});

test('registration: refuse $HOME, ~/.core, and a folder containing a registered project; ask inside one; new otherwise', () => {
  const s = sandbox();
  try {
    const a = mk(s.home, 'Projects', 'A');
    register(s.coreDir, [a]);
    const opts = { home: s.home, coreDir: s.coreDir };
    assert.deepEqual(classifyRegistration(s.home, opts), { action: 'refuse', reason: 'home' });
    assert.equal(classifyRegistration(mk(s.coreDir, 'x'), opts).reason, 'core-dir');
    const parent = classifyRegistration(join(s.home, 'Projects'), opts);
    assert.equal(parent.action, 'refuse');
    assert.equal(parent.reason, 'contains-registered');
    assert.deepEqual(parent.contains, [a]);
    assert.equal(classifyRegistration(a, opts).action, 'registered');
    assert.deepEqual(classifyRegistration(mk(a, 'sub'), opts), { action: 'ask', parent: a });
    const fresh = mk(s.home, 'Projects', 'Fresh');
    assert.deepEqual(classifyRegistration(fresh, opts), { action: 'new', root: fresh });
  } finally { s.cleanup(); }
});

test('registration: a repo can register after one of its worktrees (the worktree is behind its own .git)', () => {
  const s = sandbox();
  try {
    const repo = mk(s.home, 'Projects', 'Repo');
    mk(repo, '.git');
    const wt = mk(repo, '.claude', 'worktrees', 'w1');
    writeFileSync(join(wt, '.git'), 'gitdir: x\n');
    register(s.coreDir, [wt]);
    assert.deepEqual(classifyRegistration(repo, { home: s.home, coreDir: s.coreDir }), { action: 'new', root: repo });
  } finally { s.cleanup(); }
});

// ---------- state directory ----------

test('ensureStateDir writes .core/.gitignore ("*") and puts state under .core/<harness>/', () => {
  const s = sandbox();
  try {
    const p = mk(s.home, 'Projects', 'P');
    register(s.coreDir, [p]);
    const out = ensureStateDir({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(out.location, 'project');
    assert.equal(out.dir, join(p, '.core', 'claude-code'));
    assert.equal(readFileSync(join(p, '.core', '.gitignore'), 'utf8'), '*\n');
  } finally { s.cleanup(); }
});

test('hot and durable state both stay in the project, synced folder or not', () => {
  const s = sandbox();
  try {
    const p = mk(s.home, 'Library', 'CloudStorage', 'OneDrive-Org', 'P');
    register(s.coreDir, [p]);
    for (const kind of ['hot', 'durable']) {
      const out = projectStateDir({ root: p, harness: 'codex', kind, coreDir: s.coreDir });
      assert.equal(out.location, 'project', kind);
      assert.equal(out.dir, join(p, '.core', 'codex'), kind);
    }
  } finally { s.cleanup(); }
});
test('a read-only project root keeps all its state in ~/.core/local', { skip: isWin || isRoot }, () => {
  const s = sandbox();
  const p = mk(s.home, 'Projects', 'RO');
  try {
    register(s.coreDir, [p]);
    chmodSync(p, 0o555);
    const out = projectStateDir({ root: p, harness: 'claude-code', kind: 'durable', coreDir: s.coreDir });
    assert.equal(out.location, 'local');
    assert.equal(out.reason, 'root-not-writable');
  } finally { chmodSync(p, 0o755); s.cleanup(); }
});

test('an unregistered folder refuses new state without creating a local fallback', () => {
  const s = sandbox();
  try {
    const p = mk(s.home, 'Projects', 'Unregistered');
    assert.throws(()=>ensureStateDir({ root: p, harness: 'claude-code', coreDir: s.coreDir }),e=>e.code==='STATE_NO_PROJECT_PLACE'&&e.reason==='unregistered');
    assert.equal(existsSync(join(s.coreDir,'local')),false);
    assert.equal(existsSync(join(p, '.core')), false, 'nothing planted in the folder');
  } finally { s.cleanup(); }
});

test('harness names are a single safe segment', () => {
  assert.equal(assertHarnessName('claude-code'), 'claude-code');
  for (const bad of ['../x', 'Codex', '', 'a/b', '.hidden']) assert.throws(() => assertHarnessName(bad), /unsafe harness/);
});

// ---------- the stamp: hostile clone (spec test 2) ----------

function plantState(p, harness, stamp) {
  const dir = mk(p, '.core', harness);
  writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ metrics_disclosure_shown: true, storage_path: '../../.ssh' }));
  writeFileSync(join(dir, 'close.lock.g1'), JSON.stringify({ pid: process.pid, nonce: 'x' }));
  if (stamp !== undefined) writeFileSync(join(dir, 'stamp'), typeof stamp === 'string' ? stamp : JSON.stringify(stamp));
  return dir;
}

for (const withGit of [false, true]) {
  test(`hostile clone (${withGit ? 'git clone' : 'ZIP, no .git'}): forged stamp with this install's id is planted, its state never read, nothing written outside`, () => {
    const s = sandbox();
    try {
      const p = mk(s.base, 'clone');
      if (withGit) mk(p, '.git');
      const { installId } = ensureInstallIdentity({ coreDir: s.coreDir });
      const dir = plantState(p, 'claude-code', { path: p, harness: 'claude-code', install_id: installId, hmac: 'a'.repeat(64) });
      const wsFile = join(dir, 'workspace.json');
      if (!isWin && !isRoot) chmodSync(wsFile, 0o000);
      const outside = snapshot(s.base, (x) => x.startsWith(p));
      const r = classifyStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
      assert.equal(r.status, 'planted');
      assert.equal(r.reason, 'hmac-mismatch');
      assert.deepEqual(snapshot(s.base, (x) => x.startsWith(p)), outside);
      if (!isWin && !isRoot) chmodSync(wsFile, 0o644);
    } finally { s.cleanup(); }
  });
}

test('hostile clone: a made-up foreign install_id is left in place as another machine\'s state, never read', () => {
  const s = sandbox();
  try {
    const p = mk(s.base, 'clone');
    ensureInstallIdentity({ coreDir: s.coreDir });
    const dir = plantState(p, 'claude-code', { path: p, harness: 'claude-code', install_id: 'f'.repeat(32), hmac: 'b'.repeat(64) });
    const wsFile = join(dir, 'workspace.json');
    if (!isWin && !isRoot) chmodSync(wsFile, 0o000);
    const before = snapshot(s.base, (x) => x === wsFile);
    const r = classifyStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(r.status, 'foreign-install');
    assert.deepEqual(snapshot(s.base, (x) => x === wsFile), before);
    if (!isWin && !isRoot) chmodSync(wsFile, 0o644);
  } finally { s.cleanup(); }
});

test('a missing or malformed stamp is planted', () => {
  const s = sandbox();
  try {
    const p = mk(s.base, 'p1');
    plantState(p, 'codex');
    assert.deepEqual(classifyStamp({ root: p, harness: 'codex', coreDir: s.coreDir }), { status: 'planted', reason: 'missing-stamp' });
    const q = mk(s.base, 'p2');
    plantState(q, 'codex', '{not json');
    assert.equal(classifyStamp({ root: q, harness: 'codex', coreDir: s.coreDir }).status, 'planted');
  } finally { s.cleanup(); }
});

test('a symlinked .core is refused on read and on write', () => {
  const s = sandbox();
  try {
    const target = mk(s.base, 'secret-dir');
    mkdirSync(join(target, 'claude-code'));
    const p = mk(s.base, 'clone');
    symlinkSync(target, join(p, '.core'), DIR_LINK);
    register(s.coreDir, [p]);
    assert.deepEqual(classifyStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir }), { status: 'refused', reason: 'symlink' });
    assert.throws(() => ensureStateDir({ root: p, harness: 'claude-code', coreDir: s.coreDir }), /symlink/);
    assert.deepEqual(readdirSync(join(target, 'claude-code')), []);
  } finally { s.cleanup(); }
});

test('no .core yet is absent', () => {
  const s = sandbox();
  try {
    assert.deepEqual(classifyStamp({ root: mk(s.base, 'new'), harness: 'claude-code', coreDir: s.coreDir }), { status: 'absent' });
  } finally { s.cleanup(); }
});

// ---------- copy, move, ask (spec test 3) ----------

test('stamp verifies on its own path', () => {
  const s = sandbox();
  try {
    const p = mk(s.base, 'Projects', 'P');
    const stamp = writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    const { secret } = ensureInstallIdentity({ coreDir: s.coreDir });
    assert.equal(stamp.hmac, stampHmac(secret, stamp));
    assert.equal(classifyStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir }).status, 'verified');
  } finally { s.cleanup(); }
});

test('cp -r: the copy classifies as copied and the original is byte-identical', () => {
  const s = sandbox();
  try {
    const p = mk(s.base, 'Projects', 'P');
    writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    writeFileSync(join(p, '.core', 'claude-code', 'workspace.json'), '{"project_id":"abc"}');
    const before = snapshot(p);
    const copy = join(s.base, 'Projects', 'P-copy');
    cpSync(p, copy, { recursive: true });
    const r = classifyStamp({ root: copy, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(r.status, 'copied');
    assert.equal(r.oldPath, p);
    assert.deepEqual(snapshot(p), before);
  } finally { s.cleanup(); }
});

test('mv within an existing parent classifies as moved', () => {
  const s = sandbox();
  try {
    const p = mk(s.base, 'Projects', 'P');
    writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    const moved = join(s.base, 'Projects', 'P-renamed');
    renameSync(p, moved);
    const r = classifyStamp({ root: moved, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(r.status, 'moved');
    assert.equal(r.oldPath, p);
  } finally { s.cleanup(); }
});

test('old path and its parent both gone (unmounted drive, re-clone) asks instead of guessing', () => {
  const s = sandbox();
  try {
    const drive = mk(s.base, 'Volumes', 'Ext');
    const p = mk(drive, 'P');
    writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    const landed = join(mk(s.base, 'Projects'), 'P');
    renameSync(p, landed);
    rmSync(drive, { recursive: true, force: true });
    const r = classifyStamp({ root: landed, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(r.status, 'ask');
    assert.equal(r.oldPath, p);
  } finally { s.cleanup(); }
});

test('the install secret is created once, mode 0600, and reused', { skip: isWin }, () => {
  const s = sandbox();
  try {
    const a = ensureInstallIdentity({ coreDir: s.coreDir });
    const b = ensureInstallIdentity({ coreDir: s.coreDir });
    assert.equal(a.installId, b.installId);
    assert.ok(a.secret.equals(b.secret));
    assert.equal(statSync(join(s.coreDir, 'install-secret')).mode & 0o777, 0o600);
    assert.ok(existsSync(join(s.coreDir, 'install-id')));
    assert.equal(dirname(join(s.coreDir, 'install-id')), s.coreDir);
  } finally { s.cleanup(); }
});

test('a moved project whose migration is unfinished is fenced: no re-stamp, no write, stamp bytes kept; a healthy moved project is re-stamped', async () => {
  const { stateDir } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  for (const fenced of [true, false]) {
    const s = sandbox();
    try {
      const p = mk(s.base, 'Projects', 'P');
      writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
      if (fenced) writeFileSync(join(p, '.core', 'claude-code', '.migrating'), '');
      const moved = join(s.base, 'Projects', 'P-renamed');
      renameSync(p, moved);
      register(s.coreDir, [moved]);
      const stamp = join(moved, '.core', 'claude-code', 'stamp');
      const before = readFileSync(stamp, 'utf8');
      assert.equal(classifyStamp({ root: moved, harness: 'claude-code', coreDir: s.coreDir }).status, 'moved');
      if (fenced) {
        assert.equal(stateDir({ root: moved, harness: 'claude-code', coreDir: s.coreDir })?.status ?? null, null, 'a read is held: nothing local to read');
        assert.throws(() => stateDir({ root: moved, harness: 'claude-code', coreDir: s.coreDir, forWrite: true }), 'a write is refused');
        assert.equal(readFileSync(stamp, 'utf8'), before, 'the stamp is not re-written');
      } else {
        const r = stateDir({ root: moved, harness: 'claude-code', coreDir: s.coreDir, forWrite: true });
        assert.equal(r.status, 'moved');
        assert.notEqual(readFileSync(stamp, 'utf8'), before, 'control: a healthy moved project is re-stamped');
      }
    } finally { s.cleanup(); }
  }
});

test('a copied project with an unfinished migration is not archived or re-stamped; settling an ask waits too; a healthy copy is set aside as before', async () => {
  const { stateDir } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { settleState } = await import('../../plugins/core/skills/core/scripts/index-registry.mjs');
  for (const fenced of [true, false]) {
    const s = sandbox();
    try {
      const p = mk(s.base, 'Projects', 'P');
      writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
      const copy = join(s.base, 'Projects', 'P-copy');
      cpSync(p, copy, { recursive: true });
      if (fenced) writeFileSync(join(copy, '.core', 'claude-code', '.migrating'), '');
      register(s.coreDir, [p, copy]);
      const before = snapshot(join(copy, '.core'));
      if (fenced) {
        assert.throws(() => stateDir({ root: copy, harness: 'claude-code', coreDir: s.coreDir, forWrite: true }));
        assert.deepEqual(snapshot(join(copy, '.core')), before, 'marker, stamp and bytes kept as found');
      } else {
        const r = stateDir({ root: copy, harness: 'claude-code', coreDir: s.coreDir, forWrite: true });
        assert.equal(r.status, 'copied'); assert.ok(r.setAside, 'control: a healthy copy is set aside');
      }
    } finally { s.cleanup(); }
  }
  // an 'ask' (old path and parent gone) with a marker: settling waits
  const s = sandbox();
  try {
    const drive = mk(s.base, 'Volumes', 'Ext');
    const p = mk(drive, 'P');
    writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    const landed = join(mk(s.base, 'Projects'), 'P');
    renameSync(p, landed);
    rmSync(drive, { recursive: true, force: true });
    writeFileSync(join(landed, '.core', 'claude-code', '.migrating'), '');
    register(s.coreDir, [landed]);
    const before = snapshot(join(landed, '.core'));
    for (const decision of ['accept-move', 'fresh']) {
      const r = settleState(s.coreDir, { root: landed, harness: 'claude-code', decision });
      assert.equal(r.status, 'held', decision); assert.equal(r.changed, false);
    }
    assert.deepEqual(snapshot(join(landed, '.core')), before);
  } finally { s.cleanup(); }
});

test('a malformed or missing stamp under an unfinished migration refuses the write, marker and bytes kept', async () => {
  const { stateDir } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  for (const shape of ['malformed', 'missing']) {
    const s = sandbox();
    try {
      const p = mk(s.base, 'Projects', 'P');
      writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
      register(s.coreDir, [p]);
      const stamp = join(p, '.core', 'claude-code', 'stamp');
      if (shape === 'malformed') writeFileSync(stamp, 'not a stamp\n'); else rmSync(stamp);
      writeFileSync(join(p, '.core', 'claude-code', '.migrating'), '');
      writeFileSync(join(p, '.core', 'claude-code', 'notes.md'), 'half-copied\n');
      const before = snapshot(join(p, '.core'));
      assert.throws(() => stateDir({ root: p, harness: 'claude-code', coreDir: s.coreDir, forWrite: true }), shape);
      assert.deepEqual(snapshot(join(p, '.core')), before, `${shape}: marker and bytes kept`);
    } finally { s.cleanup(); }
  }
});
