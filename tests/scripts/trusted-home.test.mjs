import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  trustedHome, requireTrustedHome,
  isSafeWorkspaceId, assertSafeWorkspaceId,
  containedPath, regularFileWithin,
} from '../../plugins/core/skills/core/scripts/trusted-home.mjs';

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

test('requireTrustedHome: throws NO_TRUSTED_HOME rather than yielding a spoofable home', () => {
  assert.equal(requireTrustedHome(), userInfo().homedir);
  assert.throws(
    () => requireTrustedHome({ resolve: () => null }),
    (e) => e.code === 'NO_TRUSTED_HOME',
    'an unresolvable account home must fail closed, never fall back to homedir()',
  );
});

test('workspace ids name one directory segment; traversal shapes are rejected', () => {
  for (const ok of ['core-plugin', 'probe-codex-3', 'a', 'A.b_c-1']) {
    assert.equal(isSafeWorkspaceId(ok), true, `${ok} is a legitimate id`);
    assert.equal(assertSafeWorkspaceId(ok), ok);
  }
  for (const bad of ['../../../etc', '..', '.', 'a/b', 'a\\b', '/abs', 'C:\\x', '', null, undefined, 'x'.repeat(200)]) {
    assert.equal(isSafeWorkspaceId(bad), false, `${JSON.stringify(bad)} must not name a directory`);
    assert.throws(() => assertSafeWorkspaceId(bad), (e) => e.code === 'UNSAFE_WORKSPACE_ID');
  }
});

test('containedPath: a prefix-sharing sibling directory cannot spoof containment', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-contain-')));
  const root = join(base, 'user');
  const sibling = join(base, 'user2');
  mkdirSync(root); mkdirSync(sibling);
  writeFileSync(join(sibling, 'unit.md'), 'x');

  assert.equal(containedPath(root, join(root, 'a', 'b.md')), join(root, 'a', 'b.md'),
    'a not-yet-created destination under the root is contained');
  assert.equal(containedPath(root, join(sibling, 'unit.md')), null,
    'a sibling whose name merely shares the root prefix must not read as contained');
  assert.equal(containedPath(root, join(root, '..', 'user2', 'unit.md')), null,
    'traversal out of the root must not read as contained');
});

test('containedPath / regularFileWithin: a symlink is judged by its real target', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-contain-link-')));
  const root = join(base, 'store');
  const outside = join(base, 'outside');
  mkdirSync(root); mkdirSync(outside);
  const secret = join(outside, 'secret.md');
  writeFileSync(secret, 'not yours');
  const inside = join(root, 'real.md');
  writeFileSync(inside, 'yours');

  const escaping = join(root, 'escape.md');
  const internal = join(root, 'alias.md');
  try { symlinkSync(secret, escaping); symlinkSync(inside, internal); }
  catch { return; } // filesystem without symlink support

  assert.equal(containedPath(root, escaping), null, 'a link out of the store is not contained');
  assert.equal(regularFileWithin(root, escaping), null, 'and it is not a readable unit');
  assert.equal(regularFileWithin(root, internal), inside, 'a link resolving inside the store is contained');
  assert.equal(regularFileWithin(root, root), null, 'a directory is not a regular file');
});
