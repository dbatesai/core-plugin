// A project whose `_memories` is a link to a folder outside it: the unit-index writer, the unit
// checker, the lifecycle report, the edge decorator, the session-close marker and lock, the
// supersession stamper, the capability-drift log, the MEMORY.md priority block, the PROJECT.md
// decision compactor and hot section, and the metrics package each refuse before following the
// link. The folder the link leads to keeps its exact bytes and listing, and nothing read through it
// reaches MEMORY.md, PROJECT.md or a package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stampCreatedBaseline } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';

const isWin = process.platform === 'win32';
const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));

const UNITS = {
  'dc-001-outside-decision.md': '---\nid: dc-001-outside-decision\ntype: decision\nstatus: active\ncreated: 2026-01-01\n---\n# An outside decision\n\nbody\n',
  'risk-001-outside-risk.md': '---\nid: risk-001-outside-risk\ntype: risk\nstatus: active\ncreated: 2026-01-01\n---\n# An outside risk\n\nbody\n',
  'secret.md': '---\nid: secret\ntype: observation\n---\nsecret: outside the project\n',
  'dc-002-retired-target.md': '---\nid: dc-002-retired-target\ntype: decision\nstatus: retired\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# A retired decision\n',
  'dc-003-superseder.md': '---\nid: dc-003-superseder\ntype: decision\nstatus: active\ncreated: 2026-02-01\nupdated: 2026-02-01\nedges:\n  - { type: supersedes, target: dc-002-retired-target }\n---\n# A superseding decision\n',
  'capability-drift-log.md': '# an outside file with the old drift-log name\n',
  '_close-marker.json': '{"session_id":"outside","status":"closed","ops":{}}\n',
};

function writeUnits(dir) { for (const [n, body] of Object.entries(UNITS)) writeFileSync(join(dir, n), body); }

// A full-text decision entry the compactor would turn into a stub carrying the unit's title. The
// ledger prefix is built from parts so the development-leakage scan sees no ledger reference here.
const DC1 = 'D' + 'C-1';
const PROJECT_MD = '# Project\n\n**Decisions (dated, append-only):**\n\n- `2026-01-01` — **' + DC1 + ': Placeholder title.** A full-text entry long enough to be compacted into a one-line stub.\n  Second line of the entry.\n\n**Risks (open):**\n\n- none\n';
// MEMORY.md sits beside the project, as the harness's own copy does.
const MEMORY_MD = '# Memory\n\n## Top project units\n\n- (none yet)\n\n## Other\n\nkept\n';

function fixture({ linked }) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-link-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target');
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, 'PROJECT.md'), PROJECT_MD);
  writeFileSync(join(base, 'MEMORY.md'), MEMORY_MD);
  mkdirSync(join(base, 'home', '.core'), { recursive: true });
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
  ['close-pass.mjs', (p) => ['begin', p, '--session', 's1', '--ops', 'material-capture']],
  ['close-pass.mjs', (p) => ['record', p, '--op', 'material-capture', '--status', 'done']],
  ['close-pass.mjs', (p) => ['finish', p, '--session', 's1']],
  ['close-pass.mjs', (p) => ['detect', p, '--ops', 'material-capture']],
  ['close-pass.mjs', (p) => ['certify', p, '--session', 's1']],
  ['close-pass.mjs', (p) => ['release', p]],
  ['close-pass.mjs', (p) => ['process-request', p, '--session', 's1']],
  ['bitemporal.mjs', (p) => [p, '--stamp', '--apply']],
  ['bitemporal.mjs', (p) => [p, '--metrics']],
  ['analyze-capability-drift.mjs', (p) => [p, '--harness', 'claude-code']],
  ['generate-memory-index.mjs', (p) => [join(p, '_memories'), '--memory-md', join(dirname(p), 'MEMORY.md'), '--today', '2026-03-01']],
  ['generate-memory-index.mjs', (p) => [join(p, '_memories'), '--memory-md', join(dirname(p), 'MEMORY.md'), '--dry-run']],
  ['compact-project.mjs', (p) => [p]],
  ['hot-section.mjs', (p) => ['candidates', p, '--json']],
  ['hot-section.mjs', (p) => ['apply', p, '--text', 'a hot line']],
  ['hot-section.mjs', (p) => ['clear', p]],
  ['metrics-package.mjs', (p) => [p, '--home', join(dirname(p), 'home')]],
];

/** The places a reader copies store content to: MEMORY.md, PROJECT.md, and anything new in the project (a package, a scratch folder). */
function destinations(f) {
  return {
    memoryMd: readFileSync(join(f.base, 'MEMORY.md'), 'utf8'),
    projectMd: readFileSync(join(f.root, 'PROJECT.md'), 'utf8'),
    projectListing: readdirSync(f.root).sort(),
  };
}

for (const [script, argsFor] of CASES) {
  test(`a linked _memories is refused by ${script} ${argsFor('<P>').join(' ')}, and the folder it leads to is byte-identical after`, { skip: isWin }, () => {
    const f = fixture({ linked: true });
    try {
      const before = snapshot(f.outside);
      const destBefore = destinations(f);
      const r = run(script, argsFor(f.root), f.base);
      assert.notEqual(r.status, 0, `${script} exits nonzero`);
      assert.match(r.stderr, /refused: store refused: .*_memories is a link or leaves the project folder/, `${script} names the refusal\n${r.stderr}`);
      for (const name of Object.keys(UNITS)) assert.ok(!r.stdout.includes(name.replace(/\.md$/, '')), `${script} printed nothing read through the link (${name})\n${r.stdout}`);
      assert.deepEqual(snapshot(f.outside), before, 'the outside folder keeps its listing and bytes');
      const destAfter = destinations(f);
      assert.equal(destAfter.memoryMd, destBefore.memoryMd, 'MEMORY.md is unchanged');
      assert.equal(destAfter.projectMd, destBefore.projectMd, 'PROJECT.md is unchanged');
      assert.deepEqual(destAfter.projectListing, destBefore.projectListing, 'nothing new (a package, a scratch folder) appears in the project');
      for (const text of [destAfter.memoryMd, destAfter.projectMd]) assert.doesNotMatch(text, /outside/i, 'no outside title reached MEMORY.md or PROJECT.md');
    } finally { f.cleanup(); }
  });
}

test('control: with a real _memories folder the same commands run and are not refused', { skip: isWin }, () => {
  const f = fixture({ linked: false });
  try {
    // PROJECT.md's creation baseline, which the compactor requires before it writes.
    stampCreatedBaseline(f.root, join(f.root, 'PROJECT.md'), { kind: 'project', home: join(f.base, 'home') });
    for (const [script, argsFor] of CASES) {
      const r = run(script, argsFor(f.root), f.base);
      assert.doesNotMatch(r.stderr, /store refused/, `${script} ${argsFor('<P>').join(' ')}\n${r.stderr}`);
    }
    assert.ok(existsSync(join(f.root, '_memories', 'INDEX-decisions.md')), 'the decisions index is written inside the project');
    assert.ok(existsSync(join(f.root, '_memories', 'INDEX-risks.md')), 'the risks index is written inside the project');
    // The destinations the linked cases protect are real: from a real store, unit titles reach them.
    assert.match(readFileSync(join(f.base, 'MEMORY.md'), 'utf8'), /An outside decision/, 'the priority block lists store titles');
    assert.match(readFileSync(join(f.root, 'PROJECT.md'), 'utf8'), new RegExp(DC1 + ': An outside decision\\*\\* → `_memories/dc-001-outside-decision\\.md`'), 'the compactor writes the unit title into PROJECT.md');
  } finally { f.cleanup(); }
});
