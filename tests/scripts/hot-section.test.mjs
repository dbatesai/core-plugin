import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHotSection, recordProjectMdWrite, HOT_BEGIN, HOT_END,
} from '../../plugins/core/skills/core/scripts/hot-section.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hot-section-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, '.core'), { recursive: true });
  writeFileSync(join(project, 'PROJECT.md'), '# Project\n\n## What & Why\n\nThe thing.\n');
  return { root, project, home, cachePath: join(home, '.core', 'state-cache.json') };
}

test('applyHotSection stamps state-cache last_written_by: hot-section for PROJECT.md', () => {
  const { root, project, home, cachePath } = setup();
  try {
    applyHotSection(project, 'Right now: shipping the thing.', { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    const entry = cache.files[join(project, 'PROJECT.md')];
    assert.ok(entry, 'PROJECT.md has a state-cache entry after apply');
    assert.equal(entry.last_written_by, 'hot-section',
      'the script-driven write is recorded as CORE-authored, not a user edit');
    assert.match(entry.last_hash, /^[0-9a-f]{16}$/, 'last_hash is a 16-hex digest');
    assert.equal(entry.last_written, '2026-06-06T00:00:00Z', 'last_written uses the injected timestamp');
    // and the hot block actually landed in PROJECT.md
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.includes(HOT_BEGIN) && pm.includes(HOT_END), 'hot block written to PROJECT.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordProjectMdWrite merges into an existing cache without clobbering other entries', () => {
  const { root, project, home, cachePath } = setup();
  try {
    writeFileSync(cachePath, JSON.stringify({
      files: { '/some/other/file.md': { last_hash: 'deadbeefdeadbeef', last_written: 'x', last_written_by: 'init' } },
    }, null, 2));
    recordProjectMdWrite(join(project, 'PROJECT.md'), { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.ok(cache.files['/some/other/file.md'], 'pre-existing entry preserved');
    assert.equal(cache.files['/some/other/file.md'].last_written_by, 'init', 'pre-existing entry untouched');
    assert.equal(cache.files[join(project, 'PROJECT.md')].last_written_by, 'hot-section', 'new entry added');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordProjectMdWrite tolerates a missing cache file (creates it)', () => {
  const { root, project, home, cachePath } = setup();
  try {
    recordProjectMdWrite(join(project, 'PROJECT.md'), { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.files[join(project, 'PROJECT.md')].last_written_by, 'hot-section');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
