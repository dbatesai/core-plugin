import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureStore, generateSummaryIndex, loadFreshIndex } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { buildRetrievalTrace, buildFinalContextPack, storeHealth, main } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'core-incomplete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, '_memories', 'nested'), { recursive: true });
  for (const [file, id, title] of [['unit-1.md', 'unit-1', 'ordinary apples'], ['nested/unit-2.md', 'unit-2', 'forbidden zeppelin']]) {
    fs.writeFileSync(join(root, '_memories', file), `---\nid: ${id}\ntype: decision\nstatus: active\n---\n# ${title}\n`);
  }
  return root;
}

// Deterministic EACCES works on Windows and under root; exercise real public
// entry points while replacing only one filesystem operation at its boundary.
function failIo(method, path, fn) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    if (String(file) === path) throw Object.assign(new Error('synthetic permission denied'), { code: 'EACCES' });
    return original.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  try { return fn(); } finally { fs[method] = original; syncBuiltinESMExports(); }
}

for (const [label, method, suffix, relative] of [
  ['file read', 'readFileSync', 'nested/unit-2.md', 'nested/unit-2.md'],
  ['directory traversal', 'readdirSync', 'nested', 'nested/'],
  ['file stat', 'statSync', 'nested/unit-2.md', 'nested/unit-2.md'],
]) {
  test(`${label} failure is incomplete and never replaces a complete cache`, t => {
    const root = fixture(t);
    assert.equal(generateSummaryIndex(root).count, 2);
    const cachePath = join(root, '_memories', '_lib', 'unit-summaries.json');
    const before = fs.readFileSync(cachePath, 'utf8');
    failIo(method, join(root, '_memories', suffix), () => {
      for (const index of [captureStore(root).index, loadFreshIndex(root), generateSummaryIndex(root)]) {
        assert.equal(index.count, 1);
        assert.equal(index.degraded, true);
        assert.equal(index.incomplete, true);
        assert.deepEqual(index.read_errors, [{ path: relative, code: 'EACCES' }]);
        assert.equal(fs.readFileSync(cachePath, 'utf8'), before, 'complete cache bytes preserved');
      }
      const health = storeHealth(root);
      assert.equal(health.incomplete, true, 'health cannot certify an old complete cache');
      assert.deepEqual(health.read_errors, [{ path: relative, code: 'EACCES' }]);
    });
    const recovered = buildRetrievalTrace('forbidden zeppelin', root);
    assert.equal(recovered.health.incomplete, false);
    assert.equal(recovered.stages.final[0].id, 'unit-2');
  });
}

test('incomplete no-match emits an explicit warning in the production trace and CLI pack', t => {
  const root = fixture(t);
  failIo('readFileSync', join(root, '_memories', 'nested/unit-2.md'), () => {
    const trace = buildRetrievalTrace('forbidden zeppelin', root);
    assert.equal(trace.stages.final.length, 0);
    assert.equal(trace.health.incomplete, true);
    assert.match(trace.pack.text, /search incomplete/i);
    assert.match(trace.pack.text, /unreadable/);
    assert.doesNotMatch(trace.pack.text, /0 duplicate/);
    assert.ok(trace.pack.warnings.length);
    assert.equal(fs.existsSync(join(root, '_memories', '_lib', 'unit-summaries.json')), false);
    const original = process.stdout.write;
    let out = '';
    process.stdout.write = chunk => { out += chunk; return true; };
    try { main([root, 'forbidden zeppelin', '--pack']); } finally { process.stdout.write = original; }
    assert.match(out, /search incomplete/i);
  });
  assert.equal(buildRetrievalTrace('no_matching_terms', root).pack.text, '', 'healthy no-match stays empty');
});

test('incomplete warning takes priority over hits without exceeding the byte cap', () => {
  const health = { degraded: true, incomplete: true, read_errors: [{ path: 'unit-2.md', code: 'EACCES' }], duplicate_conflicts: [] };
  for (const byteCap of [0, 1, 80, 200, 2048]) {
    const pack = buildFinalContextPack([{ id: 'unit-1', summary: 'x'.repeat(2000), tier: 'canonical', score: 1 }], { health, byteCap });
    assert.ok(pack.bytes <= byteCap);
    assert.ok(pack.warnings.some(w => /search incomplete/i.test(w)));
    if (byteCap >= 200) assert.match(pack.text, /search incomplete/i);
    if (!/search incomplete/i.test(pack.text)) assert.equal(pack.accepted.length, 0, 'never deliver hits as complete when warning cannot fit');
  }
});

test('an inaccessible store root is incomplete, not storeless; a truly missing store stays read-only', t => {
  const root = fixture(t);
  const memories = join(root, '_memories');
  const exists = fs.existsSync;
  // existsSync returns false for EACCES as well as ENOENT. Simulate that native
  // boundary deterministically on every platform, including privileged runners.
  fs.existsSync = file => String(file) === memories ? false : exists(file);
  syncBuiltinESMExports();
  try {
    failIo('statSync', memories, () => failIo('readdirSync', memories, () => {
      const trace = buildRetrievalTrace('forbidden zeppelin', root);
      assert.notEqual(trace.storeless, true);
      assert.equal(trace.health.incomplete, true);
      assert.deepEqual(trace.health.read_errors, [{ path: '.', code: 'EACCES' }]);
      assert.match(trace.pack.text, /search incomplete/i);
    }));
  } finally { fs.existsSync = exists; syncBuiltinESMExports(); }
  const missing = join(root, 'absent-project');
  assert.equal(buildRetrievalTrace('anything', missing).storeless, true);
  assert.equal(fs.existsSync(missing), false, 'a true missing store is never created');
});
