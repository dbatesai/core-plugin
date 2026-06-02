import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { probe } from '../../plugins/core/skills/core/scripts/capability/target-surface-collab-files-probe.mjs';

function git(args, cwd) {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Build a real git repo whose `push --dry-run` deterministically fails: origin points at
// a non-existent local path. The repo is otherwise valid (root matches, status parseable).
function repoWithUnpushableRemote() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-files-probe-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 't@t'], dir);
  git(['config', 'user.name', 't'], dir);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
  const bogusRemote = join(dir, 'does-not-exist-remote.git');
  git(['remote', 'add', 'origin', bogusRemote], dir);
  return { dir, bogusRemote };
}

test('M11: a mutation-kind surface with a failed write-proof degrades fail-closed (was a false PASS)', async () => {
  const { dir, bogusRemote } = repoWithUnpushableRemote();
  try {
    const row = await probe({ filesRepo: dir, expectedRemote: bogusRemote });
    assert.equal(row.capability_kind, 'mutation', 'this surface is mutation-kind');
    // Before the fix the unproven push was "corroborating" and identity stayed PASS, so the
    // runner (which gates mutation on identity PASS) would clear a write on a repo we cannot
    // prove we can write to. Fail-closed mutation requires DEGRADED here.
    assert.equal(row.identity_status, 'DEGRADED', 'unproven write on a mutation surface must not be PASS');
    const pushEv = row.evidence.find((e) => e.source === 'git-push-dry-run');
    assert.equal(pushEv.weight, 'conflicting', 'the failed write-proof is the conflicting signal');
    assert.equal(pushEv.value.unproven_code, 'target_surface_write_unproven', 'still documented as unproven, not proven-broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
