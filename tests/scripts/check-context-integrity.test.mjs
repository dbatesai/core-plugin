import { test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkContextIntegrity, resolveAutoMemorySurface } from '../../plugins/core/skills/core/scripts/check-context-integrity.mjs';
import { mapProjectPathToSlug } from '../../plugins/core/skills/core/scripts/project-slug.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts', 'check-context-integrity.mjs');

test('flags MEMORY.md over cap', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /CONTEXT-PARTIAL/);
  assert.ok(res.dropped.some(d => /MEMORY/.test(d.file)));
});

test('flags partial PROJECT.md read', () => {
  const res = checkContextIntegrity({ memoryBytes: 1000, memoryCapBytes: 24576, projectTotalLines: 2200, projectReadLines: 80 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /PROJECT\.md loaded 80\/2200/);
});

test('clean when both fit', () => {
  const res = checkContextIntegrity({ memoryBytes: 1000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  assert.equal(res.ok, true);
  assert.match(res.marker, /CONTEXT-COMPLETE/);
});

test('estimatedUnitsLost is reported on a MEMORY.md overflow', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  const mem = res.dropped.find(d => /MEMORY/.test(d.file));
  assert.ok(mem.estimatedUnitsLost >= 1, 'dropped bytes map to an estimated entry count');
});

test('both surfaces partial: marker names both', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 2200, projectReadLines: 80 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /MEMORY/);
  assert.match(res.marker, /80\/2200/);
});

// ---- Harness-aware memory surface (the Codex hardcoded-path defect) ----

test('resolveAutoMemorySurface (claude-code): derives the slug-encoded MEMORY.md path from cwd', () => {
  const cwd = '/Users/first.last/Documents/My Proj';
  const s = resolveAutoMemorySurface({ harness: 'claude-code', cwd, home: '/home/x' });
  assert.equal(s.skipped, false);
  assert.equal(s.path, join('/home/x', '.claude', 'projects', mapProjectPathToSlug(cwd), 'memory', 'MEMORY.md'));
  assert.ok(!s.path.includes('first.last'), 'the dot in the username is slug-encoded, not passed through');
});

test('resolveAutoMemorySurface (codex): no auto-memory file surface -> explicit skip, never the Claude path', () => {
  const s = resolveAutoMemorySurface({ harness: 'codex', cwd: '/w/p', home: '/home/x' });
  assert.equal(s.skipped, true);
  assert.equal(s.path, null, 'must not fabricate a Claude-only path on Codex');
  assert.match(s.reason, /codex/);
});

test('resolveAutoMemorySurface: env detection picks codex from CORE_HARNESS/CODEX_* signals', () => {
  assert.equal(resolveAutoMemorySurface({ cwd: '/w/p', env: { CORE_HARNESS: 'codex' } }).skipped, true);
  assert.equal(resolveAutoMemorySurface({ cwd: '/w/p', env: { CODEX_PLUGIN_ROOT: '/x' } }).skipped, true);
  assert.equal(resolveAutoMemorySurface({ cwd: '/w/p', env: {} }).skipped, false, 'default remains claude-code');
});

test('resolveAutoMemorySurface: an explicit --memory path wins over harness detection', () => {
  const s = resolveAutoMemorySurface({ harness: 'codex', explicitPath: '/anywhere/MEMORY.md' });
  assert.equal(s.skipped, false);
  assert.equal(s.path, '/anywhere/MEMORY.md');
});

test('a skipped memory surface is NAMED in the marker, and memoryBytes is not judged', () => {
  const res = checkContextIntegrity({
    memoryBytes: 999999, // would overflow the cap — but the surface was never measured
    memorySkippedReason: 'no-auto-memory-file-surface-on-codex',
    projectTotalLines: 100, projectReadLines: 100,
  });
  assert.equal(res.ok, true, 'a skipped surface is not a dropped surface');
  assert.match(res.marker, /CONTEXT-COMPLETE/);
  assert.match(res.marker, /MEMORY\.md check skipped \(no-auto-memory-file-surface-on-codex\)/);
  assert.equal(res.dropped.length, 0);
  assert.equal(res.memorySkipped.reason, 'no-auto-memory-file-surface-on-codex');
});

test('skip + partial project: the marker carries both the shortfall and the skip', () => {
  const res = checkContextIntegrity({
    memorySkippedReason: 'no-auto-memory-file-surface-on-codex',
    projectTotalLines: 2200, projectReadLines: 80,
  });
  assert.equal(res.ok, false);
  assert.match(res.marker, /CONTEXT-PARTIAL/);
  assert.match(res.marker, /80\/2200/);
  assert.match(res.marker, /MEMORY\.md check skipped/);
});

test('CLI on codex: memory check explicitly skipped in the printed marker, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cci-codex-'));
  try {
    writeFileSync(join(dir, 'PROJECT.md'), 'a\nb\nc\n');
    const child = spawnSync(process.execPath, [SCRIPT,
      '--project', join(dir, 'PROJECT.md'), '--project-read-lines', '4', '--cwd', dir,
    ], { encoding: 'utf8', env: { ...process.env, CORE_HARNESS: 'codex' } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /MEMORY\.md check skipped \(no-auto-memory-file-surface-on-codex\)/);
    assert.doesNotMatch(child.stdout, /MEMORY\.md dropped/, 'never a false judgment of an unmeasured surface');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: explicit --memory override is still honored (measures the given file against the cap)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cci-override-'));
  try {
    writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(2000));
    writeFileSync(join(dir, 'PROJECT.md'), 'a\n');
    const child = spawnSync(process.execPath, [SCRIPT,
      '--memory', join(dir, 'MEMORY.md'), '--memory-cap-bytes', '1000',
      '--project', join(dir, 'PROJECT.md'), '--project-read-lines', '2',
    ], { encoding: 'utf8', env: { ...process.env, CORE_HARNESS: 'codex' } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /CONTEXT-PARTIAL/);
    assert.match(child.stdout, /MEMORY\.md dropped/, '--memory wins over the codex skip');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
