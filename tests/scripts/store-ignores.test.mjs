// CORE's own working files in the memory store are ignored by git from the first write, with no
// startup having run; project content never is; an ignore file the user already has is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { ensureStoreIgnores } from '../../plugins/core/skills/core/scripts/store-ignores.mjs';
import { stampFile } from '../../plugins/core/skills/core/scripts/state-cache.mjs';
import { loadFreshIndex, generateSummaryIndex } from '../../plugins/core/skills/core/scripts/generate-summary-index.mjs';
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
    ensureStoreIgnores(root);
    assert.equal(readFileSync(join(root, '_memories', '.gitignore'), 'utf8'), mine, 'a second call changes nothing');
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
    writeFileSync(join(root, '.gitignore'), '_memories/_close*\n_memories/.*.lock*\n_memories/.*.tmp-*\n_memories/_*.json\n_memories/_capability-drift-log.md\n');
    const covered = ensureStoreIgnores(root);
    assert.equal(covered.some((p) => /visible to git/.test(p)), false, 'nothing present or sampled is visible');
    assert.ok(covered.some((p) => /does not prove later names/.test(p)), 'but the folder\'s own file does not prove later names are covered');
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

const CONTENT = new Set(['_memories/u1.md', '_memories/INDEX-decisions.md', '_memories/inbox.md', '_memories/.gitignore', '_memories/_lib/.gitignore']);
const generatedIn = (root) => files(join(root, '_memories')).map((p) => relative(root, p).split('\\').join('/')).filter((r) => !CONTENT.has(r) && !/^_memories\/INDEX-[^/]+\.md$/.test(r));

test('each store writer, run alone in a fresh project, leaves every file it creates ignored', { skip: isWin }, async () => {
  const { runMaintenance } = await import('../../plugins/core/skills/core/scripts/maintenance-run.mjs');
  const writers = {
    'state-cache stamp': (r) => assert.equal(stampFile(r, join(r, '_memories', 'u1.md'), 'h', 'test').stamped, true),
    'summary index, command-line sink': (r) => generateSummaryIndex(r),
    'summary index, retrieval': (r) => loadFreshIndex(r),
    'enrichment sidecar': (r) => writeEnrichment(r, { unitPath: 'u1.md', writerModelFamily: 'OPUS', answerModelFamily: 'FABLE', aliases: ['x'] }),
    'session inventory': (r) => recordSessionStart(r),
    'decorate lock': (r) => decorateStoreLocked(r),
    'decorate lock, no store yet': (r) => { rmSync(join(r, '_memories'), { recursive: true }); decorateStoreLocked(r); },
    'PROJECT.md writer lock, no store yet': (r) => { rmSync(join(r, '_memories'), { recursive: true }); withProjectMdWriterLock(r, () => {}); },
    'close lock': (r) => { assert.equal(acquireLock(r, { sessionId: 's' }).ok, true); releaseLock(r, { sessionId: 's' }); },
    'maintenance': (r) => runMaintenance(r, { apply: true, metrics: false }),
  };
  for (const [name, write] of Object.entries(writers)) {
    const root = project();
    try {
      write(root);
      const made = generatedIn(root);
      assert.ok(made.length, `${name}: wrote something`);
      for (const r of made) assert.equal(ignored(root, r), true, `${name}: ${r} is ignored`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('the cache folder is refused, before any write, when git would track what goes in it', { skip: isWin }, async () => {
  const { symlinkSync } = await import('node:fs');
  const cases = {
    're-included file': (r, lib) => writeFileSync(join(lib, '.gitignore'), '*\n!state-cache.json\n'),
    'already tracked': (r, lib) => { writeFileSync(join(lib, '.gitignore'), '*\n'); writeFileSync(join(lib, 'state-cache.json'), '{"tracked":true}'); git(r, 'add', '-f', '_memories/_lib/state-cache.json'); },
    'ignore file is a link': (r, lib) => { writeFileSync(join(r, 'elsewhere-ignore'), '*\n'); symlinkSync(join(r, 'elsewhere-ignore'), join(lib, '.gitignore')); },
  };
  for (const [name, plant] of Object.entries(cases)) {
    const root = project();
    try {
      const lib = join(root, '_memories', '_lib'); mkdirSync(lib);
      plant(root, lib);
      const before = Object.fromEntries(readdirSync(lib).map((n) => [n, readFileSync(join(lib, n), 'utf8')]));
      const st = stampFile(root, join(root, '_memories', 'u1.md'), 'h', 'test');
      assert.equal(st.stamped, false, `${name}: nothing stamped`);
      assert.throws(() => generateSummaryIndex(root), `${name}: the index command refuses`);
      // Retrieval still answers; a link in the cache folder refuses the whole store, as it always has.
      try { assert.ok(loadFreshIndex(root), `${name}: retrieval still answers`); }
      catch (e) { assert.equal(name, 'ignore file is a link'); assert.match(e.message, /store refused/); }
      const after = Object.fromEntries(readdirSync(lib).map((n) => [n, readFileSync(join(lib, n), 'utf8')]));
      assert.deepEqual(after, before, `${name}: nothing in the cache folder changed`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

// Watches every file write while a writer runs: a CORE working file written into _memories or its cache
// folder before that folder's ignore file exists is a violation. Project content (units, indexes, inbox)
// and its temp files are not CORE working files.
async function firstWriteViolations(root, run) {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { dirname, basename } = await import('node:path');
  const mem = join(root, '_memories'), lib = join(mem, '_lib');
  const content = (n) => /^[^._].*\.md$/.test(n) || /^\.[^._].*\.md\.tmp-/.test(n);
  const violations = [];
  const check = (p) => {
    const d = dirname(String(p)), n = basename(String(p));
    if ((d === mem || d === lib) && n !== '.gitignore' && !content(n) && !fs.existsSync(join(d, '.gitignore'))) violations.push(relative(root, String(p)));
  };
  const names = ['writeFileSync', 'appendFileSync', 'openSync', 'linkSync', 'renameSync', 'copyFileSync'];
  const orig = Object.fromEntries(names.map((k) => [k, fs[k]]));
  fs.writeFileSync = (p, ...a) => { check(p); return orig.writeFileSync(p, ...a); };
  fs.appendFileSync = (p, ...a) => { check(p); return orig.appendFileSync(p, ...a); };
  fs.openSync = (p, flags, ...a) => { if (typeof flags === 'string' ? /[wa+]/.test(flags) : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR))) check(p); return orig.openSync(p, flags, ...a); };
  fs.linkSync = (a, b) => { check(b); return orig.linkSync(a, b); };
  fs.renameSync = (a, b) => { check(b); return orig.renameSync(a, b); };
  fs.copyFileSync = (a, b, ...r) => { check(b); return orig.copyFileSync(a, b, ...r); };
  syncBuiltinESMExports();
  try { await run(); } finally { Object.assign(fs, orig); syncBuiltinESMExports(); }
  return violations;
}

test('no CORE working file is written into the store before its ignore file exists, writer by writer', { skip: isWin }, async () => {
  const { runMaintenance } = await import('../../plugins/core/skills/core/scripts/maintenance-run.mjs');
  const writers = {
    'state-cache stamp': (r) => stampFile(r, join(r, '_memories', 'u1.md'), 'h', 'test'),
    'summary index, command-line sink': (r) => generateSummaryIndex(r),
    'summary index, retrieval': (r) => loadFreshIndex(r),
    'enrichment sidecar': (r) => writeEnrichment(r, { unitPath: 'u1.md', writerModelFamily: 'OPUS', answerModelFamily: 'FABLE', aliases: ['x'] }),
    'session inventory': (r) => recordSessionStart(r),
    'decorate lock, no store yet': (r) => { rmSync(join(r, '_memories'), { recursive: true }); decorateStoreLocked(r); },
    'PROJECT.md writer lock, no store yet': (r) => { rmSync(join(r, '_memories'), { recursive: true }); withProjectMdWriterLock(r, () => {}); },
    'close lock': (r) => { acquireLock(r, { sessionId: 's' }); releaseLock(r, { sessionId: 's' }); },
    'maintenance': (r) => runMaintenance(r, { apply: true, metrics: false }),
  };
  for (const [name, write] of Object.entries(writers)) {
    const root = project();
    try {
      const v = await firstWriteViolations(root, () => write(root));
      assert.deepEqual(v, [], `${name}: written before its folder's ignore file existed`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('an ignore file that is a FIFO is reported without being opened', { skip: isWin }, () => {
  const root = project();
  try {
    execFileSync('mkfifo', [join(root, '_memories', '.gitignore')]);
    const code = `const m = await import(${JSON.stringify(new URL('../../plugins/core/skills/core/scripts/store-ignores.mjs', import.meta.url).href)}); console.log(JSON.stringify(m.ensureStoreIgnores(${JSON.stringify(root)})));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.signal, null, 'did not block');
    assert.match(r.stdout, /not a file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a project with no repository of its own never asks git, even inside a parent repository', { skip: isWin }, async () => {
  const { chmodSync } = await import('node:fs');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-parent-')));
  const bin = join(parent, 'bin'); mkdirSync(bin);
  const marker = join(parent, 'git-was-run');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  try {
    execFileSync('git', ['-C', parent, 'init', '-q'], { env });
    const child = join(parent, 'child'); mkdirSync(join(child, '_memories'), { recursive: true });
    writeFileSync(join(child, '_memories', '.gitignore'), '# mine\n');
    process.env.PATH = `${bin}:${path}`;
    assert.deepEqual(ensureStoreIgnores(child), []);
    assert.equal(existsSync(marker), false, 'git was never run, so the parent repository was not consulted');
  } finally { process.env.PATH = path; rmSync(parent, { recursive: true, force: true }); }
});

test('an exact exception the user wrote for one of the names CORE writes is reported', { skip: isWin }, () => {
  const root = project();
  try {
    writeFileSync(join(root, '_memories', '.gitignore'), '_close.lock*\n._close.lock*\n.*.lock*\n.*.tmp-*\n_close-marker.json\n_maintenance-state.json\n_pm-state.json\n_capability-drift-log.md\n!_close.lock.g1.done\n');
    assert.match(ensureStoreIgnores(root).join(), /leaves _close\.lock\* visible to git/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a .git that cannot be examined is unknown: the cache folder is refused and the check says it could not run', { skip: isWin }, async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { ensureLibDir } = await import('../../plugins/core/skills/core/scripts/store-ignores.mjs');
  const root = project();
  writeFileSync(join(root, '_memories', '.gitignore'), '# mine\n');
  const orig = fs.lstatSync;
  fs.lstatSync = (p, ...a) => { if (String(p) === join(root, '.git')) throw Object.assign(new Error('injected'), { code: 'EIO' }); return orig(p, ...a); };
  syncBuiltinESMExports();
  try {
    assert.match(ensureStoreIgnores(root).join(), /could not check/);
    assert.throws(() => ensureLibDir(root), (e) => e.code === 'cache-tracking-unknown');
  } finally { fs.lstatSync = orig; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }); }
});

test('a later lock generation or round re-included by the user is seen: present files are checked, and re-includes are named as unchecked', { skip: isWin }, async () => {
  const root = project();
  try {
    const all = '_close.lock*\n._close.lock*\n.*.lock*\n.*.tmp-*\n_close-marker.json\n_maintenance-state.json\n_pm-state.json\n_capability-drift-log.md\n';
    writeFileSync(join(root, '_memories', '.gitignore'), all + '!_close.lock.g2.done\n');
    let problems = ensureStoreIgnores(root).join();
    assert.match(problems, /does not prove later names are covered for .*_close\.lock\*/, 'an exception is named as something that cannot be fully checked');
    writeFileSync(join(root, '_memories', '_close.lock.g2.done'), '{}');
    assert.match(ensureStoreIgnores(root).join(), /leaves _close\.lock\* visible/, 'the generation actually present is checked');
    // rounds
    mkdirSync(join(root, '_tests', 'self-test', 'round-2'), { recursive: true });
    writeFileSync(join(root, '_tests', 'self-test', '.gitignore'), 'round-*/\nauto-author-state.json\n!round-2/\n');
    assert.match(ensureStoreIgnores(root).join(), /_tests\/self-test\/\.gitignore is not CORE's and leaves round-\*\/ visible/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a .git that is a link or a pointer file keeps its repository outside: git is not run, a custom ignore file is reported as not checked, and the cache folder is not refused', { skip: isWin }, async () => {
  const { symlinkSync, chmodSync } = await import('node:fs');
  const { ensureLibDir } = await import('../../plugins/core/skills/core/scripts/store-ignores.mjs');
  for (const shape of ['link', 'pointer file']) {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'core-outside-repo-')));
    execFileSync('git', ['-C', outside, 'init', '-q'], { env });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'core-store-ignores-')));
    mkdirSync(join(root, '_memories'));
    writeFileSync(join(root, '_memories', '.gitignore'), '# mine\n');
    if (shape === 'link') symlinkSync(join(outside, '.git'), join(root, '.git'));
    else writeFileSync(join(root, '.git'), `gitdir: ${join(outside, '.git')}\n`);
    const bin = join(root, '..', `bin-${Date.now()}`); mkdirSync(bin);
    const marker = join(bin, 'git-was-run');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${path}`;
      assert.deepEqual(ensureStoreIgnores(root), ["_memories/.gitignore was not checked: the project's .git is a link or pointer file, and the repository it names is not consulted"], shape);
      assert.ok(ensureLibDir(root), `${shape}: the cache folder is made`);
      rmSync(join(root, '_memories', '.gitignore'));
      assert.deepEqual(ensureStoreIgnores(root), [], `${shape}: CORE's own file needs no repository to decide`);
      assert.deepEqual(ensureStoreIgnores(root), [], `${shape}: and stays quiet once written`);
      assert.equal(existsSync(marker), false, `${shape}: git was never run against the outside repository`);
    } finally { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
  }
});

test('a positive-only custom policy that covers the samples but not the family is reported as unproven; a listing failure is reported', { skip: isWin }, async () => {
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const root = project();
  try {
    mkdirSync(join(root, '_tests', 'self-test'), { recursive: true });
    writeFileSync(join(root, '_tests', 'self-test', '.gitignore'), 'round-1/\nauto-author-state.json\n');
    assert.match(ensureStoreIgnores(root).join(), /self-test\/\.gitignore does not prove later names are covered for round-\*\//);
    writeFileSync(join(root, '_tests', 'self-test', '.gitignore'), 'round-*/\nauto-author-state.json\n# mine\n');
    assert.equal(ensureStoreIgnores(root).some((p) => p.includes('self-test')), false, "CORE's own rule, no re-include: proven");
    const orig = fs.readdirSync;
    fs.readdirSync = (p, ...a) => { if (String(p) === join(root, '_tests', 'self-test')) throw Object.assign(new Error('x'), { code: 'EIO' }); return orig(p, ...a); };
    syncBuiltinESMExports();
    try { assert.match(ensureStoreIgnores(root).join(), /could not list the folder \(EIO\)/); }
    finally { fs.readdirSync = orig; syncBuiltinESMExports(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('telemetry under _sessions/ and the files in _metrics/ are ignored from the first write, with no startup; notes beside them stay visible', async () => {
  const { logEvent, prepareStorageDir } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const root = project();
  try {
    logEvent(root, 'retrieval-log.jsonl', { kind: 'x' }, { today: '2026-10-05' });
    mkdirSync(join(root, '_sessions', '2026-10-05'), { recursive: true });
    writeFileSync(join(root, '_sessions', '2026-10-05', 'notes.md'), 'mine\n');
    prepareStorageDir(root);
    const ask = (paths) => spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '--stdin'], { input: paths.join('\n') + '\n', env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    assert.deepEqual(ask(['_sessions/2026-10-05/retrieval-log.jsonl', '_sessions/2026-10-05/notes.md', '_sessions/2026-10-06/hygiene-log.jsonl']).sort(),
      ['_sessions/2026-10-05/retrieval-log.jsonl', '_sessions/2026-10-06/hygiene-log.jsonl']);
    assert.deepEqual(ask(['_metrics/judgment-log.jsonl', '_metrics/.turn-capture.lock', '_metrics/turn-capture/2026-10-05.jsonl', '_metrics/README.md', '_metrics/.gitignore']).sort(),
      ['_metrics/.turn-capture.lock', '_metrics/judgment-log.jsonl', '_metrics/turn-capture/2026-10-05.jsonl']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('maintenance reports a re-include in _core and CORE files git already tracks; the bare files CORE wrote before are accepted', async () => {
  const { PROJECT_IGNORES, STORE_IGNORES, trackedGenerated } = await import('../../plugins/core/skills/core/scripts/store-ignores.mjs');
  const root = project();
  try {
    mkdirSync(join(root, '_core', 'claude-code'), { recursive: true });
    writeFileSync(join(root, '_core', '.gitignore'), '*\n');
    mkdirSync(join(root, '_metrics'));
    writeFileSync(join(root, '_metrics', '.gitignore'), '*\n!.gitignore\n!README.md\n');
    assert.deepEqual(ensureStoreIgnores(root, { families: PROJECT_IGNORES }).filter((p) => !p.startsWith('_sessions')), [], 'files CORE wrote before, without the header, pass');
    writeFileSync(join(root, '_core', '.gitignore'), '*\n!claude-code/\n!claude-code/workspace.json\n');
    assert.ok(ensureStoreIgnores(root, { families: PROJECT_IGNORES }).some((p) => p.startsWith('_core/.gitignore')), 'a re-include in _core is reported');
    writeFileSync(join(root, '_metrics', 'judgment-log.jsonl'), '{}\n');
    writeFileSync(join(root, '_metrics', 'README.md'), 'readme\n');
    git(root, 'add', '-f', '_metrics/judgment-log.jsonl', '_metrics/README.md', '_memories/u1.md', '_memories/inbox.md');
    assert.deepEqual(trackedGenerated(root, [...STORE_IGNORES, ...PROJECT_IGNORES]), ['_metrics/judgment-log.jsonl is tracked by git, so its ignore rule does not apply to it']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a per-turn writer only makes sure the ignore file is there: git is never run on that path', { skip: isWin }, async () => {
  const { chmodSync } = await import('node:fs');
  const { logEvent } = await import('../../plugins/core/skills/core/scripts/log-event.mjs');
  const root = project();
  const bin = join(root, '..', `bin-hot-${Date.now()}`); mkdirSync(bin);
  const marker = join(bin, 'git-was-run');
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(join(bin, 'git'), 0o755);
  const path = process.env.PATH;
  try {
    mkdirSync(join(root, '_sessions'));
    writeFileSync(join(root, '_sessions', '.gitignore'), '# mine\n');
    process.env.PATH = `${bin}:${path}`;
    logEvent(root, 'retrieval-log.jsonl', { kind: 'x' }, { today: '2026-10-05' });
    assert.equal(existsSync(marker), false);
    assert.equal(readFileSync(join(root, '_sessions', '.gitignore'), 'utf8'), '# mine\n', "the user's file is left alone");
  } finally { process.env.PATH = path; rmSync(root, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
});
