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
// and requires that nothing was deleted. It then checks content, not only paths: the transcript carries
// three canaries (the user's prompt, the assistant's reply, a tool call's input), and the test checks
// which written files hold each one; every operational JSON/JSONL file written in A and C is parsed
// and its keys are compared against an explicit allowed-keys shape with types, with the close
// record's content-bearing fields pinned empty; and in B the capture stream must exist and hold the
// prompt. Negative controls run with CORE_METRICS_ENABLED=1 and require that analytics output
// appears, so the diff and the canary checks are shown to see it.
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
// The retrieval hook's closed reason vocabulary; the hook runs main() only as a CLI entry.
import { RETRIEVAL_REASONS } from '../../plugins/core/skills/core/hooks/retrieve-context-hook.mjs';

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
// The assistant's reply and a tool call's input carry their own canaries, so a leak names its source.
const REPLY_MARK = 'ALLOWLIST-REPLY-9c2e';
const REPLY_WORD = 'quillzebra';
const REPLY = `${REPLY_MARK} ${REPLY_WORD}`;
const TOOLARG_MARK = 'ALLOWLIST-TOOLARG-4b1d';
const TOOLARG_WORD = 'zephyrnib';
const TOOLARG = `${TOOLARG_MARK} ${TOOLARG_WORD}`;
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
    { timestamp: '2026-11-06T10:01:30.000Z', sessionId: SESSION, cwd: project, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${TOOLARG}` } }] } },
    { timestamp: '2026-11-06T10:02:00.000Z', sessionId: SESSION, cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: `Not yet. ${REPLY}` }] } },
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

function deleted(before, now) {
  return [...before.keys()].filter((p) => !now.has(p)).sort();
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

/**
 * Run the four entry points in a fresh sandbox; return the normalized written set, the raw written
 * paths and the deleted paths. Fails unless the close left its receipt and the tree then settled.
 */
function exercise(gate) {
  const s = sandbox();
  const before = snapshot(s.base);
  const env = childEnv(s.home, gate);
  run(SESSION_START, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'SessionStart', source: 'startup', transcript_path: s.transcript }), env, s.project);
  run(RETRIEVE, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'UserPromptSubmit', prompt: PROMPT, transcript_path: s.transcript }), env, s.project);
  run(CLOSE, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'SessionEnd', reason: 'other', transcript_path: s.transcript }), env, s.project);
  // The SessionEnd hook launches the close detached: wait for its receipt, then for the tree to settle.
  const receiptSeen = waitFor(() => changed(before, snapshot(s.base)).some((p) => /\/close\/receipts\/[^/]+\.json$/.test(p)));
  assert.ok(receiptSeen, 'the close launched by SessionEnd left its receipt within the wait');
  let last = null, stable = 0;
  const settled = waitFor(() => { const now = JSON.stringify([...snapshot(s.base)]); stable = now === last ? stable + 1 : 0; last = now; return stable >= 5; });
  assert.ok(settled, 'the sandbox tree stopped changing after the close, within the wait');
  run(MAINTENANCE, [s.project, '--json'], '', env, s.project);
  const after = snapshot(s.base);
  const written = changed(before, after);
  const removed = deleted(before, after);
  return { ...s, receiptSeen, settled, written, removed, normalized: [...new Set(written.map(normalize))].sort() };
}

// Each canary is a marker string plus a plain-letter word: an analytics row keeps tokenized words,
// and letters outside a-f cannot turn up inside a hash or an id.
const CANARIES = {
  prompt: { mark: PROMPT_MARK, word: PROMPT_WORD },
  reply: { mark: REPLY_MARK, word: REPLY_WORD },
  toolarg: { mark: TOOLARG_MARK, word: TOOLARG_WORD },
};

/** Every written file holding a canary (the prompt by default): verbatim, or as its tokenized word. */
function filesHolding(s, { mark, word } = CANARIES.prompt) {
  return s.written.filter((p) => {
    let text;
    try { text = readFileSync(join(s.base, p), 'utf8'); } catch { return false; }
    return text.includes(mark) || text.toLowerCase().includes(word);
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

// Turn capture's declared output (protocols/data-storage.md, "Turn-capture evidence"). Capture runs on
// its own opt-in, CORE_TURN_CAPTURE=1, outside the analytics gate: the analytics default does not stop
// it (state B) and an explicit CORE_METRICS_ENABLED=0 does (state C).
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

// Where the reply and tool-input canaries may land in state B: nowhere. Capture keeps the prompt and
// the delivered pack; the close record keeps the opening request and the touched paths. Neither
// keeps the assistant's text or a tool call's input.
const CAPTURE_REPLY_PLACES = [];
const CAPTURE_TOOLARG_PLACES = [];

// Nothing that existed before the run may disappear.
const ALLOWED_DELETIONS = [];

// ---- field allow-lists for the operational JSON/JSONL files written in states A and C ----
// A shape maps every allowed key to its type: a type name ('string', 'number', 'boolean', 'null',
// 'object', 'array', or alternatives joined by '|'), a nested shape, [type] for an array of that type,
// or eachValue(type) for an object whose keys vary (checked separately) and whose values share a type.
const STR = 'string', NUM = 'number', BOOL = 'boolean';
const EACH = Symbol('each value');
const eachValue = (type) => ({ [EACH]: type });

const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
function checkType(v, type, at) {
  if (Array.isArray(type)) {
    assert.equal(typeName(v), 'array', `${at} is ${typeName(v)}, allowed array`);
    v.forEach((e, i) => checkType(e, type[0], `${at}[${i}]`));
  } else if (typeof type === 'object') {
    assert.equal(typeName(v), 'object', `${at} is ${typeName(v)}, allowed object`);
    if (type[EACH]) { for (const [k, e] of Object.entries(v)) checkType(e, type[EACH], `${at}[${JSON.stringify(k)}]`); return; }
    assert.deepEqual(Object.keys(v).sort(), Object.keys(type).sort(), `${at}: the keys differ from the allowed set`);
    for (const [k, t] of Object.entries(type)) checkType(v[k], t, `${at}.${k}`);
  } else {
    assert.ok(type.split('|').includes(typeName(v)), `${at} is ${typeName(v)}, allowed ${type}`);
  }
}

// The close receipt (close-pass-hook → the close writer). Every string is an id, a path CORE derives,
// a timestamp, a hash or a closed status code; the record's three content-bearing fields
// (opening_request, files_touched, capture_content) are pinned separately by value.
const CLOSE_RECEIPT_SHAPE = {
  session_id: STR, status: STR, root: STR, harness: STR, closed_at: STR,
  ops: { capture: STR, summary: STR, 'project-state': STR },
  summary_path: STR, summary_sha256: STR, model_calls: NUM,
  record: {
    schema: STR, capture_content: BOOL, session_id: STR, harness: STR, started_at: STR, ended_at: STR,
    coverage: STR, status: STR, substantive: BOOL, model_calls: NUM,
    counts: { events: NUM, tools: NUM, mutating_tools: NUM, user_turns: NUM },
    tools_used: [STR],        // tool names from the transcript, not their inputs
    files_touched: [STR],     // content-bearing: empty unless capture is on
    opening_request: STR,     // content-bearing: '' unless capture is on
    git_head: 'string|null',
  },
  generated_close: { marker: STR, sha256: STR },
};

// hooks-log.jsonl rows, by hook: lifecycle receipts made of closed codes, the project path and ids.
const HOOK_ROW_COMMON = { ts: STR, hook: STR, action: STR, cwd: STR, producer_version: STR, producer_sha: STR };
const HOOK_ROW_SHAPES = {
  'session-start': { ...HOOK_ROW_COMMON },
  'retrieve-context': { ...HOOK_ROW_COMMON, reason: STR, harness: STR, retrieval_id: STR, turn_capture: STR, escalation: STR },
  'session-end': { ...HOOK_ROW_COMMON, reason: STR, session: STR },
};

const MAINTENANCE_OP = { last_run: STR, run_count: NUM };
const LOCK_DONE_SHAPE = { pid: NUM, nonce: STR, gen: NUM, started_at: STR };

// Normalized path → shape. Every JSON/JSONL file written in A or C must have an entry here.
const OPERATIONAL_SHAPES = {
  'proj/_metrics/close/receipts/<SESSION-KEY>.json': CLOSE_RECEIPT_SHAPE,
  // The maintenance cadence ledger: timestamps, the store's file-name+hash signature, per-op counters.
  'proj/_memories/_maintenance-state.json': {
    last_run: STR, last_sig: STR,
    ops: { 'decisions-index': MAINTENANCE_OP, 'risks-index': MAINTENANCE_OP, 'summary-index': MAINTENANCE_OP },
  },
  // Hashes of the generated files, keyed by their path.
  'proj/_memories/_lib/state-cache.json': {
    files: eachValue({ last_hash: STR, last_written: STR, last_written_by: STR }),
    status: STR,
  },
  // The unit summary index: derived from the project's own memory units, not from the session.
  'proj/_memories/_lib/unit-summaries.json': {
    count: NUM, generated: STR, source_sig: STR, next_invalidation_at: 'string|number|null',
    degraded: BOOL, incomplete: BOOL, read_errors: ['string|object'], duplicate_conflicts: ['string|object'],
    units: [{ id: STR, path: STR, type: STR, tier: STR, summary: STR, topics: [STR], status: STR, updated: STR }],
  },
  // Lock completion markers: owner pid, nonce, generation, start time.
  'proj/_memories/_lib/.state-cache.lock.g<N>.done': LOCK_DONE_SHAPE,
  'proj/_metrics/.turn-capture.lock.g<N>.done': LOCK_DONE_SHAPE,
};
const HOOKS_LOG = 'proj/_core/_hooks/hooks-log.jsonl';
const CLOSE_SUMMARY = 'proj/_metrics/close/summaries/<SESSION-KEY>.md';
const CLOSE_RECEIPT = 'proj/_metrics/close/receipts/<SESSION-KEY>.json';
const STATE_CACHE = 'proj/_memories/_lib/state-cache.json';
const STATE_CACHE_FILES = ['_memories/INDEX-decisions.md', '_memories/INDEX-risks.md', '_memories/_lib/unit-summaries.json'];

/** The one written file whose normalized path is `norm`, read as text. */
function writtenText(r, norm) {
  const hits = r.written.filter((p) => normalize(p) === norm);
  assert.equal(hits.length, 1, `exactly one written file normalizes to ${norm}: ${JSON.stringify(hits)}`);
  return readFileSync(join(r.base, hits[0]), 'utf8');
}

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
  test(`state ${name} (${st.label}): the written set equals its allow-list and nothing was deleted`, () => {
    const r = resultFor(name);
    assert.ok(r.receiptSeen && r.settled, 'the close left its receipt and the tree settled');
    assert.deepEqual(r.normalized, st.allow,
      `unexpected or missing writes in state ${name}:\n  extra: ${JSON.stringify(r.normalized.filter((p) => !st.allow.includes(p)), null, 2)}\n  missing: ${JSON.stringify(st.allow.filter((p) => !r.normalized.includes(p)), null, 2)}`);
    assert.deepEqual(r.removed.map(normalize), ALLOWED_DELETIONS, `state ${name} deleted files that existed before the run`);
  });
}

test('the prompt, reply and tool-input canaries are in no written file in states A and C', () => {
  for (const name of ['A', 'C']) {
    for (const [which, canary] of Object.entries(CANARIES)) {
      assert.deepEqual(filesHolding(resultFor(name), canary), [], `state ${name} wrote the ${which} canary`);
    }
  }
});

test('state B: the prompt text appears only in capture-gated output; the reply and tool-input canaries only in their allowed places', () => {
  const r = resultFor('B');
  const outside = (places, which) => filesHolding(r, CANARIES[which]).filter((p) => !places.some((re) => re.test(p)));
  assert.deepEqual(outside(CAPTURE_PROMPT_PLACES, 'prompt'), [], 'the prompt landed outside capture-gated output');
  assert.deepEqual(outside(CAPTURE_REPLY_PLACES, 'reply'), [], 'the reply canary landed outside its allowed places');
  assert.deepEqual(outside(CAPTURE_TOOLARG_PLACES, 'toolarg'), [], 'the tool-input canary landed outside its allowed places');
});

test('state B: the capture stream exists and holds a row whose prompt field carries the prompt', () => {
  const r = resultFor('B');
  const rows = writtenText(r, CAPTURE_ROWS).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(rows.some((row) => typeof row.prompt_text === 'string' && row.prompt_text.includes(PROMPT_MARK)),
    `no capture row's prompt_text holds ${PROMPT_MARK}: ${JSON.stringify(rows.map((row) => Object.keys(row)))}`);
  // The close record follows the same capture gate, so its content fields are filled here: the
  // discriminator that the A and C pins below can see content when it is there.
  const rec = JSON.parse(writtenText(r, CLOSE_RECEIPT)).record;
  assert.equal(rec.capture_content, true);
  assert.ok(rec.opening_request.includes(PROMPT_MARK), 'the close record in B keeps the opening request');
  assert.ok(rec.files_touched.length > 0, 'the close record in B keeps the touched paths');
});

test('states A and C: every operational JSON/JSONL file written carries only its allowed keys, with their types', () => {
  for (const name of ['A', 'C']) {
    const r = resultFor(name);
    const json = r.written.filter((p) => /\.(json|jsonl)$|\.done$/.test(p)).map(normalize).sort();
    assert.deepEqual(json, [...Object.keys(OPERATIONAL_SHAPES), HOOKS_LOG].sort(), `state ${name}: a JSON/JSONL file without a field allow-list`);
    for (const [norm, shape] of Object.entries(OPERATIONAL_SHAPES)) checkType(JSON.parse(writtenText(r, norm)), shape, `${name}:${norm}`);

    // The close record: identity and paths are the known values, the content-bearing fields are empty.
    const receipt = JSON.parse(writtenText(r, CLOSE_RECEIPT));
    assert.equal(receipt.session_id, SESSION);
    assert.equal(receipt.record.session_id, SESSION);
    assert.equal(receipt.root, r.project);
    assert.ok(receipt.summary_path.startsWith(join(r.project, '_metrics', 'close', 'summaries') + sep), `${name}: summary_path is CORE's own path`);
    assert.equal(receipt.record.capture_content, false, `${name}: the close record says it kept no content`);
    assert.equal(receipt.record.opening_request, '', `${name}: the close record kept the opening request`);
    assert.deepEqual(receipt.record.files_touched, [], `${name}: the close record kept the touched paths`);
    assert.deepEqual([...receipt.record.tools_used].sort(), ['Bash', 'Edit'], `${name}: tools_used holds only the transcript's tool names`);
    // The close read every transcript line, the reply and the canary-carrying tool call included, so
    // the canaries' absence is not a transcript that went unread.
    assert.deepEqual(receipt.record.counts, { events: 4, tools: 2, mutating_tools: 1, user_turns: 1 }, `${name}: the close counted the whole transcript`);

    // The state cache is keyed by the generated files' paths, and only those.
    const cache = JSON.parse(writtenText(r, STATE_CACHE));
    assert.deepEqual(Object.keys(cache.files).sort(), STATE_CACHE_FILES.map((f) => join(r.project, ...f.split('/'))).sort());

    // hooks-log rows: one per hook, each with exactly its allowed keys.
    const rows = writtenText(r, HOOKS_LOG).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((row) => row.hook), ['session-start', 'retrieve-context', 'session-end'], `${name}: hooks-log rows`);
    for (const row of rows) {
      checkType(row, HOOK_ROW_SHAPES[row.hook], `${name}:hooks-log[${row.hook}]`);
      assert.equal(row.cwd, r.project);
    }
    const retrieve = rows.find((row) => row.hook === 'retrieve-context');
    assert.ok(RETRIEVAL_REASONS.includes(retrieve.reason), `${name}: retrieve-context reason ${retrieve.reason} is in the closed vocabulary`);
    assert.equal(retrieve.reason, name === 'C' ? 'metrics-opt-out' : 'metrics-off', `${name}: the receipt names why no retrieval row was written`);
    assert.equal(retrieve.turn_capture, 'disabled', `${name}: capture did not run`);
    assert.match(retrieve.retrieval_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(rows.find((row) => row.hook === 'session-end').session, SESSION);
  }
});

test('states A and C: the close summary holds no canary, no opening request and no touched paths', () => {
  for (const name of ['A', 'C']) {
    const r = resultFor(name);
    const md = writtenText(r, CLOSE_SUMMARY);
    assert.match(md, /^## Tools used$/m, `${name}: the summary was read (positive anchor)`);
    for (const [which, { mark, word }] of Object.entries(CANARIES)) {
      assert.ok(!md.includes(mark) && !md.toLowerCase().includes(word), `${name}: the close summary holds the ${which} canary`);
    }
    assert.doesNotMatch(md, /^## Opening request/m, `${name}: the close summary has an opening request section`);
    assert.doesNotMatch(md, /^## Files touched/m, `${name}: the close summary has a files-touched section`);
    assert.ok(!md.includes('PROJECT.md'), `${name}: the close summary names a touched file`);
  }
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

test('with nothing opted in, the session close alone (no maintenance pass after it) leaves _metrics ignoring itself', () => {
  const s = sandbox();
  try {
    const env = childEnv(s.home, states.A.gate);
    run(CLOSE, [], JSON.stringify({ session_id: SESSION, cwd: s.project, hook_event_name: 'SessionEnd', reason: 'other', transcript_path: s.transcript }), env, s.project);
    const receipts = join(s.project, '_metrics', 'close', 'receipts');
    assert.ok(waitFor(() => existsSync(receipts) && readdirSync(receipts).some((n) => n.endsWith('.json'))), 'the close wrote its receipt');
    const ignore = join(s.project, '_metrics', '.gitignore');
    assert.ok(existsSync(ignore), '_metrics has its self-ignore before any maintenance pass');
    assert.match(readFileSync(ignore, 'utf8'), /\*/);
  } finally { rmSync(s.base, { recursive: true, force: true }); }
});
