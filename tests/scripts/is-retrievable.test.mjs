import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walk } from '../../plugins/core/skills/core/scripts/graph-walk.mjs';
import { rankUnits } from '../../plugins/core/skills/core/scripts/priority.mjs';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';
import { isActiveStatus } from '../../plugins/core/skills/core/scripts/unit-vocab.mjs';

// A store where a user-DELETED fact (status: retired) is canonical, PROJECT.md-sourced,
// and freshly dated — retiring bumps `updated`, so its R·S clears the 0.3 prune (~0.98).
// The only thing that should keep it out of retrieval is a status check. Before this fix
// there was none in graph-walk / rankUnits, and no invalidation check in the summary index.
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'is-retrievable-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  const write = (id, fm, edges = []) => {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    if (edges.length) {
      lines.push('edges:');
      for (const e of edges) lines.push(`  - { type: ${e.type}, target: ${e.target} }`);
    }
    lines.push('---', '', `# ${id}`, 'the widget alpha decision body text');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  };
  write('dc-active', { type: 'decision', status: 'active', created: '2026-05-25',
    updated: '2026-05-25', canonical: 'true', sources: '[PROJECT.md]', topics: '[widget]' },
    [{ type: 'cites', target: 'dc-deleted' }]);
  // The deleted fact: retired, canonical, fresh updated date, cites back to active
  // so the walk reaches it by edge.
  write('dc-deleted', { type: 'decision', status: 'retired', created: '2026-05-25',
    updated: '2026-07-01', retired_at: '2026-07-01', canonical: 'true',
    sources: '[PROJECT.md]', topics: '[widget]' },
    [{ type: 'cites', target: 'dc-active' }]);
  return { dir, mem };
}

const T = new Date('2026-07-02');

test('isActiveStatus: active/empty true, terminal false', () => {
  assert.equal(isActiveStatus({ status: 'active' }), true);
  assert.equal(isActiveStatus({}), true);
  assert.equal(isActiveStatus({ status: '' }), true);
  assert.equal(isActiveStatus({ status: 'retired' }), false);
  assert.equal(isActiveStatus({ status: 'archived' }), false);
  assert.equal(isActiveStatus({ status: 'superseded' }), false);
});

test('T1: graph-walk does not surface a retired unit', () => {
  const { mem } = store();
  const results = walk(join(mem, 'dc-active.md'), { memoriesDir: mem, today: T });
  const ids = results.map(r => r.unit_id);
  assert.ok(!ids.includes('dc-deleted'), `retired unit surfaced in walk: ${JSON.stringify(ids)}`);
});

test('T2: rankUnits does not rank a retired unit', () => {
  const { mem } = store();
  const ranked = rankUnits(mem, { today: T });
  const ids = ranked.map(([, u]) => u.id);
  assert.ok(!ids.includes('dc-deleted'), `retired unit ranked: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes('dc-active'), 'active unit should still rank');
});

test('T3: retrieveContext does not surface a retired unit', () => {
  const { dir } = store();
  const hits = retrieveContext('widget alpha decision', dir, { topN: 5 });
  const ids = hits.map(h => h.id);
  assert.ok(!ids.includes('dc-deleted'), `retired unit surfaced in retrieval: ${JSON.stringify(ids)}`);
});
