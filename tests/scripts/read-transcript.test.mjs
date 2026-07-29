import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeCode, parseCodex, parseTranscript, resolveTranscriptPath, resolveTranscript, readTranscript, SUPPORTED_HARNESSES,
} from '../../plugins/core/skills/core/scripts/read-transcript.mjs';

// --- Claude Code parser (verified schema: message.content[]) ---

test('parseClaudeCode: text + tool_use events in order', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'echo TOKEN-A' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
  ];
  const ev = parseClaudeCode(lines);
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0].kind, ev[1].kind], ['text', 'tool']);
  assert.equal(ev[1].name, 'Bash');
  assert.ok(ev[0].text.includes('TOKEN-A'));
});

test('parseClaudeCode: malformed lines skipped, blanks ignored', () => {
  const ev = parseClaudeCode(['not json', '', JSON.stringify({ message: { content: [{ type: 'text', text: 'ok' }] } })]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].text, 'ok');
});

// --- Codex parser (verified schema: {type, payload}; response_item:message) ---

test('parseCodex: response_item message text surfaced with role; reasoning skipped', () => {
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'x' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'zzz' } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'text');
  assert.equal(ev[0].role, 'assistant');
  assert.equal(ev[0].text, 'hi there');
});

test('parseCodex: event_msg agent/user messages surfaced', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'done' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {} } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 2);
  assert.equal(ev[0].role, 'assistant');
  assert.equal(ev[1].role, 'user');
});

// --- Codex tool/shell extraction (schema from a real rollout-*.jsonl) ---
// Verified shapes: function_call {name, arguments(JSON string), call_id};
// custom_tool_call {name, input(string), call_id}. The arguments/input carry the shell
// command / patch path, which is what CORE_SURFACE_RE matches for memory-accessed.
test('parseCodex: function_call surfaced as a tool event with name + arguments text', () => {
  const lines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'rtk grep IGM _memories/', workdir: '/p' }), call_id: 'c1' } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].name, 'exec_command');
  assert.ok(ev[0].text.includes('_memories/'), 'arguments text carries the path/command for access detection');
});

test('parseCodex: custom_tool_call surfaced as a tool event with name + input text', () => {
  const lines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Add File: /p/_memories/note.md\n+x', call_id: 'c2' } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'tool');
  assert.equal(ev[0].name, 'apply_patch');
  assert.ok(ev[0].text.includes('_memories/'));
});

test('parseCodex: message text + tool calls coexist in order; outputs/reasoning skipped', () => {
  const lines = [
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'about IGM?' }] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"grep IGM _memories/"}', call_id: 'c3' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: 'noise' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'zzz' } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 2, 'one text + one tool; output + reasoning skipped');
  assert.equal(ev[0].kind, 'text');
  assert.equal(ev[1].kind, 'tool');
});

// --- dispatch + path resolution + fail-open ---

test('parseTranscript dispatches by harness; unknown → []', () => {
  assert.equal(parseTranscript('{}', 'nope').length, 0);
  assert.equal(parseTranscript('bogus', 'nope').length, 0);
});

test('resolveTranscriptPath: unsupported harness returns null (no guess)', () => {
  assert.equal(resolveTranscriptPath('nope', { home: '/tmp/nope' }), null);
});

test('resolveTranscriptPath: claude-code picks latest .jsonl by mtime', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-'));
  try {
    const cwd = '/work/Proj';
    const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.jsonl'), 'x');
    const newer = join(dir, 'new.jsonl');
    writeFileSync(newer, 'y');
    const r = resolveTranscriptPath('claude-code', { cwd, home });
    assert.equal(r, newer);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('resolveTranscriptPath: dotted username maps dots→dashes to match Claude projects folder', () => {
  // A corporate dotted username: Claude Code's ~/.claude/projects/<slug> encodes
  // dots AND slashes to dashes. A slash-only replace leaves the dot and looks in
  // the wrong dir → transcript not found → classifier silently UNAVAILABLE.
  const home = mkdtempSync(join(tmpdir(), 'rt-dot-'));
  try {
    const cwd = '/Users/David.Bates28/proj';
    const correctSlug = '-Users-David-Bates28-proj'; // canonical: dots → dashes too
    const dir = join(home, '.claude', 'projects', correctSlug);
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'session.jsonl');
    writeFileSync(f, '{}\n');
    assert.equal(resolveTranscriptPath('claude-code', { cwd, home }), f,
      'resolves the transcript via the dot-encoded canonical slug');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('readTranscript: fail-open on missing transcript (available:false, no throw)', () => {
  const r = readTranscript({ harness: 'claude-code', cwd: '/no/such', home: '/tmp/none' });
  assert.equal(r.available, false);
  assert.deepEqual(r.events, []);
});

test('readTranscript: codex meta reports tool extraction implemented', () => {
  const r = readTranscript({ harness: 'codex', home: '/tmp/none' });
  assert.equal(r.meta.codex_tool_extraction, 'implemented');
});

test('readTranscript: unsupported harness → unsupported meta, not available', () => {
  const r = readTranscript({ harness: 'nope' });
  assert.equal(r.meta.supported, false);
  assert.equal(r.available, false);
});

test('SUPPORTED_HARNESSES covers the two target harnesses', () => {
  ['claude-code', 'codex'].forEach((h) => assert.ok(SUPPORTED_HARNESSES.has(h)));
});

// --- session-id-exact resolution; mtime is a documented fallback ---

test('explicit sessionId resolves the exact transcript even when another file is newer', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-sid-'));
  try {
    const cwd = '/work/Proj';
    const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const mine = join(dir, 'sess-aaa.jsonl');
    writeFileSync(mine, '{}\n');
    const newer = join(dir, 'sess-bbb.jsonl'); // a NEW session started before the analyzers ran
    writeFileSync(newer, '{}\n');
    const r = resolveTranscript('claude-code', { cwd, home, sessionId: 'sess-aaa', env: {} });
    assert.equal(r.path, mine, 'exact session-id match must beat mtime');
    assert.equal(r.resolution, 'session-id');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('CLAUDE_CODE_SESSION_ID env is used when no explicit sessionId is passed', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-env-'));
  try {
    const cwd = '/work/Proj';
    const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const mine = join(dir, 'sess-env.jsonl');
    writeFileSync(mine, '{}\n');
    writeFileSync(join(dir, 'sess-other.jsonl'), '{}\n');
    const r = resolveTranscript('claude-code', { cwd, home, env: { CLAUDE_CODE_SESSION_ID: 'sess-env' } });
    assert.equal(r.path, mine);
    assert.equal(r.resolution, 'session-id');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('no file matches the session id → documented mtime fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-fb-'));
  try {
    const cwd = '/work/Proj';
    const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    const only = join(dir, 'sess-zzz.jsonl');
    writeFileSync(only, '{}\n');
    const r = resolveTranscript('claude-code', { cwd, home, sessionId: 'sess-gone', env: {} });
    assert.equal(r.path, only, 'falls back rather than failing');
    assert.equal(r.resolution, 'mtime-fallback', 'fallback is labeled, never silent');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('readTranscript stamps meta.transcript_resolution', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-meta-'));
  try {
    const cwd = '/work/Proj';
    const dir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'sess-m.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const r = readTranscript({ harness: 'claude-code', cwd, home, sessionId: 'sess-m', env: {} });
    assert.equal(r.available, true);
    assert.equal(r.meta.transcript_resolution, 'session-id');
    const fb = readTranscript({ harness: 'claude-code', cwd, home, sessionId: 'nope', env: {} });
    assert.equal(fb.meta.transcript_resolution, 'mtime-fallback');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('low: parseCodex extracts text from a structured-content (array) event_msg body, not just strings', () => {
  // A string message still works; an array-of-blocks body was previously dropped.
  const lines = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'plain string' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] } }),
  ];
  const ev = parseCodex(lines);
  assert.equal(ev.length, 2, 'both turns surfaced — the array body is no longer dropped');
  assert.equal(ev[0].text, 'plain string');
  assert.equal(ev[1].text, 'block one\nblock two');
  assert.equal(ev[1].role, 'assistant');
});

// --- Project binding: a transcript belongs to a project, never to "whatever is newest" ---

function codexRollout(dir, name, { id, cwd, mtime }) {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  const head = cwd === undefined
    ? JSON.stringify({ timestamp: '2026-07-28T00:00:00.000Z', type: 'event_msg', payload: { type: 'task_started' } })
    : JSON.stringify({ timestamp: '2026-07-28T00:00:00.000Z', type: 'session_meta', payload: { id, cwd } });
  const body = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: id } });
  writeFileSync(p, `${head}\n${body}\n`);
  if (mtime) utimesSync(p, mtime, mtime);
  return p;
}

test('codex transcript selection is bound to the requesting project, not global mtime', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-bind-'));
  try {
    const projA = join(home, 'work', 'proj-a');
    const projB = join(home, 'work', 'proj-b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    const sess = join(home, '.codex', 'sessions', '2026', '07', '28');
    const mine = codexRollout(sess, 'rollout-a.jsonl', { id: 'sess-a', cwd: projA, mtime: 1000 });
    codexRollout(sess, 'rollout-b.jsonl', { id: 'sess-b', cwd: projB, mtime: 9000 }); // newer, other project
    const r = resolveTranscript('codex', { cwd: projA, home, env: {} });
    assert.equal(r.path, mine, "project A must never be handed project B's newer transcript");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('codex: only another project has a transcript → UNKNOWN with a reason, never a wrong-project file', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-bind-none-'));
  try {
    const projA = join(home, 'work', 'proj-a');
    const projB = join(home, 'work', 'proj-b');
    mkdirSync(projA, { recursive: true });
    mkdirSync(projB, { recursive: true });
    codexRollout(join(home, '.codex', 'sessions', '2026', '07', '28'), 'rollout-b.jsonl', { id: 'sess-b', cwd: projB });
    const r = resolveTranscript('codex', { cwd: projA, home, env: {} });
    assert.equal(r.path, null);
    assert.equal(r.reason, 'no-project-transcript');
    const t = readTranscript({ harness: 'codex', cwd: projA, home, env: {} });
    assert.equal(t.available, false);
    assert.equal(t.reason, 'no-project-transcript');
    assert.deepEqual(t.events, []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('codex: a transcript with no establishable identity is UNKNOWN, not the answer', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-bind-anon-'));
  try {
    const projA = join(home, 'work', 'proj-a');
    mkdirSync(projA, { recursive: true });
    codexRollout(join(home, '.codex', 'sessions', '2026', '07', '28'), 'rollout-anon.jsonl', { id: 'sess-x', cwd: undefined });
    const r = resolveTranscript('codex', { cwd: projA, home, env: {} });
    assert.equal(r.path, null);
    assert.equal(r.resolution, null);
    assert.equal(r.reason, 'no-project-transcript');
    assert.equal(readTranscript({ harness: 'codex', cwd: projA, home, env: {} }).available, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('codex: thread id selects the exact rollout within the project', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-bind-sid-'));
  try {
    const projA = join(home, 'work', 'proj-a');
    mkdirSync(projA, { recursive: true });
    const sess = join(home, '.codex', 'sessions', '2026', '07', '28');
    const mine = codexRollout(sess, 'rollout-1.jsonl', { id: 'sess-mine', cwd: projA, mtime: 1000 });
    codexRollout(sess, 'rollout-2.jsonl', { id: 'sess-newer', cwd: projA, mtime: 9000 });
    const r = resolveTranscript('codex', { cwd: projA, home, sessionId: 'sess-mine', env: {} });
    assert.equal(r.path, mine, 'exact thread id must beat mtime');
    assert.equal(r.resolution, 'session-id');
    const viaEnv = resolveTranscript('codex', { cwd: projA, home, env: { CODEX_THREAD_ID: 'sess-mine' } });
    assert.equal(viaEnv.path, mine);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('claude-code: another project\'s transcript is never returned for this project', () => {
  const home = mkdtempSync(join(tmpdir(), 'rt-bind-cc-'));
  try {
    const dirB = join(home, '.claude', 'projects', '-work-proj-b');
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirB, 'sess-b.jsonl'), '{}\n');
    const r = resolveTranscript('claude-code', { cwd: '/work/proj-a', home, env: {} });
    assert.equal(r.path, null);
    assert.equal(r.reason, 'no-project-transcript');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
