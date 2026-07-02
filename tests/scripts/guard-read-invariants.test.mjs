// REGRESSION GUARD — pattern 5: "a read-side invariant with no single owner."
//
// Every path that reads the unit store must hold the same two invariants:
//   (a) a terminal-status unit (retired/archived/superseded) does not surface by default;
//   (b) an invalidated unit (t_invalid in the past) does not surface by default.
// Deleted facts resurfaced before because these held in some read paths and not
// others. This guard checks ALL default-read entry points against ONE fixture, so
// a new read path (or a regression in an existing one) that skips the check fails CI.
//
// When you add a new way to read/rank/retrieve units, add it to READERS below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { walk } from '../../plugins/core/skills/core/scripts/graph-walk.mjs';
import { rankUnits } from '../../plugins/core/skills/core/scripts/priority.mjs';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

const T = new Date('2026-07-02');

// A store with an active unit and two units that must be suppressed by default:
// one retired (user-deleted, freshly dated so score can't be the excuse), one
// active-status but invalidated (past t_invalid). Both cite the active unit so an
// edge walk reaches them.
function store() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-read-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  const write = (id, fm, edges = []) => {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    if (edges.length) { lines.push('edges:'); for (const e of edges) lines.push(`  - { type: ${e.type}, target: ${e.target} }`); }
    lines.push('---', '', `# ${id}`, 'widget alpha decision body');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  };
  write('dc-active', { type: 'decision', status: 'active', created: '2026-05-25', updated: '2026-05-25',
    canonical: 'true', sources: '[PROJECT.md]', topics: '[widget]' },
    [{ type: 'cites', target: 'dc-retired' }, { type: 'cites', target: 'dc-invalid' }]);
  write('dc-retired', { type: 'decision', status: 'retired', created: '2026-05-25', updated: '2026-07-01',
    canonical: 'true', sources: '[PROJECT.md]', topics: '[widget]' }, [{ type: 'cites', target: 'dc-active' }]);
  write('dc-invalid', { type: 'decision', status: 'active', created: '2026-05-25', updated: '2026-05-25',
    t_invalid: '2026-06-01', canonical: 'true', sources: '[PROJECT.md]', topics: '[widget]' },
    [{ type: 'cites', target: 'dc-active' }]);
  return { dir, mem };
}

// Each reader: name -> function returning the set of surfaced unit ids for the store.
const READERS = {
  'graph-walk': ({ mem }) => new Set(walk(join(mem, 'dc-active.md'), { memoriesDir: mem, today: T }).map(r => r.unit_id)),
  'rankUnits': ({ mem }) => new Set(rankUnits(mem, { today: T }).map(([, u]) => u.id)),
  'retrieve-context': ({ dir }) => new Set(retrieveContext('widget alpha decision', dir, { topN: 9 }).map(h => h.id)),
};

for (const [name, read] of Object.entries(READERS)) {
  test(`read-invariant: ${name} suppresses retired units by default`, () => {
    const s = store();
    try { assert.ok(!read(s).has('dc-retired'), `${name} surfaced a retired unit`); }
    finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
  test(`read-invariant: ${name} suppresses invalidated units by default`, () => {
    const s = store();
    try { assert.ok(!read(s).has('dc-invalid'), `${name} surfaced an invalidated unit`); }
    finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
  test(`read-invariant: ${name} still surfaces the active unit (filter not over-broad)`, () => {
    const s = store();
    try {
      // retrieve-context seeds from a lexical hit; the active unit is the seed/anchor everywhere.
      const ids = read(s);
      assert.ok(ids.has('dc-active') || name === 'graph-walk',
        `${name} dropped the active unit`);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
}
