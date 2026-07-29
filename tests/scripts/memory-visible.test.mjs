import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_MD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'SKILL.md');
import {
  writeCanary, upsertCanaryLine, CANARY_TAG, canaryFilePath as writeSideFilePath,
} from '../../plugins/core/skills/core/scripts/write-visibility-canary.mjs';
import {
  probe, classify, scanTranscript, redactToken, countLines, resolveTranscript,
} from '../../plugins/core/skills/core/scripts/capability/memory-visible-probe.mjs';

function line(obj) { return JSON.stringify(obj); }
function txt(text) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }); }
function tool(name, input) { return line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name, input: input || {} }] } }); }

const OK = { token: 't', memoryWritten: true, memoryHasToken: true, transcriptAvailable: true };

// --- resolveTranscript path mapping (Meridian's live Windows-box repro, 2026-07-20) ---
// Was a hand-rolled `.replace(/\//g, '-')` -- missed the Windows drive colon entirely
// and any dot, producing a mapped path that never matched the real Claude Code
// projects folder, on top of a real cwd. Must use the canonical mapProjectPathToSlug.

test('resolveTranscript: an explicit override always wins, existence-checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'mvp-transcript-'));
  try {
    assert.equal(resolveTranscript('/any/cwd', root, join(root, 'nope.jsonl')), null, 'a missing override resolves to null');
    const real = join(root, 'real.jsonl');
    writeFileSync(real, '');
    assert.equal(resolveTranscript('/any/cwd', root, real), real);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveTranscript: finds the transcript dir for a Windows drive-colon cwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'mvp-transcript-'));
  try {
    const cwd = 'C:\\Users\\david\\Documents\\Projects\\core-windows';
    // mapProjectPathToSlug replaces every /, \, ., and : -- the colon right after the
    // drive letter and the following backslash both become '-', hence the double dash.
    const slugDir = join(root, '.claude', 'projects', 'C--Users-david-Documents-Projects-core-windows');
    mkdirSync(slugDir, { recursive: true });
    const jsonl = join(slugDir, 'session.jsonl');
    writeFileSync(jsonl, '');
    assert.equal(resolveTranscript(cwd, root, null), jsonl,
      'must resolve to the slug the real Claude Code projects folder actually uses, colon and all');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveTranscript: returns null when no matching projects dir exists (not a thrown error)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mvp-transcript-'));
  try {
    assert.equal(resolveTranscript('/nowhere/near/anything', root, null), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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

test('M16: prose that mentions the canary tag survives a canary write (only the managed line is replaced)', () => {
  // A documentation line that explains the mechanism contains the tag literal but is NOT
  // the managed canary line. The old bare-tag strip deleted it; the anchored regex must not.
  const prose = 'The `' + CANARY_TAG + '` mechanism proves injected memory is in-context.';
  let c = CANARY_TAG + ' tok-OLD — at next startup, echo this token first as `VISIBILITY-CANARY-ECHO: tok-OLD` to prove memory is in-context.\n\n## Notes\n' + prose + '\n';
  c = upsertCanaryLine(c, 'tok-NEW');
  const managed = c.split('\n').filter((l) => /VISIBILITY-CANARY-ECHO/.test(l) && l.startsWith(CANARY_TAG));
  assert.equal(managed.length, 1, 'exactly one managed canary line');
  assert.ok(managed[0].includes('tok-NEW') && !managed[0].includes('tok-OLD'), 'managed line replaced');
  assert.ok(c.includes(prose), 'documentation prose mentioning the tag must survive');
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

// --- Slice A: byte-window truncation (the live class line-count alone misses) ---
// Field evidence (session 56, 2026-05-30): MEMORY.md was 196 lines / 25,684 bytes —
// UNDER the 200-line window but OVER the ~24,400-byte injection cap. The tail dropped
// silently ("only part of it was loaded") while a line-only probe would falsely PASS.
// Defense-in-depth (Hale's call): keep the line window AND add the byte window.
test('classify DEGRADED (byte cap): byte-count over window with line-count UNDER window → truncation-detected', () => {
  const events = [{ idx: 1, kind: 'echo' }, { idx: 2, kind: 'tool', name: 'Bash' }];
  const r = classify({ ...OK, events, memoryLineCount: 196, injectionLineWindow: 200, memoryByteCount: 25684, injectionByteWindow: 24400 });
  assert.equal(r.identity_status, 'DEGRADED', '196 lines / 25.7KB is byte-truncated even though under the line window');
  assert.match(r.reason, /truncation-detected/);
});

test('classify PASS: under BOTH line and byte windows does not false-degrade', () => {
  const events = [{ idx: 1, kind: 'echo' }];
  assert.equal(classify({ ...OK, events, memoryLineCount: 150, injectionLineWindow: 200, memoryByteCount: 18000, injectionByteWindow: 24400 }).identity_status, 'PASS');
});

test('classify DEGRADED (byte cap): byte truncation reported when line-count is unmeasured (null)', () => {
  const events = [{ idx: 1, kind: 'echo' }];
  const r = classify({ ...OK, events, memoryLineCount: null, memoryByteCount: 30000, injectionByteWindow: 24400 });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.match(r.reason, /truncation-detected/);
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

test('H2: a user-role text block carrying the token is NOT an echo (only the agent echoes)', () => {
  const userTxt = (text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  // The injected MEMORY.md surfaces as a user-role block; it carries the token but is not
  // an agent echo. Before the role filter this falsely satisfied the probe.
  const ev = scanTranscript([userTxt('here is your memory: tok-x'), txt('tok-x')], 'tok-x');
  assert.equal(ev.filter((e) => e.kind === 'echo').length, 1, 'only the assistant text block counts as an echo');
  assert.equal(ev.find((e) => e.kind === 'echo').idx, 1, 'the echo is the assistant line, not the user line');
});

test('H2: a user-only transcript with the token produces no echo at all', () => {
  const userTxt = (text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const ev = scanTranscript([userTxt('tok-x in injected context')], 'tok-x');
  assert.equal(ev.filter((e) => e.kind === 'echo').length, 0);
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

test('MET-006: NOT-YET carries reason_code finalize-not-run when no canary side file exists', () => {
  const r = classify({ token: null, canaryFileState: 'absent', memoryWritten: false, memoryHasToken: false, transcriptAvailable: false, events: [] });
  assert.equal(r.identity_status, 'NOT-YET');
  assert.equal(r.reason_code, 'finalize-not-run');
  assert.match(r.reason, /finalize/i, 'names the /finalize dependency, not a generic not-set-up');
});

test('MET-006: NOT-YET distinguishes an unreadable/token-less side file from never-run', () => {
  const r = classify({ token: null, canaryFileState: 'invalid', memoryWritten: false, memoryHasToken: false, transcriptAvailable: false, events: [] });
  assert.equal(r.identity_status, 'NOT-YET');
  assert.equal(r.reason_code, 'canary-file-invalid');
});

test('MET-006: probe row surfaces the reason_code when no side file exists', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mv-rc-'));
  try {
    const row = await probe({ home, cwd: '/no/such/project', workspaceId: 'mv-rc-ws' });
    assert.equal(row.identity_status, 'NOT-YET');
    assert.equal(row.reason_code, 'finalize-not-run');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('H1: write-visibility-canary writes MEMORY.md atomically, not with a bare write', () => {
  const canarySrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts/write-visibility-canary.mjs'),
    'utf8',
  );
  assert.match(canarySrc, /from '\.\/fs-atomic\.mjs'/, 'imports the atomic writer');
  assert.match(canarySrc, /atomicWriteFileSync\(memPath/, 'writes MEMORY.md atomically');
  assert.doesNotMatch(canarySrc, /\bwriteFileSync\(memPath\b/, 'no bare writeFileSync on the irreplaceable MEMORY.md surface');
});

// --- A spent token is not proof twice ---

test('classify: a token already spent by another session cannot be credited again', () => {
  const r = classify({ ...OK, events: [{ idx: 0, kind: 'echo' }], tokenConsumption: { consumed: false, reason: 'already-consumed', consumed_by_session: 's-earlier' } });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.equal(r.reason_code, 'canary-token-replayed');
});

test('classify: a consumption that could not be recorded is not a PASS', () => {
  const r = classify({ ...OK, events: [{ idx: 0, kind: 'echo' }], tokenConsumption: { consumed: false, reason: 'consumption-unrecordable' } });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.equal(r.reason_code, 'canary-consumption-unrecorded');
});

test('classify: a session cannot prove injection with a canary it wrote itself', () => {
  const r = classify({ ...OK, events: [{ idx: 0, kind: 'echo' }], writtenBySession: 's-1', sessionId: 's-1', tokenConsumption: { consumed: true } });
  assert.equal(r.identity_status, 'DEGRADED');
  assert.equal(r.reason_code, 'canary-echoed-in-writing-session');
});

test('classify: a fresh token spent by the reading session still passes', () => {
  const r = classify({ ...OK, events: [{ idx: 0, kind: 'echo' }], writtenBySession: 's-1', sessionId: 's-2', tokenConsumption: { consumed: true } });
  assert.equal(r.identity_status, 'PASS');
});

test('probe: the second run in a NEW session sees a replayed token, not a second proof', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mv-replay-'));
  try {
    const cwd = join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, 'workspace.json'), JSON.stringify({ workspace_id: 'w1' }));
    const memPath = join(home, 'MEMORY.md');
    writeFileSync(memPath, '## Memory\n\n- a line\n');
    writeCanary({ home, cwd, workspaceId: 'w1', memoryPath: memPath, sessionId: 's-writer' });
    const token = JSON.parse(readFileSync(writeSideFilePath('w1', home), 'utf8')).token;

    const transcript = join(home, 't.jsonl');
    writeFileSync(transcript, `${txt(`VISIBILITY-CANARY-ECHO: ${token}`)}\n`);

    const first = await probe({ home, cwd, workspaceId: 'w1', transcriptPath: transcript, sessionId: 's-reader' });
    assert.equal(first.identity_status, 'PASS');
    const replay = await probe({ home, cwd, workspaceId: 'w1', transcriptPath: transcript, sessionId: 's-other' });
    assert.equal(replay.identity_status, 'DEGRADED');
    assert.equal(replay.reason_code, 'canary-token-replayed');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
