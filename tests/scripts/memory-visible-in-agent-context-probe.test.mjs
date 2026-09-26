import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findAutoMemEntry, classifyVisibility, probe, samePath, SCHEMA_VERSION, CAPABILITY_ID,
} from '../../plugins/core/skills/core/scripts/capability/memory-visible-in-agent-context-probe.mjs';
import { parseClaudeCode } from '../../plugins/core/skills/core/scripts/read-transcript.mjs';

const VALID_WEIGHTS = new Set(['primary', 'corroborating', 'conflicting']);

// --- read-transcript.mjs: 'attachment' event extraction ---

test('parseClaudeCode surfaces a top-level attachment line as an attachment event', () => {
  const line = JSON.stringify({
    type: 'attachment',
    attachment: { type: 'instructions', files: [
      { path: '/home/.claude/CLAUDE.md', type: 'User', content: 'x' },
      { path: '/proj/memory/MEMORY.md', type: 'AutoMem', content: 'hello memory' },
    ] },
  });
  const events = parseClaudeCode([line]);
  const att = events.find((e) => e.kind === 'attachment');
  assert.ok(att, 'attachment event extracted');
  assert.equal(att.attachmentType, 'instructions');
  assert.equal(att.files.length, 2);
});

test('parseClaudeCode ignores non-attachment lines for attachment events', () => {
  const line = JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  const events = parseClaudeCode([line]);
  assert.equal(events.filter((e) => e.kind === 'attachment').length, 0);
});

// --- findAutoMemEntry ---

test('findAutoMemEntry finds the AutoMem-typed file by path', () => {
  const events = [{ kind: 'attachment', files: [
    { path: '/x/CLAUDE.md', type: 'User', content: 'a' },
    { path: '/x/MEMORY.md', type: 'AutoMem', content: 'mem body' },
  ] }];
  const hit = findAutoMemEntry(events, '/x/MEMORY.md');
  assert.ok(hit);
  assert.equal(hit.content, 'mem body');
});

test('findAutoMemEntry matches a backslash-recorded path against a forward-slash expected path', () => {
  const events = [{ kind: 'attachment', files: [
    { path: 'C:\\Users\\u\\.claude\\projects\\C--proj\\memory\\MEMORY.md', type: 'AutoMem', content: 'mem body' },
  ] }];
  const hit = findAutoMemEntry(events, 'C:\\Users\\u/.claude/projects/C--proj/memory/MEMORY.md');
  assert.ok(hit);
});

test('samePath folds case only on win32', () => {
  assert.ok(samePath('C:\\Users\\U\\MEMORY.md', 'c:/users/u/MEMORY.md', 'win32'));
  assert.ok(!samePath('/Users/U/MEMORY.md', '/users/u/MEMORY.md', 'linux'));
});

test('findAutoMemEntry returns null when no AutoMem entry present', () => {
  const events = [{ kind: 'attachment', files: [{ path: '/x/CLAUDE.md', type: 'User', content: 'a' }] }];
  assert.equal(findAutoMemEntry(events, '/x/MEMORY.md'), null);
});

// --- classifyVisibility (pure) ---

test('classifyVisibility: PASS when AutoMem entry has non-empty content', () => {
  const r = classifyVisibility({ transcriptAvailable: true, autoMemEntry: { content: 'abc' }, fileExistsNow: true, currentContent: 'abc' });
  assert.equal(r.identity_status, 'PASS');
  assert.equal(r.injected_length, 3);
});

test('classifyVisibility: PASS notes drift when current file differs in length', () => {
  const r = classifyVisibility({ transcriptAvailable: true, autoMemEntry: { content: 'abc' }, fileExistsNow: true, currentContent: 'abcdef' });
  assert.equal(r.identity_status, 'PASS');
  assert.match(r.reason, /drift expected/);
});

test('classifyVisibility: DEGRADED when MEMORY.md exists but no AutoMem entry observed', () => {
  const r = classifyVisibility({ transcriptAvailable: true, autoMemEntry: null, fileExistsNow: true, currentContent: 'abc' });
  assert.equal(r.identity_status, 'DEGRADED');
});

test('classifyVisibility: DEGRADED when AutoMem entry content is empty (truncated to nothing)', () => {
  const r = classifyVisibility({ transcriptAvailable: true, autoMemEntry: { content: '' }, fileExistsNow: true, currentContent: '' });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.equal(r.injected_length, 0);
});

test('classifyVisibility: NOT-YET when no MEMORY.md exists and no entry observed', () => {
  const r = classifyVisibility({ transcriptAvailable: true, autoMemEntry: null, fileExistsNow: false, currentContent: null });
  assert.equal(r.identity_status, 'NOT-YET');
});

test('classifyVisibility: UNKNOWN when transcript unavailable — never a false negative', () => {
  const r = classifyVisibility({ transcriptAvailable: false, autoMemEntry: null, fileExistsNow: true, currentContent: 'abc' });
  assert.equal(r.identity_status, 'UNKNOWN');
});

// --- probe() integration against a temp filesystem + fixture transcript ---

function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'mvac-'));
  try { return fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

function writeMemory(home, cwd, body) {
  const mapped = cwd.replace(/\//g, '-');
  const dir = join(home, '.claude', 'projects', mapped, 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), body);
  return join(dir, 'MEMORY.md');
}

test('probe: PASS when transcript carries an AutoMem attachment matching the mapped MEMORY.md path', async () => {
  await withTempHome(async (home) => {
    const cwd = '/work/ProjA';
    const memPath = writeMemory(home, cwd, 'current body');
    const tpath = join(home, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({
      type: 'attachment',
      attachment: { type: 'instructions', files: [{ path: memPath, type: 'AutoMem', content: 'current body' }] },
    }));
    const row = await probe({ home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'PASS');
    assert.equal(row.capability_id, CAPABILITY_ID);
    assert.equal(row.schema_version, SCHEMA_VERSION);
    assert.equal(row.mutation_permitted, false);
    assert.equal(row.mutation_block_reason, 'read-only-context');
    for (const e of row.evidence) assert.ok(VALID_WEIGHTS.has(e.weight));
  });
});

test('probe: DEGRADED when MEMORY.md exists but transcript has no AutoMem entry', async () => {
  await withTempHome(async (home) => {
    const cwd = '/work/ProjB';
    writeMemory(home, cwd, 'body');
    const tpath = join(home, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
    const row = await probe({ home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'DEGRADED');
  });
});

test('probe: NOT-YET when no MEMORY.md exists for the mapped cwd', async () => {
  await withTempHome(async (home) => {
    const tpath = join(home, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
    const row = await probe({ home, cwd: '/work/NoMemoryHere', transcriptPath: tpath });
    assert.equal(row.identity_status, 'NOT-YET');
  });
});

test('probe: UNKNOWN when transcript is unavailable', async () => {
  await withTempHome(async (home) => {
    const cwd = '/work/ProjC';
    writeMemory(home, cwd, 'body');
    const row = await probe({ home, cwd, transcriptPath: join(home, 'nonexistent.jsonl') });
    assert.equal(row.identity_status, 'UNKNOWN');
  });
});

test('probe: UNKNOWN for a non-claude-code harness (no attachment-record mechanism known)', async () => {
  await withTempHome(async (home) => {
    const row = await probe({ home, cwd: '/work/ProjD', harness: 'codex' });
    assert.equal(row.identity_status, 'UNKNOWN');
    assert.equal(row.harness, 'codex');
  });
});

test('probe: row always carries the required schema fields', async () => {
  await withTempHome(async (home) => {
    const row = await probe({ home, cwd: '/work/Any', transcriptPath: join(home, 'nonexistent.jsonl') });
    for (const k of ['schema_version', 'capability_id', 'capability_kind', 'observed_at', 'identity_status', 'mutation_permitted', 'evidence']) {
      assert.ok(k in row, `row missing required field: ${k}`);
    }
    for (const e of row.evidence) assert.ok(VALID_WEIGHTS.has(e.weight));
  });
});
