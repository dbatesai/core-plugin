import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync } from '../../plugins/core/skills/core/scripts/fs-atomic.mjs';

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
