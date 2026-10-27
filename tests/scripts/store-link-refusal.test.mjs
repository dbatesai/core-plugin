// A project whose `_memories` is a link to a folder outside it: the unit-index writer, the unit
// checker, the lifecycle report and the edge decorator each refuse before following the link, and
// the folder the link leads to keeps its exact bytes and listing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const isWin = process.platform === 'win32';
const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));

const UNITS = {
  'dc-001-outside-decision.md': '---\nid: dc-001-outside-decision\ntype: decision\nstatus: active\ncreated: 2026-01-01\n---\n# An outside decision\n\nbody\n',
  'risk-001-outside-risk.md': '---\nid: risk-001-outside-risk\ntype: risk\nstatus: active\ncreated: 2026-01-01\n---\n# An outside risk\n\nbody\n',
  'secret.md': '---\nid: secret\ntype: observation\n---\nsecret: outside the project\n',
};

function writeUnits(dir) { for (const [n, body] of Object.entries(UNITS)) writeFileSync(join(dir, n), body); }

function fixture({ linked }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-link-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target');
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, 'PROJECT.md'), '# Project\n');
  if (linked) { writeUnits(outside); symlinkSync('../outside-target', join(root, '_memories')); }
  else { mkdirSync(join(root, '_memories')); writeUnits(join(root, '_memories')); }
  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Every entry (dot files included) with the sha1 of each file's bytes, sorted. */
function snapshot(dir) {
  return readdirSync(dir).sort().map((n) => `${n}:${createHash('sha1').update(readFileSync(join(dir, n))).digest('hex')}`);
}

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, `${script} did not block`);
  return r;
}

const CASES = [
  ['generate-unit-index.mjs', (p) => ['--kind', 'decisions', '--store', p]],
  ['generate-unit-index.mjs', (p) => ['--kind', 'risks', '--store', p]],
  ['generate-unit-index.mjs', (p) => ['--kind', 'decisions', '--store', join(p, '_memories')]],
  ['check-units.mjs', (p) => ['--store', p, '--integrity']],
  ['check-units.mjs', (p) => ['--store', p]],
  ['check-units.mjs', (p) => ['--store', join(p, '_memories'), '--schema']],
  ['lifecycle-detect.mjs', (p) => [p, '--json']],
  ['lifecycle-detect.mjs', (p) => [p, '--record-session-start', 's1']],
  ['decorate-graph.mjs', (p) => [p]],
];

for (const [script, argsFor] of CASES) {
  test(`a linked _memories is refused by ${script} ${argsFor('<P>').join(' ')}, and the folder it leads to is byte-identical after`, { skip: isWin }, () => {
    const f = fixture({ linked: true });
    try {
      const before = snapshot(f.outside);
      const r = run(script, argsFor(f.root), f.base);
      assert.notEqual(r.status, 0, `${script} exits nonzero`);
      assert.match(r.stderr, /refused: store refused: .*_memories is a link or leaves the project folder/, `${script} names the refusal\n${r.stderr}`);
      for (const name of Object.keys(UNITS)) assert.ok(!r.stdout.includes(name.replace(/\.md$/, '')), `${script} printed nothing read through the link (${name})\n${r.stdout}`);
      assert.deepEqual(snapshot(f.outside), before, 'the outside folder keeps its listing and bytes');
    } finally { f.cleanup(); }
  });
}

test('control: with a real _memories folder the same commands run and are not refused', { skip: isWin }, () => {
  const f = fixture({ linked: false });
  try {
    for (const [script, argsFor] of CASES) {
      const r = run(script, argsFor(f.root), f.base);
      assert.doesNotMatch(r.stderr, /store refused/, `${script} ${argsFor('<P>').join(' ')}\n${r.stderr}`);
    }
    assert.ok(existsSync(join(f.root, '_memories', 'INDEX-decisions.md')), 'the decisions index is written inside the project');
    assert.ok(existsSync(join(f.root, '_memories', 'INDEX-risks.md')), 'the risks index is written inside the project');
  } finally { f.cleanup(); }
});
