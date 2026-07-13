import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { trustedHome } from '../../plugins/core/skills/core/scripts/trusted-home.mjs';

// The trusted home comes from the OS account database, NOT $HOME/$USERPROFILE, so a
// project-forwarded hook env cannot redirect it. Resolvable → the real account home;
// unresolvable → null so callers fail closed.
test('trustedHome: returns the OS-account home, ignoring $HOME', () => {
  const real = userInfo().homedir;
  const saved = process.env.HOME;
  try {
    process.env.HOME = '/tmp/attacker-home'; // spoof attempt
    assert.equal(trustedHome(), real, 'must return the OS-account home, not the spoofed $HOME');
  } finally {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
  }
});
