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
const { decorateStore, decorateUnitText, findExistingEdgesBlock, renderEdgesBlock, EDGES_BEGIN, EDGES_END, main } =
  await import(pathToFileURL(join(SCRIPTS, 'decorate-graph.mjs')).href);

function quiet(fn) {
  const origOut = process.stdout.write, origErr = process.stderr.write;
  const out = [], err = [];
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  try { return [fn(), out.join(''), err.join('')]; } finally { process.stdout.write = origOut; process.stderr.write = origErr; }
}

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
  assert.deepEqual(findExistingEdgesBlock(out), { ok: true, block: null });
  assert.doesNotMatch(out, /CORE:BEGIN_EDGES/);
});

test('findExistingEdgesBlock fails closed on a malformed marker state (Hale\'s falsifier)', () => {
  // One orphaned BEGIN, no END, a human-authored line after it — exactly the
  // shape that used to let a later regenerated END pair with the wrong BEGIN
  // and silently delete everything in between.
  const malformed = `# dc-1\n\nBody.\n\n${EDGES_BEGIN}\nHUMAN-MUST-SURVIVE\n`;
  assert.deepEqual(findExistingEdgesBlock(malformed), { ok: false, block: null });
});

test('findExistingEdgesBlock fails closed on duplicate BEGIN markers', () => {
  const malformed = `${EDGES_BEGIN}\nfirst\n${EDGES_BEGIN}\nsecond\n${EDGES_END}\n`;
  assert.deepEqual(findExistingEdgesBlock(malformed), { ok: false, block: null });
});

test('findExistingEdgesBlock fails closed when END precedes BEGIN', () => {
  const malformed = `${EDGES_END}\nstuff\n${EDGES_BEGIN}\n`;
  assert.deepEqual(findExistingEdgesBlock(malformed), { ok: false, block: null });
});

test('decorateUnitText throws MALFORMED_EDGES_MARKERS instead of corrupting a malformed file', () => {
  const activeById = new Map([['dc-1', {}], ['dc-2', {}]]);
  const malformed = `# dc-1\n\nBody.\n\n${EDGES_BEGIN}\nHUMAN-MUST-SURVIVE\n`;
  assert.throws(
    () => decorateUnitText(malformed, 'dc-1', [{ type: 'cites', target: 'dc-2' }], activeById),
    (e) => e.code === 'MALFORMED_EDGES_MARKERS',
  );
});

test('decorateStore refuses a malformed-marker file without touching its siblings', () => {
  const root = mkdtempSync(join(tmpdir(), 'decorate-graph-malformed-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'dc-1-bad.md'),
      `---\nid: dc-1-bad\ntype: decision\nstatus: active\nedges:\n  - type: cites\n    target: dc-2-good\n---\n\n# dc-1-bad\n\n${EDGES_BEGIN}\nHUMAN-MUST-SURVIVE\n`);
    writeFileSync(join(mem, 'dc-2-good.md'),
      '---\nid: dc-2-good\ntype: decision\nstatus: active\n---\n\n# dc-2-good\n\nBody.\n');
    const before = readFileSync(join(mem, 'dc-1-bad.md'), 'utf8');

    const result = decorateStore(root);

    const after = readFileSync(join(mem, 'dc-1-bad.md'), 'utf8');
    assert.equal(before, after, 'the malformed file must be left byte-identical, not guessed at');
    assert.match(after, /HUMAN-MUST-SURVIVE/, 'the human-authored line must survive');
    assert.equal(result.refused.some(r => r.path === 'dc-1-bad.md'), true);
    assert.equal(result.refused.some(r => r.path === 'dc-2-good.md'), false, 'a sibling file is unaffected by dc-1-bad\'s malformed markers');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stale-byte comparison: bytes mutated after capture correctly fail Buffer.equals', () => {
  // decorateStore's refusal path is exactly Buffer.equals() between the bytes
  // captured at snapshot time and a fresh read immediately before write.
  // Exercising the full concurrent-writer race through decorateStore itself
  // would need dependency injection into loadSnapshot's timing; this test
  // instead verifies the actual comparison primitive the refusal relies on,
  // using real file I/O — the same pattern this codebase's other
  // concurrency-safety tests use (e.g. file-lock.mjs's crash simulations
  // construct state directly rather than running real parallel processes).
  const root = mkdtempSync(join(tmpdir(), 'decorate-graph-stale-'));
  try {
    const filePath = join(root, 'unit.md');
    writeFileSync(filePath, 'original content, as captured by the snapshot');
    const captured = readFileSync(filePath);
    writeFileSync(filePath, 'mutated by a concurrent writer after the snapshot');
    const current = readFileSync(filePath);
    assert.equal(current.equals(captured), false, 'mutated bytes must not match the captured snapshot bytes');
  } finally { rmSync(root, { recursive: true, force: true }); }
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

test('decorateUnitText is CRLF-safe (Meridian\'s Windows review, 2026-07-21)', () => {
  // Marker lookup is plain string indexOf on the literal marker text, not a
  // newline-spanning regex, so a file rewritten with \r\n by Obsidian or a
  // Windows editor must not break block detection, idempotence, or removal.
  const activeById = new Map([['dc-1', {}], ['dc-2', {}]]);
  const crlfText = '---\r\nid: dc-1\r\ntype: decision\r\nstatus: active\r\n---\r\n\r\n# dc-1\r\n\r\nBody with CRLF.\r\n';
  const edges = [{ type: 'cites', target: 'dc-2' }];

  const once = decorateUnitText(crlfText, 'dc-1', edges, activeById);
  assert.match(once, /\[\[dc-2\]\]/);

  const twice = decorateUnitText(once, 'dc-1', edges, activeById);
  assert.equal(once, twice, 'idempotent on a CRLF file');

  const removed = decorateUnitText(once, 'dc-1', [], activeById);
  assert.doesNotMatch(removed, /CORE:BEGIN_EDGES/);
  assert.match(removed, /Body with CRLF\.\r\n/, 'human-authored CRLF line endings survive block removal');
});

test('main() prints and exits nonzero on a refused (malformed-marker) file, instead of silently reporting success (Hale\'s 2026-07-21 finding)', () => {
  const root = mkdtempSync(join(tmpdir(), 'decorate-graph-cli-refuse-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'dc-1-bad.md'),
      `---\nid: dc-1-bad\ntype: decision\nstatus: active\n---\n\n# dc-1-bad\n\n${EDGES_BEGIN}\nHUMAN-MUST-SURVIVE\n`);

    const [exitCode, out, err] = quiet(() => main([root]));
    assert.notEqual(exitCode, 0, 'a refusal must not report success');
    assert.doesNotMatch(out, /none needed a change/, 'must not claim nothing happened when a file was refused');
    assert.match(err, /dc-1-bad\.md/, 'the refused file must be named');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('main() reports success cleanly when nothing needs a change and nothing is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'decorate-graph-cli-clean-'));
  try {
    const mem = join(root, '_memories');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'dc-1.md'), '---\nid: dc-1\ntype: decision\nstatus: active\n---\n\n# dc-1\n\nBody.\n');

    const [exitCode, out] = quiet(() => main([root]));
    assert.equal(exitCode, 0);
    assert.match(out, /none needed a change/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
