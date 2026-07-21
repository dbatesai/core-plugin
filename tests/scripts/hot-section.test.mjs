import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  applyHotSection, recordProjectMdWrite, HOT_BEGIN, HOT_END,
  currentHotSection, clearHotSection, candidatesForSynthesis,
  HOT_SECTION_TOKEN_BUDGET,
} from '../../plugins/core/skills/core/scripts/hot-section.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/hot-section.mjs', import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hot-section-'));
  const project = join(root, 'project');
  const home = join(root, 'home');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(home, '.core'), { recursive: true });
  writeFileSync(join(project, 'PROJECT.md'), '# Project\n\n## What & Why\n\nThe thing.\n');
  return {
    root, project, home,
    globalCachePath: join(home, '.core', 'state-cache.json'),
    // Per-project cache — the write of record since the shared-write concurrency split (2026-07-14).
    projectCachePath: join(project, '_memories', '_lib', 'state-cache.json'),
  };
}

test('applyHotSection stamps the PER-PROJECT state-cache last_written_by: hot-section', () => {
  const { root, project, home, projectCachePath } = setup();
  try {
    applyHotSection(project, 'Right now: shipping the thing.', { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(projectCachePath, 'utf8'));
    const entry = cache.files[join(project, 'PROJECT.md')];
    assert.ok(entry, 'PROJECT.md has a per-project state-cache entry after apply');
    assert.equal(entry.last_written_by, 'hot-section',
      'the script-driven write is recorded as CORE-authored, not a user edit');
    assert.match(entry.last_hash, /^[0-9a-f]{16}$/, 'last_hash is a 16-hex digest');
    assert.equal(entry.last_written, '2026-06-06T00:00:00Z', 'last_written uses the injected timestamp');
    // and the hot block actually landed in PROJECT.md
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.includes(HOT_BEGIN) && pm.includes(HOT_END), 'hot block written to PROJECT.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordProjectMdWrite merges into an existing per-project cache without clobbering other entries', () => {
  const { root, project, home, projectCachePath } = setup();
  try {
    mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
    writeFileSync(projectCachePath, JSON.stringify({
      files: { '/some/other/file.md': { last_hash: 'deadbeefdeadbeef', last_written: 'x', last_written_by: 'init' } },
    }, null, 2));
    recordProjectMdWrite(join(project, 'PROJECT.md'), { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(projectCachePath, 'utf8'));
    assert.ok(cache.files['/some/other/file.md'], 'pre-existing entry preserved');
    assert.equal(cache.files['/some/other/file.md'].last_written_by, 'init', 'pre-existing entry untouched');
    assert.equal(cache.files[join(project, 'PROJECT.md')].last_written_by, 'hot-section', 'new entry added');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordProjectMdWrite tolerates a missing per-project cache file (creates it)', () => {
  const { root, project, home, projectCachePath } = setup();
  try {
    recordProjectMdWrite(join(project, 'PROJECT.md'), { now: '2026-06-06T00:00:00Z', home });
    const cache = JSON.parse(readFileSync(projectCachePath, 'utf8'));
    assert.equal(cache.files[join(project, 'PROJECT.md')].last_written_by, 'hot-section');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('recordProjectMdWrite prunes the file entry from the GLOBAL cache (one-release migration), preserving others', () => {
  const { root, project, home, globalCachePath, projectCachePath } = setup();
  try {
    const pmPath = join(project, 'PROJECT.md');
    writeFileSync(globalCachePath, JSON.stringify({
      files: {
        [pmPath]: { last_hash: 'stale00000000000', last_written: 'x', last_written_by: 'hot-section' },
        '/another/project/PROJECT.md': { last_hash: 'aaaaaaaaaaaaaaaa', last_written: 'y', last_written_by: 'hot-section' },
      },
    }, null, 2));
    recordProjectMdWrite(pmPath, { now: '2026-06-06T00:00:00Z', home });
    const globalCache = JSON.parse(readFileSync(globalCachePath, 'utf8'));
    assert.ok(!(pmPath in globalCache.files), 'this file\'s stale global entry pruned');
    assert.ok(globalCache.files['/another/project/PROJECT.md'], 'other projects\' global entries preserved');
    const projectCache = JSON.parse(readFileSync(projectCachePath, 'utf8'));
    assert.equal(projectCache.files[pmPath].last_written_by, 'hot-section', 'per-project stamp is the write of record');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply --file lands prose with shell metacharacters verbatim', () => {
  const { root, project, home } = setup();
  try {
    const prose = 'Right now: `priority.mjs` re-ranked — "quotes", $CORE_ROOT, a \\ backslash, and ; semicolons all survive.';
    const draft = join(root, 'draft.md');
    writeFileSync(draft, prose);
    const res = spawnSync(process.execPath, [SCRIPT, 'apply', project, '--file', draft], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0, `apply --file exits 0 (stderr: ${res.stderr})`);
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.includes(prose), 'metacharacter prose lands in PROJECT.md unaltered');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('apply reads stdin when neither --text nor --file is given', () => {
  const { root, project, home } = setup();
  try {
    const prose = 'Right now: stdin path works — no shell interpolation of unit-derived text.';
    const res = spawnSync(process.execPath, [SCRIPT, 'apply', project], {
      encoding: 'utf8',
      input: prose,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0, `apply via stdin exits 0 (stderr: ${res.stderr})`);
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.includes(prose), 'stdin prose lands in PROJECT.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- coverage additions (2026-07-20, iteration ~71): currentHotSection,
// clearHotSection, candidatesForSynthesis, applyHotSection's over-budget
// throw, and the CLI subcommands were entirely untested. Real gaps, not
// speculative — these are exported functions with no test at all before
// this batch. ----

function writeUnit(memoriesDir, id, { type = 'observation', status = 'active', topics = [], title = 'A title', updated = '2026-06-01' } = {}) {
  mkdirSync(memoriesDir, { recursive: true });
  const fm = [
    '---',
    `id: ${id}`,
    `type: ${type}`,
    `status: ${status}`,
    `updated: ${updated}`,
    `topics: [${topics.join(', ')}]`,
    '---',
    '',
    `# ${title}`,
    '',
    'Body text.',
  ].join('\n');
  writeFileSync(join(memoriesDir, `${id}.md`), fm);
}

test('currentHotSection returns empty string when no hot block is present', () => {
  const { root, project } = setup();
  try {
    assert.equal(currentHotSection(project), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('currentHotSection round-trips the composed body, stripping the heading and footer', () => {
  const { root, project, home } = setup();
  try {
    applyHotSection(project, 'The actual synthesis prose.', { now: '2026-06-06T00:00:00Z', home });
    assert.equal(currentHotSection(project), 'The actual synthesis prose.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clearHotSection is a no-op when no hot block is present', () => {
  const { root, project } = setup();
  try {
    const before = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    const returned = clearHotSection(project);
    assert.equal(returned, before, 'unchanged content returned');
    assert.equal(readFileSync(join(project, 'PROJECT.md'), 'utf8'), before, 'file untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('clearHotSection removes an existing block', () => {
  const { root, project, home } = setup();
  try {
    applyHotSection(project, 'Ephemeral.', { now: '2026-06-06T00:00:00Z', home });
    clearHotSection(project);
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(!pm.includes(HOT_BEGIN) && !pm.includes(HOT_END), 'markers gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyHotSection throws HOT_SECTION_OVER_BUDGET for oversized text, and skips the write', () => {
  const { root, project, home } = setup();
  try {
    const huge = 'x'.repeat(Math.ceil(HOT_SECTION_TOKEN_BUDGET / 0.30) + 100);
    assert.throws(
      () => applyHotSection(project, huge, { now: '2026-06-06T00:00:00Z', home }),
      (err) => err.code === 'HOT_SECTION_OVER_BUDGET' && err.tokens > HOT_SECTION_TOKEN_BUDGET,
    );
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(!pm.includes(HOT_BEGIN), 'no partial write happened on the over-budget path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyHotSection with allowOverBudget:true writes oversized text anyway', () => {
  const { root, project, home } = setup();
  try {
    const huge = 'x'.repeat(Math.ceil(HOT_SECTION_TOKEN_BUDGET / 0.30) + 100);
    applyHotSection(project, huge, { now: '2026-06-06T00:00:00Z', home, allowOverBudget: true });
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.includes(HOT_BEGIN), 'escape hatch writes despite exceeding budget');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('applyHotSection appends the block at EOF when `## What & Why` is missing', () => {
  const { root, project, home } = setup();
  try {
    writeFileSync(join(project, 'PROJECT.md'), '# Project\n\nNo six-section shape here.\n');
    applyHotSection(project, 'Fallback insertion point.', { now: '2026-06-06T00:00:00Z', home });
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(pm.trim().endsWith(HOT_END), 'block landed at the end, not silently dropped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('candidatesForSynthesis returns [] when _memories/ is absent or empty', () => {
  const { root, project } = setup();
  try {
    assert.deepEqual(candidatesForSynthesis(project), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('candidatesForSynthesis ranks active units, excludes non-active status, and respects --top', () => {
  const { root, project } = setup();
  try {
    const memoriesDir = join(project, '_memories');
    writeUnit(memoriesDir, 'obs-alpha', { title: 'Alpha finding', topics: ['x'], updated: '2026-06-01' });
    writeUnit(memoriesDir, 'obs-beta', { title: 'Beta finding', topics: ['x'], updated: '2026-06-05' });
    writeUnit(memoriesDir, 'obs-retired', { status: 'retired', title: 'Should not appear' });
    const cands = candidatesForSynthesis(project, { top: 1 });
    assert.equal(cands.length, 1, '--top caps the result count');
    assert.ok(cands.every(c => c.id !== 'obs-retired'), 'non-active units excluded');
    assert.ok(cands[0].title.length > 0, 'title extracted from the unit body');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: candidates subcommand prints "(no candidates ...)" against an empty store, exits 0', () => {
  const { root, project, home } = setup();
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'candidates', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no candidates/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: candidates --json emits parseable JSON', () => {
  const { root, project, home } = setup();
  try {
    writeUnit(join(project, '_memories'), 'obs-json', { title: 'JSON path' });
    const res = spawnSync(process.execPath, [SCRIPT, 'candidates', project, '--json'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed[0].id, 'obs-json');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: current subcommand prints nothing against an empty PROJECT.md, exits 0', () => {
  const { root, project, home } = setup();
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'current', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: clear subcommand reports "nothing to clear" when no block exists', () => {
  const { root, project, home } = setup();
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'clear', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /nothing to clear/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: apply with no --text/--file and empty stdin exits 2 with an error, writes nothing', () => {
  const { root, project, home } = setup();
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'apply', project], {
      encoding: 'utf8', input: '', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /no synthesis text provided/);
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(!pm.includes(HOT_BEGIN), 'no write happened on the error path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: unknown subcommand exits 2 with usage on stderr', () => {
  const { root, project, home } = setup();
  try {
    const res = spawnSync(process.execPath, [SCRIPT, 'bogus', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown subcommand/);
    assert.match(res.stderr, /Usage:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: --help prints usage and exits 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

test('CLI: candidates human-readable path prints rank, id, title, and topics for each candidate', () => {
  const { root, project, home } = setup();
  try {
    writeUnit(join(project, '_memories'), 'obs-human', { title: 'Human-readable line', topics: ['a', 'b'] });
    const res = spawnSync(process.execPath, [SCRIPT, 'candidates', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /\[1\] obs-human/);
    assert.match(res.stdout, /Human-readable line/);
    assert.match(res.stdout, /topics: a, b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: clear subcommand reports success and actually removes the block', () => {
  const { root, project, home } = setup();
  try {
    applyHotSection(project, 'To be cleared.', { now: '2026-06-06T00:00:00Z', home });
    const res = spawnSync(process.execPath, [SCRIPT, 'clear', project], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /hot section cleared/);
    const pm = readFileSync(join(project, 'PROJECT.md'), 'utf8');
    assert.ok(!pm.includes(HOT_BEGIN), 'block actually gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
