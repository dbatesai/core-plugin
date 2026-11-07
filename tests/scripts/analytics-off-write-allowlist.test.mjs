// What the real entry points write when nobody opted in to analytics.
//
// Each case builds a sandbox (its own account home with a registry, one registered project with a
// small `_memories/` store and a PROJECT.md, and a session transcript), snapshots every file in it,
// runs the real SessionStart, per-turn retrieval and SessionEnd hooks (waiting for the close the
// SessionEnd hook launches) and the maintenance pass as subprocesses, then compares the set of
// created or changed files against an explicit allow-list for that gate state:
//   A  nothing opted in                                   → operational receipts only
//   B  CORE_TURN_CAPTURE=1 alone                          → A plus capture's own output
//   C  CORE_METRICS_ENABLED=0 with CORE_TURN_CAPTURE=1    → the same as A
// and checks where the user's prompt text landed. A negative control runs with
// CORE_METRICS_ENABLED=1 and requires that analytics output appears, so the diff is shown to see it.
//
// The subprocesses resolve their account home through the test preload (CORE_TEST_ACCOUNT_HOME,
// passed explicitly in NODE_OPTIONS), the same seam the isolated runner uses, pointed here at the
// sandbox, so nothing reaches the real ~/.core, the runner's account, or a real project.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerFixtureProject } from './registered-project-fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = join(ROOT, 'plugins', 'core', 'skills', 'core');
const HOOKS = join(SKILL, 'hooks');
const SESSION_START = join(HOOKS, 'session-start-hook.mjs');
const RETRIEVE = join(HOOKS, 'retrieve-context-hook.mjs');
const CLOSE = join(HOOKS, 'close-pass-hook.mjs');
const MAINTENANCE = join(SKILL, 'scripts', 'maintenance-run.mjs');
const FIXT = join(ROOT, 'tests', 'fixtures', 'obligation3-store');
const PRELOAD_URL = pathToFileURL(join(ROOT, 'tests', 'helpers', 'account-home-preload.mjs')).href;

const PROMPT_MARK = 'ALLOWLIST-PROMPT-7f3a';
// The analytics row keeps tokenized prompt words, so a plain-letter token is checked too (letters
// outside a-f cannot turn up inside a hash or an id).
const PROMPT_WORD = 'zebraquill';
const PROMPT = `${PROMPT_MARK} ${PROMPT_WORD} widget: is the omega speedmaster on sale yet?`;
const SESSION = 'allowlist-sess-5b1e9c40-2d7a-4e0f-8c3b-77aa00c0ffee';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'allowlist-')));
  cleanup.push(base);
  const home = join(base, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  const project = join(base, 'proj');
  cpSync(FIXT, project, { recursive: true });
  writeFileSync(join(project, 'PROJECT.md'), '# Watch shopping\n\n## Current state\n\nWaiting for a Speedmaster sale.\n');
  registerFixtureProject(home, project);
  // A Claude Code transcript for the session, outside the project, carrying the same prompt.
  const transcript = join(base, 'transcript.jsonl');
  writeFileSync(transcript, [
    { timestamp: '2026-11-06T10:00:00.000Z', sessionId: SESSION, cwd: project, message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } },
    { timestamp: '2026-11-06T10:01:00.000Z', sessionId: SESSION, cwd: project, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: join(project, 'PROJECT.md') } }] } },
    { timestamp: '2026-11-06T10:02:00.000Z', sessionId: SESSION, cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'Not yet.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { base, home, project, transcript };
}

// A clean environment: no inherited CORE_* switch, the sandbox as both the account home (through
// the preload) and HOME, and Claude Code's own harness signals.
function childEnv(home, gate) {
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CORE_TEST_ACCOUNT_HOME: home,
    NODE_OPTIONS: `--import ${PRELOAD_URL}`,
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SESSION_ID: SESSION,
    ...gate,
  };
  for (const k of ['TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function snapshot(base) {
  const files = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else files.set(relative(base, p).split(sep).join('/'), st.isFile() ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'link');
    }
  };
  walk(base);
  return files;
}

function changed(before, now) {
  return [...now.keys()].filter((p) => before.get(p) !== now.get(p)).sort();
}

const normalize = (p) => p
  .replace(new RegExp(SESSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<SESSION>')
  .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
  .replace(/\b[0-9a-f]{64}\b/g, '<SESSION-KEY>')        // close records are named by a hash of the session id
  .replace(/\.g\d+\.done$/, '.g<N>.done');              // a lock's generation moves when another writer shares it

function run(file, args, input, env, cwd) {
  const r = spawnSync(process.execPath, [file, ...args], { input, env, cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `${file.split(sep).pop()} exited ${r.status}: ${r.stderr}`);
  return r;
}

function waitFor(cond, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

/** Run the four entry points in a fresh sandbox; return the normalized written set and the raw paths. */
function exercise(gate) {
  const s = sandbox();
  const before = snapshot(s.base);
  const env = childEnv(s.home, gate);
  run(SESSION_START, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'SessionStart', source: 'startup', transcript_path: s.transcript }), env, s.project);
  run(RETRIEVE, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'UserPromptSubmit', prompt: PROMPT, transcript_path: s.transcript }), env, s.project);
  run(CLOSE, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'SessionEnd', reason: 'other', transcript_path: s.transcript }), env, s.project);
  // The SessionEnd hook launches the close detached: wait for its receipt, then for the tree to settle.
  const receiptSeen = waitFor(() => changed(before, snapshot(s.base)).some((p) => /\/close\/receipts\/[^/]+\.json$/.test(p)));
  let last = null, stable = 0;
  waitFor(() => { const now = JSON.stringify([...snapshot(s.base)]); stable = now === last ? stable + 1 : 0; last = now; return stable >= 5; });
  run(MAINTENANCE, [s.project, '--json'], '', env, s.project);
  const written = changed(before, snapshot(s.base));
  return { ...s, receiptSeen, written, normalized: [...new Set(written.map(normalize))].sort() };
}

/** Every written file holding the prompt: verbatim, or as the tokenized word an analytics row keeps. */
function filesHolding(s) {
  return s.written.filter((p) => {
    let text;
    try { text = readFileSync(join(s.base, p), 'utf8'); } catch { return false; }
    return text.includes(PROMPT_MARK) || text.toLowerCase().includes(PROMPT_WORD);
  });
}

// ---- the allow-lists: normalized paths relative to the sandbox (home/… is the account home, proj/… the project) ----

// Operational writes, permitted whatever the analytics gate says.
const OPERATIONAL = [
  'proj/_core/.gitignore',                                   // self-ignore for CORE's own working folder
  'proj/_core/_hooks/.gitignore',                            // self-ignore for the hook receipts
  'proj/_core/_hooks/hooks-log.jsonl',                       // hook lifecycle receipts (action, reason, cwd, producer)
  'proj/_memories/.gitignore',                               // self-ignore for the store's generated files
  'proj/_memories/INDEX-decisions.md',                       // index the maintenance pass regenerates
  'proj/_memories/INDEX-risks.md',                           // index the maintenance pass regenerates
  'proj/_memories/_lib/.gitignore',                          // self-ignore for the derived-index folder
  'proj/_memories/_lib/.state-cache.lock.g<N>.done',         // lock completion marker for the state cache
  'proj/_memories/_lib/state-cache.json',                    // hashes of the generated files maintenance wrote
  'proj/_memories/_lib/unit-summaries.json',                 // summary index of the units (ids, titles, topics)
  'proj/_memories/_maintenance-state.json',                  // maintenance cadence ledger
  'proj/_metrics/.gitignore',                                // self-ignore for the folder close records live in
  'proj/_metrics/.turn-capture.lock.g<N>.done',              // lock completion marker; the close receipt writer takes this lock
  'proj/_metrics/close/.gitignore',                          // self-ignore for close records
  'proj/_metrics/close/receipts/.gitignore',                 // self-ignore for close receipts
  'proj/_metrics/close/receipts/<SESSION-KEY>.json',         // this session's close receipt: identity, times, counts, tool names
  'proj/_metrics/close/summaries/.gitignore',                // self-ignore for close summaries
  'proj/_metrics/close/summaries/<SESSION-KEY>.md',          // this session's deterministic close summary (same content as the receipt)
];

// Turn capture's declared output (protocols/data-storage.md, "Turn-capture evidence"). Read from a run
// with both CORE_METRICS_ENABLED=1 and CORE_TURN_CAPTURE=1: the only state in which the per-turn hook
// reaches the capture writer today.
const CAPTURE_OUTPUT = [
  'proj/_metrics/turn-capture/.gitignore',
  'proj/_metrics/turn-capture/<DATE>.jsonl',
  'proj/_metrics/turn-capture-health.json',
];
// Where capture-gated prompt text may land in state B: the capture stream, and the automatic close
// record, which "uses the same capture gate as turn capture" for its opening request
// (protocols/data-storage.md, "Automatic close privacy").
const CAPTURE_PROMPT_PLACES = [
  /^proj\/_metrics\/turn-capture\//,
  /^proj\/_metrics\/close\/receipts\/[0-9a-f]{64}\.json$/,
  /^proj\/_metrics\/close\/summaries\/[0-9a-f]{64}\.md$/,
];

const ALLOW_A = [...OPERATIONAL].sort();
const ALLOW_B = [...OPERATIONAL, ...CAPTURE_OUTPUT].sort();
const ALLOW_C = ALLOW_A;

// The analytics row the negative controls name: written only when analytics are on.
const RETRIEVAL_ROW = 'proj/_sessions/<DATE>/retrieval-log.jsonl';
const CAPTURE_ROWS = 'proj/_metrics/turn-capture/<DATE>.jsonl';

const states = {
  A: { gate: {}, allow: ALLOW_A, label: 'nothing opted in' },
  B: { gate: { CORE_TURN_CAPTURE: '1' }, allow: ALLOW_B, label: 'CORE_TURN_CAPTURE=1 alone' },
  C: { gate: { CORE_METRICS_ENABLED: '0', CORE_TURN_CAPTURE: '1' }, allow: ALLOW_C, label: 'CORE_METRICS_ENABLED=0 with CORE_TURN_CAPTURE=1' },
};

const results = {};
const resultFor = (name) => (results[name] ??= exercise(states[name].gate));
for (const [name, st] of Object.entries(states)) {
  test(`state ${name} (${st.label}): the written set equals its allow-list`, () => {
    const r = resultFor(name);
    assert.ok(r.receiptSeen, 'the close launched by SessionEnd left its receipt');
    assert.deepEqual(r.normalized, st.allow,
      `unexpected or missing writes in state ${name}:\n  extra: ${JSON.stringify(r.normalized.filter((p) => !st.allow.includes(p)), null, 2)}\n  missing: ${JSON.stringify(st.allow.filter((p) => !r.normalized.includes(p)), null, 2)}`);
  });
}

test('the prompt text is in no written file in states A and C', () => {
  for (const name of ['A', 'C']) assert.deepEqual(filesHolding(resultFor(name)), [], `state ${name} wrote the prompt text`);
});

test('state B: the prompt text appears only in capture-gated output', () => {
  const holding = filesHolding(resultFor('B'));
  assert.deepEqual(holding.filter((p) => !CAPTURE_PROMPT_PLACES.some((re) => re.test(p))), [], 'the prompt landed outside capture-gated output');
});

test('negative control: with CORE_METRICS_ENABLED=1 the diff sees the retrieval analytics row, which state A forbids, and the prompt check sees its tokens', () => {
  const r = exercise({ CORE_METRICS_ENABLED: '1' });
  assert.ok(!ALLOW_A.includes(RETRIEVAL_ROW));
  assert.ok(r.normalized.includes(RETRIEVAL_ROW), `metrics on did not write ${RETRIEVAL_ROW}: ${JSON.stringify(r.normalized)}`);
  assert.ok(filesHolding(r).some((p) => normalize(p) === RETRIEVAL_ROW), 'the prompt check did not see the tokenized prompt in the analytics row');
});

test('negative control: with both switches on the diff sees capture rows, and the prompt check sees the prompt in them', () => {
  const r = exercise({ CORE_METRICS_ENABLED: '1', CORE_TURN_CAPTURE: '1' });
  assert.ok(r.normalized.includes(CAPTURE_ROWS), `capture did not write ${CAPTURE_ROWS}: ${JSON.stringify(r.normalized)}`);
  assert.ok(filesHolding(r).some((p) => normalize(p) === CAPTURE_ROWS), 'the prompt check did not see the prompt in the capture rows');
});
