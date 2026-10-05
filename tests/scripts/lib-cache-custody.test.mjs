import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync, realpathSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeBoundaryProblem } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { writeEnrichment } from '../../plugins/core/skills/core/scripts/enrichment-sidecar.mjs';
import { recordSessionStart, readSessionInventory } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';

const isWin = process.platform === 'win32';
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

test('ordinary cache files, and a lock file holding a second name in the same folder, pass the store check', { skip: isWin }, () => {
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
    test(`a cache file ${name} that is ${shape} is never read or written through`, { skip: isWin }, () => {
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

test('a linked _lib folder gets no sidecar, lock or session inventory where the link leads', { skip: isWin }, () => {
  const f = fixture();
  try {
    const outside = join(f.base, 'outside-lib'); mkdirSync(outside);
    rmSync(f.lib, { recursive: true }); symlinkSync(outside, f.lib);
    inChild(f.root, `assert.throws(() => e.writeEnrichment(root, payload), /store refused/);
      assert.throws(() => l.recordSessionStart(root), /store refused/);`);
    assert.deepEqual(readdirSync(outside), [], 'nothing was created through the link');
  } finally { f.cleanup(); }
});

test('a lock file that is a FIFO, a link or a second hard link is refused before it is read: no hang, nothing written, the planted file kept', { skip: isWin }, () => {
  for (const shape of ['a FIFO', 'a link', 'a second hard link']) {
    const f = fixture();
    try {
      const lock = join(f.lib, '.enrichment-sidecar.lock');
      if (shape === 'a FIFO') execFileSync('mkfifo', [lock]);
      else if (shape === 'a link') symlinkSync(f.foreign, lock);
      else linkSync(f.foreign, lock);
      inChild(f.root, `const fl = await import(${JSON.stringify(scripts + 'file-lock.mjs')});
        const lock = ${JSON.stringify(lock)};
        assert.equal(fl.acquireFileLock(lock).reason, 'unsafe-lock-file');
        assert.equal(fl.inspectFileLock(lock).held, true);
        assert.throws(() => e.writeEnrichment(root, payload), (err) => err.code === 'LOCK_UNSAFE' || err.code === 'STORE_OUTSIDE_ROOT');`);
      assert.equal(existsSync(join(f.lib, 'enrichment-sidecar.json')), false, `${shape}: no sidecar`);
      assert.equal(readFileSync(f.foreign, 'utf8'), FOREIGN, `${shape}: the other name keeps its bytes`);
    } finally { f.cleanup(); }
  }
});
