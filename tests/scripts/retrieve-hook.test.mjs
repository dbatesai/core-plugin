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
// Same manifest the shared receipt producer reads (hook-log.mjs PRODUCER_VERSION /
// PRODUCER_SHA) -- read dynamically rather than hardcode 'unknown', since a real
// release cut legitimately stamps a real source_sha into this repo's own manifest.
const EXPECTED_MANIFEST = (() => {
  try {
    return JSON.parse(rf(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch { return {}; }
})();
const EXPECTED_PRODUCER_VERSION = String(EXPECTED_MANIFEST.version || 'unknown');
const EXPECTED_PRODUCER_SHA = String(EXPECTED_MANIFEST.source_sha || 'unknown');
// CORE_RETRIEVAL_STORE is absent from the product hooks entirely — no
// legitimate production use, and its trust check was lexical-only
// (symlink-bypassable). Tests pass
// the store via `cwd` in the JSON payload, the same trusted channel the real
// harness always used — no env var, no symlink workaround needed anymore.
const FIXT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
// The committed fixture is NEVER touched by tests — even "read" paths write the
// cached index (_lib/unit-summaries.json) as a side effect, which polluted the
// committed tree (retrieval-premise.test.mjs owns this pattern; the
// fixture-cold-clean guard test enforces it). All reads run against a clone.
const FIXT = mkdtempSync(join(tmpdir(), 'obligation3-store-'));
cpSync(FIXT_SRC, FIXT, { recursive: true });
process.on('exit', () => { try { rmSync(FIXT, { recursive: true, force: true }); } catch { /* tmpdir */ } });

// Isolate every hook test log: a subprocess hook run
// that doesn't override CORE_HOOKS_LOG_FILE defaults to the real machine-wide
// ~/.core/hooks-log.jsonl (hook-log.mjs's default path) — tests writing there
// pollute the developer's real log and, under a sandboxed/CI HOME or
// concurrent test runs, can behave differently across environments. Every
// call gets its own fresh temp path unless the test explicitly needs a
// specific one (those pass CORE_HOOKS_LOG_FILE in `env`, which wins here).
// Rooted under ~/.core (fix, 2026-07-18): CORE_HOOKS_LOG_FILE now only
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

test('default ON: flag unset → injects (shipped on, opt-out)', () => {
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

test('hook output carries the authority tier for observation hits (the label must survive to the hook output)', async () => {
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

// ---- Per-turn event semantics ----
// Every field must be an OBSERVED value: ladder tier from the producing stage
// (never the unit authority tier), no fabricated escalation on empty results,
// observed query terms, correlation id, and an OBSERVABLE write outcome.
import { cpSync, mkdtempSync, rmSync, writeFileSync as wf, readFileSync as rf, readdirSync as rd, existsSync as ex, mkdirSync as mkd } from 'node:fs';
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
    // CORE_ESCALATION=0 keeps the text-only directive path under test; with
    // escalation on (the default) a zero-hit injects the shard pack instead.
    const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1', CORE_ESCALATION: '0' }, root);
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

// ABSENCE contract (2026-07-31): the preregistered three-arm efficacy pilot's
// env-var control (CORE_REASONING_ARM, with its deterministic-only / always-on
// behavioral arms) was DELETED from shipped retrieval — the pilot's frozen
// branch preserves it. Setting the var must now be indistinguishable from any
// other unknown env var: no arm resolution, no directive suppression or
// forcing, no explicit-set receipt fields, no crash.

test('absence: CORE_REASONING_ARM no longer suppresses the zero-hit directive (former deterministic-only arm is gone)', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-arm-det-')));
  try {
    const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1', CORE_REASONING_ARM: 'deterministic-only', CORE_ESCALATION: '0' }, root);
    assert.match(out, /CORE reasoning escalation required/, 'the true zero-hit directive fires regardless of the deleted control');
    const [evt] = readEventRows(root);
    assert.equal(evt.result, 'no-hit');
    assert.equal(evt.requested_arm, undefined, 'no pilot receipt fields survive the deletion');
    assert.equal(evt.directive_fired, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('absence: CORE_REASONING_ARM no longer forces the directive on a real hit (former always-on arm is gone)', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-arm-always-')));
  try {
    const out = runHook('widget decision', { CORE_METRICS_ENABLED: '1', CORE_REASONING_ARM: 'always-on' }, root);
    assert.match(out, /widget/i, 'the real hit content is delivered as usual');
    assert.doesNotMatch(out, /CORE reasoning escalation required/, 'no forced escalation — the directive only ever fires on a true zero-hit now');
    const [evt] = readEventRows(root);
    assert.equal(evt.requested_arm, undefined);
    assert.equal(evt.directive_fired, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('absence: an arbitrary CORE_REASONING_ARM value never crashes the hook — it is an ordinary unknown env var now', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-arm-garbage-')));
  const logFile = isolatedHooksLog();
  try {
    const child = runHookProcess('widget decision', { CORE_METRICS_ENABLED: '1', CORE_REASONING_ARM: 'not-a-real-arm', CORE_HOOKS_LOG_FILE: logFile }, root);
    assert.equal(child.status, 0);
    assert.match(child.stdout, /widget/i, 'delivery is unaffected — the fail-closed arm validation is gone with the arms');
    const rows = rf(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.hook === 'retrieve-context');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'delivered', 'a garbage value in the deleted control no longer produces a pipeline-error receipt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('absence: shipped retrieval source carries no pilot-arm mechanism at all', () => {
  const src = rf(HOOK, 'utf8');
  assert.doesNotMatch(src, /CORE_REASONING_ARM|deterministic-only|always-on/, 'the env-var arms live only on the pilot\'s frozen branch, never in shipped retrieval');
});

// UTF-8 byte cap: buildFinalContextPack budgets the pack in real UTF-8 bytes
// (Buffer.byteLength) and the hook's directive path truncates with
// truncateUtf8 — a real byte offset backed off to a complete-sequence
// boundary. A dense-emoji unit body pushes the pack right up against the cap,
// so a byte-unaware truncation anywhere on the delivery path would either
// exceed the budget or split a surrogate pair mid-sequence.
test('K-series UTF-8 fix: dense multi-byte content stays within the real byte budget with no corrupted (replacement-char) truncation', () => {
  const root = mkdtempSync(join(trustedTestTmpRoot(), 'rh-utf8-'));
  const store = join(root, '_memories');
  mkd(store, { recursive: true });
  wf(join(root, 'PROJECT.md'), '# T\n');
  // 600 four-byte emoji = 2400 raw UTF-8 bytes in the body alone — comfortably
  // past the 2048 cap on its own, entirely multi-byte, so any byte-unaware
  // truncation is very likely to land mid-character.
  const emojiFiller = '🎯'.repeat(600);
  wf(join(store, 'dc-1-widget.md'),
    `---\nid: dc-1-widget\ntype: decision\nstatus: active\ncreated: 2026-07-01\ntopics:\n  - widget\n---\n\nWidget decision body. ${emojiFiller}\n`);
  try {
    const out = runHook('widget decision', { CORE_METRICS_ENABLED: '0' }, root);
    assert.match(out, /dc-1-widget/, 'the dense unit is still delivered, not silently dropped by the budget');
    assert.ok(Buffer.byteLength(out, 'utf8') <= 2048, `delivered payload must respect the real UTF-8 byte budget (got ${Buffer.byteLength(out, 'utf8')} bytes)`);
    assert.ok(!out.includes('�'), 'no replacement-character corruption from a mid-sequence split');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('metrics opt-out means zero telemetry rows', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-optout-')));
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '0' }, root);
    assert.equal(readEventRows(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The directive_fired ordering
// fix moved directive construction inside the metricsEnabled() branch, which
// meant CORE_METRICS_ENABLED=0 silently suppressed the Tier 3 escalation
// directive itself -- not just its telemetry row. Opting out of telemetry
// must never change what the user's turn actually receives. These two prove
// the delivered directive is independent of the metrics flag; none of the
// tests above this point combined metrics-off with a case that should still
// escalate, which is exactly why this regression shipped once already.

test('metrics-off automatic zero-hit still escalates (telemetry opt-out must not suppress retrieval behavior)', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-optout-zerohit-')));
  try {
    const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '0' }, root);
    assert.match(out, /CORE memory escalation:/, 'the escalation pack must still fire with metrics off');
    assert.equal(readEventRows(root).length, 0, 'no telemetry row, but the delivered content is unaffected');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('telemetry write failure is observable in the hook log, and the turn is never blocked', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-wfail-')));
  // CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now, so the
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
    // The branch above only ever calls receipt()
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
    { name: 'hook-log-write-failed', env: {}, prompt: 'widget decision', expect: { action: 'failed', reason: 'hook-log-write-failed' }, breakHookLog: true },
  ];
  for (const b of branches) {
    const root = mkdtempSync(join(trustedTestTmpRoot(), `rh-recpt-${b.name}-`));
    // CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now, so
    // the log can no longer live alongside the (os.tmpdir()-rooted) store
    // fixture — isolatedHooksLog() is rooted correctly and self-tracks cleanup.
    const logFile = isolatedHooksLog();
    try {
      let store = root;
      if (b.storeless) { mkd(join(root, 'empty'), { recursive: true }); store = join(root, 'empty'); }
      else if (b.needStore !== false) makeStore(root);
      if (b.setup) b.setup(root);
      // breakHookLog needs an unwritable path that still resolves inside the
      // trusted ~/.core (else the gate silently substitutes the real
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
  // CORE_HOOKS_LOG_FILE only honors paths inside ~/.core now.
  const logFile = isolatedHooksLog();
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: logFile }, root);
    assert.equal(readEventRows(root).length, 0, 'no retrieval row when metrics are off');
    assert.match(rf(logFile, 'utf8'), /"reason":"metrics-opt-out"/, 'hook-log is the authoritative receipt');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Packaged producer identity on every receipt ----
// The shared receipt producer (hook-log.mjs) reads the plugin manifest ONCE
// and stamps producer_version + producer_sha on EVERY hook-log row, so any
// receipt can be bound to the exact shipped build that wrote it. Proven
// through the real subprocess path here, not just the library call.
test('every terminal receipt carries the packaged producer identity from the plugin manifest', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-producer-')));
  const logFile = isolatedHooksLog();
  try {
    runHook('widget decision', { CORE_METRICS_ENABLED: '0', CORE_HOOKS_LOG_FILE: logFile }, root);
    const rows = rf(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.hook === 'retrieve-context');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].producer_version, EXPECTED_PRODUCER_VERSION, 'receipt version comes from the manifest, never a fork');
    assert.equal(rows[0].producer_sha, EXPECTED_PRODUCER_SHA, 'receipt sha echoes manifest.source_sha (or the honest unknown)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// ---- Outcome-pipeline residue absence ----
// The per-turn pending-marker + inferred outcome close was DELETED along with
// record-retrieval-outcome.mjs (no importer remains); retrieval injection is
// unchanged. Two same-session runs must leave no pending marker and no
// outcome row anywhere in the store.
test('absence: no pending marker and no outcome row — the outcome pipeline is gone, injection is intact', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-residue-')));
  try {
    const runWithSession = (prompt) => execFileSync('node', [HOOK], {
      input: JSON.stringify({ prompt, cwd: root, session_id: 'sess-residue' }),
      env: {
        ...process.env,
        // Strip ambient harness signals, declare claude-code explicitly, so
        // the result is identical anywhere `node --test` runs.
        CLAUDE_CODE_SESSION_ID: undefined, CODEX_SESSION_ID: undefined, CODEX_PLUGIN_ROOT: undefined,
        CLAUDECODE: '1', CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      },
      encoding: 'utf8',
    });
    const first = runWithSession('widget decision');
    assert.match(first, /dc-1-widget/, 'injection itself is fully intact');
    runWithSession('entirely different topic now');
    const lib = join(root, '_memories', '_lib');
    const pendings = ex(lib) ? rd(lib).filter((f) => f.startsWith('pending-retrieval-')) : [];
    assert.deepEqual(pendings, [], 'no per-turn pending marker is ever written');
    const sess = join(root, '_sessions');
    const outcomeRows = [];
    if (ex(sess)) {
      for (const d of rd(sess)) {
        const f = join(sess, d, 'outcome-log.jsonl');
        if (ex(f)) for (const l of rf(f, 'utf8').trim().split('\n')) outcomeRows.push(JSON.parse(l));
      }
    }
    assert.deepEqual(outcomeRows, [], 'no retrieval-outcome rows are ever produced by the hook');
    assert.equal(readEventRows(root).length, 2, 'the canonical per-turn retrieval events still land');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('absence: no outcome-pipeline residue in the hook source, and the recorder module is deleted', () => {
  const src = rf(HOOK, 'utf8');
  assert.doesNotMatch(src, /recordRetrievalOutcome|pendingOutcomePath|pending-retrieval-/, 'no import or mechanism reference survives');
  const recorder = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
    'plugins', 'core', 'skills', 'core', 'scripts', 'record-retrieval-outcome.mjs');
  assert.ok(!ex(recorder), 'record-retrieval-outcome.mjs is gone from the shipped tree');
});

// Reasoning escalation (S2): on a thin or empty keyword result the hook injects the
// first two candidate shards (id — summary) so the active model reasons over them.

test('escalation: a zero-hit injects the shard pack; CORE_ESCALATION=0 restores the text directive', () => {
  const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1' });
  assert.match(out, /^CORE memory escalation:/m, 'pack header present');
  assert.match(out, /^values-heritage — /m, 'a fixture unit appears as an id — summary row');
  assert.doesNotMatch(out, /CORE reasoning escalation required/, 'the pack replaces the directive');
  assert.ok(Buffer.byteLength(out, 'utf8') <= 32768, 'pack inside its own cap');
  const rows = readEventRows(FIXT).slice(-1);
  assert.equal(rows[0].result, 'no-hit', 'the substrate still reports an honest no-hit');
  assert.equal(rows[0].escalation, 'shards');
  assert.ok(Number.isInteger(rows[0].shard_rows) && rows[0].shard_rows > 0);

  const off = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1', CORE_ESCALATION: '0' });
  assert.match(off, /CORE reasoning escalation required/);
  assert.doesNotMatch(off, /CORE memory escalation:/);
  const offRows = readEventRows(FIXT).slice(-1);
  assert.equal(offRows[0].escalation, 'directive');
  assert.equal(offRows[0].shard_rows, undefined);
});

test('escalation: a literal prompt gets the ordinary pack only, event escalation none', () => {
  const out = runHook('speedmaster', { CORE_METRICS_ENABLED: '1' });
  assert.match(out, /speedmaster/i, 'ordinary pack delivered');
  assert.doesNotMatch(out, /CORE memory escalation:/);
  const evt = readEventRows(FIXT).at(-1);
  assert.equal(evt.escalation, 'none');
  assert.equal(evt.shard_rows, undefined);
});

test('escalation: an abstract question with a flat ranking gets ordinary pack + shard pack', () => {
  // Terms that each touch several fixture units with no clear winner.
  const q = 'should I keep waiting on the watch purchase decision or move on?';
  const out = runHook(q, { CORE_METRICS_ENABLED: '1' });
  const evt = readEventRows(FIXT).at(-1);
  if (evt.result === 'no-hit') return; // ranking-dependent; the zero-hit test covers this branch
  assert.match(out, /CORE memory escalation:/, 'pack follows the ordinary pack on a thin result');
  assert.ok(out.indexOf('CORE memory escalation:') > 0, 'ordinary pack comes first');
  assert.equal(evt.escalation, 'shards');
  assert.ok(Number.isInteger(evt.shard_rows) && evt.shard_rows > 0);
});

test('escalation: a large store with no enrichment gets the directive, event escalation unenriched', () => {
  const root = makeStore(mkdtempSync(join(trustedTestTmpRoot(), 'rh-unenriched-')));
  try {
    // 200 active units, none enriched: two shards of 80 are not exhaustive and the
    // order would be substrate order — the pack is gated off.
    for (let i = 0; i < 200; i++) {
      wf(join(root, '_memories', `obs-filler-${i}.md`), `---\nid: obs-filler-${i}\ntype: observation\nstatus: active\ncreated: 2026-07-03\ntopics:\n  - filler${i}\n---\n\nFiller body number ${i}.\n`);
    }
    const out = runHook('zzqx unmatchable quark', { CORE_METRICS_ENABLED: '1' }, root);
    assert.match(out, /CORE reasoning escalation required/);
    assert.doesNotMatch(out, /CORE memory escalation:/);
    const evt = readEventRows(root).at(-1);
    assert.equal(evt.escalation, 'unenriched');
    assert.equal(evt.shard_rows, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
