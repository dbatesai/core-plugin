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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

test('stampFiles prunes the same paths from the GLOBAL cache (one-release migration), preserving other files\' global entries', () => {
  const { root, project, home, cachePath } = setup();
  try {
    const globalPath = join(home, '.core', 'state-cache.json');
    writeFileSync(globalPath, JSON.stringify({
      files: {
        '/a.md': { last_hash: 'stale0000000000', last_written: 'x', last_written_by: 'old' },
        '/keep-me.md': { last_hash: 'aaaaaaaaaaaaaaaa', last_written: 'y', last_written_by: 'someone-else' },
      },
    }, null, 2));

    stampFiles(project, [{ path: '/a.md', hash: hashText('a'), lastWrittenBy: 'maintenance-run' }], { home });

    const globalCache = JSON.parse(readFileSync(globalPath, 'utf8'));
    assert.ok(!('/a.md' in globalCache.files), 'the stamped file\'s stale global entry is pruned');
    assert.ok(globalCache.files['/keep-me.md'], 'an unrelated global entry survives the prune');

    const projectCache = JSON.parse(readFileSync(cachePath, 'utf8'));
    assert.equal(projectCache.files['/a.md'].last_written_by, 'maintenance-run', 'the per-project stamp is the write of record');
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
