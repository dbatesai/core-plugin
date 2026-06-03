import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../../plugins/core/skills/core/scripts/generate-memory-index.mjs';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts/generate-memory-index.mjs'),
  'utf8',
);

// Silence stderr while exercising main()'s error paths.
function quietStderr(fn) {
  const orig = process.stderr.write;
  process.stderr.write = () => true;
  try { return fn(); } finally { process.stderr.write = orig; }
}

// H1: the CLI entry guard must use fileURLToPath, not new URL().pathname.
// On Windows `new URL(import.meta.url).pathname` yields `/C:/...` (leading slash,
// %-encoded), which never equals `process.argv[1]` (`C:\...`), so the guard
// fails and the contamination-guarded MEMORY.md refresh silently no-ops.
test('generate-memory-index CLI guard uses fileURLToPath (H1 — Windows-safe)', () => {
  assert.ok(SRC.includes('fileURLToPath'), 'must import/use fileURLToPath for the CLI entry self-path');
});

test('generate-memory-index CLI guard does NOT use new URL().pathname (H1 regression)', () => {
  assert.ok(
    !/new URL\(\s*import\.meta\.url\s*\)\.pathname/.test(SRC),
    'new URL(import.meta.url).pathname breaks the entry guard on Windows — use fileURLToPath',
  );
});

// --- M13: --top must be a positive integer; a NaN top must never thin MEMORY.md ---

const CURATED = '# idx\n\n## Top project units (refreshed from priority.mjs --top 30, 2026-06-01)\n\n- [a](a.md) — one\n- [b](b.md) — two\n';

function scratchMemoryMd() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-idx-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  const memMd = join(dir, 'MEMORY.md');
  writeFileSync(memMd, CURATED);
  return { dir, memMd };
}

for (const bad of ['garbage', '0', '-5', '3.5', '']) {
  test(`M13: --top ${JSON.stringify(bad)} is rejected (exit 2) and leaves MEMORY.md untouched`, () => {
    const { dir, memMd } = scratchMemoryMd();
    try {
      const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', memMd, '--top', bad]));
      assert.equal(code, 2, 'invalid --top must exit 2, not silently thin the block');
      assert.equal(readFileSync(memMd, 'utf8'), CURATED, 'the curated top-units block must be untouched');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a missing --memory-md target exits 2 cleanly (no uncaught ENOENT crash)', () => {
  const { dir } = scratchMemoryMd();
  try {
    const missing = join(dir, 'does-not-exist', 'MEMORY.md');
    const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', missing]));
    assert.equal(code, 2, 'a missing target refuses with exit 2 instead of throwing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing _memories SOURCE dir exits 2 cleanly (no uncaught ENOENT from iterUnits)', () => {
  const { dir, memMd } = scratchMemoryMd();
  try {
    const badSource = join(dir, 'no-such-memories');
    const code = quietStderr(() => main([badSource, '--memory-md', memMd]));
    assert.equal(code, 2, 'a bad source dir refuses with exit 2 instead of throwing deep in iterUnits');
    assert.equal(readFileSync(memMd, 'utf8'), CURATED, 'target untouched on source error');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed --today exits 2 cleanly (no RangeError from toISOString)', () => {
  const { dir, memMd } = scratchMemoryMd();
  try {
    const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', memMd, '--today', 'garbage']));
    assert.equal(code, 2, 'malformed --today refuses with exit 2');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
