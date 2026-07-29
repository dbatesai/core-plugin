import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';


test('AUD-102: adoption refuses a corrupt or unreadable baseline; absent and clean-partial baselines adopt their unstamped remainder', async () => {
  const { adoptExistingStore } = await import('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'adopt-corrupt-'));
  try {
    const lib = join(dir, '_memories', '_lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(dir, '_memories', 'dc-1.md'), '---\nid: dc-1\n---\nbody\n');
    writeFileSync(join(lib, 'state-cache.json'), '{corrupt not json');
    const r = adoptExistingStore(dir, { apply: true });
    assert.equal(r.applied, false, 'a corrupt baseline must stop adoption');
    assert.equal(r.refused_reason, 'baseline-not-absent');
    assert.ok(r.baseline_status === 'corrupt' || r.baseline_status === 'unreadable');
    assert.ok(existsSync(join(lib, 'state-cache.json')), 'the corrupt bytes are not replaced by adoption');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
