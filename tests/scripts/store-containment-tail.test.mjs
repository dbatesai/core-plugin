// The rest of the store boundary. Scripts that read `_memories` on their own (not through the
// shared loader) refuse a link anywhere under it before they read; the PROJECT.md writers refuse
// a PROJECT.md or PROJECT-ARCHIVE.md that is a link before they read it; a folder under the store
// that can't be listed is unproven, so the store is refused, the same rule project-only and the
// graph walk apply. A hard-linked unit file is accepted: its bytes are in the project tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, readlinkSync, chmodSync, linkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { stampCreatedBaseline } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';
import { storeBoundaryProblem, firstLinkUnder } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';

const isWin = process.platform === 'win32';
const isRoot = process.getuid?.() === 0;
const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));
const MARK = 'OUTSIDE-TEXT-9c2e';
const OLD = '2025-01-02';

const unitText = (id, title, extra = '') => `---\nid: ${id}\ntype: decision\nstatus: active\ncreated: ${OLD}\nupdated: ${OLD}\ntopics: [widget store]\n${extra}---\n# ${title}\n\nwidget body\n`;
const PROJECT_MD = (tag) => `# Project ${tag}\n\n## Moves\n\n- [x] **${tag} finished move** shipped ${OLD}\n\n## State\n\n- **${tag} old state.** narrative ${OLD}\n\n**Decisions (dated, append-only):**\n\n- \`${OLD}\` — **${'D' + 'C-1'}: ${tag} title.** A full-text entry long enough to be compacted into a stub.\n  Second line.\n`;

function run(script, args, cwd) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.signal, null, `${script} did not block`);
  return r;
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

// A project with a real store, a link somewhere under `_memories` (shape), and the files the
// surveyed scripts read beside it: PROJECT.md, inbox.md, a validation test, a native MEMORY.md.
function storeFixture(shape) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-containment-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target'), mem = join(root, '_memories');
  mkdirSync(join(outside, 'dir'), { recursive: true });
  const secret = unitText('dc-009-linked-unit', `${MARK} file title widget`, `edges:\n  - { type: affects, target: dc-001-inside-decision }\nby-when: ${OLD}\n`) + `${MARK} widget body\n`;
  writeFileSync(join(outside, 'secret.md'), secret);
  writeFileSync(join(outside, 'dir', 'dc-010-outside-folder.md'), unitText('dc-010-outside-folder', `${MARK} folder title widget`) + `${MARK} widget body\n`);
  mkdirSync(join(outside, 'mem'), { recursive: true });
  writeFileSync(join(outside, 'mem', 'dc-011-outside-store.md'), unitText('dc-011-outside-store', `${MARK} store title widget`) + `${MARK} widget body\n`);
  let link = null;
  if (shape === 'store') { mkdirSync(root); link = mem; symlinkSync(join(outside, 'mem'), mem); }
  else {
    mkdirSync(join(mem, '_validation', 'tests'), { recursive: true });
    writeFileSync(join(mem, 'dc-001-inside-decision.md'), unitText('dc-001-inside-decision', 'An inside decision widget'));
    writeFileSync(join(mem, '_validation', 'tests', 'test-1.yaml'), '---\nquery: widget store body\nexpected_memories: [dc-001-inside-decision]\n---\n');
    if (shape === 'file') { link = join(mem, 'dc-009-linked-unit.md'); symlinkSync(join(outside, 'secret.md'), link); }
    else if (shape === 'folder') { link = join(mem, 'decisions'); symlinkSync(join(outside, 'dir'), link); }
    else if (shape === 'control') { writeFileSync(join(mem, 'dc-009-linked-unit.md'), secret.replaceAll(MARK, 'inside')); }
  }
  writeFileSync(join(root, 'PROJECT.md'), PROJECT_MD('inside') + '\nBacked by: dc-009-linked-unit\n');
  writeFileSync(join(root, 'inbox.md'), '---\nid: dc-009-linked-unit\ntype: decision\nstatus: draft\nmode: B\nsource: "a quoted source span"\nextracted-at: 2026-01-01\nconfidence-level: sourced\n---\nbody\n');
  writeFileSync(join(base, 'MEMORY.md'), '# Memory\n\n- WidgetFactor fact only native\n');
  mkdirSync(join(base, 'home', '.core'), { recursive: true });
  return { base, root, mem, outside, link, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

// The scripts that read `_memories` themselves rather than through the shared loader, and the
// renderers and self-test that read through it but did not report the refusal as one.
const SURVEY = [
  ['validate.mjs', (p) => [p]],
  ['metrics-check.mjs', (p) => [p, '--json']],
  ['analyze-retrieval-skip.mjs', (p, b) => [p, '--transcript', join(b, 'no-transcript.jsonl'), '--json']],
  ['audit-memory-boundary.mjs', (p, b) => [p, '--native', join(b, 'MEMORY.md'), '--json']],
  ['impact-trace.mjs', (p) => [p, '--of', 'dc-001-inside-decision']],
  ['check-inbox.mjs', (p) => [p]],
  ['configure-project.mjs', (p) => ['--project', p, '--json']],
  ['demote-moves.mjs', (p) => [p, '--json']],
  ['demote-state-narrative.mjs', (p) => [p, '--apply', '--json']],
  ['metrics-detectors.mjs', (p) => [p, '--json']],
  ['classify-turns.mjs', (p) => [p, '--json']],
  ['memory-view-watch.mjs', (p) => [p, '--timeout-ms', '3000', '--sweep-interval-ms', '1000']],
  ['render-browse-artifact.mjs', (p, b) => [p, '--out', join(b, 'browse.html')]],
  ['render-metrics-artifact.mjs', (p, b) => [p, '--out', join(b, 'metrics.html')]],
  ['self-test-round.mjs', (p) => ['new-round', p]],
];

for (const shape of ['store', 'file', 'folder']) {
  for (const [script, argsFor] of SURVEY) {
    test(`a ${shape} link under _memories: ${script} refuses it before reading, and no outside text reaches the output or the project`, { skip: isWin }, () => {
      const f = storeFixture(shape);
      try {
        const outsideBefore = treeSnapshot(f.outside);
        const projectBefore = treeSnapshot(f.root);
        const r = run(script, argsFor(f.root, f.base), f.base);
        const named = new RegExp(`refused: [^\\n]*${f.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*is a link`);
        assert.match(r.stderr, named, `${script} names the link it refused\n${r.stdout}\n${r.stderr}`);
        // The watcher's exit 3 means "stopped by a signal", so it refuses with its config-error exit, 1,
        // at arm time: it never watches or sweeps a folder the link leads to.
        const want = script === 'memory-view-watch.mjs' ? 1 : 3;
        assert.equal(r.status, want, `${script} exits ${want} on a refusal\n${r.stdout}\n${r.stderr}`);
        if (script === 'memory-view-watch.mjs') assert.doesNotMatch(r.stdout + r.stderr, /armed on|idle-timeout/, 'the watcher never arms on a refused store');
        assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK), `${script} printed nothing read through the link\n${r.stdout}\n${r.stderr}`);
        assert.deepEqual(treeSnapshot(f.outside), outsideBefore, 'the outside target keeps its listing and bytes');
        assert.deepEqual(treeSnapshot(f.root), projectBefore, `${script} wrote nothing in the project before refusing`);
        assert.ok(!treeText(f.root).includes(MARK), 'no outside text reached any file in the project');
      } finally { f.cleanup(); }
    });
  }
}

test('control: with the linked file made real, the surveyed scripts run without a link refusal', { skip: isWin }, () => {
  const f = storeFixture('control');
  try {
    for (const [script, argsFor] of SURVEY) {
      if (script === 'memory-view-watch.mjs') continue;   // arms and waits; its refusal is the only exit tested here
      const r = run(script, argsFor(f.root, f.base), f.base);
      assert.doesNotMatch(r.stderr, /is a link|store refused/, `${script}\n${r.stderr}`);
    }
  } finally { f.cleanup(); }
});

// PROJECT.md (or PROJECT-ARCHIVE.md) linked to a file outside the project. Each writer refuses
// before it reads the file: the link and its target stay as they were, and no outside text
// reaches the output, a log, or a regular file in the project.
function synthesisFixture(which) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-synthesis-link-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target'), mem = join(root, '_memories');
  mkdirSync(mem, { recursive: true }); mkdirSync(outside);
  mkdirSync(join(base, 'home', '.core'), { recursive: true });
  writeFileSync(join(mem, 'dc-001-inside-decision.md'), unitText('dc-001-inside-decision', 'An inside decision'));
  writeFileSync(join(outside, 'PROJECT.md'), PROJECT_MD(MARK));
  writeFileSync(join(outside, 'PROJECT-ARCHIVE.md'), `# Archive ${MARK}\n\n## §Moves\n\n## §State\n`);
  let link;
  if (which === 'PROJECT.md') {
    link = join(root, 'PROJECT.md'); symlinkSync(join(outside, 'PROJECT.md'), link);
    // A direct caller trying to adopt the linked bytes as a baseline (what a writer would need before
    // it rewrites PROJECT.md); the baseline writer refuses it, tested on its own below.
    stampCreatedBaseline(root, link, { kind: 'project', home: join(base, 'home') });
  } else {
    writeFileSync(join(root, 'PROJECT.md'), PROJECT_MD('inside'));
    stampCreatedBaseline(root, join(root, 'PROJECT.md'), { kind: 'project', home: join(base, 'home') });
    link = join(root, 'PROJECT-ARCHIVE.md'); symlinkSync(join(outside, 'PROJECT-ARCHIVE.md'), link);
  }
  return { base, root, outside, link, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const WRITERS = [
  ['hot-section.mjs', (p) => ['apply', p, '--text', 'a hot line']],
  ['hot-section.mjs', (p) => ['candidates', p, '--json']],
  ['compact-project.mjs', (p) => [p]],
  ['demote-moves.mjs', (p) => [p]],
  ['demote-moves.mjs', (p) => [p, '--dry-run', '--json']],
  ['demote-state-narrative.mjs', (p) => [p, '--apply']],
  ['demote-state-narrative.mjs', (p) => [p, '--json']],
  ['lifecycle-detect.mjs', (p) => [p, '--stamp-created', join(p, 'PROJECT.md'), '--kind', 'project']],
  ['lifecycle-detect.mjs', (p) => [p, '--adopt-existing-store', '--apply', '--json']],
  ['lifecycle-detect.mjs', (p) => [p, '--adopt-existing-store', '--json']],
  ['lifecycle-detect.mjs', (p) => [p, '--json']],
  // Not a writer, but it copies excerpts of PROJECT.md into its metrics records.
  ['classify-turns.mjs', (p) => [p, '--json']],
];

for (const which of ['PROJECT.md', 'PROJECT-ARCHIVE.md']) {
  for (const [script, argsFor] of WRITERS) {
    if (which === 'PROJECT-ARCHIVE.md' && !script.startsWith('demote-')) continue;
    test(`${which} linked out of the project: ${script} ${argsFor('<P>').join(' ')} refuses before reading it`, { skip: isWin }, () => {
      const f = synthesisFixture(which);
      try {
        const outsideBefore = treeSnapshot(f.outside);
        const projectBefore = treeSnapshot(f.root);
        const target = readlinkSync(f.link);
        const r = run(script, argsFor(f.root), f.base);
        assert.equal(r.status, 3, `${script} exits 3\n${r.stdout}\n${r.stderr}`);
        assert.match(r.stderr, new RegExp(`refused: [^\\n]*${which.replace('.', '\\.')} is a link`), `${script} names the link\n${r.stderr}`);
        assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK), `${script} printed nothing read through the link\n${r.stdout}\n${r.stderr}`);
        assert.equal(readlinkSync(f.link), target, `${which} is still the same link`);
        assert.deepEqual(treeSnapshot(f.outside), outsideBefore, 'the outside file keeps its bytes');
        assert.deepEqual(treeSnapshot(f.root), projectBefore, `${script} wrote nothing in the project`);
        assert.ok(!treeText(f.root).includes(MARK), 'no outside text reached a file in the project');
      } finally { f.cleanup(); }
    });
  }
}

test('the baseline writer refuses a linked target, so a direct caller cannot adopt outside bytes', { skip: isWin }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-stamp-link-')));
  try {
    const root = join(base, 'project'), outside = join(base, 'outside.md');
    mkdirSync(join(root, '_memories'), { recursive: true }); mkdirSync(join(base, 'home', '.core'), { recursive: true });
    writeFileSync(outside, PROJECT_MD(MARK));
    const link = join(root, 'PROJECT.md'); symlinkSync(outside, link);
    const before = treeSnapshot(root);
    const stamp = stampCreatedBaseline(root, link, { kind: 'project', home: join(base, 'home') });
    assert.equal(stamp.stamped, false, JSON.stringify(stamp));
    assert.equal(stamp.outcome, 'refused');
    assert.equal(stamp.reason, 'target-is-a-link');
    assert.deepEqual(treeSnapshot(root), before, 'no baseline or cache was written');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('control: a real PROJECT.md and archive are not refused by the writers', { skip: isWin }, () => {
  const f = synthesisFixture('PROJECT-ARCHIVE.md');
  try {
    rmSync(f.link); writeFileSync(f.link, '# Archive\n\n## §Moves\n\n## §State\n');
    for (const [script, argsFor] of WRITERS) {
      const r = run(script, argsFor(f.root), f.base);
      assert.doesNotMatch(r.stderr, /is a link|store refused/, `${script} ${argsFor('<P>').join(' ')}\n${r.stderr}`);
    }
  } finally { f.cleanup(); }
});

// A folder under the store that can't be listed. One that can still be entered (search but no
// read permission) is unproven: a reader that opens a known path walks through it to a link the
// walk never saw. The shared check refuses it, except for the readers that only list (retrieval,
// the summary index, hot-section): they skip it and report the search incomplete. A folder that
// can't be entered either is passed over: nothing under it can be reached. Project-only memory
// processing and the graph walk refuse both. A link inside the folder is never read.
for (const mode of [0o100, 0o000]) {
  test(`a subfolder of _memories with mode ${mode.toString(8)}: ${mode ? 'the shared check refuses it' : 'the shared check passes it over'}, retrieval says the search is incomplete, the graph walk and project-only refuse`, { skip: isWin || isRoot }, async () => {
    const f = storeFixture('control');
    const sub = join(f.mem, 'observations');
    mkdirSync(sub);
    symlinkSync(join(f.outside, 'secret.md'), join(sub, 'obs-linked.md'));
    chmodSync(sub, mode);
    try {
      const problem = storeBoundaryProblem(f.root);
      if (mode) assert.deepEqual([problem?.code, problem?.path], ['STORE_BOUNDARY_UNVERIFIED', sub], JSON.stringify(problem));
      else assert.equal(problem, null);
      assert.equal(storeBoundaryProblem(f.root, { listing: true }), null, 'a listing reader skips it');
      assert.throws(() => firstLinkUnder(f.mem), (e) => e.code === 'EACCES');
      const cu = run('check-units.mjs', ['--store', f.root], f.base);
      if (mode) { assert.equal(cu.status, 3, cu.stderr); assert.match(cu.stderr, /refused: store refused: .*observations could not be checked \(EACCES\)/); }
      else assert.doesNotMatch(cu.stderr, /refused/);
      const rc = run('retrieve-context.mjs', [f.root, 'widget store body', '--pack'], f.base);
      assert.equal(rc.status, 0, rc.stderr);
      assert.match(rc.stdout + rc.stderr, /search incomplete/i);
      assert.ok(!(rc.stdout + rc.stderr).includes(MARK), 'nothing read through the link');
      const gw = run('graph-walk.mjs', [join(f.mem, 'dc-001-inside-decision.md'), '--memories', f.mem, '--hops', '2'], f.base);
      assert.equal(gw.status, 3, gw.stderr);
      assert.match(gw.stderr, /refused: part of .* could not be listed \(EACCES\)/);
      assert.ok(!gw.stdout.includes(MARK));
      const { processMemory } = await import('../../plugins/core/skills/core/scripts/project-only.mjs');
      const pm = await processMemory({ root: f.root });
      assert.equal(pm.status, 'refused', JSON.stringify(pm));
      assert.equal(pm.state, 'boundary-unverified');
      // Search-only: the shared check names the folder; no access at all: project-only's own walk refuses it.
      assert.match(pm.reason, mode ? /_memories\/observations$/ : /EACCES: part of _memories could not be listed/);
    } finally { chmodSync(sub, 0o755); f.cleanup(); }
  });
}

// The case the security review named: `_memories/_validation` can be entered but not listed, and
// `tests/` inside it holds a link to an outside test file. The walk can't see the link; validate
// opens `_validation/tests` by its known path and would read through it.
test('a search-only folder on validate\'s fixed path, with a link inside: validate refuses and reads nothing through it', { skip: isWin || isRoot }, () => {
  const f = storeFixture('control');
  const val = join(f.mem, '_validation');
  writeFileSync(join(f.outside, 'test-outside.yaml'), `---\nquery: ${MARK} widget\nexpected_memories: [dc-001-inside-decision]\n---\n`);
  symlinkSync(join(f.outside, 'test-outside.yaml'), join(val, 'tests', 'test-2.yaml'));
  chmodSync(val, 0o111);
  try {
    const projectBefore = (() => { chmodSync(val, 0o755); try { return treeSnapshot(f.root); } finally { chmodSync(val, 0o111); } })();
    const r = run('validate.mjs', [f.root], f.base);
    assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /refused: /);
    assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK), `nothing read through the link\n${r.stdout}\n${r.stderr}`);
    chmodSync(val, 0o755);
    assert.deepEqual(treeSnapshot(f.root), projectBefore, 'no report was written');
  } finally { chmodSync(val, 0o755); f.cleanup(); }
});

test('validate refuses a link on its fixed test path even without the shared walk', { skip: isWin }, async () => {
  const f = storeFixture('control');
  try {
    writeFileSync(join(f.outside, 'test-outside.yaml'), `---\nquery: ${MARK} widget\n---\n`);
    symlinkSync(join(f.outside, 'test-outside.yaml'), join(f.mem, '_validation', 'tests', 'test-2.yaml'));
    const { loadTests } = await import('../../plugins/core/skills/core/scripts/validate.mjs');
    assert.throws(() => loadTests(f.root), (e) => e.code === 'STORE_OUTSIDE_ROOT' && /test-2\.yaml is a link/.test(e.message));
  } finally { f.cleanup(); }
});

test('an unsearchable _memories still passes the shared check: nothing beneath it can be reached', { skip: isWin || isRoot }, () => {
  const f = storeFixture('control');
  try {
    chmodSync(f.mem, 0o000);
    try { assert.equal(storeBoundaryProblem(f.root), null); } finally { chmodSync(f.mem, 0o755); }
  } finally { f.cleanup(); }
});

test('a hard-linked unit file is accepted: its bytes are in the project tree and CORE writes replace it by rename', { skip: isWin }, () => {
  const f = storeFixture('control');
  try {
    const twin = join(f.base, 'twin.md');
    linkSync(join(f.mem, 'dc-001-inside-decision.md'), twin);
    assert.equal(storeBoundaryProblem(f.root), null);
    const r = run('check-units.mjs', ['--store', f.root, '--schema'], f.base);
    assert.doesNotMatch(r.stderr, /refused/);
  } finally { f.cleanup(); }
});
