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
    assert.equal(out.dir, join(p, '_core', 'claude-code'));
    assert.equal(readFileSync(join(p, '_core', '.gitignore'), 'utf8'), '*\n');
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
      assert.equal(out.dir, join(p, '_core', 'codex'), kind);
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
    assert.equal(existsSync(join(p, '_core')), false, 'nothing planted in the folder');
  } finally { s.cleanup(); }
});

test('harness names are a single safe segment', () => {
  assert.equal(assertHarnessName('claude-code'), 'claude-code');
  for (const bad of ['../x', 'Codex', '', 'a/b', '.hidden']) assert.throws(() => assertHarnessName(bad), /unsafe harness/);
});

// ---------- the stamp: hostile clone (spec test 2) ----------

function plantState(p, harness, stamp) {
  const dir = mk(p, '_core', harness);
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
    symlinkSync(target, join(p, '_core'), DIR_LINK);
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
    writeFileSync(join(p, '_core', 'claude-code', 'workspace.json'), '{"project_id":"abc"}');
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

/** Whether `dir` is on a filesystem that treats two spellings differing only in case as one name. */
function caseInsensitiveAt(dir) {
  const probe = mk(dir, 'CaseProbe');
  try { return existsSync(join(dir, 'caseprobe')); } finally { rmSync(probe, { recursive: true, force: true }); }
}

test('a folder renamed by letter case only reads as moved, not copied; its state, opt-outs, registry row, file baseline and metrics pin follow it; a real copy beside it still reads as copied', async (t) => {
  const { updateManifest, readManifest, writePinSigned, readPinSigned } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { touchProject } = await import('../../plugins/core/skills/core/scripts/index-registry.mjs');
  const { stampFile, readProjectCache } = await import('../../plugins/core/skills/core/scripts/state-cache.mjs');
  const { metricsEnabled } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const { turnCaptureEnabled } = await import('../../plugins/core/skills/core/scripts/turn-capture.mjs');
  const s = sandbox();
  try {
    const parent = mk(s.base, 'Projects');
    if (!caseInsensitiveAt(parent)) return t.skip('case-sensitive filesystem: a case-only rename is a rename to a different name');
    const harness = 'claude-code';
    const env = { CORE_HARNESS: harness };
    const p = mk(parent, 'Proj');
    register(s.coreDir, [p]);
    writeStamp({ root: p, harness, coreDir: s.coreDir });
    // the project's opt-outs, in its signed manifest
    const seeded = updateManifest({ root: p, harness, coreDir: s.coreDir, fields: { metrics_enabled: false, turn_capture: false } });
    const ws = join(p, '_core', harness, 'workspace.json');
    const wsBytes = readFileSync(ws, 'utf8');
    // a file baseline keyed by the old spelling
    const unit = join(p, 'notes.md');
    writeFileSync(unit, 'hello\n');
    assert.equal(stampFile(p, unit, 'h-notes', 'seed-writer', { now: '2026-10-01T00:00:00Z' }).stamped, true, 'precondition: baseline seeded');
    const oldEntry = readProjectCache(p).files[unit];
    assert.ok(oldEntry, 'precondition: baseline keyed by the old spelling');
    // the metrics storage pin, signed for the old spelling
    mk(p, '_metrics');
    const meta = mk(p, '_core', harness, 'metrics');
    writePinSigned({ dir: meta, path: join(p, '_metrics'), root: p, coreDir: s.coreDir });
    assert.equal(readPinSigned({ dir: meta, root: p, coreDir: s.coreDir }), join(p, '_metrics'), 'precondition: pin seeded');

    const renamed = join(parent, 'proj');
    renameSync(p, renamed);
    assert.equal(realpathSync.native(p), renamed, 'precondition: the old spelling now resolves to the renamed folder');
    const r = classifyStamp({ root: renamed, harness, coreDir: s.coreDir });
    assert.equal(r.status, 'moved', 'the same folder under a new spelling is a move');
    assert.equal(r.oldPath, p);

    // the normal moved handling: state opened for write, registry follows
    const touched = touchProject(s.coreDir, { root: renamed, harness });
    const moves = touched.events.filter((e) => e.kind === 'state-moved');
    assert.equal(moves.length, 1, 'one move is reported');
    assert.equal(moves[0].oldPath, p);
    assert.deepEqual(touched.events.filter((e) => e.kind !== 'state-moved'), [], 'nothing is set aside, copied or asked');
    assert.equal(existsSync(join(renamed, '_core', harness, 'superseded')), false, 'nothing is set aside');
    assert.equal(classifyStamp({ root: renamed, harness, coreDir: s.coreDir }).status, 'verified', 'the re-stamp names the new spelling');

    // (a) identity and opt-outs kept, still verified
    assert.equal(readFileSync(join(renamed, '_core', harness, 'workspace.json'), 'utf8'), wsBytes, 'the manifest bytes are kept');
    const m = readManifest({ root: renamed, harness, coreDir: s.coreDir });
    assert.ok(m, 'the manifest still verifies under the new spelling');
    assert.equal(m.project_id, seeded.project_id, 'the project keeps its identity');
    assert.equal(m.metrics_enabled, false, 'the metrics opt-out is kept');
    assert.equal(m.turn_capture, false, 'the turn-capture opt-out is kept');
    assert.equal(metricsEnabled({ project: renamed, env, home: s.home }), false, 'metrics stay off');
    assert.equal(turnCaptureEnabled({ project: renamed, env, home: s.home }), false, 'turn capture stays off');

    // (b) the registry row names the new spelling, once; the old spelling is gone
    const rows = JSON.parse(readFileSync(join(s.coreDir, 'projects.json'), 'utf8'));
    assert.equal(rows.filter((e) => e.path === renamed).length, 1, 'one row names the new spelling');
    assert.deepEqual(rows.filter((e) => e.path === p), [], 'no row names the old spelling');
    assert.equal(rows.length, 1, 'no second row was added');
    assert.equal(rows[0].moved_from, p, 'the row records the old spelling it moved from');

    // (c) the file baseline is keyed by the new spelling, hash and writer kept
    assert.equal(moves[0].repointed.cache.status, 'repointed');
    const cache = readProjectCache(renamed);
    assert.deepEqual(cache.files[join(renamed, 'notes.md')], oldEntry, 'the baseline entry moved to the new key unchanged');
    assert.equal(Object.hasOwn(cache.files, unit), false, 'no baseline entry keeps the old spelling');

    // (d) the metrics pin is re-signed for the new spelling and reads for it
    const metaNow = join(renamed, '_core', harness, 'metrics');
    assert.notEqual(readPinSigned({ dir: metaNow, root: renamed, coreDir: s.coreDir }), null, 'the pin still verifies for the new root');
    assert.deepEqual(moves[0].repointed.pins, [{ folder: metaNow, status: 'repointed' }], 'the pin is re-signed for the new root');
    const pinBody = JSON.parse(readFileSync(join(metaNow, 'storage-path.txt'), 'utf8'));
    assert.deepEqual(pinBody, { path: join(renamed, '_metrics'), root: renamed }, 'the signed pin names the new spelling');
    assert.equal(readPinSigned({ dir: metaNow, root: renamed, coreDir: s.coreDir }), join(renamed, '_metrics'), 'the pin reads for the new root');

    // control: a real copy beside the renamed folder is still a copy
    const copy = join(parent, 'Proj-copy');
    cpSync(renamed, copy, { recursive: true });
    const c = classifyStamp({ root: copy, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(c.status, 'copied');
    assert.equal(c.oldPath, renamed);
    const pinBefore = readFileSync(join(metaNow, 'storage-path.txt'), 'utf8');
    writeFileSync(join(s.coreDir, 'projects.json'), JSON.stringify([...rows, { path: copy }]));
    const copied = touchProject(s.coreDir, { root: copy, harness });
    assert.ok(copied.events.some((e) => e.kind === 'state-copied'), 'the copy is set aside as a copy');
    assert.ok(!copied.events.some((e) => e.kind === 'state-moved'), 'the copy is not a move');
    assert.equal(readPinSigned({ dir: join(copy, '_core', harness, 'metrics'), root: copy, coreDir: s.coreDir }), null, 'the copy does not get the pin');
    assert.equal(readFileSync(join(metaNow, 'storage-path.txt'), 'utf8'), pinBefore, 'the renamed project keeps its pin');
  } finally { s.cleanup(); }
});

test('after a rename by letter case, a later real move still carries the metrics pin', async (t) => {
  const { writePinSigned, readPinSigned } = await import('../../plugins/core/skills/core/scripts/project-state.mjs');
  const { touchProject } = await import('../../plugins/core/skills/core/scripts/index-registry.mjs');
  const s = sandbox();
  try {
    const parent = mk(s.base, 'Projects');
    if (!caseInsensitiveAt(parent)) return t.skip('case-sensitive filesystem: a case-only rename is a rename to a different name');
    const harness = 'claude-code';
    const p = mk(parent, 'Proj');
    register(s.coreDir, [p]);
    writeStamp({ root: p, harness, coreDir: s.coreDir });
    mk(p, '_metrics');
    writePinSigned({ dir: mk(p, '_core', harness, 'metrics'), path: join(p, '_metrics'), root: p, coreDir: s.coreDir });

    const lower = join(parent, 'proj');
    renameSync(p, lower);
    touchProject(s.coreDir, { root: lower, harness });

    const other = join(parent, 'Other');
    renameSync(lower, other);
    // startup registers the new path before the move is noticed
    const rows = JSON.parse(readFileSync(join(s.coreDir, 'projects.json'), 'utf8'));
    writeFileSync(join(s.coreDir, 'projects.json'), JSON.stringify([...rows, { path: other }]));
    const r = touchProject(s.coreDir, { root: other, harness });
    const ev = r.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'the later move is reported');
    assert.equal(ev.oldPath, lower);
    const meta = join(other, '_core', harness, 'metrics');
    assert.deepEqual(ev.repointed.pins, [{ folder: meta, status: 'repointed' }], 'the pin is carried to the new folder');
    assert.equal(readPinSigned({ dir: meta, root: other, coreDir: s.coreDir }), join(other, '_metrics'), 'the pin reads for the new folder');
  } finally { s.cleanup(); }
});

test('on a case-sensitive filesystem, Proj and proj are two folders: a copy of Proj into proj still reads as copied', (t) => {
  const s = sandbox();
  try {
    const parent = mk(s.base, 'Projects');
    if (caseInsensitiveAt(parent)) return t.skip('case-insensitive filesystem: Proj and proj cannot both exist');
    const p = mk(parent, 'Proj');
    writeStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir });
    const other = join(parent, 'proj');
    cpSync(p, other, { recursive: true });
    assert.notEqual(statSync(p).ino, statSync(other).ino, 'precondition: two distinct folders');
    const r = classifyStamp({ root: other, harness: 'claude-code', coreDir: s.coreDir });
    assert.equal(r.status, 'copied', 'names equal ignoring case are not the same folder');
    assert.equal(r.oldPath, p);
    assert.equal(classifyStamp({ root: p, harness: 'claude-code', coreDir: s.coreDir }).status, 'verified', 'control: the original still verifies');
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
      if (fenced) writeFileSync(join(p, '_core', 'claude-code', '.migrating'), '');
      const moved = join(s.base, 'Projects', 'P-renamed');
      renameSync(p, moved);
      register(s.coreDir, [moved]);
      const stamp = join(moved, '_core', 'claude-code', 'stamp');
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
      if (fenced) writeFileSync(join(copy, '_core', 'claude-code', '.migrating'), '');
      register(s.coreDir, [p, copy]);
      const before = snapshot(join(copy, '_core'));
      if (fenced) {
        assert.throws(() => stateDir({ root: copy, harness: 'claude-code', coreDir: s.coreDir, forWrite: true }));
        assert.deepEqual(snapshot(join(copy, '_core')), before, 'marker, stamp and bytes kept as found');
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
    writeFileSync(join(landed, '_core', 'claude-code', '.migrating'), '');
    register(s.coreDir, [landed]);
    const before = snapshot(join(landed, '_core'));
    for (const decision of ['accept-move', 'fresh']) {
      const r = settleState(s.coreDir, { root: landed, harness: 'claude-code', decision });
      assert.equal(r.status, 'held', decision); assert.equal(r.changed, false);
    }
    assert.deepEqual(snapshot(join(landed, '_core')), before);
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
      const stamp = join(p, '_core', 'claude-code', 'stamp');
      if (shape === 'malformed') writeFileSync(stamp, 'not a stamp\n'); else rmSync(stamp);
      writeFileSync(join(p, '_core', 'claude-code', '.migrating'), '');
      writeFileSync(join(p, '_core', 'claude-code', 'notes.md'), 'half-copied\n');
      const before = snapshot(join(p, '_core'));
      assert.throws(() => stateDir({ root: p, harness: 'claude-code', coreDir: s.coreDir, forWrite: true }), shape);
      assert.deepEqual(snapshot(join(p, '_core')), before, `${shape}: marker and bytes kept`);
    } finally { s.cleanup(); }
  }
});
