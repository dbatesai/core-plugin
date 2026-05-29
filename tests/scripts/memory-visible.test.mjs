import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'core', 'SKILL.md');
import {
  writeCanary, upsertCanaryLine, CANARY_TAG, canaryFilePath as writeSideFilePath,
} from '../../skills/core/scripts/write-visibility-canary.mjs';
import {
  probe, classify, scanTranscript, redactToken, countLines,
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
  // Visible markdown line, not an HTML comment — HTML comments are stripped from
  // injected MEMORY.md (field-proven 2026-05-29), which blocked the field-cycle PASS.
  assert.ok(c.startsWith(CANARY_TAG), 'canary is a visible line at the top');
  assert.ok(!c.startsWith('<!--'), 'canary must not be an HTML comment');
  assert.ok(c.includes('## Recent activity'));
});

test('write-canary: upgrades a legacy HTML-comment canary in place (no accumulation)', () => {
  // A file still carrying the old `<!-- ... -->` form must end up with exactly one
  // visible canary line after the next write — the clean migration path.
  let c = '<!-- ' + CANARY_TAG + ' tok-OLD (legacy) -->\n## Recent activity\n- a\n';
  c = upsertCanaryLine(c, 'tok-NEW');
  const m = c.split('\n').filter((l) => l.includes(CANARY_TAG));
  assert.equal(m.length, 1, 'legacy line replaced, not appended');
  assert.ok(m[0].includes('tok-NEW'));
  assert.ok(!c.includes('tok-OLD'));
  assert.ok(!c.includes('<!--'), 'legacy HTML comment fully removed');
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

test('classify DEGRADED (blocker 1b): line-count exceeds injection window → truncation-detected, never PASS', () => {
  const events = [{ idx: 1, kind: 'echo' }, { idx: 2, kind: 'tool', name: 'Bash' }];
  const r = classify({ ...OK, events, memoryLineCount: 250, injectionLineWindow: 200 });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.match(r.reason, /truncation-detected/);
});

test('classify PASS: line-count within injection window does not false-degrade', () => {
  const events = [{ idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, events, memoryLineCount: 150, injectionLineWindow: 200 }).identity_status, 'PASS');
});

test('classify DEGRADED: transcript unavailable', () => {
  assert.equal(classify({ ...OK, transcriptAvailable: false, events: [] }).identity_status, 'DEGRADED');
});

// --- countLines trailing-newline boundary (HC blocker #3) ---

test('countLines: N real lines + trailing newline counts as N, not N+1', () => {
  const content = Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
  assert.equal(countLines(content), 200);
});

test('countLines: no-trailing-newline and empty cases', () => {
  assert.equal(countLines('a\nb\nc'), 3);
  assert.equal(countLines(''), 0);
  assert.equal(countLines('only'), 1);
});

test('blocker #3: exactly window-size memory (200 lines + \\n) does NOT trip truncation at a 200-window', () => {
  const content = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n') + '\n';
  const r = classify({ ...OK, events: [{ idx: 1, kind: 'echo' }], memoryLineCount: countLines(content), injectionLineWindow: 200 });
  assert.equal(r.identity_status, 'PASS', '200 real lines at a 200-line window is complete, not truncated');
});

test('blocker #3: 201 real lines DOES trip truncation at a 200-window', () => {
  const content = Array.from({ length: 201 }, (_, i) => `l${i}`).join('\n') + '\n';
  const r = classify({ ...OK, events: [{ idx: 1, kind: 'echo' }], memoryLineCount: countLines(content), injectionLineWindow: 200 });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.match(r.reason, /truncation-detected/);
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

// --- startup echo-ordering wire-in (HC_627): the doc represents the order, and the
//     documented order satisfies the verifier ---

test('SKILL.md documents the canary echo-first startup order (HC_627)', () => {
  const md = readFileSync(SKILL_MD, 'utf8');
  assert.match(md, /CORE-VISIBILITY-CANARY/, 'names the canary tag');
  assert.match(md, /VISIBILITY-CANARY-ECHO/, 'names the echo line format');
  assert.match(md, /first output this session/i, 'echo is the first output');
  assert.match(md, /before .*(read|capability probe|Bash)/i, 'echo precedes any reading tool');
  assert.match(md, /Skill tool is allowlisted/i, 'names the Skill allowlist exception');
  // the section is placed before the "Read protocols/startup.md" startup step
  assert.ok(md.indexOf('VISIBILITY-CANARY-ECHO') < md.indexOf('Before the task — startup'), 'echo instruction precedes the startup-protocol read step');
});

test('probe PASS for the documented startup order: Skill → echo → Read startup.md → Bash probe', async () => {
  await withHome(async (home) => {
    const cwd = '/work/Proj';
    const mem = join(home, 'MEMORY.md'); writeFileSync(mem, '# idx\n## Recent activity\n');
    writeCanary({ workspaceId: 'ws', home, cwd, memoryPath: mem });
    const token = JSON.parse(readFileSync(writeSideFilePath('ws', home), 'utf8')).token;
    const tdir = join(home, '.claude', 'projects', cwd.replace(/\//g, '-')); mkdirSync(tdir, { recursive: true });
    const tpath = join(tdir, 'sess.jsonl');
    // exactly the documented order: allowlisted Skill load, then the echo, then reads.
    writeFileSync(tpath, [
      tool('Skill', { skill: 'core' }),
      txt(`VISIBILITY-CANARY-ECHO: ${token}`),
      tool('Read', { file_path: '/somewhere/protocols/startup.md' }),
      tool('Bash', { command: 'node capability-probe.mjs --startup' }),
    ].join('\n'));
    const row = await probe({ workspaceId: 'ws', home, cwd, transcriptPath: tpath });
    assert.equal(row.identity_status, 'PASS', 'the documented Skill→echo→Read→Bash order verifies as PASS');
  });
});
