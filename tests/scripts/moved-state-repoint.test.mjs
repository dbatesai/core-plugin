import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, renameSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProject, touchProject, settleState } from '../../plugins/core/skills/core/scripts/index-registry.mjs';
import { writePinSigned, readPinSigned, updateManifest } from '../../plugins/core/skills/core/scripts/project-state.mjs';
import { stampFile, hashText, readProjectCache, projectCachePath } from '../../plugins/core/skills/core/scripts/state-cache.mjs';

const H = 'claude-code';

function sandbox() {
  const base = realpathSync(realpathSync.native(mkdtempSync(join(tmpdir(), 'moved-repoint-'))));
  const coreDir = join(base, 'home', '.core');
  mkdirSync(coreDir, { recursive: true });
  const mk = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p; };
  return { base, coreDir, mk, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// A registered project with one stamped file and a signed metrics pin, as a few sessions would leave it.
function seeded(s, ...parts) {
  const p = s.mk(...parts);
  registerProject(s.coreDir, p);
  updateManifest({ root: p, harness: H, coreDir: s.coreDir, fields: { agent_name: 'Plover' } });
  const text = '# Project\n\nBudget: 40k\n';
  writeFileSync(join(p, 'PROJECT.md'), text);
  const out = stampFile(p, join(p, 'PROJECT.md'), hashText(text), 'test-writer', { now: '2026-09-01T10:00:00Z' });
  assert.equal(out.stamped, true);
  const meta = join(p, '_core', H, 'metrics');
  mkdirSync(meta, { recursive: true });
  mkdirSync(join(p, '_metrics'), { recursive: true });
  writePinSigned({ dir: meta, path: join(p, '_metrics'), root: p, coreDir: s.coreDir });
  assert.equal(readPinSigned({ dir: meta, root: p, coreDir: s.coreDir }), join(p, '_metrics'));
  return { p, text, meta };
}

test('a confirmed move carries the file baseline and the metrics pin to the new path, hashes and times unchanged', () => {
  const s = sandbox();
  try {
    const { p, text } = seeded(s, 'Projects', 'Old');
    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved);
    const r = touchProject(s.coreDir, { root: moved, harness: H });
    const ev = r.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'the move is reported');
    assert.equal(ev.repointed.cache.status, 'repointed');
    assert.equal(ev.repointed.cache.count, 1);

    const files = readProjectCache(moved).files;
    assert.deepEqual(Object.keys(files), [join(moved, 'PROJECT.md')], 'the old key is gone, the new one is present');
    const stamp = files[join(moved, 'PROJECT.md')];
    assert.equal(stamp.last_hash, hashText(text), 'hash kept');
    assert.equal(stamp.last_written, '2026-09-01T10:00:00Z', 'time kept: nothing was re-baselined');
    assert.equal(stamp.last_written_by, 'test-writer');

    const meta = join(moved, '_core', H, 'metrics');
    assert.equal(readPinSigned({ dir: meta, root: moved, coreDir: s.coreDir }), join(moved, '_metrics'), 'pin names the new folder');
    assert.ok(ev.repointed.pins.some((x) => x.status === 'repointed'));

    // An edit made before the next pass is still detected: the baseline hash is not the edited text's.
    const edited = text.replace('40k', '55k');
    assert.notEqual(hashText(edited), stamp.last_hash);
  } finally { s.cleanup(); }
});

test('the user-answered move (state-ask, accept-move) repoints the same two records', () => {
  const s = sandbox();
  try {
    const { p, text } = seeded(s, 'Drive', 'Projects', 'P');
    const here = join(s.base, 'P');
    renameSync(p, here);
    rmSync(join(s.base, 'Drive'), { recursive: true, force: true });
    registerProject(s.coreDir, here);
    const out = settleState(s.coreDir, { root: here, harness: H, decision: 'accept-move' });
    assert.equal(out.changed, true);
    assert.equal(out.repointed.cache.status, 'repointed');
    const stamp = readProjectCache(here).files[join(here, 'PROJECT.md')];
    assert.equal(stamp.last_hash, hashText(text));
    assert.equal(readPinSigned({ dir: join(here, '_core', H, 'metrics'), root: here, coreDir: s.coreDir }), join(here, '_metrics'));
  } finally { s.cleanup(); }
});

test('a copied folder is not a move: the original keeps its records and the copy gets no baseline from them', () => {
  const s = sandbox();
  try {
    const { p } = seeded(s, 'Projects', 'Orig');
    const copy = join(s.base, 'Projects', 'Copy');
    cpSync(p, copy, { recursive: true });
    const origCache = readFileSync(projectCachePath(p), 'utf8');
    registerProject(s.coreDir, copy);
    const r = touchProject(s.coreDir, { root: copy, harness: H });
    assert.ok(r.events.some((e) => e.kind === 'state-copied'));
    assert.ok(!r.events.some((e) => e.kind === 'state-moved'));
    assert.equal(readFileSync(projectCachePath(p), 'utf8'), origCache, 'the original baseline is untouched');
    const copyKeys = Object.keys(readProjectCache(copy).files);
    assert.ok(!copyKeys.includes(join(copy, 'PROJECT.md')), 'the copy does not inherit a baseline for its own path');
    assert.equal(readPinSigned({ dir: join(copy, '_core', H, 'metrics'), root: copy, coreDir: s.coreDir }), null, 'the copy does not inherit the pin');
    assert.ok(existsSync(join(p, 'PROJECT.md')));
  } finally { s.cleanup(); }
});

test('a damaged baseline is held and left as found, and the move still completes', () => {
  const s = sandbox();
  try {
    const { p } = seeded(s, 'Projects', 'Old');
    writeFileSync(projectCachePath(p), '{ not json');
    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved);
    const r = touchProject(s.coreDir, { root: moved, harness: H });
    const ev = r.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev, 'the move itself still goes through');
    assert.equal(ev.repointed.cache.status, 'held');
    assert.equal(readFileSync(projectCachePath(moved), 'utf8'), '{ not json', 'damaged bytes are kept, not rewritten');
  } finally { s.cleanup(); }
});

test('a pin that names a folder outside the old root is left as it was and reported', () => {
  const s = sandbox();
  try {
    const { p, meta } = seeded(s, 'Projects', 'Old');
    const elsewhere = s.mk('elsewhere', 'metrics');
    writePinSigned({ dir: meta, path: elsewhere, root: p, coreDir: s.coreDir });
    const moved = join(s.base, 'Projects', 'New');
    renameSync(p, moved);
    registerProject(s.coreDir, moved);
    const r = touchProject(s.coreDir, { root: moved, harness: H });
    const ev = r.events.find((e) => e.kind === 'state-moved');
    assert.ok(ev.repointed.pins.some((x) => x.status === 'left-outside-old-root'));
    assert.equal(readPinSigned({ dir: join(moved, '_core', H, 'metrics'), root: moved, coreDir: s.coreDir }), null, 'no pin is invented for the new root');
  } finally { s.cleanup(); }
});
