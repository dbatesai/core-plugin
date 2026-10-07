// Run only through scripts/release/run-suite-isolated.mjs: it makes the runner's own cleanup fail twice, then fails the suite.
// The protected ~/.core is moved aside (so restoring its mode fails) and a folder inside the disposable home is made
// unreadable (so removing the home fails), and the test itself then fails. Refuses anywhere but the disposable home.
import { test } from 'node:test';
import { renameSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { isRunnerHome } from '../helpers/disposable-home.mjs';

test('make the runner clean up badly, then fail', () => {
  const home = process.env.CORE_TEST_ACCOUNT_HOME || '';
  if (!isRunnerHome(home)) throw new Error(`refusing to run outside the runner's disposable home: ${home || '(none)'}`);
  renameSync(join(home, '.core'), join(home, '.core-moved'));
  mkdirSync(join(home, 'locked'));
  writeFileSync(join(home, 'locked', 'f'), 'x');
  chmodSync(join(home, 'locked'), 0o000);
  throw new Error('deliberate suite failure');
});
