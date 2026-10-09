// Positive control: the shared test root inside the protected ~/.core takes writes.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';

test('a write into the shared test root', () => {
  writeFileSync(join(userInfo().homedir, '.core', '.test-tmp', 'ok-from-test.txt'), 'x');
});
