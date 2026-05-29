import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeCanary, upsertCanaryLine, CANARY_TAG, canaryFilePath as writeSideFilePath,
} from '../../skills/core/scripts/write-visibility-canary.mjs';
import {
  probe, classify, scanTranscript, redactToken,
} from '../../skills/core/scripts/capability/memory-visible-probe.mjs';

function line(obj) { return JSON.stringify(obj); }
function txt(text) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); }
function tool(name, input) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: input || {} }] } }); }

const OK = { token: 't', memoryWritten: true, memoryHasToken: true, transcriptAvailable: true };

// --- write-canary (idempotent + redaction) ---

test('write-canary: idempotent — two writes leave exactly one canary line at the top', () => {
  let c = '# MEMORY index\n## Recent activity\n- a\n';
  c = upsertCanaryLine(c, 'tok-AAA');
  c = upsertCanaryLine(c, 'tok-BBB');
  const m = c.split('\n').filter((l) => l.includes(CANARY_TAG));
  assert.equal(m.length, 1);
  assert.ok(m[0].includes('tok-BBB'));
  assert.ok(c.startsWith('<!-- ' + CANARY_TAG));
  assert.ok(c.includes('## Recent activity'));
});

test('write-canary: records side-file with token + memory_written; return is redacted', () => {
  const home = mkdtempSync(join(tmpdir(), 'mv-'));
  try {
    const mem = join(home, 'MEMORY.md'); writeFileSync(mem, '# idx\n## Recent activity\n');
    const r = writeCanary({ workspaceId: 'ws', home, cwd: '/work/P', memoryPath: mem, now: '2026-05-29T10:00:00Z' });
    assert.ok(!('token' in r), 'return must not expose the raw token');
    const s = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8'));
    assert.ok(s.token.startsWith('vcan-'));
    assert.equal(s.memory_written, true);
    assert.equal(s.written_at, '2026-05-29T10:00:00Z');
    assert.ok(readFileSync(mem, 'utf8').includes(s.token), 'token landed in MEMORY.md');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- classify (HC_623-hardened) ---

test('classify PASS: injected + echoed + no non-allowlisted pre-echo tool', () => {
  const events = [{ idx: 1, kind: 'echo' }, { idx: 2, kind: 'tool', name: 'Bash' }];
  assert.equal(classify({ ...OK, events }).identity_status, 'PASS');
});

test('classify DEGRADED (blocker 1): echo but memory_written=false → not PASS', () => {
  const events = [{ idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, memoryWritten: false, events }).identity_status, 'DEGRADED');
});

test('classify DEGRADED (blocker 1): echo but token absent from memory file → not PASS', () => {
  const events = [{ idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, memoryHasToken: false, events }).identity_status, 'DEGRADED');
});

test('classify DEGRADED: transcript unavailable', () => {
  assert.equal(classify({ ...OK, transcriptAvailable: false, events: [] }).identity_status, 'DEGRADED');
});

test('classify DEGRADED: no echo', () => {
  assert.equal(classify({ ...OK, events: [{ idx: 0, kind: 'tool', name: 'Skill' }] }).identity_status, 'DEGRADED');
});

test('classify DEGRADED (blocker 2): non-allowlisted Bash before echo → DEGRADED', () => {
  const events = [{ idx: 0, kind: 'tool', name: 'Bash' }, { idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, events }).identity_status, 'DEGRADED');
});

test('classify PASS (blocker 2): allowlisted Skill before echo → still PASS', () => {
  const events = [{ idx: 0, kind: 'tool', name: 'Skill' }, { idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, events }).identity_status, 'PASS');
});

test('classify DEGRADED (blocker 2): pre-echo Read of unrelated path still degrades', () => {
  const events = [{ idx: 0, kind: 'tool', name: 'Read' }, { idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, events }).identity_status, 'DEGRADED');
});

test('classify NOT-YET: no canary token', () => {
  assert.equal(classify({ token: null, memoryWritten: false, memoryHasToken: false, transcriptAvailable: true, events: [] }).identity_status, 'NOT-YET');
});

// --- scan + redact ---

test('scanTranscript records the echo and every tool by name', () => {
  const ev = scanTranscript([tool('Skill', {}), txt('tok-x here'), tool('Bash', { command: 'ls' })], 'tok-x');
  assert.equal(ev.filter((e) => e.kind === 'echo').length, 1);
  assert.deepEqual(ev.filter((e) => e.kind === 'tool').map((e) => e.name), ['Skill', 'Bash']);
});

test('redactToken never emits the raw token', () => {
  const r = redactToken('supersecret-vcan-123');
  assert.ok(!r.includes('supersecret-vcan-123'));
  assert.match(r, /sha256:/);
});

// --- probe() integration ---

function withHome(fn) { const h = mkdtempSync(join(tmpdir(), 'mv-')); try { return fn(h); } finally { rmSync(h, { recursive: true, force: true }); } }

test('probe PASS end-to-end: canary in real MEMORY.md, echoed before any non-allowlisted tool', async () => {
  await withHome(async (home) => {
    const cwd = '/work/Proj';
    const mem = join(home, 'MEMORY.md'); writeFileSync(mem, '# idx\n## Recent activity\n');
    writeCanary({ workspaceId: 'ws', home, cwd, memoryPath: mem });
    const token = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8')).token;
    const tdir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-')); mkdirSync(tdir, { recursive: true });
    const tpath = join(tdir, 'sess.jsonl');
    writeFileSync(tpath, [tool('Skill', { name: 'core' }), txt(`canary I see: ${token}`), tool('Bash', { command: 'node capability-probe.mjs --startup' })].join('\n'));
    const row = await probe({ workspaceId: 'ws', home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'PASS');
    assert.ok(!JSON.stringify(row).includes(token), 'raw token must not leak into the row');
  });
});

test('probe DEGRADED (blocker 1): canary recorded but never written to MEMORY.md, even with echo', async () => {
  await withHome(async (home) => {
    const cwd = '/work/Proj';
    // memoryPath points at a non-existent file → memory_written=false
    writeCanary({ workspaceId: 'ws', home, cwd, memoryPath: join(home, 'nope', 'MEMORY.md') });
    const token = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8')).token;
    const tdir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-')); mkdirSync(tdir, { recursive: true });
    const tpath = join(tdir, 'sess.jsonl');
    writeFileSync(tpath, [txt(`canary: ${token}`)].join('\n'));
    const row = await probe({ workspaceId: 'ws', home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'DEGRADED', 'echo without injection must not be PASS');
  });
});

test('probe NOT-YET when no canary side-file', async () => {
  await withHome(async (home) => {
    const row = await probe({ workspaceId: 'none', home, cwd: '/work/Proj', transcriptPath: '/no/such' });
    assert.equal(row.identity_status, 'NOT-YET');
  });
});
