/**
 * decorate-graph — in-place Obsidian-native [[wikilink]] decoration.
 * Covers the guarantees named in its own docstring: idempotence, dangling/
 * retired-target stripping, destructive marker replacement, and clean
 * removal when a unit's edges disappear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const { decorateStore, decorateUnitText, findExistingEdgesBlock, renderEdgesBlock, EDGES_BEGIN, EDGES_END } =
  await import(pathToFileURL(join(SCRIPTS, 'decorate-graph.mjs')).href);

function fixtureStore() {
  const root = mkdtempSync(join(tmpdir(), 'decorate-graph-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-1-alpha.md'),
    `---\nid: dc-1-alpha\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-2-beta\n  - type: supersedes\n    target: dc-3-retired\n---\n\n# DC-1 — Alpha\n\nBody.\n`);
  writeFileSync(join(mem, 'dc-2-beta.md'),
    '---\nid: dc-2-beta\ntype: decision\nstatus: active\n---\n\n# DC-2 — Beta\n\nBody.\n');
  writeFileSync(join(mem, 'dc-3-retired.md'),
    '---\nid: dc-3-retired\ntype: decision\nstatus: retired\n---\n\n# DC-3 — Retired\n\nMust never be linked to.\n');
  writeFileSync(join(mem, 'dc-4-orphan.md'),
    '---\nid: dc-4-orphan\ntype: observation\nstatus: active\n---\n\n# DC-4 — No edges\n\nBody.\n');
  writeFileSync(join(mem, 'INDEX.md'), '# scaffolding — must be excluded');
  return root;
}

test('renders a [[wikilink]] block for an active edge, filters an edge to a retired target', () => {
  const activeById = new Map([['dc-1', {}], ['dc-2', {}]]);
  const edges = [{ type: 'cites', target: 'dc-2' }, { type: 'supersedes', target: 'dc-3-retired' }];
  const block = renderEdgesBlock('dc-1', edges, activeById);
  assert.match(block, /\[\[dc-2\]\]/);
  assert.doesNotMatch(block, /dc-3-retired/);
  assert.ok(block.includes(EDGES_BEGIN) && block.includes(EDGES_END));
});

test('no kept edges renders an empty block (nothing to add)', () => {
  const activeById = new Map([['dc-1', {}]]);
  const block = renderEdgesBlock('dc-1', [{ type: 'cites', target: 'dc-9-missing' }], activeById);
  assert.equal(block, '');
});

test('decorateUnitText appends a new block when none exists', () => {
  const activeById = new Map([['dc-1', {}], ['dc-2', {}]]);
  const text = '---\nid: dc-1\ntype: decision\nstatus: active\n---\n\n# dc-1\n\nBody.\n';
  const out = decorateUnitText(text, 'dc-1', [{ type: 'cites', target: 'dc-2' }], activeById);
  assert.ok(out.startsWith(text.trimEnd()), 'human-authored body precedes the appended block');
  assert.match(out, /\[\[dc-2\]\]/);
});

test('decorateUnitText replaces an existing block rather than duplicating it', () => {
  const activeById = new Map([['dc-1', {}], ['dc-2', {}], ['dc-3', {}]]);
  const withOldBlock = `---\nid: dc-1\ntype: decision\nstatus: active\n---\n\n# dc-1\n\nBody.\n\n${EDGES_BEGIN}\nstale content\n${EDGES_END}\n`;
  const out = decorateUnitText(withOldBlock, 'dc-1', [{ type: 'cites', target: 'dc-3' }], activeById);
  assert.equal((out.match(new RegExp(EDGES_BEGIN.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'g')) || []).length, 1,
    'exactly one begin marker — no duplication');
  assert.doesNotMatch(out, /stale content/);
  assert.match(out, /\[\[dc-3\]\]/);
});

test('decorateUnitText is idempotent — a second pass with the same edges is a byte-identical no-op', () => {
  const activeById = new Map([['dc-1', {}], ['dc-2', {}]]);
  const text = '---\nid: dc-1\ntype: decision\nstatus: active\n---\n\n# dc-1\n\nBody.\n';
  const edges = [{ type: 'cites', target: 'dc-2' }];
  const once = decorateUnitText(text, 'dc-1', edges, activeById);
  const twice = decorateUnitText(once, 'dc-1', edges, activeById);
  assert.equal(once, twice);
});

test('decorateUnitText cleanly removes a stale block once its edges are gone', () => {
  const activeById = new Map([['dc-1', {}]]);
  const withBlock = `---\nid: dc-1\ntype: decision\nstatus: active\n---\n\n# dc-1\n\nBody.\n\n${EDGES_BEGIN}\n- cites: [[dc-2]]\n${EDGES_END}\n`;
  const out = decorateUnitText(withBlock, 'dc-1', [], activeById);
  assert.equal(findExistingEdgesBlock(out), null);
  assert.doesNotMatch(out, /CORE:BEGIN_EDGES/);
});

test('decorateStore: writes changed units, skips unchanged, never touches a retired unit', () => {
  const root = fixtureStore();
  try {
    const result = decorateStore(root);
    assert.equal(result.changed.includes('dc-1-alpha.md'), true, 'dc-1 gained a real edge to dc-2');
    assert.equal(result.changed.includes('dc-4-orphan.md'), false, 'dc-4 has no edges — nothing to write');

    const alpha = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
    assert.match(alpha, /\[\[dc-2-beta\]\]/);
    assert.doesNotMatch(alpha, /\[\[dc-3-retired\]\]/, 'edge to a retired target must not appear as a rendered link (raw frontmatter still legitimately names it)');

    const retired = readFileSync(join(root, '_memories', 'dc-3-retired.md'), 'utf8');
    assert.doesNotMatch(retired, /CORE:BEGIN_EDGES/, 'a retired unit is out of loadSnapshot\'s active population — never decorated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('decorateStore: a second run over unchanged output writes nothing further', () => {
  const root = fixtureStore();
  try {
    decorateStore(root);
    const before = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
    const result2 = decorateStore(root);
    const after = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
    assert.equal(before, after);
    assert.equal(result2.changed.length, 0, 'fully idempotent on a second pass');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('decorateStore --dry-run (dryRun option) reports changes without writing them', () => {
  const root = fixtureStore();
  try {
    const before = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
    const result = decorateStore(root, { dryRun: true });
    const after = readFileSync(join(root, '_memories', 'dc-1-alpha.md'), 'utf8');
    assert.equal(before, after, 'dry run must not write');
    assert.ok(result.changed.includes('dc-1-alpha.md'));
    assert.equal(result.dry_run, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
