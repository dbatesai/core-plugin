// Negative controls for the attempted-access gate: an outside read or write is refused and recorded
// whether the code imports fs by default or by name, and the outside sentinel's bytes never change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GATE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'fs-confine.mjs')).href;
const inside = realpathSync(mkdtempSync(join(tmpdir(), 'confine-in-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'confine-out-')));
const sentinel = join(outside, 'sentinel.txt');
writeFileSync(sentinel, 'outside bytes\n');

const run = (code) => {
  const r = spawnSync(process.execPath, ['--import', GATE, '--input-type=module', '-e', code], { env: { ...process.env, FS_CONFINE_ROOTS: inside }, encoding: 'utf8' });
  return { ...r, violations: JSON.parse(r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/)[1]) };
};
const S = JSON.stringify(sentinel);

for (const [label, imp, read, write] of [
  ['named import', "import { readFileSync, writeFileSync } from 'node:fs';", 'readFileSync', 'writeFileSync'],
  ['default import', "import fs from 'node:fs';", 'fs.readFileSync', 'fs.writeFileSync'],
  ['promises', "import { readFile, writeFile } from 'node:fs/promises';", 'await readFile', 'await writeFile'],
]) {
  test(`${label}: an outside read and write are refused and recorded; the sentinel is unchanged`, () => {
    const r = run(`${imp}
      const out = [];
      try { ${read}(${S}, 'utf8'); out.push('read-ok'); } catch (e) { out.push(e.code); }
      try { ${write}(${S}, 'clobbered'); out.push('write-ok'); } catch (e) { out.push(e.code); }
      ${write}(${JSON.stringify(join(inside, 'ok.txt'))}, 'inside'); out.push('inside-ok');
      process.stdout.write(out.join(','));`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'EACCES,EACCES,inside-ok');
    assert.equal(r.violations.length, 2);
    assert.ok(r.violations.every(v => v.path === sentinel));
    assert.equal(readFileSync(sentinel, 'utf8'), 'outside bytes\n');
  });
}

test('existsSync outside reads as absent and is recorded', () => {
  const r = run(`import { existsSync } from 'node:fs'; process.stdout.write(String(existsSync(${S})));`);
  assert.equal(r.stdout, 'false');
  assert.deepEqual(r.violations.map(v => v.call), ['existsSync']);
});

test('realpathSync.native outside is refused and recorded too; inside it still works', () => {
  const r = run(`import { realpathSync } from 'node:fs';
    const out = [];
    try { realpathSync.native(${S}); out.push('ok'); } catch (e) { out.push(e.code); }
    out.push(realpathSync.native(${JSON.stringify(inside)}) === ${JSON.stringify(inside)} ? 'inside-ok' : 'inside-bad');
    process.stdout.write(out.join(','));`);
  assert.equal(r.stdout, 'EACCES,inside-ok');
  assert.deepEqual(r.violations.map(v => v.call), ['realpathSync.native']);
});

test('a link inside a root that leads outside is judged by where it leads; lstat of the link itself is allowed', { skip: process.platform === 'win32' ? 'symlink fixtures need POSIX' : false }, async () => {
  const { symlinkSync } = await import('node:fs');
  const link = join(inside, 'out-link');
  symlinkSync(outside, link);
  const L = JSON.stringify(join(link, 'sentinel.txt'));
  const r = run(`import { readFileSync, lstatSync } from 'node:fs';
    const out = [];
    out.push(lstatSync(${JSON.stringify(link)}).isSymbolicLink() ? 'lstat-ok' : 'lstat-bad');
    try { readFileSync(${L}, 'utf8'); out.push('read-ok'); } catch (e) { out.push(e.code); }
    process.stdout.write(out.join(','));`);
  assert.equal(r.stdout, 'lstat-ok,EACCES');
  assert.deepEqual(r.violations.map(v => v.call), ['readFileSync']);
});

test('cleanup', () => { rmSync(inside, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
