// A linked PROJECT.md is refused before anything opens it, in every mode of the scripts that read
// it. Two targets show it. A regular file holding a marker: the marker never reaches the output or
// a file in the project. A named pipe: opening one blocks until a writer arrives, so any open of
// the target, even one whose error is swallowed, hangs the script until the timeout kills it. A
// script that only looks at the link (lstat) never opens the pipe and finishes.
// Retrieval never opens PROJECT.md, so a linked one neither blocks nor refuses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { linkFile, FILE_LINK_SKIP } from '../helpers/links.mjs';

const isWin = process.platform === 'win32';
const SCRIPTS = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/', import.meta.url));
const MARK = 'OUTSIDE-SYNTHESIS-71f3';
const PIPE_TIMEOUT_MS = 10_000;

const unitText = (id, title) => `---\nid: ${id}\ntype: decision\nstatus: active\ncreated: 2025-01-02\nupdated: 2025-01-02\ntopics: [widget store]\n---\n# ${title}\n\nwidget body\n`;
const PROJECT_MD = (tag) => `# Project ${tag}\n\n## State\n\n- WidgetFactor ${tag} state.\n\n**Decisions (dated, append-only):**\n\n- \`2025-01-02\` — **${'D' + 'C-1'}: ${tag} title.** A full-text entry long enough to be compacted.\n`;

function run(script, args, cwd, timeout = 30_000) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd, encoding: 'utf8', timeout });
}

/** Every path under `dir`, judged with lstat: a link is recorded by its target and never followed. */
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

function treeText(dir) {
  let text = '';
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    text += e.isDirectory() ? treeText(p) : readFileSync(p, 'latin1');
  }
  return text;
}

// target: 'file' (outside text with the marker), 'pipe' (a named pipe), or 'real' (no link).
function fixture(target) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'core-guard-first-')));
  const root = join(base, 'project'), outside = join(base, 'outside-target');
  mkdirSync(join(root, '_memories'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(root, '_memories', 'dc-001-inside-decision.md'), unitText('dc-001-inside-decision', 'An inside decision widget'));
  writeFileSync(join(base, 'MEMORY.md'), '# Memory\n\n- WidgetFactor fact only native\n');
  const link = join(root, 'PROJECT.md');
  if (target === 'real') writeFileSync(link, PROJECT_MD('inside'));
  else {
    const t = join(outside, 'PROJECT.md');
    if (target === 'pipe') {
      const r = spawnSync('mkfifo', [t]);
      assert.equal(r.status, 0, `mkfifo: ${r.stderr}`);
    } else writeFileSync(t, PROJECT_MD(MARK));
    linkFile(t, link);
  }
  return { base, root, link, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const REFUSERS = [
  ['compact-project.mjs', (p) => [p]],
  ['compact-project.mjs', (p) => [p, '--check']],
  ['compact-project.mjs', (p) => ['--check', p]],
  ['compact-project.mjs', (p) => [p, '--section-sizes']],
  ['audit-memory-boundary.mjs', (p, b) => [p, '--native', join(b, 'MEMORY.md'), '--json']],
  ['audit-memory-boundary.mjs', (p, b) => [p, '--native', join(b, 'MEMORY.md')]],
];
// A file link runs wherever this account can make one; a named pipe also needs mkfifo, which is POSIX.
const pipeSkip = isWin ? 'mkfifo is POSIX' : FILE_LINK_SKIP;

for (const [script, argsFor] of REFUSERS) {
  const label = `${script} ${argsFor('<P>', '<B>').join(' ')}`;
  test(`PROJECT.md linked to outside text: ${label} refuses, and the text reaches no output or project file`, { skip: FILE_LINK_SKIP }, () => {
    const f = fixture('file');
    try {
      const before = treeSnapshot(f.root);
      const r = run(script, argsFor(f.root, f.base), f.base);
      assert.equal(r.signal, null, `${label} did not block`);
      assert.equal(r.status, 3, `${label} exits 3\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /refused: [^\n]*PROJECT\.md is a link/, `${label} names the link\n${r.stderr}`);
      assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK), `${label} printed nothing read through the link\n${r.stdout}\n${r.stderr}`);
      assert.deepEqual(treeSnapshot(f.root), before, `${label} wrote nothing in the project`);
      assert.ok(!treeText(f.root).includes(MARK), 'no outside text reached a project file');
    } finally { f.cleanup(); }
  });

  test(`PROJECT.md linked to a named pipe: ${label} refuses without opening it`, { skip: pipeSkip }, () => {
    const f = fixture('pipe');
    try {
      const r = run(script, argsFor(f.root, f.base), f.base, PIPE_TIMEOUT_MS);
      assert.equal(r.signal, null, `${label} opened the linked target and blocked on the pipe`);
      assert.equal(r.status, 3, `${label} exits 3\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /refused: [^\n]*PROJECT\.md is a link/);
    } finally { f.cleanup(); }
  });
}

test('control: a real PROJECT.md is read by every mode, with no refusal', { skip: isWin }, () => {
  const f = fixture('real');
  try {
    for (const [script, argsFor] of REFUSERS) {
      const r = run(script, argsFor(f.root, f.base), f.base);
      assert.notEqual(r.status, 3, `${script} ${argsFor('<P>', '<B>').join(' ')}\n${r.stdout}\n${r.stderr}`);
      assert.doesNotMatch(r.stderr, /is a link|store refused/);
      if (argsFor('<P>', '<B>').some((a) => a === '--check' || a === '--section-sizes')) assert.match(r.stdout, /PROJECT\.md: \d+ bytes/);
    }
    // The audit reads PROJECT.md's terms: the native fact is represented there, so it is no candidate.
    const audit = JSON.parse(run('audit-memory-boundary.mjs', [f.root, '--native', join(f.base, 'MEMORY.md'), '--json'], f.base).stdout);
    assert.equal(audit.stats.nativeOnly, 0);
  } finally { f.cleanup(); }
});

// Retrieval reads units through the shared loader and never opens PROJECT.md: with it linked to a
// pipe, the per-turn search still answers, and with it linked to outside text, none of that text
// appears. The per-prompt hook runs this same pipeline (buildRetrievalTrace).
for (const target of ['pipe', 'file']) {
  for (const extra of [[], ['--pack']]) {
    test(`retrieve-context ${extra.join(' ')} with PROJECT.md linked to ${target === 'pipe' ? 'a named pipe' : 'outside text'}: it answers and never opens the link`, { skip: target === 'pipe' ? pipeSkip : FILE_LINK_SKIP }, () => {
      const f = fixture(target);
      try {
        const r = run('retrieve-context.mjs', [f.root, 'inside decision widget', ...extra], f.base, PIPE_TIMEOUT_MS);
        assert.equal(r.signal, null, 'retrieval opened the linked PROJECT.md and blocked');
        assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
        assert.match(r.stdout, /dc-001-inside-decision/);
        assert.ok(!r.stdout.includes(MARK) && !r.stderr.includes(MARK));
      } finally { f.cleanup(); }
    });
  }
}
