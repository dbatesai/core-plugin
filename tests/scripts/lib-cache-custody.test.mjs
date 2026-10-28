import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync, realpathSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeBoundaryProblem } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { writeEnrichment } from '../../plugins/core/skills/core/scripts/enrichment-sidecar.mjs';
import { recordSessionStart, readSessionInventory } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';
import { linkFolder, linkFile, FILE_LINK_SKIP } from '../helpers/links.mjs';

const FIFO_SKIP = process.platform === 'win32' ? 'mkfifo is POSIX' : false;
const FOREIGN = 'foreign bytes\n';
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-lib-custody-')));
  const root = join(base, 'project'), lib = join(root, '_memories', '_lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(root, '_memories', 'u1.md'), '---\nid: u1\ntype: observation\n---\nbody\n');
  const foreign = join(base, 'foreign.json'); writeFileSync(foreign, FOREIGN);
  return { base, root, lib, foreign, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
const payload = { unitPath: 'u1.md', writerModelFamily: 'OPUS', answerModelFamily: 'FABLE', aliases: ['x'] };

test('ordinary cache files, and a lock file holding a second name in the same folder, pass the store check', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.lib, 'state-cache.json'), '{}');
    writeFileSync(join(f.lib, '.state-cache.lock'), 'x'); linkSync(join(f.lib, '.state-cache.lock'), join(f.lib, '.state-cache.lock.gen'));
    assert.equal(storeBoundaryProblem(f.root), null);
    recordSessionStart(f.root);
    assert.ok(readSessionInventory(f.root), 'the session inventory is written and read back');
    writeEnrichment(f.root, payload);
    assert.ok(existsSync(join(f.lib, 'enrichment-sidecar.json')), 'control: the sidecar is written');
  } finally { f.cleanup(); }
});

// Each refusal runs in a child with a time limit, so a reader that opens a FIFO fails the test
// instead of hanging the suite.
const scripts = new URL('../../plugins/core/skills/core/scripts/', import.meta.url).href;
function inChild(root, body) {
  const code = `import assert from 'node:assert/strict';
    const g = await import(${JSON.stringify(scripts + 'generate-summary-index.mjs')});
    const e = await import(${JSON.stringify(scripts + 'enrichment-sidecar.mjs')});
    const l = await import(${JSON.stringify(scripts + 'lifecycle-detect.mjs')});
    const root = ${JSON.stringify(root)}, payload = ${JSON.stringify(payload)};
    ${body}
    console.log('ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.signal, null, 'did not block');
  assert.equal(r.stdout.trim(), 'ok', r.stderr);
}

for (const [name, body] of [
  ['unit-summaries.json', `assert.throws(() => g.loadFreshIndex(root), /store refused/);`],
  ['enrichment-sidecar.json', `assert.throws(() => e.loadValidEnrichments(root, { units: [] }), /store refused/);
    assert.throws(() => e.writeEnrichment(root, payload), /store refused/);`],
  ['.lifecycle-session.json', `assert.equal(l.readSessionInventory(root), null);
    assert.throws(() => l.recordSessionStart(root), /store refused/);`],
]) {
  for (const shape of ['a second hard link', 'a FIFO']) {
    test(`a cache file ${name} that is ${shape} is never read or written through`, { skip: shape === 'a FIFO' ? FIFO_SKIP : false }, () => {
      const f = fixture();
      try {
        const leaf = join(f.lib, name);
        if (shape === 'a FIFO') execFileSync('mkfifo', [leaf]); else linkSync(f.foreign, leaf);
        assert.equal(storeBoundaryProblem(f.root)?.code, 'STORE_OUTSIDE_ROOT');
        inChild(f.root, body);
        assert.equal(readFileSync(f.foreign, 'utf8'), FOREIGN, 'the other name keeps its bytes');
      } finally { f.cleanup(); }
    });
  }
}

test('a linked _lib folder gets no sidecar, lock or session inventory where the link leads', () => {
  const f = fixture();
  try {
    const outside = join(f.base, 'outside-lib'); mkdirSync(outside);
    rmSync(f.lib, { recursive: true }); linkFolder(outside, f.lib);
    inChild(f.root, `assert.throws(() => e.writeEnrichment(root, payload), /store refused/);
      assert.throws(() => l.recordSessionStart(root), /store refused/);`);
    assert.deepEqual(readdirSync(outside), [], 'nothing was created through the link');
  } finally { f.cleanup(); }
});

test('a lock file that is a FIFO, a link or a second hard link is refused before it is read: no hang, nothing written, the planted file kept', async (t) => {
  for (const [shape, skip] of [['a FIFO', FIFO_SKIP], ['a link', FILE_LINK_SKIP], ['a second hard link', false]]) await t.test(shape, { skip }, () => {
    const f = fixture();
    try {
      const lock = join(f.lib, '.enrichment-sidecar.lock');
      if (shape === 'a FIFO') execFileSync('mkfifo', [lock]);
      else if (shape === 'a link') linkFile(f.foreign, lock);
      else linkSync(f.foreign, lock);
      inChild(f.root, `const fl = await import(${JSON.stringify(scripts + 'file-lock.mjs')});
        const lock = ${JSON.stringify(lock)};
        assert.equal(fl.acquireFileLock(lock).reason, 'unsafe-lock-file');
        assert.equal(fl.inspectFileLock(lock).held, true);
        assert.throws(() => e.writeEnrichment(root, payload), (err) => err.code === 'LOCK_UNSAFE' || err.code === 'STORE_OUTSIDE_ROOT');`);
      assert.equal(existsSync(join(f.lib, 'enrichment-sidecar.json')), false, `${shape}: no sidecar`);
      assert.equal(readFileSync(f.foreign, 'utf8'), FOREIGN, `${shape}: the other name keeps its bytes`);
    } finally { f.cleanup(); }
  });
});

test('a held lock generation replaced by a FIFO or a link before release: release fails by name without reading it, and the operation result or error is kept', async (t) => {
  // The FIFO half keeps the operation's result through a failed release; the link half keeps the operation's own error.
  for (const [shape, skip] of [['fifo', FIFO_SKIP], ['link', FILE_LINK_SKIP]]) await t.test(shape, { skip }, () => {
    const f = fixture();
    try {
      const lock = join(f.lib, '.probe.lock');
      inChild(f.root, `const fl = await import(${JSON.stringify(scripts + 'file-lock.mjs')});
        const { execFileSync } = await import('node:child_process');
        const fs = await import('node:fs');
        const lock = ${JSON.stringify(lock)}, foreign = ${JSON.stringify(f.foreign)}, shape = ${JSON.stringify(shape)};
        const replace = (shape) => { const g = fl.currentLockFile(lock); fs.rmSync(g); if (shape === 'fifo') execFileSync('mkfifo', [g]); else fs.symlinkSync(foreign, g); return g; };
        // healthy control
        let got = fl.acquireFileLock(lock);
        assert.equal(got.ok, true);
        assert.equal(fl.releaseFileLock(lock, got.nonce).released, true);
        got = fl.acquireFileLock(lock);
        assert.equal(got.ok, true, shape);
        const planted = replace(shape);
        const rel = fl.releaseFileLock(lock, got.nonce);
        assert.equal(rel.released, false, shape);
        assert.equal(rel.reason, 'unsafe-lock-file', shape);
        assert.ok(fs.lstatSync(planted), shape + ': the planted file is left in place');
        assert.equal(fl.releaseFileLock(lock, null, { force: true }).released, true, 'operator force release clears it');
        got = fl.acquireFileLock(lock);
        if (shape === 'fifo') {
          // the operation's result survives a failed release
          assert.throws(() => fl.withAcquiredFileLock(lock, got.nonce, () => { replace('fifo'); return 'material'; }),
            (err) => err.code === 'LOCK_RELEASE_FAILED' && err.operationResult === 'material' && err.releaseResult.reason === 'unsafe-lock-file');
        } else {
          // and so does the operation's own error
          assert.throws(() => fl.withAcquiredFileLock(lock, got.nonce, () => { replace('link'); throw new Error('boom'); }),
            (err) => err.message === 'boom' && err.lockReleaseFailure.reason === 'unsafe-lock-file');
        }
        fl.releaseFileLock(lock, null, { force: true });`);
      assert.equal(readFileSync(f.foreign, 'utf8'), FOREIGN);
    } finally { f.cleanup(); }
  });
});
