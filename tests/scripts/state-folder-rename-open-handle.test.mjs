// The first state access of a registered project renames an older `.core` to `_core`. This is the rename with a file held
// open inside it. POSIX renames regardless; Windows may refuse a folder rename while a handle is open. Either outcome is
// acceptable if it is clean: the refusal leaves `.core` and its contents exactly as they were, names the error, and the
// rename succeeds once the handle is closed. Anything else (both folders, lost or altered content, a throw, a refusal that
// outlasts the handle) fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, openSync, closeSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleStateFolderName } from '../../plugins/core/skills/core/scripts/state-dirname.mjs';

test('renaming .core to _core with a file held open inside it either succeeds or refuses cleanly, then succeeds once the handle is closed', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rename-open-handle-')));
  let fd = null;
  try {
    mkdirSync(join(root, '.core', 'claude-code'), { recursive: true });
    const inner = join(root, '.core', 'claude-code', 'workspace.json');
    writeFileSync(inner, '{"kept":true}\n');
    fd = openSync(inner, 'r');
    const first = settleStateFolderName(root);
    if (first === 'renamed') {
      assert.ok(!existsSync(join(root, '.core')) && existsSync(join(root, '_core', 'claude-code', 'workspace.json')), 'renamed: the content moved with it');
    } else {
      assert.match(first, /^not-renamed:(EPERM|EBUSY|EACCES)$/, `a refusal names a Windows sharing error, got ${first}`);
      assert.ok(existsSync(inner) && !existsSync(join(root, '_core')), 'refused: .core is exactly as it was and no _core appeared');
      assert.equal(readFileSync(inner, 'utf8'), '{"kept":true}\n', 'refused: contents unchanged');
      closeSync(fd); fd = null;
      assert.equal(settleStateFolderName(root), 'renamed', 'the rename succeeds once the handle is closed');
      assert.ok(!existsSync(join(root, '.core')) && readFileSync(join(root, '_core', 'claude-code', 'workspace.json'), 'utf8') === '{"kept":true}\n');
    }
    assert.equal(settleStateFolderName(root), null, 'nothing left to rename');
  } finally { if (fd !== null) try { closeSync(fd); } catch { /* closed */ } rmSync(root, { recursive: true, force: true }); }
});
