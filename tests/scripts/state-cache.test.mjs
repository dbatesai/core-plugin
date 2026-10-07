/**
 * state-cache.mjs — the shared stamp-and-prune primitive extracted 2026-07-22
 * out of hot-section.mjs's recordProjectMdWrite, so decorate-graph.mjs and
 * maintenance-run.mjs didn't need their own copies of the same lock/prune
 * logic. Domain-specific classification (hashing outside a marker-delimited
 * block) stays in each caller; this module only covers the generic
 * stamp/read/prune plumbing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname, resolve, delimiter } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  hashText, projectCachePath, readProjectCache, stampFiles, stampFile,
  CACHE_ABSENT, CACHE_CORRUPT,
} from '../../plugins/core/skills/core/scripts/state-cache.mjs';

// Windows contract: never .pathname on a file: URL (yields /D:/... which
// join+pathToFileURL mangle into D:\D:\...). The URL itself is the import spec.
const STATE_CACHE_SCRIPT = new URL('../../plugins/core/skills/core/scripts/state-cache.mjs', import.meta.url).href;

// Genuinely concurrent child processes (spawnSync would serialize the "race" —
// same pattern index-registry.test.mjs's lost-update proof uses).
function spawnAsync(args) {
  return new Promise((res) => {
    const c = spawn(process.execPath, args, { timeout: 30000 });
    let stdout = '', stderr = '';
    c.stdout.on('data', d => { stdout += d; });
    c.stderr.on('data', d => { stderr += d; });
    c.on('close', (status) => res({ status, stdout, stderr }));
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'state-cache-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, '.core'), { recursive: true });
  return { root, project, home, cachePath: projectCachePath(project) };
}

test('hashText is a deterministic 16-hex digest, empty-safe', () => {
  assert.match(hashText('hello'), /^[0-9a-f]{16}$/);
  assert.equal(hashText('hello'), hashText('hello'));
  assert.notEqual(hashText('hello'), hashText('world'));
  assert.match(hashText(''), /^[0-9a-f]{16}$/);
  assert.match(hashText(undefined), /^[0-9a-f]{16}$/, 'tolerates undefined input');
});

test('readProjectCache reports an absent cache as absent, not as an empty clean one', () => {
  const { project } = setup();
  const cache = readProjectCache(project);
  assert.deepEqual(cache.files, {});
  assert.equal(cache.status, CACHE_ABSENT);
});

test('readProjectCache reports a corrupt cache as corrupt — absence and damage are different answers', () => {
  const { project, cachePath } = setup();
  mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
  writeFileSync(cachePath, 'not json{{{');
  const cache = readProjectCache(project);
  assert.deepEqual(cache.files, {});
  assert.equal(cache.status, CACHE_CORRUPT, 'an unparseable cache must never read as an empty clean one');

  // A well-formed JSON document of the wrong shape is damage too.
  writeFileSync(cachePath, JSON.stringify({ files: [] }));
  assert.equal(readProjectCache(project).status, CACHE_CORRUPT);
});

test('stampFiles preserves corrupt cache bytes and reports the lost attribution', () => {
  const { root, project, home, cachePath } = setup();
  try {
    mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
    const corruptBytes = '{"files": {"/kept.md": {"last_written_by": "core"';
    writeFileSync(cachePath, corruptBytes);

    const outcome = stampFiles(project, [{ path: '/a.md', hash: hashText('a'), lastWrittenBy: 'decorate-graph' }],
      { now: '2026-07-28T00:00:00Z', home });

    assert.equal(outcome.stamped, true, 'the new write is still attributed');
    assert.equal(outcome.outcome, 'prior-attribution-unknown',
      'but prior attribution is UNKNOWN — never silently rebuilt as an empty cache');
    assert.equal(outcome.recovery, 'recovery-required');
    assert.ok(outcome.quarantined, 'and the damaged file is named');
    assert.equal(readFileSync(outcome.quarantined, 'utf8'), corruptBytes,
      'the corrupt bytes are preserved verbatim beside the original');
    assert.match(outcome.quarantined, /state-cache\.json\.corrupt-/);

    const rebuilt = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(rebuilt.files['/a.md'].last_written_by, 'decorate-graph');
    assert.equal('/kept.md' in rebuilt.files, false, 'the unreadable prior state is not guessed at');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFiles reports an unreadable cache as refused, never as stamped', () => {
  const { root, project, home, cachePath } = setup();
  try {
    // A directory where the cache file should be: the read fails, the bytes are never seen.
    mkdirSync(join(cachePath, 'blocker'), { recursive: true });
    const outcome = stampFiles(project, [{ path: '/a.md', hash: hashText('a'), lastWrittenBy: 'decorate-graph' }],
      { now: '2026-07-28T00:00:00Z', home });
    assert.equal(outcome.stamped, false, 'a refused stamp must not read as success');
    assert.equal(outcome.outcome, 'refused');
    assert.match(outcome.reason, /cache-unreadable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFiles refuses to overwrite a corrupt cache it could not preserve', () => {
  const { root, project, home, cachePath } = setup();
  try {
    mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
    const corruptBytes = '{"files": {"/kept.md": {"last_written_by": "core"';
    writeFileSync(cachePath, corruptBytes);
    // Occupy the quarantine destination with a non-empty directory so the rename fails.
    const now = '2026-07-28T00:00:00Z';
    mkdirSync(join(`${cachePath}.corrupt-${now.replace(/[:.]/g, '-')}`, 'x'), { recursive: true });
    const outcome = stampFiles(project, [{ path: '/a.md', hash: hashText('a'), lastWrittenBy: 'decorate-graph' }], { now, home });
    assert.equal(outcome.stamped, false);
    assert.equal(outcome.reason, 'corrupt-cache-not-preserved');
    assert.equal(readFileSync(cachePath, 'utf8'), corruptBytes, 'the only copy of prior attribution is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('detectStore surfaces a corrupt baseline as UNKNOWN rather than a store of fresh files', async () => {
  const { root, project, cachePath } = setup();
  try {
    mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
    writeFileSync(join(project, 'PROJECT.md'), '# P\n');
    writeFileSync(cachePath, 'not json{{{');
    const { detectStore } = await import('../../plugins/core/skills/core/scripts/lifecycle-detect.mjs');
    const report = detectStore(project);
    assert.equal(report.baseline_status, CACHE_CORRUPT,
      'a damaged baseline must not be narrated as "every file needs one"');
    assert.equal(report.baseline_trustworthy, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFiles writes one entry per file, merging into any pre-existing cache without clobbering it', () => {
  const { root, project, home, cachePath } = setup();
  try {
    mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ files: { '/other/file.md': { last_hash: 'aaaa', last_written_by: 'init' } } }));

    stampFiles(project, [
      { path: '/a.md', hash: hashText('a'), lastWrittenBy: 'decorate-graph' },
      { path: '/b.md', hash: hashText('b'), lastWrittenBy: 'decorate-graph', extra: { outside_hash: 'deadbeefdeadbeef' } },
    ], { now: '2026-07-22T00:00:00Z', home });

    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.files['/other/file.md'].last_written_by, 'init', 'pre-existing entry untouched');
    assert.equal(cache.files['/a.md'].last_written_by, 'decorate-graph');
    assert.equal(cache.files['/a.md'].last_hash, hashText('a'));
    assert.equal(cache.files['/a.md'].last_written, '2026-07-22T00:00:00Z');
    assert.equal(cache.files['/b.md'].outside_hash, 'deadbeefdeadbeef', 'extra fields merge into the stamp');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFiles is a no-op for an empty/absent entries array — never creates a cache file out of nothing', () => {
  const { root, project, home, cachePath } = setup();
  try {
    stampFiles(project, [], { home });
    assert.ok(!existsSync(cachePath));
    stampFiles(project, undefined, { home });
    assert.ok(!existsSync(cachePath));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A stamp works inside its project: the child runs under the attempted-access gate with the
// project and this repo (the code) as the only roots, so any touch of ~/.core, the OS temp dir or
// another project is refused and recorded, even if the code swallows the error.
test('a stamp touches no global cache or shared lock — its only outside access is the lock-identity read', () => {
  const { root, project, cachePath } = setup();
  try {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const mod = pathToFileURL(join(repo, 'plugins/core/skills/core/scripts/state-cache.mjs')).href;
    const code = `const { stampFiles } = await import(${JSON.stringify(mod)});
      process.stdout.write(JSON.stringify(stampFiles(${JSON.stringify(project)}, [{ path: '/a.md', hash: 'abcdabcdabcdabcd', lastWrittenBy: 'probe' }])));`;
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(join(repo, 'tests/scripts/fs-confine.mjs')).href, '--input-type=module', '-e', code], {
      env: { ...process.env, FS_CONFINE_ROOTS: [realpathSync(project), project, repo].join(delimiter) }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).stamped, true);
    const v = JSON.parse(r.stderr.match(/FS_CONFINE_VIOLATIONS (.*)/)[1]);
    // The one outside access left is the lock helper's ownership identity (file-lock.mjs
    // localMachineId → ~/.core/install-id), an open one-folder item; no global cache read, write or lock.
    assert.deepEqual(v, [{ call: 'readFileSync', path: join(userInfo().homedir, '.core', 'install-id') }], 'only the lock-identity read leaves the project');
    assert.equal(JSON.parse(readFileSync(cachePath, 'utf8')).files['/a.md'].last_written_by, 'probe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stampFile (singular) is a thin one-entry wrapper around stampFiles', () => {
  const { root, project, home, cachePath } = setup();
  try {
    stampFile(project, '/single.md', hashText('x'), 'hot-section', { now: '2026-07-22T00:00:00Z', home, extra: { outside_hash: 'cafebabecafebabe' } });
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(cache.files['/single.md'].last_written_by, 'hot-section');
    assert.equal(cache.files['/single.md'].outside_hash, 'cafebabecafebabe');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- THE LOST-UPDATE PROOF: stampFiles used to
// be an unlocked read-modify-write over the whole project-local cache file.
// A 40-concurrent-process probe measured the consequence directly:
// 29/40 entries survived, 11 lost to the race. This reproduces that same
// shape — N genuinely concurrent OS processes (not just concurrent promises
// in one process — spawnSync would serialize them, defeating the point),
// each stamping a DISTINCT file path into the SAME project-local cache — and
// asserts every single one survives now that the read-modify-write is
// serialized under `.state-cache.lock` (same withFileLock primitive
// index-registry.mjs's own lost-update proof already relies on). ----
test("race: 40 concurrent processes each stamping a distinct file all survive — no lost update (29/40 survived before the lock fix)", async () => {
  const { root, project, home, cachePath } = setup();
  try {
    const N = 40;
    const code = (i) => [
      `import { stampFile } from ${JSON.stringify(STATE_CACHE_SCRIPT)};`,
      `stampFile(${JSON.stringify(project)}, ${JSON.stringify(`/concurrent-${i}.md`)}, ${JSON.stringify(hashText(`entry-${i}`))}, 'concurrency-test', { now: '2026-07-22T00:00:00Z', home: ${JSON.stringify(home)} });`,
    ].join('\n');

    const procs = await Promise.all(
      Array.from({ length: N }, (_, i) => spawnAsync(['--input-type=module', '-e', code(i)]))
    );
    for (const p of procs) assert.equal(p.status, 0, `stamp process ${p} exited 0 (stderr: ${p.stderr})`);

    const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
    const survived = Object.keys(cache.files).length;
    assert.equal(survived, N, `all ${N} concurrent stamps must survive under the lock (got ${survived}/${N})`);
    for (let i = 0; i < N; i++) {
      assert.ok(cache.files[`/concurrent-${i}.md`], `entry ${i} present`);
      assert.equal(cache.files[`/concurrent-${i}.md`].last_written_by, 'concurrency-test');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable cache is not absent — only ENOENT is absence', async () => {
  const { readProjectCache, CACHE_ABSENT } = await import('../../plugins/core/skills/core/scripts/state-cache.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'cache-unreadable-'));
  try {
    // A DIRECTORY at the cache path yields EISDIR on read — unreadable, not missing.
    const lib = join(dir, '_memories', '_lib');
    mkdirSync(join(lib, 'state-cache.json'), { recursive: true });
    const r = readProjectCache(dir);
    assert.notEqual(r.status, CACHE_ABSENT, 'EISDIR must not report absence');
    assert.equal(r.status, 'unreadable', 'a read failure that is not ENOENT reports unreadable');
    assert.ok(r.error, 'the original evidence is preserved');
    assert.equal(r.baseline_trustworthy_hint, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- The first write into a fresh project: many processes create _memories, _lib and its ignore file at once.
// Each one checks "absent" and then creates; the losers used to throw EEXIST (or judge a half-written ignore file),
// and a stamp lost that way still exited 0. Every process must now get the folder back, and the ignore file must be whole. ----
test("race: 40 processes preparing the same fresh cache folder all succeed, over repeated rounds", async () => {
  const ENSURE = new URL('../../plugins/core/skills/core/scripts/store-ignores.mjs', import.meta.url).href;
  for (let round = 0; round < 12; round++) {
    const { root, project } = setup();
    try {
      const code = `import { ensureLibDir } from ${JSON.stringify(ENSURE)}; console.log(ensureLibDir(${JSON.stringify(project)}));`;
      const procs = await Promise.all(Array.from({ length: 40 }, () => spawnAsync(['--input-type=module', '-e', code])));
      for (const p of procs) assert.equal(p.status, 0, `round ${round}: a process failed: ${p.stderr.trim().slice(0, 300)}`);
      const ignore = readFileSync(join(project, '_memories', '_lib', '.gitignore'), 'utf8');
      assert.ok(ignore.trimEnd().endsWith('*'), `round ${round}: the ignore file is whole`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
