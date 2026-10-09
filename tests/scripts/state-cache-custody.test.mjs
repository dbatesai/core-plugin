// The state cache is CORE's generated file: it must physically be the project's own. A linked folder,
// or a cache file or lock file that is a link or has a second hard link, is refused before anything
// is created, read or locked, and nothing foreign is inherited or changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stampFiles, readProjectCache, cacheCustodyProblem, CACHE_UNREADABLE, CACHE_ABSENT } from '../../plugins/core/skills/core/scripts/state-cache.mjs';

const skip = process.platform === 'win32';
const FOREIGN = JSON.stringify({ files: { 'FOREIGN.md': { last_hash: 'f0f0', last_written_by: 'someone-else' } } }, null, 2) + '\n';
const ENTRY = [{ path: 'a.md', hash: 'abc', lastWrittenBy: 'test' }];
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cache-custody-')));
  const root = join(base, 'project'); const foreign = join(base, 'foreign');
  mkdirSync(join(root, '_memories'), { recursive: true }); mkdirSync(foreign);
  writeFileSync(join(foreign, 'state-cache.json'), FOREIGN);
  const snapshot = () => { const o = {}; const walk = (d, pre) => { for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (e.isDirectory()) { o[pre + e.name + '/'] = 'dir'; walk(join(d, e.name), pre + e.name + '/'); } else o[pre + e.name] = readFileSync(join(d, e.name), 'utf8'); } }; walk(foreign, ''); return o; };
  return { base, root, foreign, snapshot, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('control: a regular project stamps its own cache; a never-stamped project reads as absent; an alias path works', { skip }, () => {
  const s = setup();
  try {
    assert.equal(cacheCustodyProblem(s.root), null);
    assert.equal(readProjectCache(s.root).status, CACHE_ABSENT);
    assert.equal(stampFiles(s.root, ENTRY).stamped, true);
    assert.equal(readProjectCache(s.root).files['a.md'].last_hash, 'abc');
    assert.equal(stampFiles(s.root, [{ path: 'b.md', hash: 'def', lastWrittenBy: 'test' }]).stamped, true, 'a second stamp over its own cache and released lock');
    const alias = join(s.base, 'alias'); symlinkSync(s.root, alias);
    assert.equal(stampFiles(alias, [{ path: 'c.md', hash: '123', lastWrittenBy: 'test' }]).stamped, true);
    assert.deepEqual(Object.keys(readProjectCache(s.root).files).sort(), ['a.md', 'b.md', 'c.md']);
    assert.deepEqual(s.snapshot(), { 'state-cache.json': FOREIGN });
  } finally { s.cleanup(); }
});

const cases = {
  '_memories/_lib is a link out': (s) => symlinkSync(s.foreign, join(s.root, '_memories', '_lib')),
  '_memories is a link out': (s) => { rmSync(join(s.root, '_memories'), { recursive: true }); mkdirSync(join(s.foreign, '_lib')); symlinkSync(s.foreign, join(s.root, '_memories')); },
  'the cache file is a link': (s) => { mkdirSync(join(s.root, '_memories', '_lib')); symlinkSync(join(s.foreign, 'state-cache.json'), join(s.root, '_memories', '_lib', 'state-cache.json')); },
  'the cache file has a second hard link': (s) => { mkdirSync(join(s.root, '_memories', '_lib')); linkSync(join(s.foreign, 'state-cache.json'), join(s.root, '_memories', '_lib', 'state-cache.json')); },
  'a lock generation has a second hard link': (s) => { mkdirSync(join(s.root, '_memories', '_lib')); writeFileSync(join(s.foreign, 'lockish'), '{}'); linkSync(join(s.foreign, 'lockish'), join(s.root, '_memories', '_lib', '.state-cache.lock.g1')); },
};
for (const [name, plant] of Object.entries(cases)) {
  test(`refused, nothing foreign inherited or changed: ${name}`, { skip }, () => {
    const s = setup();
    try {
      plant(s);
      const before = s.snapshot();
      assert.ok(cacheCustodyProblem(s.root));
      const read = readProjectCache(s.root);
      assert.equal(read.status, CACHE_UNREADABLE);
      assert.deepEqual(read.files, {}, 'no foreign baseline entry is returned');
      assert.match(read.error, /^cache-custody: /);
      const r = stampFiles(s.root, ENTRY);
      assert.deepEqual([r.stamped, r.outcome], [false, 'refused']);
      assert.match(r.reason, /^cache-custody: /);
      assert.deepEqual(s.snapshot(), before, 'foreign bytes and names are unchanged: no stamp, no lock artifact');
    } finally { s.cleanup(); }
  });
}

test('a FIFO where the cache file should be is refused without being opened: the read and the stamp both return, bounded', { skip }, () => {
  const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const mod = pathToFileURL(join(REPO, 'plugins/core/skills/core/scripts/state-cache.mjs')).href;
  const s = setup();
  try {
    const lib = join(s.root, '_memories', '_lib'); mkdirSync(lib);
    const fifo = join(lib, 'state-cache.json'); execFileSync('mkfifo', [fifo]);
    const script = `const m = await import(${JSON.stringify(mod)}); const read = m.readProjectCache(${JSON.stringify(s.root)}); const stamp = m.stampFiles(${JSON.stringify(s.root)}, [{ path: 'a.md', hash: 'abc', lastWrittenBy: 't' }]); console.log(JSON.stringify({ read: [read.status, read.error], stamp: [stamp.stamped, stamp.outcome, stamp.reason] }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000 });
    assert.equal(r.signal, null, 'neither call blocked on the FIFO');
    const out = JSON.parse(r.stdout);
    assert.equal(out.read[0], CACHE_UNREADABLE);
    assert.match(out.read[1], /^cache-custody: .*state-cache\.json is not a regular file/);
    assert.deepEqual(out.stamp.slice(0, 2), [false, 'refused']);
    assert.match(out.stamp[2], /^cache-custody: /);
    assert.equal(existsSync(fifo), true, 'the FIFO is left as found');
  } finally { s.cleanup(); }
});

test('a directory where the cache file should be stays the ordinary unreadable case, not a custody refusal', () => {
  const s = setup();
  try {
    mkdirSync(join(s.root, '_memories', '_lib', 'state-cache.json'), { recursive: true });
    assert.equal(cacheCustodyProblem(s.root), null);
    const read = readProjectCache(s.root);
    assert.equal(read.status, CACHE_UNREADABLE);
    assert.doesNotMatch(read.error, /cache-custody/);
  } finally { s.cleanup(); }
});
