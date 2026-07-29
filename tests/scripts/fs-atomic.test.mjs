import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync, renameWithRetrySync, RENAME_RETRIES } from '../../plugins/core/skills/core/scripts/fs-atomic.mjs';

function scratch() { return mkdtempSync(join(tmpdir(), 'fs-atomic-')); }

test('atomicWriteFileSync writes new content', () => {
  const dir = scratch();
  try {
    const f = join(dir, 'PROJECT.md');
    atomicWriteFileSync(f, '# hello\n');
    assert.equal(readFileSync(f, 'utf8'), '# hello\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFileSync replaces existing content in place', () => {
  const dir = scratch();
  try {
    const f = join(dir, 'PROJECT.md');
    writeFileSync(f, 'old contents that are longer\n');
    atomicWriteFileSync(f, 'new\n');
    assert.equal(readFileSync(f, 'utf8'), 'new\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFileSync leaves no temp file behind on success', () => {
  const dir = scratch();
  try {
    const f = join(dir, 'PROJECT.md');
    atomicWriteFileSync(f, 'x\n');
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'temp file must be renamed away, not left in the dir');
    assert.deepEqual(readdirSync(dir), ['PROJECT.md'], 'only the target file remains');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('atomicWriteFileSync cleans up its temp file when the write fails', () => {
  const dir = scratch();
  try {
    // A non-string, non-buffer object makes writeFileSync throw after the temp path is chosen.
    assert.throws(() => atomicWriteFileSync(join(dir, 'PROJECT.md'), { not: 'writable' }));
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'a failed write must not leave a temp file behind');
    assert.equal(existsSync(join(dir, 'PROJECT.md')), false, 'the target was never created');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function eperm() { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; return e; }

test('Windows EPERM is retried and succeeds on a later attempt', () => {
  let calls = 0;
  const flaky = () => { calls++; if (calls < 3) throw eperm(); };
  renameWithRetrySync('a', 'b', { isWindows: true, delayMs: 1, renameFn: flaky });
  assert.equal(calls, 3, 'two transient failures then success');
});

test('Windows EPERM exhausts the retry budget and throws', () => {
  let calls = 0;
  const dead = () => { calls++; throw eperm(); };
  assert.throws(() => renameWithRetrySync('a', 'b', { isWindows: true, delayMs: 1, renameFn: dead }), /EPERM/);
  assert.equal(calls, RENAME_RETRIES);
});

test('POSIX never retries — one attempt, immediate throw', () => {
  let calls = 0;
  const dead = () => { calls++; throw eperm(); };
  assert.throws(() => renameWithRetrySync('a', 'b', { isWindows: false, delayMs: 1, renameFn: dead }));
  assert.equal(calls, 1, 'EPERM on POSIX is a real permissions problem, not a sync-client race');
});

test('non-transient Windows errors throw immediately (no pointless retry)', () => {
  let calls = 0;
  const dead = () => { calls++; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  assert.throws(() => renameWithRetrySync('a', 'b', { isWindows: true, delayMs: 1, renameFn: dead }));
  assert.equal(calls, 1);
});

test('the folder-rename protocol carries the cloud-sync caveat (doc guard)', () => {
  const proto = readFileSync(new URL('../../plugins/core/skills/core/protocols/startup-conditional-loads.md', import.meta.url), 'utf8');
  const section = proto.slice(proto.indexOf('## Load — folder rename only'));
  assert.match(section, /OneDrive/, 'the rename branch must warn about cloud-sync paths');
  assert.match(section, /cp -r/, 'and name the safe alternative');
});

test('scripts/README.md documents the cloud-sync write caveats', () => {
  const readme = readFileSync(new URL('../../plugins/core/skills/core/scripts/README.md', import.meta.url), 'utf8');
  assert.match(readme, /Cloud-synced stores/);
  assert.match(readme, /conflict copy/);
});
