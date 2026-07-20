import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PILOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { checkCorpusLeakage, checkStringsForLeakage } = await import(pathToFileURL(join(PILOT, 'corpus-leakage-check.mjs')).href);

function store(units) {
  const root = mkdtempSync(join(tmpdir(), 'leak-check-'));
  const mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [filename, content] of Object.entries(units)) {
    writeFileSync(join(mem, filename), content);
  }
  return root;
}

test('checkCorpusLeakage requires an explicit carrier per token', () => {
  const root = store({ 'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit\n\nBody.\n' });
  assert.throws(() => checkCorpusLeakage(root, []), (e) => e.code === 'PLANTS_REQUIRED');
  assert.throws(
    () => checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'does-not-exist.md' }]),
    (e) => e.code === 'CARRIER_NOT_FOUND',
  );
});

// Hale re-audit (hale--4fa-f624-narrow-pass-new-falsifiers): "Two units
// share frontmatter id 'duplicate-carrier', both bodies contain the
// token, and the plant names that id. checkCorpusLeakage() treats both
// as carriers and returns clean: true." A carrier reference must resolve
// to exactly one unit -- ambiguity here means the corpus itself has a
// duplicate-id problem the check must not silently reason past.
test('checkCorpusLeakage rejects an ambiguous carrier reference (duplicate frontmatter id)', () => {
  const root = store({
    'dc-1-a.md': '---\nid: duplicate-carrier\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit A\n\nThe answer is cobalt.\n',
    'dc-2-b.md': '---\nid: duplicate-carrier\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit B\n\nAlso says cobalt here.\n',
  });
  assert.throws(
    () => checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'duplicate-carrier' }]),
    (e) => e.code === 'AMBIGUOUS_CARRIER',
  );
});

test('clean corpus: target token only in the designated carrier body passes', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot proof unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-proof.md' }]);
  assert.equal(clean, true, `expected clean, got: ${JSON.stringify(violations)}`);
});

test('leak via unit id', () => {
  const root = store({
    'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-cobalt.md' }]);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'id' && v.token === 'cobalt'));
});

test('leak via file path/name', () => {
  const root = store({
    'dc-1-cobalt-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-proof' }]);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'path'));
});

// Hale re-audit (b3dc2e2), false negative 2: block-style YAML topics were
// never recognized by the ad hoc parser -- only flow-style `[a, b]`. Now
// uses the project's real parseFrontmatter (validate.mjs), which handles
// both.
test('leak via block-style YAML topics', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics:\n  - pilot\n  - cobalt\n---\n\n# Pilot unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-proof.md' }]);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'topics'), `expected a topics violation, got: ${JSON.stringify(violations)}`);
});

test('leak via flow-style YAML topics (unchanged coverage)', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot, cobalt]\n---\n\n# Pilot unit\n\nThe blue orchard proof codename is cobalt.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-proof.md' }]);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'topics'));
});

test('leak via heading (H1)', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# The cobalt unit\n\nBody.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-proof.md' }]);
  assert.equal(clean, false);
  assert.ok(violations.some(v => v.field === 'heading'));
});

// Hale re-audit, false negative 1: the token in a SIBLING/decoy unit's body
// (not the designated carrier) was silently exempt because every body was
// exempt, not just the carrier's. That's a real spoil -- a model could
// stumble on the fact via the wrong unit and the trial would wrongly count
// it as "reasoned over the intended memory."
test('leak via a sibling/decoy unit body (only the designated carrier may contain the token)', () => {
  const root = store({
    'dc-1-carrier.md': '---\nid: dc-1-carrier\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Carrier unit\n\nThe blue orchard proof codename is cobalt.\n',
    'dc-2-decoy.md': '---\nid: dc-2-decoy\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Decoy unit\n\nUnrelated content that happens to also mention cobalt in passing.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-carrier.md' }]);
  assert.equal(clean, false, 'the decoy body leak must be caught');
  assert.ok(violations.some(v => v.unit === 'dc-2-decoy.md' && v.field === 'body'));
  // The carrier's own legitimate body mention must NOT be flagged.
  assert.ok(!violations.some(v => v.unit === 'dc-1-carrier.md' && v.field === 'body'));
});

test('case-insensitive matching catches Cobalt/COBALT variants', () => {
  const root = store({
    'dc-1-proof.md': '---\nid: dc-1-COBALT\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Pilot unit\n\nThe proof codename is COBALT.\n',
  });
  const { clean } = checkCorpusLeakage(root, [{ token: 'cobalt', carrierUnit: 'dc-1-COBALT' }]);
  assert.equal(clean, false);
});

test('multiple planted tokens are checked independently, each against its own carrier', () => {
  const root = store({
    'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit one\n\nThe proof codename is cobalt.\n',
    'dc-2-proof.md': '---\nid: dc-2-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit two\n\nThe answer is amber.\n',
  });
  const { clean, violations } = checkCorpusLeakage(root, [
    { token: 'cobalt', carrierUnit: 'dc-1-cobalt.md' },
    { token: 'amber', carrierUnit: 'dc-2-proof.md' },
  ]);
  assert.equal(clean, false);
  assert.ok(violations.every(v => v.token === 'cobalt'), 'amber (legitimately in its own carrier body) must never be flagged');
  assert.ok(violations.some(v => v.field === 'path'));
  assert.ok(violations.some(v => v.field === 'id'));
});

test('checkStringsForLeakage catches a target token in prompt/arm/index metadata', () => {
  const clean = checkStringsForLeakage({ prompt: 'what is the proof codename?', arm_label: 'always-on' }, ['cobalt']);
  assert.equal(clean.clean, true);
  const leaked = checkStringsForLeakage({ prompt: 'is the codename cobalt?', arm_label: 'always-on' }, ['cobalt']);
  assert.equal(leaked.clean, false);
  assert.ok(leaked.violations.some(v => v.field === 'prompt'));
});

test('CLI: clean corpus exits 0, leaking corpus exits 1', async () => {
  const { execFileSync } = await import('node:child_process');
  const SCRIPT = join(PILOT, 'corpus-leakage-check.mjs');

  const cleanRoot = store({ 'dc-1-proof.md': '---\nid: dc-1-proof\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit\n\nThe answer is cobalt.\n' });
  const okOut = execFileSync('node', [SCRIPT, cleanRoot, 'cobalt=dc-1-proof.md'], { encoding: 'utf8' });
  assert.match(okOut, /^clean: 0 leaks/);

  const leakRoot = store({ 'dc-1-cobalt.md': '---\nid: dc-1-cobalt\ntype: decision\nstatus: active\ntopics: [pilot]\n---\n\n# Unit\n\nThe answer is cobalt.\n' });
  assert.throws(() => execFileSync('node', [SCRIPT, leakRoot, 'cobalt=dc-1-cobalt.md'], { encoding: 'utf8' }));
});
