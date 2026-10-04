// The dirty check observes a checkout; it must never refresh the index or take index.lock,
// which would race another git process working in the same repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, utimesSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pluginTreeDirty } from '../../plugins/core/skills/core/scripts/artifact-provenance.mjs';

test('pluginTreeDirty leaves .git/index byte- and time-identical when stat data is stale', () => {
  const repo = mkdtempSync(join(tmpdir(), 'prov-nolock-'));
  try {
    const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'same\n');
    git('add', 'a.txt'); git('commit', '-qm', 'a');
    const future = new Date(Date.now() + 120_000);
    utimesSync(join(repo, 'a.txt'), future, future);   // content unchanged, stat data stale: plain status would refresh the index
    const index = join(repo, '.git', 'index');
    const before = { bytes: readFileSync(index), mtime: statSync(index).mtimeMs };
    assert.equal(pluginTreeDirty(repo, repo), false);
    assert.ok(readFileSync(index).equals(before.bytes), 'index bytes unchanged');
    assert.equal(statSync(index).mtimeMs, before.mtime, 'index not rewritten');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
