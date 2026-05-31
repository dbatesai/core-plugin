import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClaudeCode, parseCodex, parseTranscript, resolveTranscriptPath, readTranscript, SUPPORTED_HARNESSES,
} from '../../skills/core/scripts/read-transcript.mjs';

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

// --- Codex tool/shell extraction (Slice F — schema from a real rollout-*.jsonl) ---
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

test('readTranscript: fail-open on missing transcript (available:false, no throw)', () => {
  const r = readTranscript({ harness: 'claude-code', cwd: '/no/such', home: '/tmp/none' });
  assert.equal(r.available, false);
  assert.deepEqual(r.events, []);
});

test('readTranscript: codex meta reports tool extraction implemented (Slice F)', () => {
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
