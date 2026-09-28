import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


test('adoption refuses a corrupt or unreadable baseline; absent and clean-partial baselines adopt their unstamped remainder', async () => {
  const { adoptExistingStore } = await import('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'adopt-corrupt-'));
  try {
    const lib = join(dir, '_memories', '_lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(dir, '_memories', 'dc-1-alpha.md'), '---\nid: dc-1-alpha\n---\nbody\n');
    writeFileSync(join(lib, 'state-cache.json'), '{corrupt not json');
    const r = adoptExistingStore(dir, { apply: true });
    assert.equal(r.applied, false, 'a corrupt baseline must stop adoption');
    assert.equal(r.refused_reason, 'baseline-not-absent');
    assert.ok(r.baseline_status === 'corrupt' || r.baseline_status === 'unreadable');
    assert.ok(existsSync(join(lib, 'state-cache.json')), 'the corrupt bytes are not replaced by adoption');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detection and the session inventory reach units in dated subfolders, and skip archive/, _-prefixed and dot directories', async () => {
  const { detectStore, inventoryPaths } = await import('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-nested-'));
  try {
    const mem = join(dir, '_memories');
    for (const sub of ['observations/2026-09', 'archive', '_lib', '.obsidian']) mkdirSync(join(mem, sub), { recursive: true });
    const unit = '---\nid: x\n---\nbody\n';
    writeFileSync(join(mem, 'dc-1-top.md'), unit);
    writeFileSync(join(mem, 'observations', '2026-09', 'obs-nested.md'), unit);
    writeFileSync(join(mem, 'archive', 'dc-0-archived.md'), unit);
    writeFileSync(join(mem, '_lib', 'notes.md'), unit);
    writeFileSync(join(mem, '.obsidian', 'plugin.md'), unit);
    const want = [join(mem, 'dc-1-top.md'), join(mem, 'observations', '2026-09', 'obs-nested.md')];
    assert.deepEqual(detectStore(dir).files.map(f => f.path).sort(), want);
    assert.deepEqual(inventoryPaths(dir).sort(), want);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('piped --json output arrives whole when the report is larger than one pipe buffer', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'lifecycle-pipe-'));
  try {
    const mem = join(dir, '_memories');
    mkdirSync(mem, { recursive: true });
    for (let i = 0; i < 900; i++) writeFileSync(join(mem, `obs-unit-number-${i}.md`), '---\nid: x\n---\nbody\n');
    const r = spawnSync(process.execPath, [script, dir, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.ok(r.stdout.length > 64 * 1024, `fixture must exceed one pipe buffer, got ${r.stdout.length} bytes`);
    assert.equal(JSON.parse(r.stdout).files.length, 900);
    assert.equal(r.status, 1, 'unstamped files still exit nonzero');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
