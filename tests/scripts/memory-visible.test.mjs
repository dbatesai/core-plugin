import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeCanary, upsertCanaryLine, CANARY_TAG, canaryFilePath as writeSideFilePath,
} from '../../skills/core/scripts/write-visibility-canary.mjs';
import {
  probe, classify, scanTranscript, redactToken, protectedPaths,
} from '../../skills/core/scripts/capability/memory-visible-probe.mjs';

const SIDE = '/home/.core/workspaces/ws/visibility-canary.json';
function line(obj) { return JSON.stringify(obj); }
function assistantText(text) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); }
function assistantTool(name, input) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] } }); }

// --- write-canary (HC_622 #1 idempotent, #4 redaction) ---

test('write-canary: idempotent — two writes leave exactly one canary line at the top', () => {
  let content = '# MEMORY index\n## Recent activity\n- a\n';
  content = upsertCanaryLine(content, 'tok-AAA');
  content = upsertCanaryLine(content, 'tok-BBB');
  const matches = content.split('\n').filter(l => l.includes(CANARY_TAG));
  assert.equal(matches.length, 1, 'exactly one canary line — not accumulated');
  assert.ok(matches[0].includes('tok-BBB'), 'latest token wins');
  assert.ok(content.startsWith('<!-- ' + CANARY_TAG), 'canary is the first line (in injection window)');
  assert.ok(content.includes('## Recent activity'), 'original content preserved');
});

test('write-canary: records side-file with token + written_at; return is redacted', () => {
  const home = mkdtempSync(join(tmpdir(), 'mv-'));
  try {
    const r = writeCanary({ workspaceId: 'ws', home, cwd: '/work/Proj', now: '2026-05-29T10:00:00Z' });
    assert.equal(r.token_len > 0, true);
    assert.ok(!('token' in r), 'return must NOT expose the raw token (HC_622 #4)');
    const side = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8'));
    assert.ok(side.token && side.token.startsWith('vcan-'));
    assert.equal(side.written_at, '2026-05-29T10:00:00Z');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- classify (pure, HC-accepted bar) ---

test('classify: PASS when echo precedes any protected-path read', () => {
  const events = [{ idx: 1, kind: 'echo' }, { idx: 3, kind: 'read' }];
  assert.equal(classify({ token: 't', transcriptAvailable: true, events }).identity_status, 'PASS');
});
test('classify: DEGRADED when a protected-path read precedes the echo (read-first cheat not excludable)', () => {
  const events = [{ idx: 1, kind: 'read' }, { idx: 2, kind: 'echo' }];
  assert.equal(classify({ token: 't', transcriptAvailable: true, events }).identity_status, 'DEGRADED');
});
test('classify: DEGRADED when transcript unavailable', () => {
  assert.equal(classify({ token: 't', transcriptAvailable: false, events: [] }).identity_status, 'DEGRADED');
});
test('classify: DEGRADED when token never echoed (truncation / mismatch / recognition-failure)', () => {
  assert.equal(classify({ token: 't', transcriptAvailable: true, events: [{ idx: 2, kind: 'read' }] }).identity_status, 'DEGRADED');
});
test('classify: NOT-YET when no canary recorded', () => {
  assert.equal(classify({ token: null, transcriptAvailable: true, events: [] }).identity_status, 'NOT-YET');
});

// --- scanTranscript (HC_622 #3 conservative read matching) ---

test('scanTranscript: Read of side-file and Bash cat of side-file both count as reads', () => {
  const prot = [SIDE, 'visibility-canary'];
  const lines = [
    assistantTool('Read', { file_path: SIDE }),
    assistantText('the token is vcan-xyz'),
    assistantTool('Bash', { command: `cat ${SIDE}` }),
  ];
  const events = scanTranscript(lines, 'vcan-xyz', prot);
  assert.equal(events.filter(e => e.kind === 'read').length, 2, 'Read + Bash-cat both counted');
  assert.equal(events.filter(e => e.kind === 'echo').length, 1);
});

test('scanTranscript: ambiguous Bash referencing the protected path counts as a read (conservative)', () => {
  const events = scanTranscript([assistantTool('Bash', { command: `node something ${SIDE}` })], 'tok', [SIDE]);
  assert.equal(events.filter(e => e.kind === 'read').length, 1, 'ambiguous-but-references-path → read (downgrades, never upgrades)');
});

test('redactToken never emits the raw token (HC_622 #4)', () => {
  const r = redactToken('supersecret-vcan-123');
  assert.ok(!r.includes('supersecret-vcan-123'));
  assert.match(r, /sha256:/);
});

// --- probe() integration (isolated home + transcript file) ---

function withHome(fn) { const h = mkdtempSync(join(tmpdir(), 'mv-')); try { return fn(h); } finally { rmSync(h, { recursive: true, force: true }); } }

test('probe: PASS end-to-end — canary recorded, echo precedes any read, token never leaked in evidence', async () => {
  await withHome(async (home) => {
    const cwd = '/work/Proj';
    const r = writeCanary({ workspaceId: 'ws', home, cwd, memoryPath: join(home, 'MEMORY.md') });
    const token = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8')).token;
    const tdir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-'));
    mkdirSync(tdir, { recursive: true });
    const tpath = join(tdir, 'sess.jsonl');
    writeFileSync(tpath, [
      assistantText(`Visibility canary I see in context: ${token}`),
      assistantTool('Bash', { command: 'node capability-probe.mjs --startup' }),
      assistantTool('Read', { file_path: writeSideFilePath('ws', home) }),
    ].join('\n'));
    const row = await probe({ workspaceId: 'ws', home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'PASS');
    assert.equal(row.capability_kind, 'observation');
    assert.equal(row.mutation_permitted, false);
    // token must never appear raw in the row (HC_622 #4)
    assert.ok(!JSON.stringify(row).includes(token), 'raw token must not leak into the row');
  });
});

test('probe: NOT-YET when no canary side-file recorded', async () => {
  await withHome(async (home) => {
    const row = await probe({ workspaceId: 'ws-none', home, cwd: '/work/Proj', transcriptPath: '/does/not/exist' });
    assert.equal(row.identity_status, 'NOT-YET');
  });
});
