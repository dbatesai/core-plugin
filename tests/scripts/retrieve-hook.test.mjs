import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

function runHook(prompt, env) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt }),
    // Metrics hard-off by default: the hook emits the canonical per-turn
    // retrieval event + OTel span when metrics are on (2026-07-17), and a test
    // pointed at a COMMITTED fixture store must never write telemetry into it
    // (that exact pollution shipped in a2cab1b and was cleaned up same night).
    // Tests that assert the telemetry write opt back in against temp stores.
    env: { ...process.env, CORE_METRICS_ENABLED: '0', ...env },
    encoding: 'utf8',
  });
}

test('default ON: flag unset → injects (shipped on, opt-out — G2 resolved)', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '', CORE_RETRIEVAL_STORE: FIXT });
  assert.match(out, /want-omega-speedmaster-on-sale-wait/, 'default-on hook injects with no flag set');
});

test('opt-out: CORE_RETRIEVAL_HOOK=0 → no output, exit 0', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '0', CORE_RETRIEVAL_STORE: FIXT });
  assert.equal(out.trim(), '', 'hook must be a no-op when explicitly opted out with =0');
});

test('flag ON: injects summaries for a known query', () => {
  const out = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.match(out, /want-omega-speedmaster-on-sale-wait/, 'the literal-match want should be injected');
});

test('flag ON but empty query → no crash, exit 0', () => {
  const out = runHook('', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.equal(typeof out, 'string');
});

test('output is byte-capped', () => {
  const out = runHook('watch chronograph omega speedmaster heritage agenda', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
  assert.ok(Buffer.byteLength(out, 'utf8') <= 2048, 'injected context must stay within the byte cap');
});

test('integration: bootstrap integrity marker + hook injection coexist under a combined cap', async () => {
  const { checkContextIntegrity } = await import('../../plugins/core/skills/core/scripts/check-context-integrity.mjs');
  const marker = checkContextIntegrity({ memoryBytes: 1000, projectTotalLines: 100, projectReadLines: 100 }).marker;
  const injected = runHook('omega speedmaster sale', { CORE_RETRIEVAL_HOOK: '1', CORE_RETRIEVAL_STORE: FIXT });
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
      env: { ...process.env, CORE_RETRIEVAL_STORE: dir },
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
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-hit-')));
  try {
    runHook('widget decision', { CORE_RETRIEVAL_STORE: root, CORE_METRICS_ENABLED: '1' });
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
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-nohit-')));
  try {
    runHook('zzqx unmatchable quark', { CORE_RETRIEVAL_STORE: root, CORE_METRICS_ENABLED: '1' });
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
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-optout-')));
  try {
    runHook('widget decision', { CORE_RETRIEVAL_STORE: root, CORE_METRICS_ENABLED: '0' });
    assert.equal(readEventRows(root).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('telemetry write failure is observable in the hook log, and the turn is never blocked', () => {
  const root = makeStore(mkdtempSync(join(tmpdir(), 'rh-wfail-')));
  const logFile = join(root, 'hooks-log.jsonl');
  try {
    // Force the legacy write path to fail: _sessions exists as a FILE.
    wf(join(root, '_sessions'), 'not a directory');
    const out = runHook('widget decision', { CORE_RETRIEVAL_STORE: root, CORE_METRICS_ENABLED: '1', CORE_HOOKS_LOG_FILE: logFile });
    assert.ok(typeof out === 'string', 'hook exited cleanly (fail-open)');
    assert.ok(ex(logFile), 'failure surfaced in the hook log');
    assert.match(rf(logFile, 'utf8'), /telemetry-write-failed|telemetry-error/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
