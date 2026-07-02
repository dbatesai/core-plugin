import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawnShell } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

// On Windows the `claude` CLI is claude.cmd, and current Node (CVE-2024-27980)
// throws EINVAL if you spawn a .cmd without shell:true — so the self-managed
// close silently never runs on Windows. defaultSpawnFinalize must set shell on
// win32 and not elsewhere. This tests the exact decision function, on the real
// code path, rather than injecting a fake spawn the way the close tests do.
test('claudeSpawnShell: true on win32, false on posix', () => {
  assert.equal(claudeSpawnShell('win32'), true);
  assert.equal(claudeSpawnShell('darwin'), false);
  assert.equal(claudeSpawnShell('linux'), false);
});
