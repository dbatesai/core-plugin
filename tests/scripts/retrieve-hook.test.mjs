import { test, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';
// mkdtempSync / rmSync used by isolatedHooksLog() below are imported later in
// this file (line ~100) — ES module imports are hoisted, so the binding is
// available at call time regardless of textual position.

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
// D1 fix, 2026-07-18, second pass: CORE_RETRIEVAL_STORE was removed from the
// product hooks entirely (Hale + Antigravity: no legitimate production use,
// and its trust check was lexical-only — symlink-bypassable). Tests now pass
// the store via `cwd` in the JSON payload, the same trusted channel the real
// harness always used — no env var, no symlink workaround needed anymore.
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

// Isolate every hook test log (Hale audit, 2026-07-17): a subprocess hook run
// that doesn't override CORE_HOOKS_LOG_FILE defaults to the real machine-wide
// ~/.core/hooks-log.jsonl (hook-log.mjs's default path) — tests writing there
// pollute the developer's real log and, under a sandboxed/CI HOME or
// concurrent test runs, can behave differently across environments. Every
// call gets its own fresh temp path unless the test explicitly needs a
// specific one (those pass CORE_HOOKS_LOG_FILE in `env`, which wins here).
// Rooted under ~/.core (D1 fix, 2026-07-18): CORE_HOOKS_LOG_FILE now only
// honors overrides inside the trusted ~/.core, so os.tmpdir() no longer
// qualifies. Unlike os.tmpdir(), ~/.core isn't auto-cleaned — every created
// dir is tracked and removed in the after() below.
const _isolatedLogDirs = [];
function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'retrieve-hook-log-'));
  _isolatedLogDirs.push(dir);
  return join(dir, 'hooks-log.jsonl');
}
after(() => { for (const d of _isolatedLogDirs) rmSync(d, { recursive: true, force: true }); });

function runHook(prompt, env, cwd = FIXT) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd }),
    // Metrics hard-off by default: the hook emits the canonical per-turn
    // retrieval event + OTel span when metrics are on (2026-07-17), and a test
    // pointed at a COMMITTED fixture store must never write telemetry into it
    // (that exact pollution shipped in a2cab1b and was cleaned up same night).
    // Tests that assert the telemetry write opt back in against temp stores.
    env: { ...process.env, CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: isolatedHooksLog(), ...env },
    encoding: 'utf8',
  });
}

function runHookProcess(prompt, env, cwd = FIXT) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd }),
    env: { ...process.env, CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: isolatedHooksLog(), ...env },
    encoding: 'utf8',
  });
}

test('default ON: flag unset → injects (shipped on, opt-out — G2 resolved)', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '' });
  assert.match(out, /want-omega-speedmaster-on-sale-wait/, 'default-on hook injects with no flag set');
});

test('opt-out: CORE_RETRIEVAL_HOOK=0 → no output, exit 0', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '0' });
  assert.equal(out.trim(), '', 'hook must be a no-op when explicitly opted out with =0');
});

test('flag ON: injects summaries for a known query', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1' });
  assert.match(out, /want-omega-speedmaster-on-sale-wait/, 'the literal-match want should be injected');
});

test('flag ON but empty query → no crash, exit 0', () => {
  const out = runHook('', { CORE_RETRIEVAL_HOOK: '1' });
  assert.equal(typeof out, 'string');
});

test('output is byte-capped', () => {
  const out = runHook('watch chronograph omega speedmaster heritage agenda', { CORE_RETRIEVAL_HOOK: '1' });
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2048, 'injected context must stay within the byte cap');
});

test('integration: bootstrap integrity marker + hook injection coexist under a combined cap', async () => {
  const { checkContextIntegrity } = await import('../../plugins/core/skills/core/scripts/check-context-integrity.mjs');
  const marker = checkContextIntegrity({ memoryBytes: 1000, projectTotalLines: 100, projectReadLines: 100 }).marker;
  const injected = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1' });
  const combined = marker + '\n' + injected;
  assert.match(combined, /CONTEXT-COMPLETE/);
  assert.match(combined, /want-omega-speedmaster-on-sale-wait/);
  assert.ok(Buffer.byteLength(combined, 'utf8') <= 4096, 'startup marker + per-turn injection together stay bounded');
});

test('hook output carries the authority tier for observation hits (Hale re-review §6 — the label used to be stripped)', async () => {
  const { mkdtempSync, cpSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const NESTED = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'nested-store');
  const dir = mkdtempSync(join(tmpdir(), 'hook-tier-'));
  cpSync(NESTED, dir, { recursive: true });
  try {
    const out = execFileSync('node', [HOOK], {
      input: JSON.stringify({ prompt: 'quokka incident', cwd: dir }),
      env: { ...process.env, CORE_HOOKS_LOG_FILE: isolatedHooksLog() },
      encoding: 'utf8',
    });
    assert.match(out, /obs-nested-note \[observation\]:/, 'observation hit is tier-labeled in the injected context');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Per-turn event semantics (Hale live-hook audit, 2026-07-17) ----
// Every field must be an OBSERVED value: ladder tier from the producing stage
// (never the unit authority tier), no fabricated escalation on empty results,
// observed query terms, correlation id, and an OBSERVABLE write outcome.
import { mkdtempSync, rmSync, writeFileSync as wf, readFileSync as rf, readdirSync as rd, existsSync as ex, mkdirSync as mkd } from 'node:fs';
import { tmpdir } from 'node:os';

function makeStore(root) {
  const store = join(root, '_memories');
  mkd(store, { recursive: true });
  wf(join(root, 'PROJECT.md'), '# T\n');
  wf(join(store, 'dc-1-widget.md'), '---\nid: dc-1-widget\ntype: decision\nstatus: active\ncreated: 2026-07-01\ntopics:\n  - widget\n---\n\nWidget decision body.\n');
  wf(join(store, 'risk-1-widget.md'), '---\nid: risk-1-widget\ntype: risk\nstatus: active\ncreated: 2026-07-02\ntopics:\n  - widget\n---\n\nWidget risk body.\n');
  return root;
}

function readEventRows(root) {
  const sess = join(root, '_sessions');
  if (!ex(sess)) return [];
  const rows = [];
  for (const d of rd(sess)) {
    const f = join(sess, d, 'retrieval-log.jsonl');
    if (ex(f)) for (const l of rf(f, 'utf8').trim().split('\n')) rows.push(JSON.parse(l));
  }
  return rows.filter(r => r.trigger === 'per-turn-hook');
}

test('hit event: ladder tier from producing stage, observed terms, correlation present', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-hit-')));
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '1' }, root);
    const [evt] = readEventRows(root);
    assert.ok(evt, 'event written');
    assert.equal(evt.mechanism, 'model-free-substrate');
    assert.ok(typeof evt.retrieval_id === 'string' && evt.retrieval_id.length >= 8, 'correlation id present');
    assert.ok(evt.intent_topics.includes('widget'), 'observed query terms, not a constant');
    for (const u of evt.units_retrieved) {
      assert.equal(u.tier, 1, 'the product retriever (incl. one-hop expansion) IS Tier 1 by protocol definition');
      assert.ok(['ranked', 'one-hop-expansion'].includes(u.source_stage), 'intra-tier provenance rides source_stage, never the ladder tier');
    }
    assert.equal(evt.tier_reached, 1, 'model-free pipeline reports Tier 1 only');
    assert.deepEqual(evt.escalation_path, [1], 'no fabricated escalation');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty result is an honest no-hit at the tier actually run — never a fabricated Tier-3 miss', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-nohit-')));
  try {
    const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1' }, root);
    assert.match(out, /CORE reasoning escalation required/);
    assert.match(out, /inspect all 1 shard\(s\) covering 2 active units/);
    assert.ok(Buffer.byteLength(out, 'utf8') <= 2048, 'reasoning directive stays inside the hook cap');
    const rows = readEventRows(root);
    if (rows.length) { // an empty final set may still inject nothing yet log honestly
      const evt = rows[0];
      assert.equal(evt.result, 'no-hit');
      assert.equal(evt.tier_reached, 1, 'no-hit at Tier 1 — the only tier this mechanism runs');
      assert.deepEqual(evt.escalation_path, [1]);
      assert.equal(evt.units_retrieved.length, 0);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metrics opt-out means zero telemetry rows', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-optout-')));
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '0' }, root);
    assert.equal(readEventRows(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('telemetry write failure is observable in the hook log, and the turn is never blocked', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-wfail-')));
  // D1 fix: CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now, so the
  // log can no longer live alongside the (os.tmpdir()-rooted) store fixture.
  const logFile = isolatedHooksLog();
  try {
    // Force the legacy write path to fail: _sessions exists as a FILE.
    wf(join(root, '_sessions'), 'not a directory');
    const out = runHook('widget decision', { CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: logFile }, root);
    assert.ok(typeof out === 'string', 'hook exited cleanly (fail-open)');
    assert.ok(ex(logFile), 'failure surfaced in the hook log');
    assert.match(rf(logFile, 'utf8'), /"reason":"event-write-failed"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Typed operational receipt: one terminal row per invocation, closed vocabulary ----
test('every hook branch emits exactly one in-vocabulary {action, reason} receipt', async () => {
  const branches = [
    { name: 'retrieval-opt-out', env: { CORE_RETRIEVAL_HOOK: '0' }, prompt: 'widget', expect: { action: 'skip', reason: 'retrieval-opt-out' }, needStore: false },
    { name: 'empty-prompt', env: {}, prompt: '   ', expect: { action: 'skip', reason: 'empty-prompt' }, needStore: false },
    { name: 'store-absent', env: {}, prompt: 'widget', expect: { action: 'skip', reason: 'store-absent' }, storeless: true },
    { name: 'delivered-ok', env: { CORE_METRICS_ENABLED: '1' }, prompt: 'widget decision', expect: { action: 'delivered', reason: 'ok' } },
    { name: 'metrics-opt-out', env: { CORE_METRICS_ENABLED: '0' }, prompt: 'widget decision', expect: { action: 'delivered', reason: 'metrics-opt-out' } },
    { name: 'pipeline-error', env: {}, prompt: 'widget', expect: { action: 'failed', reason: 'pipeline-error' }, directReceipt: true, needStore: false },
    // 2026-07-18, Hale-authorized: the branch above only ever calls receipt()
    // directly, proving the logging contract but never that a GENUINE uncaught
    // exception through the real subprocess pipeline actually reaches the
    // catch and still exits 0. This one forces buildRetrievalTrace to throw
    // via the explicit CORE_TEST_FORCE_PIPELINE_ERROR seam and runs the real
    // subprocess end to end — fail-open proven, not assumed.
    { name: 'pipeline-error-genuine-crash', env: { CORE_TEST_FORCE_PIPELINE_ERROR: '1' }, prompt: 'widget decision', expect: { action: 'failed', reason: 'pipeline-error' } },
    { name: 'store-unavailable', env: {}, prompt: 'widget', expect: { action: 'skip', reason: 'store-unavailable' }, needStore: false, setup: (root) => { wf(join(root, '_memories'), 'not a directory'); } },
    { name: 'no-hit', env: { CORE_METRICS_ENABLED: '1' }, prompt: 'zzqx unmatchable quark', expect: { action: 'delivered', reason: 'no-hit' } },
    { name: 'delivery-failed', env: { CORE_RETRIEVAL_BYTE_CAP: '0' }, prompt: 'widget decision', expect: { action: 'failed', reason: 'delivery-failed' } },
    { name: 'event-write-failed', env: { CORE_METRICS_ENABLED: '1' }, prompt: 'widget decision', expect: { action: 'delivered', reason: 'event-write-failed' }, setup: (root) => { wf(join(root, '_sessions'), 'not a directory'); } },
    { name: 'trace-write-failed', env: { CORE_METRICS_ENABLED: '1', CORE_RETRIEVAL_TRACE: '1' }, prompt: 'widget decision', expect: { action: 'delivered', reason: 'trace-write-failed' }, setup: (root) => { const d = join(root, '_sessions', new Date().toISOString().slice(0, 10)); mkd(join(d, 'retrieval-trace.jsonl'), { recursive: true }); } },
    { name: 'hook-log-write-failed', env: {}, prompt: 'widget decision', expect: { action: 'failed', reason: 'hook-log-write-failed' }, breakHookLog: true },
  ];
  for (const b of branches) {
    const root = mkdtempSync(join(trustedTestTmpRoot(), `rh-recpt-${b.name}-`));
    // D1 fix: CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now, so
    // the log can no longer live alongside the (os.tmpdir()-rooted) store
    // fixture — isolatedHooksLog() is rooted correctly and self-tracks cleanup.
    const logFile = isolatedHooksLog();
    try {
      let store = root;
      if (b.storeless) { mkd(join(root, 'empty'), { recursive: true }); store = join(root, 'empty'); }
      else if (b.needStore !== false) makeStore(root);
      if (b.setup) b.setup(root);
      // breakHookLog needs an unwritable path that still resolves inside the
      // trusted ~/.core (else the D1 gate silently substitutes the real
      // default instead of hitting the write failure this branch tests for).
      // Nested under `root` (already mkdtemp-unique) rather than a fixed
      // name under the shared trusted-tmp root -- a fixed name collided
      // under concurrent self-invocation (5 copies of this file at once
      // all racing on the same path), a real EISDIR failure found while
      // investigating a concurrency report, 2026-07-18.
      const blockedParent = join(root, 'rh-blocked');
      const effectiveLog = b.breakHookLog ? join(blockedParent, 'hooks-log.jsonl') : logFile;
      if (b.breakHookLog) wf(blockedParent, 'not a directory');
      let run;
      if (b.directReceipt) {
        const prior = process.env.CORE_HOOKS_LOG_FILE;
        process.env.CORE_HOOKS_LOG_FILE = effectiveLog;
        try {
          const { receipt } = await import('../../plugins/core/skills/core/hooks/retrieve-context-hook.mjs');
          receipt('failed', 'pipeline-error', { cwd: store });
          run = { stderr: '' };
        } finally {
          if (prior === undefined) delete process.env.CORE_HOOKS_LOG_FILE;
          else process.env.CORE_HOOKS_LOG_FILE = prior;
        }
      } else {
        run = runHookProcess(b.prompt, { ...b.env, CORE_HOOKS_LOG_FILE: effectiveLog }, store);
      }
      // Fail-open proof for every REAL subprocess branch (not directReceipt,
      // which never launches a process): the hook contract is exit 0 always,
      // crash or not. Checked explicitly now rather than assumed from the
      // process merely producing output.
      if (!b.directReceipt) assert.equal(run.status, 0, `${b.name}: hook always exits 0 (fail-open), even on a genuine pipeline crash`);
      const rawRows = ex(logFile) ? rf(logFile, 'utf8') : run.stderr;
      const rows = rawRows.trim().split('\n').map(l => JSON.parse(l)).filter(r => r.hook === 'retrieve-context');
      assert.equal(rows.length, 1, `${b.name}: exactly one terminal row`);
      assert.equal(rows[0].action, b.expect.action, `${b.name}: action`);
      assert.equal(rows[0].reason, b.expect.reason, `${b.name}: reason`);
      assert.ok(['skip', 'delivered', 'failed'].includes(rows[0].action), `${b.name}: action in closed vocabulary`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('metrics-opt-out receipt coexists with ZERO retrieval rows (no faked telemetry)', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-recpt-optout2-')));
  // D1 fix: CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now.
  const logFile = isolatedHooksLog();
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: logFile }, root);
    assert.equal(readEventRows(root).length, 0, 'no retrieval row when metrics are off');
    assert.match(rf(logFile, 'utf8'), /"reason":"metrics-opt-out"/, 'hook-log is the authoritative receipt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Strengthened production outcome caller (Hale freeze-rejection corrections) ----
// Root-caused 2026-07-17 (the real explanation for Hale's reproduced failures
// and the GitHub CI failures, superseding an earlier partial diagnosis): the
// hook resolves harness identity from CLAUDECODE / CLAUDE_CODE_SESSION_ID /
// CODEX_SESSION_ID / CODEX_PLUGIN_ROOT in its process env. A test invoked via
// `execFileSync('node', ..., { env: { ...process.env, ... } })` inherits
// whatever the AMBIENT shell running `node --test` happens to have set —
// which is 'claude-code' on a developer's machine running inside Claude
// Code (false-positive pass), null on a clean CI runner (harness never
// resolves, pendingOutcomePath returns null, the whole mechanism silently
// no-ops — 0 rows where 1 expected), and 'codex' inside a Codex sandbox
// (mismatches the test's hardcoded 'claude-code' assertion). Strip the four
// ambient signal vars and set the harness this test suite actually means to
// exercise explicitly, so results are identical everywhere `node --test`
// runs — never a function of who/where invoked it.
function runHookWithSession(prompt, root, sessionId, env = {}) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd: root, ...(sessionId ? { session_id: sessionId } : {}) }),
    env: {
      ...process.env,
      // Strip ambient harness signals the invoking shell may carry, then set
      // the ONE this suite means to exercise — CLAUDE_CODE_SESSION_ID stays
      // unset since the hook only checks CLAUDECODE for Claude Code identity.
      CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_PLUGIN_ROOT: undefined,
      CLAUDECODE: '1',
      CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      ...env,
    },
    encoding: 'utf8',
  });
}

function readOutcomeRows(root) {
  const sess = join(root, '_sessions');
  if (!ex(sess)) return [];
  const rows = [];
  for (const d of rd(sess)) {
    const f = join(sess, d, 'outcome-log.jsonl'); // outcomes live in their own later log
    if (ex(f)) for (const l of rf(f, 'utf8').trim().split('\n')) rows.push(JSON.parse(l));
  }
  return rows.filter(r => r.kind === 'retrieval-outcome');
}

test('post-answer caller: next same-session invocation closes the previous retrieval as UNKNOWN with full identity', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-oc1-')));
  try {
    runHookWithSession('widget decision', root, 'sess-A');
    runHookWithSession('entirely different topic now', root, 'sess-A');
    const rows = readOutcomeRows(root);
    assert.equal(rows.length, 1, 'exactly one outcome row for the closed retrieval');
    const row = rows[0];
    assert.equal(row.usefulness_outcome, 'unknown', 'overlap is a provisional signal — never a harmful outcome before calibration');
    assert.ok(['corrective-retry', 'unobservable'].includes(row.evidence_authority));
    assert.equal(row.harness, 'claude-code');
    assert.equal(row.session_id, 'sess-A');
    assert.ok(row.answer_turn_id && row.producer_version && row.schema_version, 'identity fields required');
    assert.equal(row.producer_sha, 'unknown', 'the real manifest carries no git_sha yet -- honest default, not a guessed value');
    assert.notEqual(row.answer_turn_id, row.retrieval_id, 'Hale audit 2026-07-17: answer_turn_id must never alias retrieval_id — they are different concepts');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pending marker is written only AFTER delivery is confirmed — a failed delivery leaves no marker', () => {
  // Hale audit, 2026-07-17, hazard: "creates pending state before delivery."
  // CORE_RETRIEVAL_BYTE_CAP=0 forces the delivery-failed branch (selection
  // succeeds, byte-capped output delivers nothing) — before the fix, the
  // pending marker was written unconditionally once the retrieval row landed,
  // regardless of whether anything actually reached the user.
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-deferred-')));
  try {
    runHookWithSession('widget decision', root, 'sess-defer', { CORE_RETRIEVAL_BYTE_CAP: '0' });
    const lib = join(root, '_memories', '_lib');
    const pendings = ex(lib) ? rd(lib).filter(f => f.startsWith('pending-retrieval-')) : [];
    assert.equal(pendings.length, 0, 'no pending marker for content that never reached the user');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pending marker is written after a successful delivery (positive control for the deferred-write test above)', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-deferred-ok-')));
  try {
    runHookWithSession('widget decision', root, 'sess-defer-ok');
    const lib = join(root, '_memories', '_lib');
    const pendings = ex(lib) ? rd(lib).filter(f => f.startsWith('pending-retrieval-')) : [];
    assert.equal(pendings.length, 1, 'a genuinely delivered turn does leave a pending marker for the next close');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a hostile session id in the payload never escapes _memories/_lib as a filename', () => {
  // Hale audit, 2026-07-17, hazard: "unsanitized session id in a filename."
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-sanitize-')));
  try {
    runHookWithSession('widget decision', root, '../../../../etc/passwd');
    const lib = join(root, '_memories', '_lib');
    assert.ok(ex(lib), 'the pending marker landed inside _lib, not escaped elsewhere');
    const entries = rd(lib).filter(f => f.startsWith('pending-retrieval-'));
    assert.equal(entries.length, 1);
    assert.doesNotMatch(entries[0], /\.\./, 'no traversal sequence in the actual filename on disk');
    // Nothing was written outside the project root by the traversal attempt.
    assert.ok(!ex(join(root, '..', '..', '..', '..', 'etc', 'passwd-pending-retrieval-claude-code.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed outcome write never deletes the pending marker (evidence survives to retry)', () => {
  // Hale audit, 2026-07-17, hazard: "deletes pending evidence without
  // confirmed outcome persistence." Force the outcome-log write to fail by
  // making today's session directory a file instead of a directory, so
  // logEvent cannot create outcome-log.jsonl underneath it.
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-nodelete-')));
  try {
    runHookWithSession('widget decision', root, 'sess-nodelete');
    const lib = join(root, '_memories', '_lib');
    const before = rd(lib).filter(f => f.startsWith('pending-retrieval-'));
    assert.equal(before.length, 1, 'precondition: a pending marker exists to close');
    const today = new Date().toISOString().slice(0, 10);
    rmSync(join(root, '_sessions', today), { recursive: true, force: true });
    wf(join(root, '_sessions', today), 'not a directory'); // outcome-log write will fail
    runHookWithSession('entirely different topic now', root, 'sess-nodelete');
    const after = rd(lib).filter(f => f.startsWith('pending-retrieval-'));
    assert.equal(after.length, 1, 'the pending marker survives an unconfirmed/failed outcome write — evidence is never destroyed on a guess');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('post-answer caller: no session identity means NO pending state and NO outcome row (no aliasing)', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-oc2-')));
  try {
    runHookWithSession('widget decision', root, null);
    runHookWithSession('widget decision again', root, null);
    assert.equal(readOutcomeRows(root).length, 0, 'null session never aliases into an outcome');
    const lib = join(root, '_memories', '_lib');
    const pendings = ex(lib) ? rd(lib).filter(f => f.startsWith('pending-retrieval-')) : [];
    assert.equal(pendings.length, 0, 'no pending marker without a resolved session');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('post-answer caller: different sessions never close each other (keyed pending state)', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-oc3-')));
  try {
    runHookWithSession('widget decision', root, 'sess-A');
    runHookWithSession('widget decision', root, 'sess-B');
    assert.equal(readOutcomeRows(root).length, 0, 'sess-B must not close sess-A\'s retrieval');
    runHookWithSession('another topic', root, 'sess-A');
    const rows = readOutcomeRows(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'sess-A');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
