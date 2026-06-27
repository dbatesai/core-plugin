import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSummaryIndex } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';

function fixtureStore() {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    '---\nid: dc-1-alpha\ntype: decision\nstatus: active\ntopics:\n  - retrieval\n---\n\n# DC-1 — Alpha decision\n\nBody prose here.');
  writeFileSync(join(mem, 'dc-2-retired.md'),
    '---\nid: dc-2-retired\ntype: decision\nstatus: retired\ntopics:\n  - retrieval\n---\n\n# DC-2 — Retired\n\nShould be excluded.');
  return root;
}

test('indexes active units and excludes retired', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const ids = res.units.map(u => u.id);
  assert.ok(ids.includes('dc-1-alpha'));
  assert.ok(!ids.includes('dc-2-retired'), 'retired units must be excluded');
});

test('summary is the H1 line stripped', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const u = res.units.find(x => x.id === 'dc-1-alpha');
  assert.match(u.summary, /Alpha decision/);
  assert.ok(!u.summary.startsWith('#'), 'leading # must be stripped');
});

test('topics survive as a list (canonical parser, not flat)', () => {
  const root = fixtureStore();
  const res = generateSummaryIndex(root);
  const u = res.units.find(x => x.id === 'dc-1-alpha');
  assert.ok(Array.isArray(u.topics), 'topics must be an array');
  assert.ok(u.topics.includes('retrieval'));
});

test('writes _lib/unit-summaries.json atomically', () => {
  const root = fixtureStore();
  generateSummaryIndex(root);
  const written = JSON.parse(readFileSync(join(root, '_memories', '_lib', 'unit-summaries.json'), 'utf8'));
  assert.ok(Array.isArray(written.units));
  assert.equal(typeof written.count, 'number');
});

test('missing status is treated as active', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-idx-nostatus-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-3-nostatus.md'),
    '---\nid: dc-3-nostatus\ntype: decision\ntopics:\n  - retrieval\n---\n\n# DC-3 — No status\n\nBody.');
  const res = generateSummaryIndex(root);
  assert.ok(res.units.map(u => u.id).includes('dc-3-nostatus'));
});
