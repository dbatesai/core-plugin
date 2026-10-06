// Control fixture for run-suite-isolated.mjs (not a suite test: the suite globs tests/scripts/*.test.mjs).
// It writes where a stray test would: the account's ~/.core. Under the protected home this must fail.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

test('a stray write into the account ~/.core', () => {
  writeFileSync(join(userInfo().homedir, '.core', 'stray-from-test.txt'), 'x');
});
