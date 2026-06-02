import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  entryPath, checkFork,
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

      // idempotent: re-running finds the fresh path-keyed entry -> no second fork
      const r2 = checkFork({ cwd, coreDir, now: NOW });
      assert.equal(r2.action, 'no-fork', 'must not re-fork its own output');
      assert.equal(r2.reason, 'path-match');
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
