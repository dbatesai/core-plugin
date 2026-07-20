import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { checkCorpusLeakage } = await import(pathToFileURL(join(PILOT, 'corpus-leakage-check.mjs')).href);

function store(units) {
  const root = mkdtempSync(join(tmpdir(), 'leak-check-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [filename, content] of Object.entries(units)) {
    writeFileSync(join(mem, filename), content);
  }
  return root;
}

test('clean corpus: target token only in body prose passes', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot proof unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, true);
  assert.deepEqual(violations, []);
});

test('leak via unit id', () => {
  const root = store({
    'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nSome unrelated body.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'id' && v.token === 'cobalt'));
});

test('leak via file path/name', () => {
  const root = store({
    'dc-1-cobalt-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nBody.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'path'));
});

test('leak via topics', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot, cobalt]\n---\n\n# Pilot unit\n\nBody.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'topics'));
});

test('leak via heading (H1)', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# The cobalt unit\n\nBody.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'heading'));
});

test('case-insensitive matching catches Cobalt/COBALT variants', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-COBALT\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nBody.\n',
  });
  const { clean } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, false);
});

test('only the leaking unit is flagged, clean units in the same corpus are not', () => {
  const root = store({
    'dc-1-clean.md': '---\nid: dc-1-clean\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Clean unit\n\nThe fact is cobalt.\n',
    'dc-2-decoy.md': '---\nid: dc-2-decoy\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Decoy unit\n\nNothing relevant here.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt']);
  assert.equal(clean, true, `expected clean, got: ${JSON.stringify(violations)}`);
});

test('multiple target tokens are all checked independently', () => {
  const root = store({
    'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit one\n\nBody one.\n',
    'dc-2-proof.md': '---\nid: dc-2-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit two\n\nThe answer is amber.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, ['cobalt', 'amber']);
  assert.equal(clean, false);
  // "cobalt" leaks via both the filename and the id field on dc-1; "amber"
  // is body-only on dc-2 and must not appear in any violation.
  assert.ok(violations.every(v => v.token === 'cobalt'), 'amber (body-only) must never be flagged');
  assert.ok(violations.some(v => v.field === 'path'));
  assert.ok(violations.some(v => v.field === 'id'));
});

test('CLI: clean corpus exits 0, leaking corpus exits 1', async () => {
  const { execFileSync } = await import('node:child_process');
  const SCRIPT = join(PILOT, 'corpus-leakage-check.mjs');

  const cleanRoot = store({ 'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit\n\nThe answer is cobalt.\n' });
  const okOut = execFileSync('node', [SCRIPT, cleanRoot, 'cobalt'], { encoding: 'utf8' });
  assert.match(okOut, /^clean: 0 leaks/);

  const leakRoot = store({ 'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit\n\nBody.\n' });
  assert.throws(() => execFileSync('node', [SCRIPT, leakRoot, 'cobalt'], { encoding: 'utf8' }));
});
