// CORE's own working files in the memory store are ignored by git from the first write, with no
// startup having run; project content never is; an ignore file the user already has is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ensureStoreIgnores } from '../../plugins/core/skills/core/scripts/store-ignores.mjs';
import { stampFile } from '../../plugins/core/skills/core/scripts/state-cache.mjs';
import { loadFreshIndex } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
import { writeEnrichment } from '../../plugins/core/skills/core/scripts/enrichment-sidecar.mjs';
import { recordSessionStart } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';
import { decorateStoreLocked } from '../../plugins/core/skills/core/scripts/decorate-graph.mjs';
import { withProjectMdWriterLock } from '../../plugins/core/skills/core/scripts/lifecycle-core.mjs';
import { acquireLock, releaseLock } from '../../plugins/core/skills/core/scripts/close-pass.mjs';

const isWin = process.platform === 'win32';
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8' });

function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-ignores-')));
  git(root, 'init', '-q');
  mkdirSync(join(root, '_memories'));
  writeFileSync(join(root, 'PROJECT.md'), '# P\n');
  writeFileSync(join(root, '_memories', 'u1.md'), '---\nid: u1\ntype: observation\n---\nbody\n');
  writeFileSync(join(root, '_memories', 'INDEX-decisions.md'), '# Decisions\n');
  writeFileSync(join(root, '_memories', 'inbox.md'), '\n');
  return root;
}
function files(dir) {
  const out = [];
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) out.push(...files(p)); else out.push(p); }
  return out;
}
const ignored = (root, rel) => spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', rel], { env }).status === 0;

test('every CORE working file a store writer creates is ignored before anything ran startup; project content is not', { skip: isWin }, () => {
  const root = project();
  try {
    stampFile(root, join(root, '_memories', 'u1.md'), 'h', 'test');
    loadFreshIndex(root);
    writeEnrichment(root, { unitPath: 'u1.md', writerModelFamily: 'OPUS', answerModelFamily: 'FABLE', aliases: ['x'] });
    recordSessionStart(root);
    decorateStoreLocked(root);
    withProjectMdWriterLock(root, () => {});
    assert.equal(acquireLock(root, { sessionId: 's1' }).ok, true);
    releaseLock(root, { sessionId: 's1' });
    for (const n of ['_close-marker.json', '_maintenance-state.json', '_pm-state.json', '_capability-drift-log.md']) writeFileSync(join(root, '_memories', n), '{}');
    const content = new Set(['_memories/u1.md', '_memories/INDEX-decisions.md', '_memories/inbox.md', '_memories/.gitignore', '_memories/_lib/.gitignore']);
    const generated = files(join(root, '_memories')).map((p) => relative(root, p).split('\\').join('/')).filter((r) => !content.has(r));
    assert.ok(generated.some((r) => r.startsWith('_memories/_lib/')), 'the writers did create cache files');
    assert.ok(generated.some((r) => /lock/.test(r)), 'and lock files');
    for (const r of generated) assert.equal(ignored(root, r), true, `${r} is ignored`);
    for (const r of ['PROJECT.md', '_memories/u1.md', '_memories/INDEX-decisions.md', '_memories/inbox.md']) assert.equal(ignored(root, r), false, `${r} stays committable`);
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => /lock|_lib\/(?!\.gitignore)|_close-marker|_maintenance|_pm-state|drift-log/.test(l)).length, 0, 'git status shows none of them');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a store's existing .gitignore is left byte-identical, and a second call changes nothing", { skip: isWin }, () => {
  const root = project();
  try {
    const mine = '# mine\n!keep-this.json\n';
    writeFileSync(join(root, '_memories', '.gitignore'), mine);
    mkdirSync(join(root, '_memories', '_lib'));
    assert.match(ensureStoreIgnores(root).join(), /_memories\/\.gitignore is not CORE's and leaves .*_close\.lock\*.*visible to git/);
    assert.equal(readFileSync(join(root, '_memories', '.gitignore'), 'utf8'), mine);
    const lib = readFileSync(join(root, '_memories', '_lib', '.gitignore'), 'utf8');
    ensureStoreIgnores(root);
    assert.equal(readFileSync(join(root, '_memories', '_lib', '.gitignore'), 'utf8'), lib);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no store, nothing written; a store that is a link is reported, not written through', { skip: isWin }, async () => {
  const { symlinkSync, existsSync } = await import('node:fs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-ignores-')));
  try {
    assert.deepEqual(ensureStoreIgnores(root), []);
    assert.equal(existsSync(join(root, '_memories')), false);
    mkdirSync(join(root, '_memories'));
    assert.deepEqual(ensureStoreIgnores(root), []);
    assert.equal(existsSync(join(root, '_memories', '_lib')), false, 'no _lib is created by the rules alone');
    rmSync(join(root, '_memories'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(root, '_memories'));
    assert.match(ensureStoreIgnores(root).join(), /not a real folder/);
    assert.deepEqual(readdirSync(join(root, 'elsewhere')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generated self-test rounds and their trigger state are ignored once a round is made; curated gold sets are not', { skip: isWin }, async () => {
  const { newRound, markAutoAuthorTriggered } = await import('../../plugins/core/skills/core/scripts/self-test-round.mjs');
  const root = project();
  try {
    mkdirSync(join(root, '_tests'));
    writeFileSync(join(root, '_tests', 'retrieval-gold-set.json'), '[]');
    try { newRound(root); } catch { /* a round needs units to quota; the folder is made first */ }
    markAutoAuthorTriggered(root);
    const made = files(join(root, '_tests', 'self-test')).map((p) => relative(root, p).split('\\').join('/')).filter((r) => !r.endsWith('/.gitignore'));
    assert.ok(made.includes('_tests/self-test/auto-author-state.json'));
    for (const r of made) assert.equal(ignored(root, r), true, `${r} is ignored`);
    assert.equal(ignored(root, '_tests/self-test/round-1/goldset.json'), true, 'a round written later is covered too');
    assert.equal(ignored(root, '_tests/retrieval-gold-set.json'), false, 'the curated gold set stays committable');
    assert.equal(readdirSync(join(root, '..')).includes('.gitignore'), false, 'nothing is written above the project');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the trigger-state writer alone adds the rules before its first write', { skip: isWin }, async () => {
  const { markAutoAuthorTriggered } = await import('../../plugins/core/skills/core/scripts/self-test-round.mjs');
  const root = project();
  try {
    assert.equal(markAutoAuthorTriggered(root), true);
    assert.equal(ignored(root, '_tests/self-test/auto-author-state.json'), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a linked parent never leads the rules outside the project: _memories or _tests as a link to a folder with the child inside', { skip: isWin }, async () => {
  const { symlinkSync } = await import('node:fs');
  for (const [parent, child] of [['_memories', '_lib'], ['_tests', 'self-test']]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-ignores-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-outside-')));
    try {
      mkdirSync(join(outside, child));
      symlinkSync(outside, join(root, parent));
      const problems = ensureStoreIgnores(root);
      assert.match(problems.join(), new RegExp(`${parent} is not a real folder`), parent);
      assert.deepEqual(readdirSync(outside), [child], `${parent}: nothing written where the link leads`);
      assert.deepEqual(readdirSync(join(outside, child)), [], `${parent}/${child}: nothing written there either`);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  }
});

test("an existing ignore file that leaves CORE's working files visible is reported, kept byte-identical, and named in the maintenance notes; one the repository's rules cover is not reported", { skip: isWin }, async () => {
  const { runMaintenance } = await import('../../plugins/core/skills/core/scripts/maintenance-run.mjs');
  const root = project();
  try {
    const mine = '# user-owned rules only\n';
    writeFileSync(join(root, '_memories', '.gitignore'), mine);
    const problems = ensureStoreIgnores(root);
    for (const rule of ['_close.lock*', '_close-marker.json', '_maintenance-state.json']) assert.ok(problems.join().includes(rule), rule);   // ._* may already be hidden by a global excludes file
    assert.equal(acquireLock(root, { sessionId: 's1' }).ok, true); releaseLock(root, { sessionId: 's1' });
    assert.equal(readFileSync(join(root, '_memories', '.gitignore'), 'utf8'), mine, 'the user file is untouched');
    assert.match(git(root, 'status', '--porcelain', '--untracked-files=all'), /_close\.lock\.g1\.done/, 'the stated limit: the lock is visible to git');
    const { notes } = runMaintenance(root, { apply: true, metrics: false });
    assert.ok(notes.some((n) => /^git ignore: _memories\/\.gitignore is not CORE's/.test(n)), notes.join(' | '));
    // the repository's own rules cover them: nothing to report
    writeFileSync(join(root, '.gitignore'), '_memories/_close*\n_memories/.*.lock*\n_memories/_*.json\n_memories/_capability-drift-log.md\n');
    assert.deepEqual(ensureStoreIgnores(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the self-test writers create nothing through a linked _tests folder', { skip: isWin }, async () => {
  const { symlinkSync } = await import('node:fs');
  const { newRound, markAutoAuthorTriggered } = await import('../../plugins/core/skills/core/scripts/self-test-round.mjs');
  const root = project();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-outside-')));
  try {
    symlinkSync(outside, join(root, '_tests'));
    assert.equal(markAutoAuthorTriggered(root), false);
    assert.throws(() => newRound(root), (e) => e.code === 'SELF_TEST_UNSAFE');
    assert.deepEqual(readdirSync(outside), [], 'nothing written where the link leads');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
