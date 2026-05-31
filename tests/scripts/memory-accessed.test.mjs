import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAccess, probe } from '../../plugins/core/skills/core/scripts/capability/memory-accessed-probe.mjs';
import { runStartup } from '../../plugins/core/skills/core/scripts/capability-probe.mjs';

const toolEv = (text) => ({ idx: 0, kind: 'tool', name: 'Bash', text });

// --- classifier (pure) ---

test('classifyAccess PASS: a CORE-surface access is observed', () => {
  const events = [toolEv('grep -r foo _memories/'), toolEv('cat MEMORY.md')];
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events, coreStorePresent: true });
  assert.equal(r.identity_status, 'PASS');
  assert.equal(r.core, 1);
});

test('classifyAccess DEGRADED: native-only access = store-selection failure', () => {
  const events = [toolEv('cat ~/.codex/memories/MEMORY.md')];
  const r = classifyAccess({ harness: 'codex', transcriptAvailable: true, toolExtractionPending: false, events, coreStorePresent: true });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.match(r.reason, /store-selection/);
});

test('classifyAccess DEGRADED: no memory access of either kind observed', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('ls /tmp')], coreStorePresent: true });
  assert.equal(r.identity_status, 'DEGRADED');
});

test('classifyAccess NOT-YET: no CORE store present', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [], coreStorePresent: false });
  assert.equal(r.identity_status, 'NOT-YET');
});

test('classifyAccess UNKNOWN: transcript unavailable (no false "not accessed")', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: false, toolExtractionPending: false, events: [], coreStorePresent: true });
  assert.equal(r.identity_status, 'UNKNOWN');
});

test('classifyAccess UNKNOWN: Codex tool extraction pending — refuses false negative', () => {
  // Codex events have no tool kind yet (read-transcript residual); must not say "not accessed".
  const r = classifyAccess({ harness: 'codex', transcriptAvailable: true, toolExtractionPending: true, events: [], coreStorePresent: true });
  assert.equal(r.identity_status, 'UNKNOWN');
  assert.match(r.reason, /pending/);
});

test('classifyAccess PASS: PROJECT.md read counts as CORE access', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('Read PROJECT.md')], coreStorePresent: true });
  assert.equal(r.identity_status, 'PASS');
});

// --- probe() integration via read-transcript on a CC fixture ---

test('probe: CC transcript showing _memories grep → PASS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'session.jsonl');
    writeFileSync(tpath, [
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'looking' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x', path: '_memories/' } }] } }),
    ].join('\n'));
    const row = await probe({ harness: 'claude-code', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.equal(row.identity_status, 'PASS');
    assert.equal(row.capability_id, 'memory-accessed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe: Codex harness now CLASSIFIES via tool extraction (Slice F) — PASS on _memories/ access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'rollout.jsonl');
    // A real-shape Codex function_call whose arguments reach the CORE store.
    writeFileSync(tpath, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'grep IGM _memories/' }), call_id: 'c1' } }));
    const row = await probe({ harness: 'codex', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.equal(row.identity_status, 'PASS', 'Codex tool extraction now observes CORE-store reach');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe: Codex harness → DEGRADED when extraction works but no CORE access seen (honest, not UNKNOWN)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'rollout.jsonl');
    writeFileSync(tpath, JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls /tmp' }), call_id: 'c1' } }));
    const row = await probe({ harness: 'codex', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.equal(row.identity_status, 'DEGRADED', 'store present, tools observed, none reached CORE → store-selection signal');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- HC blocker #2 (evt-202605291319): path false-positives must not count as access ---

test('classifyAccess: PROJECT.md.bak does NOT count as a CORE access (extension look-alike)', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('cat PROJECT.md.bak')], coreStorePresent: true });
  assert.equal(r.core, 0, '.bak extension must not match PROJECT.md');
  assert.equal(r.identity_status, 'DEGRADED');  // no real access observed
});

test('classifyAccess: my_memories/ does NOT count (word-internal look-alike)', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('ls my_memories/')], coreStorePresent: true });
  assert.equal(r.core, 0, 'preceding-char boundary rejects word-internal _memories');
});

test('classifyAccess: _memories-old/ and _memories_archive/ do NOT count', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('ls _memories-old/x'), toolEv('cat _memories_archive/y.md')], coreStorePresent: true });
  assert.equal(r.core, 0, 'no slash immediately after _memories → archive/old variants excluded');
});

test('classifyAccess: MEMORY.md.bak does NOT count as native (extension look-alike)', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('cat MEMORY.md.bak')], coreStorePresent: true });
  assert.equal(r.native, 0, '.bak extension must not match MEMORY.md');
});

test('classifyAccess: a real absolute _memories/ path still PASSes after tightening', () => {
  const r = classifyAccess({ harness: 'claude-code', transcriptAvailable: true, toolExtractionPending: false, events: [toolEv('grep x /Users/d/proj/_memories/foo.md')], coreStorePresent: true });
  assert.equal(r.identity_status, 'PASS');
  assert.equal(r.core, 1, 'preceding-slash boundary still admits real path embeds');
});

// --- HC blocker #4: producer-contract row fields (env_signals + workspace_id) ---

test('probe row carries env_signals with the full standard key set (HC blocker #4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Grep', input: { path: '_memories/' } }] } }));
    const row = await probe({ harness: 'claude-code', cwd: dir, transcriptPath: tpath, coreStorePresent: true, env: { CLAUDE_PLUGIN_ROOT: '/x' } });
    assert.ok(row.env_signals && typeof row.env_signals === 'object', 'env_signals present');
    assert.equal(row.env_signals.CLAUDE_PLUGIN_ROOT, '/x', 'captures provided env value');
    assert.ok('CODEX_THREAD_ID' in row.env_signals, 'full standard key set even when unset');
    assert.equal(row.env_signals.CODEX_THREAD_ID, null, 'unset key is null, not absent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe reads workspace_id from <cwd>/workspace.json (HC blocker #4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    writeFileSync(join(dir, 'workspace.json'), JSON.stringify({ workspace_id: 'core-framework' }));
    const tpath = join(dir, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }));
    const row = await probe({ harness: 'claude-code', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.equal(row.workspace_id, 'core-framework');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('probe row has workspace_id key even when no workspace.json present (null, not missing)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'session.jsonl');
    writeFileSync(tpath, JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }));
    const row = await probe({ harness: 'claude-code', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.ok('workspace_id' in row, 'workspace_id key always present');
    assert.equal(row.workspace_id, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- HC blocker #1: runStartup must wire memory-accessed AND thread the resolved harness ---

test('runStartup wires memory-accessed (no longer orphan) + labels it claude-code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    writeFileSync(join(dir, 'PROJECT.md'), '# proj');  // core store present
    const res = await runStartup({ harness: 'claude-code', cwd: dir });
    const row = res.rows.find((r) => r.capability_id === 'memory-accessed');
    assert.ok(row, 'descriptor walk invokes memory-accessed — it is wired, not an orphan script');
    assert.equal(row.harness, 'claude-code', 'row carries the resolved harness');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runStartup({harness:codex}) labels memory-accessed codex + honest UNKNOWN (blocker #1 + #6)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    writeFileSync(join(dir, 'PROJECT.md'), '# proj');
    // transcript unavailable (nonexistent path) → UNKNOWN; the load-bearing assertion is
    // that the row is labeled codex, not the claude-code default (the bug). (Post Slice F,
    // UNKNOWN here is the transcript-unavailable case, not the old extraction-pending one.)
    const res = await runStartup({ harness: 'codex', cwd: dir, transcriptPath: '/nonexistent-rollout.jsonl' });
    const row = res.rows.find((r) => r.capability_id === 'memory-accessed');
    assert.ok(row, 'memory-accessed declared for codex (not omitted — honest row)');
    assert.equal(row.harness, 'codex', 'codex session labeled codex, proving harness threads through probeOpts');
    assert.equal(row.identity_status, 'UNKNOWN', 'pending Codex tool extraction → honest UNKNOWN, never false not-accessed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
