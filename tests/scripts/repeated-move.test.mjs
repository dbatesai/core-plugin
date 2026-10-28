import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProject, touchProject } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { applyMigration } from '../../plugins/core/skills/core/scripts/migrate-workspace-state.mjs';
import { readSignedFileAt, writePinSigned, readPinSigned, classifyStamp } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { stampFile, readProjectCache } from '../../plugins/core/skills/core/scripts/state-cache.mjs';
import { acquireFileLock, releaseFileLock } from '../../plugins/core/skills/core/scripts/file-lock.mjs';

const H = 'claude-code';
const RECEIPT = 'migrated-from.json';
const WHEN = '2026-10-27T00:00:00.000Z';

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'repeated-move-'))));
  const home = join(base, 'home');
  const coreDir = join(home, '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, home, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/**
 * A project migrated from a legacy workspace at Projects/Old, with a file baseline and a metrics pin, then renamed to Projects/New.
 * `oldStamp` is the stamp's bytes before any moved run; writing them back makes the next startup take the moved path again.
 */
function migratedMoved(s) {
  const old = s.mk('Projects', 'Old');
  const ws = join(s.coreDir, 'workspaces', 'legacy');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'workspace.json'), JSON.stringify({ workspace_id: 'legacy', agent_name: 'Plover' }));
  writeFileSync(join(ws, 'capability-history.jsonl'), '{"row":1}\n');
  writeFileSync(join(ws, 'hot-section-draft.md'), 'draft\n');
  writeFileSync(join(s.coreDir, 'index.json'), JSON.stringify([{ workspace_id: 'legacy', name: 'legacy', path: old }], null, 2));
  const table = { version: 1, entries: { legacy: { harness: H, evidence: 'fixture' } } };
  writeFileSync(join(s.coreDir, 'migrate-harness-table.json'), JSON.stringify(table));
  registerProject(s.coreDir, old);
  const mig = applyMigration({ root: old, harness: H, coreDir: s.coreDir, table });
  assert.equal(mig.status, 'migrated', JSON.stringify(mig));
  const unit = join(old, 'notes.md');
  writeFileSync(unit, 'hello\n');
  assert.equal(stampFile(old, unit, 'h-notes', 'seed-writer', { now: '2026-10-01T00:00:00Z' }).stamped, true, 'fixture: baseline seeded');
  s.mk('Projects', 'Old', '_metrics');
  const meta = s.mk('Projects', 'Old', '_core', H, 'metrics');
  writePinSigned({ dir: meta, path: join(old, '_metrics'), root: old, coreDir: s.coreDir });
  assert.equal(readPinSigned({ dir: meta, root: old, coreDir: s.coreDir }), join(old, '_metrics'), 'fixture: pin seeded');
  const seeded = JSON.parse(readFileSync(join(old, '_core', H, RECEIPT), 'utf8'));
  assert.equal(seeded.root, old, 'fixture: the receipt names the old root');

  const now = join(s.base, 'Projects', 'New');
  renameSync(old, now);
  // Startup registers the new path before the move is noticed.
  registerProject(s.coreDir, now);
  const state = join(now, '_core', H);
  const stampPath = join(state, 'stamp');
  const receiptBytes = () => [readFileSync(join(state, RECEIPT)), readFileSync(join(state, `${RECEIPT}.mac`))];
  return { old, now, state, stampPath, oldStamp: readFileSync(stampPath), receiptFiles: seeded.files.length, receiptBytes };
}

// Paths are matched in their JSON-escaped form, then written with forward slashes, so Windows paths compare too.
const normalize = (s, v) => JSON.parse(JSON.stringify(v).split(JSON.stringify(s.base).slice(1, -1)).join('<BASE>').replaceAll('\\\\', '/'));

/** Registry, cache, pin, receipt and stamp as parsed values, with the sandbox path replaced so two sandboxes compare. */
function endState(s, m) {
  const rows = JSON.parse(readFileSync(join(s.coreDir, 'projects.json'), 'utf8'))
    .map(({ registered_at: _registered, last_seen: _seen, ...rest }) => rest);
  const cache = readProjectCache(m.now);
  const pinFile = join(m.state, 'metrics', 'storage-path.txt');
  const receipt = JSON.parse(readFileSync(join(m.state, RECEIPT), 'utf8'));
  const stamp = JSON.parse(readFileSync(m.stampPath, 'utf8'));
  return normalize(s, {
    registry: rows,
    cache: { status: cache.status, files: cache.files },
    pin: {
      body: existsSync(pinFile) ? JSON.parse(readFileSync(pinFile, 'utf8')) : null,
      verifies: readPinSigned({ dir: join(m.state, 'metrics'), root: m.now, coreDir: s.coreDir }),
    },
    receipt: {
      verifies: readSignedFileAt({ dir: m.state, name: RECEIPT, coreDir: s.coreDir }) !== null,
      root: receipt.root,
      files: receipt.files.map(({ from, to, sha256, length }) => ({ from, to, sha256, length })),
    },
    stamp: { path: stamp.path, status: classifyStamp({ root: m.now, harness: H, coreDir: s.coreDir }).status },
  });
}

/** One startup: register the folder, then touch it. Returns the state-moved event's reports, or null when none ran. */
function startup(s, m) {
  registerProject(s.coreDir, m.now);
  const touched = touchProject(s.coreDir, { root: m.now, harness: H, when: WHEN });
  const ev = touched.events.find((e) => e.kind === 'state-moved');
  if (!ev) return null;
  return {
    cache: ev.repointed.cache.status,
    pins: ev.repointed.pins.map((p) => p.status),
    receipts: ev.repointed.receipts.map(({ folder: _folder, ...r }) => r),
  };
}

function writeBackOldStamp(s, m) {
  writeFileSync(m.stampPath, m.oldStamp);
  assert.equal(classifyStamp({ root: m.now, harness: H, coreDir: s.coreDir }).status, 'moved', 'precondition: the old stamp reads as moved');
}

/** The end state one clean moved run leaves, from its own sandbox. */
function cleanRunEndState() {
  const s = sandbox();
  try {
    const m = migratedMoved(s);
    assert.ok(startup(s, m), 'CORE\'s own move handling ran');
    return endState(s, m);
  } finally { s.cleanup(); }
}

test('one moved run carries the cache, metrics pin and receipt to the new path', () => {
  const s = sandbox();
  try {
    const m = migratedMoved(s);
    assert.equal(classifyStamp({ root: m.now, harness: H, coreDir: s.coreDir }).status, 'moved', 'precondition: moved');
    const run = startup(s, m);
    assert.deepEqual(run, { cache: 'repointed', pins: ['repointed'], receipts: [{ status: 'repointed', count: m.receiptFiles }] });

    const end = endState(s, m);
    assert.deepEqual(end.registry, [{ path: '<BASE>/Projects/New', moved_from: '<BASE>/Projects/Old' }], 'one registry row, for the new path');
    assert.deepEqual(Object.keys(end.cache.files), ['<BASE>/Projects/New/notes.md']);
    assert.equal(end.pin.verifies, '<BASE>/Projects/New/_metrics');
    assert.equal(end.receipt.verifies, true);
    assert.equal(end.receipt.root, '<BASE>/Projects/New');
    for (const f of end.receipt.files) assert.ok(f.to.startsWith('<BASE>/Projects/New/'), `destination under the new path: ${f.to}`);
    assert.deepEqual(end.stamp, { path: '<BASE>/Projects/New', status: 'verified' });
  } finally { s.cleanup(); }
});

test('a moved run repeated with the old stamp written back reaches the same end state as one run', () => {
  const reference = cleanRunEndState();
  const s = sandbox();
  try {
    const m = migratedMoved(s);
    assert.ok(startup(s, m), 'CORE\'s own move handling ran');
    assert.deepEqual(endState(s, m), reference, 'after run 1');
    for (const n of [2, 3]) {
      writeBackOldStamp(s, m);
      const before = m.receiptBytes();
      const run = startup(s, m);
      assert.deepEqual(run, { cache: 'nothing-to-do', pins: ['already-current'], receipts: [{ status: 'already-current' }] }, `run ${n}`);
      assert.deepEqual(m.receiptBytes(), before, `run ${n}: receipt and its MAC are unchanged`);
      assert.deepEqual(endState(s, m), reference, `after run ${n}`);
    }
  } finally { s.cleanup(); }
});

test('a receipt carry held by the close lock is carried by the next moved run', () => {
  const reference = cleanRunEndState();
  const s = sandbox();
  try {
    const m = migratedMoved(s);
    const lockFile = join(m.now, '_memories', '_close.lock');
    const lock = acquireFileLock(lockFile, { extra: { session_id: 'test-close' } });
    assert.ok(lock.ok, 'fixture: the close lock is held');
    let held;
    try { held = startup(s, m); } finally { releaseFileLock(lockFile, lock.nonce); }
    assert.deepEqual(held?.receipts, [{ status: 'held', reason: 'lock-held' }]);
    assert.equal(endState(s, m).receipt.root, '<BASE>/Projects/Old', 'the held receipt still names the old root');

    writeBackOldStamp(s, m);
    const run = startup(s, m);
    assert.deepEqual(run?.receipts, [{ status: 'repointed', count: m.receiptFiles }]);
    assert.deepEqual(endState(s, m), reference);
  } finally { s.cleanup(); }
});
