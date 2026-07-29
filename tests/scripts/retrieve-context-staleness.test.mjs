import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

// R1: the summary index must regenerate when the source units change.
// Before this fix, retrieveContext reused a present-and-parseable index forever —
// so a retired or deleted unit lingered in the retrieval surface (an anti-resurrection
// hole at the retrieval layer). These tests drive the staleness detection.

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'core-stale-'));
  mkdirSync(join(root, '_memories'), { recursive: true });
  return root;
}

function writeUnit(root, id, { status, topics = [], title, mtime } = {}) {
  const fm = ['---', `id: ${id}`, 'type: observation'];
  if (status) fm.push(`status: ${status}`);
  if (topics.length) { fm.push('topics:'); for (const t of topics) fm.push(`  - ${t}`); }
  fm.push('---', '', `# ${title || id}`, '');
  const path = join(root, '_memories', `${id}.md`);
  writeFileSync(path, fm.join('\n'));
  // Deterministic mtime so staleness detection isn't at the mercy of same-ms writes.
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

test('in-place retire drops the unit from retrieval (the anti-resurrection case)', () => {
  const root = makeStore();
  writeUnit(root, 'omega-want', { title: 'Omega Speedmaster on sale wait', mtime: 1000 });
  let hits = retrieveContext('omega speedmaster sale', root, { topN: 5 });
  assert.ok(hits.some(h => h.id === 'omega-want'), 'active unit surfaces first');

  // Retire it in place (same filename, newer mtime).
  writeUnit(root, 'omega-want', { status: 'retired', title: 'Omega Speedmaster on sale wait', mtime: 2000 });
  hits = retrieveContext('omega speedmaster sale', root, { topN: 5 });
  assert.ok(!hits.some(h => h.id === 'omega-want'), 'a retired unit must drop out of retrieval');
});

test('a deleted unit file drops from retrieval', () => {
  const root = makeStore();
  writeUnit(root, 'gone-unit', { title: 'Rolex Daytona listing', mtime: 1000 });
  let hits = retrieveContext('rolex daytona', root, { topN: 5 });
  assert.ok(hits.some(h => h.id === 'gone-unit'), 'present before delete');

  rmSync(join(root, '_memories', 'gone-unit.md'));
  hits = retrieveContext('rolex daytona', root, { topN: 5 });
  assert.ok(!hits.some(h => h.id === 'gone-unit'), 'a deleted unit must drop out of retrieval');
});

test('a newly-added unit becomes retrievable', () => {
  const root = makeStore();
  writeUnit(root, 'seed', { title: 'unrelated seed', mtime: 1000 });
  retrieveContext('zenith primero', root, { topN: 5 }); // builds the index
  writeUnit(root, 'zenith-new', { title: 'Zenith El Primero chronograph', mtime: 2000 });
  const hits = retrieveContext('zenith primero', root, { topN: 5 });
  assert.ok(hits.some(h => h.id === 'zenith-new'), 'an added unit must become retrievable');
});

test('an unchanged store does not rewrite the index (retrieval stays cheap)', () => {
  const root = makeStore();
  writeUnit(root, 'stable-unit', { title: 'stable watch unit', mtime: 1000 });
  retrieveContext('stable watch', root, { topN: 5 }); // builds index
  const indexPath = join(root, '_memories', '_lib', 'unit-summaries.json');
  const firstMtime = statSync(indexPath).mtimeMs;
  retrieveContext('stable watch', root, { topN: 5 }); // no source change
  const secondMtime = statSync(indexPath).mtimeMs;
  assert.strictEqual(secondMtime, firstMtime, 'a fresh index must not be regenerated on every call');
});
