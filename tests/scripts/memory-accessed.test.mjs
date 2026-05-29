import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAccess, probe } from '../../skills/core/scripts/capability/memory-accessed-probe.mjs';

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

test('probe: Codex harness → UNKNOWN (tool extraction pending, honest)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ma-'));
  try {
    const tpath = join(dir, 'rollout.jsonl');
    writeFileSync(tpath, JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } }));
    const row = await probe({ harness: 'codex', cwd: dir, transcriptPath: tpath, coreStorePresent: true });
    assert.equal(row.identity_status, 'UNKNOWN');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
