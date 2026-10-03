import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { main } from '../../plugins/core/skills/core/scripts/generate-memory-index.mjs';
const text = '<!-- CORE-VISIBILITY-CANARY vcan-owned-elsewhere -->\n\n## Human instructions\nKeep this exact text.\n';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'core-canary-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const memories = join(root, 'source', '_memories');
  const targetDir = join(root, 'projects', 'foreign-project', 'memory');
  mkdirSync(memories, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  const target = join(targetDir, 'MEMORY.md');
  writeFileSync(target, text);
  return { root, memories, target };
}
test('foreign-project refusal preserves all bytes including old canary', t => {
  const f = fixture(t);
  assert.equal(main([f.memories, '--memory-md', f.target]), 3);
  assert.equal(readFileSync(f.target, 'utf8'), text);
});
test('shared repository MEMORY skip also preserves all bytes including old canary', t => {
  const f = fixture(t);
  execFileSync('git', ['init', '-q', f.root]);
  const target = join(f.root, 'MEMORY.md');
  writeFileSync(target, text);
  assert.equal(main([f.memories, '--memory-md', target]), 0);
  assert.equal(readFileSync(target, 'utf8'), text);
});
test('same-project target removes canary only on a valid non-dry write', t => {
  const f = fixture(t);
  const target = join(f.root, 'source', 'MEMORY.md');
  writeFileSync(target, text);
  assert.equal(main([f.memories, '--memory-md', target, '--dry-run']), 0);
  assert.equal(readFileSync(target, 'utf8'), text);
  assert.equal(main([f.memories, '--memory-md', target, '--today', 'invalid']), 2);
  assert.equal(readFileSync(target, 'utf8'), text);
  assert.equal(main([f.memories, '--memory-md', target]), 0);
  assert.doesNotMatch(readFileSync(target, 'utf8'), /vcan-owned-elsewhere/);
  assert.match(readFileSync(target, 'utf8'), /Keep this exact text\./);
});
