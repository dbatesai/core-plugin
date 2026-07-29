import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { main, spliceSection } from '../../plugins/core/skills/core/scripts/generate-memory-index.mjs';

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

// H1 sweep: the same defect class anywhere in shipped scripts/hooks OR the test
// suite itself. `.pathname` on a file: URL yields `/D:/...` on Windows; join +
// pathToFileURL then mangle it into `D:\D:\...` (the exact failure that kept
// the stamp-race and no-baseline-detector tests red on windows-latest for two
// releases). Use fileURLToPath(new URL(...)) or pass the URL .href directly.
test('no file anywhere uses new URL(...).pathname (H1 sweep — Windows-safe)', () => {
  const roots = [
    '../../plugins/core/skills/core/scripts',
    '../../plugins/core/skills/core/hooks',
    '.',
  ].map((r) => fileURLToPath(new URL(r, import.meta.url)));
  const self = fileURLToPath(import.meta.url);
  const offenders = [];
  for (const root of roots) {
    for (const f of readdirSync(root)) {
      if (!f.endsWith('.mjs')) continue;
      const path = join(root, f);
      if (path === self) continue; // this file names the pattern in prose
      const src = readFileSync(path, 'utf8');
      if (/new URL\([^)]*\)\s*\.pathname/.test(src)) offenders.push(join(root, f));
    }
  }
  assert.deepEqual(offenders, [], `these files use URL .pathname (breaks on Windows): ${offenders.join(', ')}`);
});

// --- --top must be a positive integer; a NaN top must never thin MEMORY.md ---

const CURATED = '# idx\n\n## Top project units (refreshed from priority.mjs --top 30, 2026-06-01)\n\n- [a](a.md) — one\n- [b](b.md) — two\n';

function scratchMemoryMd() {
  const dir = mkdtempSync(join(tmpdir(), 'mem-idx-'));
  mkdirSync(join(dir, '_memories'), { recursive: true });
  const memMd = join(dir, 'MEMORY.md');
  writeFileSync(memMd, CURATED);
  return { dir, memMd };
}

for (const bad of ['garbage', '0', '-5', '3.5', '']) {
  test(`--top ${JSON.stringify(bad)} is rejected (exit 2) and leaves MEMORY.md untouched`, () => {
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

test('the MEMORY.md priority block excludes invalidated units', () => {
  const { dir, memMd } = scratchMemoryMd();
  try {
    writeFileSync(join(dir, '_memories', 'dc-live.md'),
      '---\nid: dc-live\ntype: decision\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n\n# live unit\n');
    writeFileSync(join(dir, '_memories', 'dc-dead.md'),
      '---\nid: dc-dead\ntype: decision\nstatus: superseded\ncreated: 2026-01-01\nupdated: 2026-06-01\nt_invalid: 2026-03-01\ntopics: [a]\n---\n\n# dead unit\n');
    const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', memMd, '--today', '2026-06-09']));
    assert.equal(code, 0);
    const out = readFileSync(memMd, 'utf8');
    assert.match(out, /dc-live/);
    assert.doesNotMatch(out, /dc-dead/, 'index generation is a retrieval surface — same invariant');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H1: MEMORY.md write routes through atomicWriteFileSync, not a bare write', () => {
  // MEMORY.md holds hand-curated, unreconstructable narrative; a crash mid-write
  // must never truncate it. Crash-safety can't be behaviorally unit-tested without
  // fault injection (fs-atomic.test.mjs covers the helper itself), so this is a
  // static guard that the consumer uses the safe writer.
  assert.match(SRC, /from '\.\/fs-atomic\.mjs'/, 'imports the atomic writer');
  assert.match(SRC, /atomicWriteFileSync\(memoryMdPath/, 'writes MEMORY.md atomically');
  assert.doesNotMatch(SRC, /\bwriteFileSync\(memoryMdPath/, 'no bare writeFileSync on the irreplaceable MEMORY.md surface');
});

test('--dry-run computes the change but writes nothing (was previously a documented no-op flag)', () => {
  const { dir, memMd } = scratchMemoryMd();
  try {
    writeFileSync(join(dir, '_memories', 'dc-fresh.md'),
      '---\nid: dc-fresh\ntype: decision\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n\n# fresh unit\n');
    const before = readFileSync(memMd, 'utf8');
    const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', memMd, '--dry-run']));
    assert.equal(code, 0);
    assert.equal(readFileSync(memMd, 'utf8'), before, '--dry-run must not write to MEMORY.md');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without --dry-run, the same change actually writes (control for the test above)', () => {
  const { dir, memMd } = scratchMemoryMd();
  try {
    writeFileSync(join(dir, '_memories', 'dc-fresh.md'),
      '---\nid: dc-fresh\ntype: decision\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n\n# fresh unit\n');
    const before = readFileSync(memMd, 'utf8');
    const code = quietStderr(() => main([join(dir, '_memories'), '--memory-md', memMd]));
    assert.equal(code, 0);
    assert.notEqual(readFileSync(memMd, 'utf8'), before, 'a real (non-dry) run must actually write the new block');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('splice ends with exactly one trailing newline when the section is last', () => {
  const md = '# idx\n\n## Top project units (refreshed 2026-06-01)\n\n- [a](a.md) — one';
  const out = spliceSection(md, '## Top project units (refreshed 2026-06-09)\n\n- [b](b.md) — two\n');
  assert.match(out, /two\n$/, 'POSIX final newline present');
  assert.doesNotMatch(out, /\n\n$/, 'exactly one, not several');
});
