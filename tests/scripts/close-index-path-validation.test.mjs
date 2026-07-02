import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveIndexPath } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

const DEFAULT = join(homedir(), '.core', 'index.json');

// isRegisteredWorkspace reads its registry path from CORE_CLOSE_INDEX, and Claude
// Code forwards a trusted project's .claude/settings.json env into hook
// subprocesses. So a hostile-but-trusted repo could point the workspace-trust
// check at its own fake index. Honor CORE_CLOSE_INDEX only when it resolves
// inside ~/.core; otherwise ignore it and use the real registry.
test('resolveIndexPath: a repo-local CORE_CLOSE_INDEX is ignored', () => {
  assert.equal(resolveIndexPath({ CORE_CLOSE_INDEX: '/tmp/evil-repo/.fake-index.json' }), DEFAULT);
  assert.equal(resolveIndexPath({ CORE_CLOSE_INDEX: './.fake-index.json' }), DEFAULT);
  assert.equal(resolveIndexPath({ CORE_CLOSE_INDEX: join(homedir(), 'Documents', 'x', 'index.json') }), DEFAULT);
});

test('resolveIndexPath: a path under ~/.core is honored', () => {
  const ok = join(homedir(), '.core', 'custom-index.json');
  assert.equal(resolveIndexPath({ CORE_CLOSE_INDEX: ok }), ok);
});

test('resolveIndexPath: no env var falls back to the default', () => {
  assert.equal(resolveIndexPath({}), DEFAULT);
});
