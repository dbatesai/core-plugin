// Control fixture: the stray write happens in a node process the test spawns (a hook, a CLI), which
// must resolve the same protected account home as the test file does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('a stray write from a spawned node process', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { userInfo } from 'node:os';
    try { writeFileSync(join(userInfo().homedir, '.core', 'stray-from-child.txt'), 'x'); console.log('WROTE'); } catch (e) { console.log(e.code); }`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'EACCES');
});
