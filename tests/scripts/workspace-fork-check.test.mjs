import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  entryPath, checkFork, canonicalPath,
} from '../../plugins/core/skills/core/scripts/workspace-fork-check.mjs';

// Build a fixture: a project cwd with workspace.json + a ~/.core dir with index.json.
function withFixture(pointer, index, fn) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'fork-check-')));
  const cwd = join(base, 'project');
  const coreDir = join(base, 'core');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(coreDir, { recursive: true });
  if (pointer) writeFileSync(join(cwd, 'workspace.json'), JSON.stringify(pointer, null, 2));
  if (index) writeFileSync(join(coreDir, 'index.json'), JSON.stringify(index, null, 2));
  try {
    return fn({ cwd, coreDir, base });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const NOW = new Date('2026-05-31T00:00:00Z');

// ---------- entryPath: tolerate both field conventions ----------

test('entryPath prefers canonical `path`, tolerates legacy `project_path`', () => {
  assert.equal(entryPath({ path: '/b' }), '/b');
  assert.equal(entryPath({ project_path: '/a' }), '/a'); // legacy entry still readable
  assert.equal(entryPath({ project_path: '/a', path: '/b' }), '/b'); // path wins (canonical 2026-06-01)
  assert.equal(entryPath({}), null);
});

// ---------- The regression: project_path-keyed entry must NOT re-fork ----------
// Meridian, R11, 2026-05-31: the index entry was schema-style (project_path),
// the fork-check read only `path`, so it never recognized its own registered
// workspace and re-forked local-llm-build-r11 -> -2 -> -3 every startup.

test('project_path-keyed index entry at cwd -> no fork (the false-fork bug)', () => {
  withFixture(
    { workspace_id: 'llb-r11', name: 'local-llm-build' },
    [{ workspace_id: 'llb-r11', name: 'local-llm-build', project_path: '__CWD__' }],
    ({ cwd, coreDir }) => {
      // patch the index entry's project_path to the real cwd
      const idxPath = join(coreDir, 'index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx[0].project_path = cwd;
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));

      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'no-fork', 'must recognize a project_path-keyed entry at cwd');
      assert.equal(r.reason, 'path-match');
    },
  );
});

test('path-keyed index entry at cwd -> no fork (back-compat preserved)', () => {
  withFixture(
    { workspace_id: 'ws-x', name: 'proj' },
    [{ workspace_id: 'ws-x', name: 'proj', path: '__CWD__' }],
    ({ cwd, coreDir }) => {
      const idxPath = join(coreDir, 'index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx[0].path = cwd;
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));

      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'no-fork');
      assert.equal(r.reason, 'path-match');
    },
  );
});

// ---------- Genuine copied workspace still forks (no over-broadening) ----------

test('copied workspace (id resolves to a project_path elsewhere) -> fork', () => {
  withFixture(
    { workspace_id: 'orig', name: 'orig-proj' },
    [{ workspace_id: 'orig', name: 'orig-proj', project_path: '/somewhere/else/entirely' }],
    ({ cwd, coreDir }) => {
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'forked', 'a pointer copied from another project must still fork');
      assert.equal(r.original_id, 'orig');
      // and the fork must register a path-keyed entry the next run recognizes
      const idx = JSON.parse(readFileSync(join(coreDir, 'index.json'), 'utf8'));
      const forked = idx.find(e => e.workspace_id === r.new_id);
      assert.ok(forked && entryPath(forked), 'forked entry carries a resolvable path');

      // H3: the local pointer is written atomically (no leftover temp file in cwd) and the
      // pointer now names the new id (the multi-file fork completed consistently).
      const cwdLeftovers = readdirSync(cwd).filter(n => n.includes('.tmp-'));
      assert.deepEqual(cwdLeftovers, [], 'atomic pointer write must leave no temp file in the project dir');
      const ptr = JSON.parse(readFileSync(join(cwd, 'workspace.json'), 'utf8'));
      assert.equal(ptr.workspace_id, r.new_id, 'local pointer (written last) carries the forked id');

      // idempotent: re-running finds the fresh path-keyed entry -> no second fork
      const r2 = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r2.action, 'no-fork', 'must not re-fork its own output');
      assert.equal(r2.reason, 'path-match');
    },
  );
});

// ---------- H3 crash-simulation: the meta→index→pointer write order is recoverable ----------
// The fork mutates three surfaces. checkFork resolves path-match (index path==cwd) BEFORE
// id-match, so the safe order is meta-dir → index → pointer, all atomic. These tests assert
// that a crash at each inter-file boundary leaves a recoverable state.

test('H3 crash-sim: index entry landed but pointer not (crash before pointer) → path-match resolves, no re-fork', () => {
  // Simulates: meta dir + index entry written for newId, pointer still names the old id.
  withFixture(
    { workspace_id: 'orig', name: 'p' },                       // pointer NOT yet rewritten
    [{ workspace_id: 'newid', name: 'p', path: '__CWD__' }],   // index already has newId@cwd
    ({ cwd, coreDir }) => {
      const idxPath = join(coreDir, 'index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx[0].path = cwd;
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));
      mkdirSync(join(coreDir, 'workspaces', 'newid'), { recursive: true }); // meta dir written first
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'no-fork', 'a landed index entry must resolve, not re-fork');
      assert.equal(r.reason, 'path-match');
      assert.equal(r.workspace_id, 'newid', 'resolves to the forked id via path-match (pointer id is stale but unused)');
    },
  );
});

test('H3 crash-sim: meta dir landed but index entry not (crash before index) → clean re-fork, leftover meta dir harmless', () => {
  // Simulates: a prior fork wrote the meta dir then crashed before the index entry. The pointer
  // still names the copied-from id (registered at a foreign path), so this must re-fork cleanly.
  withFixture(
    { workspace_id: 'orig', name: 'p' },
    [{ workspace_id: 'orig', name: 'p', path: '/somewhere/else/entirely' }],
    ({ cwd, coreDir }) => {
      mkdirSync(join(coreDir, 'workspaces', 'project'), { recursive: true }); // leftover from the crashed attempt (slug of cwd basename)
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'forked', 'must re-fork; no path-match exists yet, so the workspace is not orphaned');
      assert.equal(r.original_id, 'orig');
      const idx = JSON.parse(readFileSync(join(coreDir, 'index.json'), 'utf8'));
      const forked = idx.find(e => e.workspace_id === r.new_id);
      assert.ok(forked && canonicalPath(entryPath(forked)) === canonicalPath(cwd), 'now fully registered at cwd');
      // and the second run is a clean no-op (idempotent)
      assert.equal(checkFork({ cwd, coreDir, now: NOW }).action, 'no-fork');
    },
  );
});

test('H3: a real fork leaves no temp file in ~/.core (index + manifest written atomically)', () => {
  withFixture(
    { workspace_id: 'origAtomic', name: 'p' },
    [{ workspace_id: 'origAtomic', name: 'p', path: '/elsewhere' }],
    ({ cwd, coreDir }) => {
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'forked');
      // No .tmp- leftovers in the core dir (index.json) or the new meta dir (manifest).
      assert.deepEqual(readdirSync(coreDir).filter(n => n.includes('.tmp-')), [], 'index.json written atomically');
      const metaDir = join(coreDir, 'workspaces', r.new_id);
      assert.deepEqual(readdirSync(metaDir).filter(n => n.includes('.tmp-')), [], 'manifest written atomically');
    },
  );
});

// ---------- Standardization (2026-06-01): forked manifest emits canonical `path` ----------

test('forked manifest emits canonical `path`, not legacy `project_path`', () => {
  withFixture(
    { workspace_id: 'orig3', name: 'orig-proj3' },
    [{ workspace_id: 'orig3', name: 'orig-proj3', path: '/somewhere/else' }],
    ({ cwd, coreDir }) => {
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'forked');
      const manifest = JSON.parse(readFileSync(join(r.new_meta_dir, 'workspace.json'), 'utf8'));
      assert.equal(manifest.path, cwd, 'manifest records the project path under canonical `path`');
      assert.ok(!('project_path' in manifest), 'manifest must not emit the deprecated project_path');
    },
  );
});

// ---------- B7: path-identity is symlink-stable (the resolve()-vs-realpath bug) ----------
// A registered workspace reached through a symlinked root (macOS /tmp ->
// /private/tmp, OneDrive/Dropbox sync roots, a symlinked ~/Projects) must NOT
// re-fork. The fork decision canonicalizes both sides with realpathSync to match
// the CLI entry guard; resolve() alone returned the two forms unequal and
// re-forked every startup.

test('registered path reached via a symlink -> no fork (realpath normalization)', () => {
  // Don't use withFixture's realpathSync wrapper here — we need the raw symlink.
  const base = mkdtempSync(join(tmpdir(), 'fork-symlink-'));
  try {
    const realProject = join(realpathSync(base), 'real-project');
    const linkProject = join(realpathSync(base), 'link-project');
    const coreDir = join(realpathSync(base), 'core');
    mkdirSync(realProject, { recursive: true });
    mkdirSync(coreDir, { recursive: true });
    symlinkSync(realProject, linkProject, 'dir'); // link-project -> real-project

    // Index registers the REAL path; the pointer lives under the real dir.
    writeFileSync(join(realProject, 'workspace.json'),
      JSON.stringify({ workspace_id: 'sym-ws', name: 'proj' }, null, 2));
    writeFileSync(join(coreDir, 'index.json'),
      JSON.stringify([{ workspace_id: 'sym-ws', name: 'proj', path: realProject }], null, 2));

    // Open the workspace via the SYMLINK path. Must recognize it as the same
    // registered workspace, not a copy.
    const r = checkFork({ cwd: linkProject, coreDir, now: NOW });
    assert.equal(r.action, 'no-fork', 'a symlinked path to a registered workspace must not fork');
    assert.equal(r.reason, 'path-match');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('canonicalPath collapses a symlink to its real target; falls back to resolve when absent', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'canon-')));
  try {
    const real = join(base, 'real');
    const link = join(base, 'link');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link, 'dir');
    assert.equal(canonicalPath(link), real, 'symlink canonicalizes to its real target');
    // A non-existent path can't be realpath'd -> resolve() fallback, not a throw.
    const ghost = join(base, 'does', 'not', 'exist');
    assert.equal(canonicalPath(ghost), ghost, 'absent path falls back to resolve() instead of throwing');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------- B7 / DC-104 #3: identity is path-based; harness is irrelevant ----------
// A folder registered by one harness (Claude Code) opened by another (Codex) is a
// RETURNING workspace, not a fork. checkFork takes no harness input by design —
// this test pins that property so a future "harness-aware" change can't silently
// reintroduce cross-harness forking.

test('same registered path, different harness pointer -> returning, never a fork', () => {
  withFixture(
    { workspace_id: 'coexist-ws', name: 'shared', harness: 'claude-code' },
    [{ workspace_id: 'coexist-ws', name: 'shared', path: '__CWD__' }],
    ({ cwd, coreDir }) => {
      const idxPath = join(coreDir, 'index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx[0].path = cwd;
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));

      // Claude-harness pointer -> returning.
      const rClaude = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(rClaude.action, 'no-fork');
      assert.equal(rClaude.reason, 'path-match');

      // Now a Codex session opens the same folder (pointer rewritten with a Codex
      // harness marker, same id + path). Still returning — harness is not consulted.
      writeFileSync(join(cwd, 'workspace.json'),
        JSON.stringify({ workspace_id: 'coexist-ws', name: 'shared', harness: 'codex' }, null, 2));
      const rCodex = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(rCodex.action, 'no-fork', 'a different harness on a registered path must not fork');
      assert.equal(rCodex.reason, 'path-match');
    },
  );
});

// ---------- dryRun: detect the fork decision without mutating ----------

test('dryRun on a copied workspace reports would-fork and writes nothing', () => {
  withFixture(
    { workspace_id: 'orig-dry', name: 'orig' },
    [{ workspace_id: 'orig-dry', name: 'orig', path: '/somewhere/else/entirely' }],
    ({ cwd, coreDir }) => {
      const idxBefore = readFileSync(join(coreDir, 'index.json'), 'utf8');
      const pointerBefore = readFileSync(join(cwd, 'workspace.json'), 'utf8');

      const r = checkFork({ cwd, coreDir, now: NOW, dryRun: true });
      assert.equal(r.action, 'would-fork', 'dry-run reports the planned fork');
      assert.equal(r.original_id, 'orig-dry');
      assert.ok(r.new_id, 'dry-run still computes the would-be new id');

      // No mutation: index, pointer unchanged, no new meta dir.
      assert.equal(readFileSync(join(coreDir, 'index.json'), 'utf8'), idxBefore, 'index untouched');
      assert.equal(readFileSync(join(cwd, 'workspace.json'), 'utf8'), pointerBefore, 'pointer untouched');
      assert.ok(!existsSync(join(coreDir, 'workspaces', r.new_id)), 'no fork meta dir created');
    },
  );
});

test('dryRun on a returning workspace still reports no-fork', () => {
  withFixture(
    { workspace_id: 'ret-dry', name: 'proj' },
    [{ workspace_id: 'ret-dry', name: 'proj', path: '__CWD__' }],
    ({ cwd, coreDir }) => {
      const idxPath = join(coreDir, 'index.json');
      const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
      idx[0].path = cwd;
      writeFileSync(idxPath, JSON.stringify(idx, null, 2));
      const r = checkFork({ cwd, coreDir, now: NOW, dryRun: true });
      assert.equal(r.action, 'no-fork');
      assert.equal(r.reason, 'path-match');
    },
  );
});

// ---------- HARNESS-007: data_path must be an expanded absolute path ----------
// Node does not expand ~ (only POSIX shells do); a tilde-literal data_path is
// unusable by any consumer that reads it as a path, and doubly broken on Windows.

test('forked pointer data_path is an expanded absolute path, not a tilde literal', () => {
  withFixture(
    { workspace_id: 'orig-dp', name: 'p' },
    [{ workspace_id: 'orig-dp', name: 'p', path: '/somewhere/else/entirely' }],
    ({ cwd, coreDir }) => {
      const r = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r.action, 'forked');
      const ptr = JSON.parse(readFileSync(join(cwd, 'workspace.json'), 'utf8'));
      assert.ok(!ptr.data_path.startsWith('~'), 'no leading tilde literal in data_path (a mid-path ~ like a Windows RUNNER~1 8.3 short name is legitimate)');
      assert.equal(ptr.data_path, join(coreDir, 'workspaces', r.new_id) + '/',
        'data_path is the expanded meta-dir path, consumer-usable on all platforms');
    },
  );
});
