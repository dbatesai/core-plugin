import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, renameSync, copyFileSync, statSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerProject, touchProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { applyMigration, checkLegacyDrift } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';
import { writeSignedFile, readSignedFileAt, repointMovedState } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { acquireFileLock, releaseFileLock, currentLockFile } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs', import.meta.url));
const H = 'claude-code';
const RECEIPT = 'migrated-from.json';

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'receipt-root-'))));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function legacyWorkspace(s, id, { path, files = {} }) {
  const dir = join(s.coreDir, 'workspaces', id);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { workspace_id: id, name: id, path };
}

/** Startup's two migration commands, as the CLI runs them. */
function cli(s, mode, root) {
  const r = spawnSync(process.execPath, [SCRIPT, mode, '--root', root, '--harness', H, '--core-dir', s.coreDir], { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr };
}

function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else out.push(f); } };
  if (!existsSync(dir)) return out;
  if (statSync(dir).isDirectory()) walk(dir); else out.push(dir);
  return out;
}

test('a migrated project that is then moved still passes startup\'s apply and drift check at its new path', () => {
  const s = sandbox();
  try {
    const p = s.mk('Projects', 'Old');
    const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      legacyWorkspace(s, 'legacy', { path: p, files: {
        'workspace.json': JSON.stringify({ workspace_id: 'legacy', agent_name: 'Plover' }),
        'capability-history.jsonl': '{"row":1}\n',
        'hot-section-draft.md': 'draft\n',
      } }),
    ], null, 2));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify({ version: 1, entries: { legacy: { harness: H, evidence: 'fixture' } } }));
    registerProject(s.coreDir, p);

    const applied = cli(s, '--apply', p);
    assert.equal(applied.json?.status, 'migrated', applied.stdout + applied.stderr);
    const before = cli(s, '--drift-check', p);
    assert.equal(before.status, 0, 'control: the receipt verifies at the path it was written for\n' + before.stdout);
    assert.equal(before.json.status, 'unchanged');

    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved);
    const touched = touchProject(s.coreDir, { root: moved, harness: H });
    assert.ok(touched.events.some((e) => e.kind === 'state-moved'), 'CORE\'s own move handling ran');

    const apply = cli(s, '--apply', moved);
    process.stdout.write(`# (a) --apply after move: exit ${apply.status} ${JSON.stringify(apply.json)}\n`);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);

    writeFileSync(legacyLog, '{"row":1}\n{"row":"older-build-2"}\n');
    const drift = cli(s, '--drift-check', moved);
    process.stdout.write(`# (a) --drift-check after move: exit ${drift.status} ${JSON.stringify(drift.json)}\n`);
    assert.equal(drift.status, 0, `drift check after a move exits 0\n${drift.stdout}${drift.stderr}`);
    assert.ok(['unchanged', 'brought-in'].includes(drift.json.status), drift.stdout);
  } finally { s.cleanup(); }
});

/** Whether `dir` is on a filesystem that treats two spellings differing only in case as one name. */
function caseInsensitiveAt(dir) {
  const probe = join(dir, 'CaseProbe');
  mkdirSync(probe, { recursive: true });
  try { return existsSync(join(dir, 'caseprobe')); } finally { rmSync(probe, { recursive: true, force: true }); }
}

test('a migrated project renamed by letter case only still passes startup\'s apply and drift check, its receipt carried to the new spelling', (t) => {
  const s = sandbox();
  try {
    const parent = s.mk('Projects');
    if (!caseInsensitiveAt(parent)) return t.skip('case-sensitive filesystem: a case-only rename is a rename to a different name');
    const p = s.mk('Projects', 'Proj');
    const legacyLog = join(s.coreDir, 'workspaces', 'legacy', 'capability-history.jsonl');
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      legacyWorkspace(s, 'legacy', { path: p, files: {
        'workspace.json': JSON.stringify({ workspace_id: 'legacy', agent_name: 'Plover' }),
        'capability-history.jsonl': '{"row":1}\n',
        'hot-section-draft.md': 'draft\n',
      } }),
    ], null, 2));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify({ version: 1, entries: { legacy: { harness: H, evidence: 'fixture' } } }));
    registerProject(s.coreDir, p);

    const applied = cli(s, '--apply', p);
    assert.equal(applied.json?.status, 'migrated', applied.stdout + applied.stderr);
    const before = cli(s, '--drift-check', p);
    assert.equal(before.status, 0, 'control: the receipt verifies at the path it was written for\n' + before.stdout);
    assert.equal(before.json.status, 'unchanged');
    const seeded = JSON.parse(readFileSync(join(p, '_core', H, RECEIPT), 'utf8'));
    assert.equal(seeded.root, p, 'fixture: the receipt names the old spelling');
    const underState = seeded.files.filter((f) => typeof f?.to === 'string' && f.to.startsWith(p + sep));
    assert.ok(underState.length > 0, 'fixture: the receipt lists destinations under the project');

    const renamed = join(parent, 'proj');
    renameSync(p, renamed);
    assert.equal(realpathSync.native(p), renamed, 'precondition: the old spelling now resolves to the renamed folder');
    registerProject(s.coreDir, renamed);
    const touched = touchProject(s.coreDir, { root: renamed, harness: H });
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.equal(ev.oldPath, p);
    const nowState = join(renamed, '_core', H);
    process.stdout.write(`# (c) receipts after case-only rename: ${JSON.stringify(ev.repointed.receipts)}\n`);
    assert.deepEqual(ev.repointed.receipts, [{ folder: nowState, status: 'repointed', count: underState.length }], 'the receipt is carried to the new spelling');

    const raw = readSignedFileAt({ dir: nowState, name: RECEIPT, coreDir: s.coreDir });
    assert.notEqual(raw, null, 'the carried receipt verifies');
    const carried = JSON.parse(raw);
    assert.equal(carried.root, renamed, 'the receipt names the new spelling');
    for (const f of carried.files) {
      if (typeof f?.to === 'string') assert.ok(f.to.startsWith(renamed + sep), `destination under the new spelling: ${f.to}`);
    }
    assert.deepEqual(carried.files.map((f) => f.from), seeded.files.map((f) => f.from), 'sources are not rewritten');

    const apply = cli(s, '--apply', renamed);
    process.stdout.write(`# (c) --apply after case-only rename: exit ${apply.status} ${JSON.stringify(apply.json)}\n`);
    assert.equal(apply.status, 0, apply.stdout + apply.stderr);

    writeFileSync(legacyLog, '{"row":1}\n{"row":"older-build-2"}\n');
    const drift = cli(s, '--drift-check', renamed);
    process.stdout.write(`# (c) --drift-check after case-only rename: exit ${drift.status} ${JSON.stringify(drift.json)}\n`);
    assert.notEqual(drift.json?.status, 'receipt-unverified', `the carried receipt is accepted\n${drift.stdout}${drift.stderr}`);
    assert.equal(drift.status, 0, `drift check after a case-only rename exits 0\n${drift.stdout}${drift.stderr}`);
    assert.ok(['unchanged', 'brought-in'].includes(drift.json.status), drift.stdout);
  } finally { s.cleanup(); }
});

/**
 * A project registered and touched at `old`, holding a signed receipt with `root`, then moved to `now`.
 * `seed(state, body)` replaces the signed write of the receipt, for receipts this install would not carry.
 */
function movedWithReceipt(s, root, { seed } = {}) {
  const old = s.mk('Projects', 'Old');
  registerProject(s.coreDir, old);
  touchProject(s.coreDir, { root: old, harness: H });
  const state = join(old, '_core', H);
  const body = JSON.stringify({ complete: true, migrated_at: '2026-10-01T00:00:00.000Z', harness: H, root: root(old), live: 'legacy', superseded: [],
    files: [{ from: join(s.coreDir, 'workspaces', 'legacy', 'notes.md'), to: join(state, 'notes.md'), sha256: '0'.repeat(64), length: 1 }] }, null, 2) + '\n';
  if (seed) seed(state, body);
  else writeSignedFile({ dir: state, name: RECEIPT, body, coreDir: s.coreDir });
  writeFileSync(join(state, 'notes.md'), 'n\n');
  const now = join(s.base, 'Projects', 'New');
  renameSync(old, now);
  registerProject(s.coreDir, now);
  const nowState = join(now, '_core', H);
  const bytes = () => [readFileSync(join(nowState, RECEIPT), 'utf8'), readFileSync(join(nowState, `${RECEIPT}.mac`), 'utf8')];
  return { old, now, nowState, bytes };
}

test('a moved project whose receipt names a third folder keeps that receipt exactly as it was', () => {
  const s = sandbox();
  try {
    const third = s.mk('Projects', 'Third');
    const m = movedWithReceipt(s, () => third);
    const before = m.bytes();
    const touched = touchProject(s.coreDir, { root: m.now, harness: H });
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'left-root-mismatch' }]);
    assert.deepEqual(m.bytes(), before, 'receipt and its MAC are untouched');
    assert.equal(JSON.parse(before[0]).root, third);
  } finally { s.cleanup(); }
});

/** Move handling on `m`, returning the receipt reports after checking the receipt pair is byte-identical. */
function carryLeavesReceipt(s, m) {
  const before = m.bytes();
  const touched = touchProject(s.coreDir, { root: m.now, harness: H });
  const ev = touched.events.find((e) => e.kind === 'state-moved');
  assert.ok(ev, 'CORE\'s own move handling ran');
  assert.deepEqual(m.bytes(), before, 'receipt and its MAC are untouched');
  return ev.repointed.receipts;
}

test('a moved project whose receipt is tracked by git keeps that receipt exactly as it was', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const git = (...args) => spawnSync('git', ['-C', m.now, ...args], { encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0, 'fixture: git init');
    const added = git('add', '-f', `_core/${H}/${RECEIPT}`);
    assert.equal(added.status, 0, `fixture: the receipt is in the index\n${added.stderr}`);
    assert.deepEqual(carryLeavesReceipt(s, m), [{ folder: m.nowState, status: 'left-tracked' }]);
  } finally { s.cleanup(); }
});

test('a moved project whose receipt does not verify against its MAC keeps that receipt exactly as it was', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old, { seed: (state, body) => {
      writeSignedFile({ dir: state, name: RECEIPT, body, coreDir: s.coreDir });
      // Same length, one changed byte: the MAC no longer matches the body.
      writeFileSync(join(state, RECEIPT), body.replace('"complete": true', '"complete": fals'));
    } });
    assert.equal(readSignedFileAt({ dir: m.nowState, name: RECEIPT, coreDir: s.coreDir }), null, 'fixture: the receipt does not verify');
    assert.deepEqual(carryLeavesReceipt(s, m), [{ folder: m.nowState, status: 'left-unsigned' }]);
  } finally { s.cleanup(); }
});

test('a moved project whose signed receipt is not JSON keeps that receipt exactly as it was', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old, { seed: (state, body) => {
      writeSignedFile({ dir: state, name: RECEIPT, body: body.slice(0, -5), coreDir: s.coreDir });
    } });
    assert.notEqual(readSignedFileAt({ dir: m.nowState, name: RECEIPT, coreDir: s.coreDir }), null, 'fixture: the receipt verifies');
    assert.deepEqual(carryLeavesReceipt(s, m), [{ folder: m.nowState, status: 'left-unreadable' }]);
  } finally { s.cleanup(); }
});

test('a moved project whose signed receipt lacks a string root or a file list keeps that receipt exactly as it was', () => {
  for (const shape of [(r, old) => ({ ...r, root: [old] }), (r) => ({ ...r, files: {} }), () => null]) {
    const s = sandbox();
    try {
      const m = movedWithReceipt(s, (old) => old, { seed: (state, body) => {
        const old = dirname(dirname(state));
        writeSignedFile({ dir: state, name: RECEIPT, body: JSON.stringify(shape(JSON.parse(body), old), null, 2) + '\n', coreDir: s.coreDir });
      } });
      assert.notEqual(readSignedFileAt({ dir: m.nowState, name: RECEIPT, coreDir: s.coreDir }), null, 'fixture: the receipt verifies');
      assert.deepEqual(carryLeavesReceipt(s, m), [{ folder: m.nowState, status: 'left-unreadable' }]);
    } finally { s.cleanup(); }
  }
});

test('a moved project whose _memories is not a folder cannot take the close lock, and keeps its receipt exactly as it was', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    rmSync(join(m.now, '_memories'), { recursive: true, force: true });
    writeFileSync(join(m.now, '_memories'), 'not a folder\n');
    assert.deepEqual(carryLeavesReceipt(s, m), [{ folder: m.nowState, status: 'held', reason: 'FOLDER_UNSAFE' }]);
    assert.equal(readFileSync(join(m.now, '_memories'), 'utf8'), 'not a folder\n', 'the file in the folder\'s place is left as it was');
  } finally { s.cleanup(); }
});

test('a carry whose state locations cannot be listed reports the receipts held instead of throwing', () => {
  const s = sandbox();
  try {
    const now = s.mk('Projects', 'New');
    // An unusable harness name makes the state-location listing throw; the caller's move has already landed.
    const r = repointMovedState({ root: now, harness: '../x', coreDir: s.coreDir, oldPath: join(s.base, 'Projects', 'Old') });
    assert.deepEqual(r.receipts, [{ folder: null, status: 'held', reason: 'UNSAFE_HARNESS' }]);
    assert.deepEqual(r.pins, [{ folder: null, status: 'held: UNSAFE_HARNESS' }]);
  } finally { s.cleanup(); }
});

test('a moved project\'s own receipt is carried to the new folder, and left intact and reported when the close lock is held', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const before = m.bytes();
    const lockFile = join(m.now, '_memories', '_close.lock');
    const lock = acquireFileLock(lockFile, { extra: { session_id: 'test-close' } });
    assert.ok(lock.ok, 'fixture: the close lock is held');
    let touched;
    try { touched = touchProject(s.coreDir, { root: m.now, harness: H }); }
    finally { releaseFileLock(lockFile, lock.nonce); }
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.equal(ev.repointed.receipts.length, 1);
    assert.equal(ev.repointed.receipts[0].status, 'held', JSON.stringify(ev.repointed.receipts));
    assert.match(ev.repointed.receipts[0].reason, /^lock-/);
    assert.deepEqual(m.bytes(), before, 'a carry that cannot take the lock leaves the receipt as it was');
    assert.equal(touched.root, m.now);
    assert.equal(ev.oldPath, m.old);
    const again = touchProject(s.coreDir, { root: m.now, harness: H });
    assert.equal(again.events.some((e) => e.kind === 'state-moved'), false, 'the move itself completed: the state now verifies at the new path');
  } finally { s.cleanup(); }
  const s2 = sandbox();
  try {
    const m = movedWithReceipt(s2, (old) => old);
    const touched = touchProject(s2.coreDir, { root: m.now, harness: H });
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'repointed', count: 1 }]);
    const r = JSON.parse(m.bytes()[0]);
    assert.equal(r.root, m.now);
    assert.equal(r.files[0].to, join(m.nowState, 'notes.md'));
    assert.equal(r.files[0].from, join(s2.coreDir, 'workspaces', 'legacy', 'notes.md'), 'sources are not rewritten');
  } finally { s2.cleanup(); }
});

/** Run `fn` with `fs.renameSync` replaced by `patched(original, from, to)`, as every module importing node:fs sees it. */
function withRename(patched, fn) {
  const original = fs.renameSync;
  fs.renameSync = (from, to, ...rest) => patched(original, from, to, ...rest);
  syncBuiltinESMExports();
  try { return fn(); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
}

test('a carried receipt that does not read back as written is put back byte for byte and reported held', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const before = m.bytes();
    const file = join(m.nowState, RECEIPT);
    // The new receipt's write is lost once (the temp file is dropped instead of renamed over it),
    // so the folder holds the old receipt beside the new MAC and the pair does not verify.
    let dropped = 0;
    const touched = withRename((rename, from, to, ...rest) => {
      if (to === file && !dropped++) { fs.unlinkSync(from); return undefined; }
      return rename(from, to, ...rest);
    }, () => touchProject(s.coreDir, { root: m.now, harness: H }));
    assert.equal(dropped >= 1, true, 'fixture: the receipt write was reached');
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'held', reason: 'RECEIPT_READBACK', restored: true }]);
    assert.deepEqual(m.bytes(), before, 'the original receipt and its MAC are back');
    assert.deepEqual(readdirSync(m.nowState).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
  } finally { s.cleanup(); }
});

test('a carried receipt whose MAC write fails is put back byte for byte and reported held', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const before = m.bytes();
    const mac = join(m.nowState, `${RECEIPT}.mac`);
    // The new body has already replaced the old one when the MAC write fails, once.
    let failed = 0;
    const touched = withRename((rename, from, to, ...rest) => {
      if (to === mac && !failed++) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
      return rename(from, to, ...rest);
    }, () => touchProject(s.coreDir, { root: m.now, harness: H }));
    assert.equal(failed >= 1, true, 'fixture: the MAC write was reached');
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'held', reason: 'EIO', restored: true }]);
    assert.deepEqual(m.bytes(), before, 'the original receipt and its MAC are back');
    assert.deepEqual(readdirSync(m.nowState).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
  } finally { s.cleanup(); }
});

test('a carried receipt is put back while the carry still holds the close lock', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const before = m.bytes();
    const file = join(m.nowState, RECEIPT);
    const mac = `${file}.mac`;
    const lockFile = join(m.now, '_memories', '_close.lock');
    // The new receipt's write is lost once; every later write to the pair is the restore, and
    // each one records who holds the close lock at that moment.
    const seen = { [file]: 0, [mac]: 0 };
    const holders = [];
    const touched = withRename((rename, from, to, ...rest) => {
      if (to in seen && seen[to]++ > 0) {
        const live = currentLockFile(lockFile);
        let owner = null;
        try { owner = live && JSON.parse(readFileSync(live, 'utf8')); } catch { /* unreadable reads as no owner */ }
        holders.push({ to, session_id: owner?.session_id ?? null, pid: owner?.pid ?? null });
      }
      if (to === file && seen[file] === 1) { fs.unlinkSync(from); return undefined; }
      return rename(from, to, ...rest);
    }, () => touchProject(s.coreDir, { root: m.now, harness: H }));
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'held', reason: 'RECEIPT_READBACK', restored: true }]);
    assert.deepEqual(holders.map((h) => h.to), [file, mac], 'fixture: both restore writes were reached');
    for (const h of holders) assert.deepEqual(h, { to: h.to, session_id: 'move-receipt', pid: process.pid }, 'the carry owns the close lock during each restore write');
    assert.deepEqual(m.bytes(), before, 'the original receipt and its MAC are back');
  } finally { s.cleanup(); }
});

test('a restore write that fails is reported as restored: false, naming the file', () => {
  const s = sandbox();
  try {
    const m = movedWithReceipt(s, (old) => old);
    const before = m.bytes();
    const file = join(m.nowState, RECEIPT);
    const mac = `${file}.mac`;
    // The MAC write fails after the new body landed, then the restore of the body fails too,
    // leaving the new body beside the original MAC: a pair that does not verify.
    const seen = { [file]: 0, [mac]: 0 };
    const touched = withRename((rename, from, to, ...rest) => {
      if (to in seen) seen[to]++;
      if ((to === mac && seen[mac] === 1) || (to === file && seen[file] === 2)) throw Object.assign(new Error('synthetic write failure'), { code: 'EIO' });
      return rename(from, to, ...rest);
    }, () => touchProject(s.coreDir, { root: m.now, harness: H }));
    assert.deepEqual(seen, { [file]: 2, [mac]: 2 }, 'fixture: the carry wrote each file once and the restore tried each once');
    const ev = touched.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'CORE\'s own move handling ran');
    assert.deepEqual(ev.repointed.receipts, [{ folder: m.nowState, status: 'held', reason: 'EIO', restored: false, restoreFailed: RECEIPT }]);
    const after = m.bytes();
    assert.notEqual(after[0], before[0], 'the body is not back');
    assert.equal(after[1], before[1], 'the MAC restore was still attempted and landed');
    assert.deepEqual(readdirSync(m.nowState).filter((n) => n.includes('.tmp-')), [], 'no temp files left behind');
  } finally { s.cleanup(); }
});

test('a signed receipt with an empty file list, copied into another project, is refused and imports nothing', { todo: 'receipt root binding' }, () => {
  const s = sandbox();
  try {
    const a = s.mk('Projects', 'A');
    const b = s.mk('Projects', 'B');
    // A's legacy workspace holds only names the copy skips, so its real migration signs a receipt listing no files.
    writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([
      legacyWorkspace(s, 'legacy-a', { path: a, files: { 'visibility-canary.json': '{}', 'capability-history.lock.g1.done': '{}' } }),
    ], null, 2));
    writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify({ version: 1, entries: { 'legacy-a': { harness: H, evidence: 'fixture' } } }));
    registerProject(s.coreDir, a);
    assert.equal(applyMigration({ root: a, harness: H, coreDir: s.coreDir, table: { version: 1, entries: { 'legacy-a': { harness: H, evidence: 'fixture' } } } }).status, 'migrated');
    const aState = join(a, '_core', H);
    const receipt = JSON.parse(readFileSync(join(aState, RECEIPT), 'utf8'));
    assert.equal(receipt.live, 'legacy-a');
    assert.deepEqual(receipt.files, [], 'fixture: A\'s own signed receipt lists no files');

    // Content an older build later writes to A's legacy workspace.
    const aLegacy = join(s.coreDir, 'workspaces', 'legacy-a');
    writeFileSync(join(aLegacy, 'capability-history.jsonl'), '{"row":"SENTINEL-A"}\n');
    writeFileSync(join(aLegacy, 'notes.md'), 'SENTINEL-A private notes\n');

    registerProject(s.coreDir, b);
    touchProject(s.coreDir, { root: b, harness: H });
    const bState = join(b, '_core', H);
    assert.equal(existsSync(join(bState, RECEIPT)), false, 'B was never migrated');
    copyFileSync(join(aState, RECEIPT), join(bState, RECEIPT));
    copyFileSync(join(aState, `${RECEIPT}.mac`), join(bState, `${RECEIPT}.mac`));

    const drift = checkLegacyDrift({ root: b, harness: H, coreDir: s.coreDir });
    process.stdout.write(`# (b) --drift-check on B with A's copied receipt: ${JSON.stringify(drift)}\n`);
    const elsewhere = readdirSync(s.coreDir).filter((n) => n !== 'workspaces').flatMap((n) => filesUnder(join(s.coreDir, n)));
    const leaked = filesUnder(b).concat(elsewhere).filter((f) => readFileSync(f, 'utf8').includes('SENTINEL-A'));
    assert.deepEqual(leaked, [], 'nothing from A\'s legacy workspace reaches B');
    assert.ok(['receipt-unverified', 'not-migrated'].includes(drift.status), `a receipt from another project is refused, got ${drift.status}`);
  } finally { s.cleanup(); }
});
