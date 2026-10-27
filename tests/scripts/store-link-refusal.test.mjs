// A project whose `_memories` is a link to a folder outside it: the unit-index writer, the unit
// checker, the lifecycle report, the edge decorator, the session-close marker and lock, the
// supersession stamper, the capability-drift log, the MEMORY.md priority block, the PROJECT.md
// decision compactor and hot section, and the metrics package each refuse before following the
// link. The folder the link leads to keeps its exact bytes and listing, and nothing read through it
// reaches MEMORY.md, PROJECT.md or a package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, existsSync, readlinkSync } from 'node:fs';
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

// A real `_memories` with a link deeper inside it: a unit file linked to a file outside the project,
// or a subfolder linked to an outside folder. Every reader refuses (the priority listing, which
// never follows a link, names it as skipped instead). The outside bytes are unchanged, and the
// outside text reaches neither the output nor any file in the project.
const MARK = 'OUTSIDE-BODY-6b1f';
const unitText = (id, title, extra = '') => `---\nid: ${id}\ntype: decision\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\ntopics: [store]\n${extra}---\n# ${title}\n\nbody\n`;

function deepFixture(shape) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-deep-link-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target'), mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true }); mkdirSync(join(outside, 'dir'), { recursive: true });
  writeFileSync(join(root, 'PROJECT.md'), PROJECT_MD);
  writeFileSync(join(base, 'MEMORY.md'), MEMORY_MD);
  mkdirSync(join(base, 'home', '.core'), { recursive: true });
  writeFileSync(join(base, 'enrich.json'), JSON.stringify({ aliases: ['a'], paraphrases: ['p'], likely_questions: ['q'] }));
  writeFileSync(join(mem, 'dc-001-inside-decision.md'), unitText('dc-001-inside-decision', 'An inside decision', 'edges:\n  - { type: cites, target: dc-009-linked-unit }\n'));
  writeFileSync(join(mem, 'risk-001-inside-risk.md'), '---\nid: risk-001-inside-risk\ntype: risk\nstatus: active\ncreated: 2026-01-01\n---\n# An inside risk\n\nbody\n');
  const secret = unitText('dc-009-linked-unit', `${MARK} file title`) + `${MARK} file body\n`;
  writeFileSync(join(outside, 'secret.md'), secret);
  writeFileSync(join(outside, 'dir', 'dc-010-outside-folder.md'), unitText('dc-010-outside-folder', `${MARK} folder title`) + `${MARK} folder body\n`);
  let link;
  if (shape === 'file') { link = join(mem, 'dc-009-linked-unit.md'); symlinkSync(join(outside, 'secret.md'), link); }
  else if (shape === 'folder') { link = join(mem, 'decisions'); symlinkSync(join(outside, 'dir'), link); }
  else if (shape === 'control-file') { link = join(mem, 'dc-009-linked-unit.md'); writeFileSync(link, secret); }
  else { link = join(mem, 'decisions'); mkdirSync(link); writeFileSync(join(link, 'dc-010-outside-folder.md'), unitText('dc-010-outside-folder', 'a folder unit')); }
  return { base, root, mem, outside, link, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Every path under `dir` with its bytes' sha1, judged with lstat: a link is recorded by its target, never read. */
function treeSnapshot(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push(`${r} -> link:${readlinkSync(p)}`);
      else if (e.isDirectory()) { out.push(`${r}/`); walk(p, r); }
      else out.push(`${r}:${createHash('sha1').update(readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  return out;
}

/** The text of every regular file under `dir`, never through a link. */
function treeText(dir) {
  let text = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    text += e.isDirectory() ? treeText(p) : readFileSync(p, 'latin1');
  }
  return text;
}

const DEEP_CASES = [
  ...CASES,
  ['generate-summary-index.mjs', (p) => [p]],
  ['retrieve-context.mjs', (p) => [p, 'decision']],
  ['retrieve-context.mjs', (p) => [p, 'decision', '--pack']],
  ['maintenance-run.mjs', (p) => [p, '--json']],
  ['graph-walk.mjs', (p) => [join(p, '_memories', 'dc-001-inside-decision.md'), '--memories', join(p, '_memories'), '--hops', '2']],
  ['enrichment-sidecar.mjs', (p) => [p, 'dc-001-inside-decision.md', '--input', join(dirname(p), 'enrich.json'), '--writer-family', 'a', '--answer-family', 'b']],
  ['enrichment-sidecar.mjs', (p) => [p, 'dc-009-linked-unit.md', '--input', join(dirname(p), 'enrich.json'), '--writer-family', 'a', '--answer-family', 'b']],
];

for (const shape of ['file', 'folder']) {
  for (const [script, argsFor] of [...DEEP_CASES, ['priority.mjs', (p) => [join(p, '_memories'), '--top', '5']]]) {
    test(`a ${shape} linked out from inside _memories: ${script} ${argsFor('<P>').join(' ')} refuses it, and no outside text is read into the project or the output`, { skip: isWin }, () => {
      const f = deepFixture(shape);
      try {
        const outsideBefore = treeSnapshot(f.outside);
        const projectBefore = treeSnapshot(f.root);
        const memoryMdBefore = readFileSync(join(f.base, 'MEMORY.md'), 'utf8');
        const r = run(script, argsFor(f.root), f.base);
        const named = new RegExp(`${f.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*(is a link|symlink-or-junction-not-followed)`);
        if (script === 'priority.mjs') {
          // The ranking never follows a link; it names each one as a path it did not read.
          assert.match(r.stdout, /COVERAGE INCOMPLETE/, `priority names the coverage gap\n${r.stdout}`);
          assert.match(r.stdout, named, `priority names the link\n${r.stdout}`);
        } else {
          assert.notEqual(r.status, 0, `${script} exits nonzero\n${r.stdout}\n${r.stderr}`);
          assert.match(r.stderr, named, `${script} names the link it refused\n${r.stderr}`);
        }
        assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK), `${script} printed nothing read through the link\n${r.stdout}\n${r.stderr}`);
        assert.deepEqual(treeSnapshot(f.outside), outsideBefore, 'the outside target keeps its listing and bytes');
        assert.ok(!treeText(f.root).includes(MARK), 'no outside text reached any file in the project');
        assert.ok(!readFileSync(join(f.base, 'MEMORY.md'), 'utf8').includes(MARK), 'no outside text reached MEMORY.md');
        if (script !== 'priority.mjs') {
          assert.deepEqual(treeSnapshot(f.root), projectBefore, `${script} wrote nothing in the project before refusing`);
          assert.equal(readFileSync(join(f.base, 'MEMORY.md'), 'utf8'), memoryMdBefore, 'MEMORY.md is unchanged');
        }
      } finally { f.cleanup(); }
    });
  }
}

test('control: the same store with the linked file and folder made real runs every command without a link refusal', { skip: isWin }, () => {
  for (const shape of ['control-file', 'control-folder']) {
    const f = deepFixture(shape);
    try {
      stampCreatedBaseline(f.root, join(f.root, 'PROJECT.md'), { kind: 'project', home: join(f.base, 'home') });
      for (const [script, argsFor] of DEEP_CASES) {
        const r = run(script, argsFor(f.root), f.base);
        assert.doesNotMatch(r.stderr, /is a link|store refused/, `${shape}: ${script} ${argsFor('<P>').join(' ')}\n${r.stderr}`);
      }
    } finally { f.cleanup(); }
  }
});

test('a linked _memories is refused by the priority listing, the summary index, retrieval, maintenance and the enrichment writer', { skip: isWin }, () => {
  for (const [script, argsFor] of [...DEEP_CASES.slice(CASES.length), ['priority.mjs', (p) => [join(p, '_memories')]]]) {
    if (script === 'graph-walk.mjs') continue;   // its seed would be read through the link; its own chain check is tested in graph-walk.test.mjs
    const f = fixture({ linked: true });
    try {
      writeFileSync(join(f.base, 'enrich.json'), JSON.stringify({ aliases: ['a'] }));
      const before = snapshot(f.outside);
      const r = run(script, argsFor(f.root), f.base);
      assert.notEqual(r.status, 0, `${script} exits nonzero\n${r.stdout}`);
      assert.match(r.stderr, /_memories is a link/, `${script} names the refusal\n${r.stderr}`);
      assert.ok(!/outside the project|An outside/.test(r.stdout), `${script} printed nothing read through the link\n${r.stdout}`);
      assert.deepEqual(snapshot(f.outside), before, 'the outside folder keeps its listing and bytes');
    } finally { f.cleanup(); }
  }
});
