import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walk } from '../../plugins/core/skills/core/scripts/graph-walk.mjs';

// Build a tiny vault: seed -> a (valid) and seed -> b (invalidated). Recent dates
// so R·S never prunes them — the only reason b drops out is validity-suppression.
function vault() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-walk-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  const write = (id, fm, edges = []) => {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    if (edges.length) {
      lines.push('edges:');
      for (const e of edges) lines.push(`  - { type: ${e.type}, target: ${e.target} }`);
    }
    lines.push('---', '', `# ${id}`, 'body');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  };
  write('seed', { type: 'decision', created: '2026-05-25', sources: 'PROJECT.md' },
    [{ type: 'depends-on', target: 'a-valid' }, { type: 'supersedes', target: 'b-invalid' }]);
  write('a-valid', { type: 'decision', created: '2026-05-25', sources: 'PROJECT.md' });
  // Recent created (high R·S so it survives the prune) but a PAST t_invalid — so
  // validity-suppression is the only reason it leaves the valid candidate set.
  write('b-invalid', { type: 'decision', created: '2026-05-25', t_invalid: '2026-05-28', sources: 'PROJECT.md' });
  return { dir, mem };
}

const TODAY = new Date(Date.UTC(2026, 5, 2)); // 2026-06-02

test('walk suppresses invalidated units from the candidate set by default', () => {
  const { dir, mem } = vault();
  try {
    const stats = {};
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, stats }).map(c => c.unit_id);
    assert.ok(ids.includes('a-valid'), 'valid neighbor surfaces');
    assert.ok(!ids.includes('b-invalid'), 'invalidated neighbor suppressed');
    assert.equal(stats.suppressed_invalidated, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('includeInvalidated:true brings cold history back into the candidate set', () => {
  const { dir, mem } = vault();
  try {
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, includeInvalidated: true }).map(c => c.unit_id);
    assert.ok(ids.includes('b-invalid'), 'invalidated unit reachable with includeInvalidated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an open-interval unit (no t_invalid) is never suppressed', () => {
  const { dir, mem } = vault();
  try {
    const stats = {};
    const ids = walk(join(mem, 'seed.md'), { memoriesDir: mem, today: TODAY, stats }).map(c => c.unit_id);
    assert.ok(ids.includes('a-valid'));
    assert.equal(stats.suppressed_invalidated, 1); // only b-invalid, not a-valid
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
