import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mappedMemoryPath, classifyMemoryState, probe, CANARY, SCHEMA_VERSION, CAPABILITY_ID,
} from '../../plugins/core/skills/core/scripts/capability/auto-memory-injection-probe.mjs';

// Valid evidence weights per capability/row-schema.md. 'supporting' is NOT valid.
const VALID_WEIGHTS = new Set(['primary', 'corroborating', 'conflicting']);
const VALID_KINDS = new Set(['identity', 'runtime', 'mutation', 'observation']);

// --- mappedMemoryPath ---

test('mappedMemoryPath replaces every / with - and lands under .claude/projects', () => {
  const p = mappedMemoryPath('/Users/dbates/Documents/Projects/CORE', '/home');
  assert.equal(p, '/home/.claude/projects/-Users-dbates-Documents-Projects-CORE/memory/MEMORY.md');
});

test('mappedMemoryPath honors the provided home', () => {
  const p = mappedMemoryPath('/proj/Foo', '/tmp/h');
  assert.match(p, /^\/tmp\/h\/\.claude\/projects\/-proj-Foo\/memory\/MEMORY\.md$/);
});

// A live Windows-box repro: a hand-rolled `.replace(/[/\\]/g, '-')`
// missed the drive colon (and any dot), producing a mapped path that never matched the
// real Claude Code projects folder -- so this probe falsely reported memory not visible
// on Windows while the mechanism was actually working. Must use the canonical
// mapProjectPathToSlug encoder, which handles '.' and ':' too.
test('mappedMemoryPath handles a Windows drive-colon path', () => {
  const p = mappedMemoryPath('C:\\Users\\david\\Documents\\Projects\\core-windows', '/home');
  // The SLUG segment (derived from cwd) must never carry a colon -- that would be an
  // un-creatable path segment. `home` is a real filesystem path and is used as-is.
  const slug = p.split('/.claude/projects/')[1].split('/memory/')[0];
  assert.doesNotMatch(slug, /:/, 'the cwd-derived slug must not contain a colon');
  assert.equal(slug, 'C--Users-david-Documents-Projects-core-windows');
});

test('mappedMemoryPath handles a dotted username (the original dotted-username bug this shares a root cause with)', () => {
  const p = mappedMemoryPath('/Users/David.Bates28/Documents/Projects/CORE', '/home');
  assert.equal(p, '/home/.claude/projects/-Users-David-Bates28-Documents-Projects-CORE/memory/MEMORY.md');
});

// --- classifyMemoryState (pure) ---

test('classifyMemoryState: PASS when file exists and canary present, with a primary evidence entry', () => {
  const r = classifyMemoryState({ pathResolved: true, fileExists: true, content: `# x\n${CANARY}\n- a` });
  assert.equal(r.identity_status, 'PASS');
  assert.ok(r.evidence.some(e => e.weight === 'primary'), 'PASS must carry a primary entry (producer expectation #5)');
});

test('classifyMemoryState: DEGRADED when file exists but canary absent, with a conflicting entry', () => {
  const r = classifyMemoryState({ pathResolved: true, fileExists: true, content: '# x\nno marker here' });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.ok(r.evidence.some(e => e.weight === 'conflicting'), 'DEGRADED must carry a conflicting entry (producer expectation #6)');
});

test('classifyMemoryState: NOT-YET when file does not exist', () => {
  const r = classifyMemoryState({ pathResolved: true, fileExists: false, content: null });
  assert.equal(r.identity_status, 'NOT-YET');
});

test('classifyMemoryState: UNKNOWN when path could not be resolved', () => {
  const r = classifyMemoryState({ pathResolved: false, fileExists: false, content: null });
  assert.equal(r.identity_status, 'UNKNOWN');
  assert.ok(r.evidence.some(e => e.weight === 'conflicting'));
});

test('classifyMemoryState: every evidence weight across all states is schema-valid', () => {
  const states = [
    { pathResolved: true, fileExists: true, content: CANARY },
    { pathResolved: true, fileExists: true, content: 'no marker' },
    { pathResolved: true, fileExists: false, content: null },
    { pathResolved: false, fileExists: false, content: null },
  ];
  for (const s of states) {
    for (const e of classifyMemoryState(s).evidence) {
      assert.ok(VALID_WEIGHTS.has(e.weight), `weight "${e.weight}" not in schema set`);
    }
  }
});

// --- probe() integration against a temp filesystem ---

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'amip-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function writeMemory(home, cwd, body) {
  const mapped = cwd.replace(/\//g, '-');
  const dir = join(home, '.claude', 'projects', mapped, 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
}

test('probe: PASS row shape when MEMORY.md exists with canary', async () => {
  await withTempHome(async (home) => {
    const cwd = '/work/ProjA';
    writeMemory(home, cwd, `# Index\n${CANARY}\n- session line`);
    const row = await probe({ home, cwd });
    assert.equal(row.identity_status, 'PASS');
    assert.equal(row.capability_id, CAPABILITY_ID);
    assert.equal(row.schema_version, SCHEMA_VERSION);
    assert.ok(VALID_KINDS.has(row.capability_kind), 'capability_kind must be a schema kind');
    assert.equal(row.capability_kind, 'observation');
    assert.equal(row.mutation_permitted, false);
    assert.equal(row.mutation_block_reason, 'read-only-context');
    assert.equal(row.harness, 'claude-code');
    assert.match(row.memory_path, /-work-ProjA\/memory\/MEMORY\.md$/);
    assert.ok(Array.isArray(row.evidence) && row.evidence.length >= 1);
  });
});

test('probe: NOT-YET when no MEMORY.md for the mapped cwd', async () => {
  await withTempHome(async (home) => {
    const row = await probe({ home, cwd: '/work/NoMemoryHere' });
    assert.equal(row.identity_status, 'NOT-YET');
    assert.equal(row.mutation_permitted, false);
  });
});

test('probe: DEGRADED when MEMORY.md exists without the canary', async () => {
  await withTempHome(async (home) => {
    const cwd = '/work/Drifted';
    writeMemory(home, cwd, '# Index\n(no recent-activity marker)');
    const row = await probe({ home, cwd });
    assert.equal(row.identity_status, 'DEGRADED');
  });
});

test('probe: row always carries the required schema fields', async () => {
  await withTempHome(async (home) => {
    const row = await probe({ home, cwd: '/work/Any' });
    for (const k of ['schema_version', 'capability_id', 'capability_kind', 'observed_at', 'identity_status', 'mutation_permitted', 'evidence']) {
      assert.ok(k in row, `row missing required field: ${k}`);
    }
    for (const e of row.evidence) assert.ok(VALID_WEIGHTS.has(e.weight));
  });
});
