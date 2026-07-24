// Hook integration for the every-turn evidence layer (v3.14.0 Link 1 + 4a):
// retrieve-context-hook.mjs writes ONE evidence row per metrics-on turn, joined
// to the numbers row by retrieval_id; the rich-context stream and the
// CORE_RETRIEVAL_TRACE env stream are retired; retrieval-log rows carry
// producer identity (Link 4a).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { trustedTestTmpRoot } from './trusted-test-tmp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = join(ROOT, 'plugins', 'core', 'skills', 'core', 'hooks', 'retrieve-context-hook.mjs');
const SCRIPTS = join(ROOT, 'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(ROOT, 'tests', 'fixtures', 'obligation3-store');

const _cleanup = [];
after(() => { for (const d of _cleanup) rmSync(d, { recursive: true, force: true }); });

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-hook-store-'));
  _cleanup.push(dir);
  const store = join(dir, 'store');
  cpSync(FIXT, store, { recursive: true });
  return store;
}

function isolatedHooksLog() {
  const dir = mkdtempSync(join(trustedTestTmpRoot(), 'tc-hook-log-'));
  _cleanup.push(dir);
  return join(dir, 'hooks-log.jsonl');
}

function runHook(prompt, env, cwd) {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify({ prompt, cwd, session_id: 'tc-session-1' }),
    env: {
      ...process.env,
      CORE_METRICS_ENABLED: '1',
      CORE_TURN_CAPTURE: '',
      CORE_HOOKS_LOG_FILE: isolatedHooksLog(),
      ...env,
    },
    encoding: 'utf8',
  });
}

function evidenceRows(store) {
  const dir = join(store, '_metrics', 'turn-capture');
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

function retrievalRows(store) {
  const sessions = join(store, '_sessions');
  if (!existsSync(sessions)) return [];
  const rows = [];
  for (const d of readdirSync(sessions)) {
    const f = join(sessions, d, 'retrieval-log.jsonl');
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) rows.push(JSON.parse(line));
    }
  }
  return rows;
}

test('metrics-on turn writes an evidence row joined to the numbers row by retrieval_id', () => {
  const store = tempStore();
  runHook('omega speedmaster sale', {}, store);
  const evidence = evidenceRows(store);
  const numbers = retrievalRows(store);
  assert.equal(evidence.length, 1, 'exactly one evidence row');
  assert.equal(numbers.length, 1, 'exactly one numbers row');
  assert.equal(evidence[0].retrieval_id, numbers[0].retrieval_id);
  assert.equal(evidence[0].prompt_text, 'omega speedmaster sale');
  assert.ok(evidence[0].pack_text.length > 0, 'combined delivered pack text captured');
  assert.ok(Array.isArray(evidence[0].delivered) && evidence[0].delivered.length > 0);
  assert.ok(typeof evidence[0].delivered[0].score === 'number');
  assert.ok(Array.isArray(evidence[0].rejected_top));
  assert.ok(evidence[0].store_signature, 'store signature recorded for drift detection');
  assert.ok(evidence[0].producer_version);
  assert.ok(evidence[0].producer_sha);
});

test('CORE_TURN_CAPTURE=0 → numbers row still written, no evidence stream', () => {
  const store = tempStore();
  runHook('omega speedmaster sale', { CORE_TURN_CAPTURE: '0' }, store);
  assert.equal(retrievalRows(store).length, 1);
  assert.equal(evidenceRows(store).length, 0);
  assert.equal(existsSync(join(store, '_metrics', 'turn-capture')), false);
});

test('metrics master off → neither stream written', () => {
  const store = tempStore();
  runHook('omega speedmaster sale', { CORE_METRICS_ENABLED: '0' }, store);
  assert.equal(retrievalRows(store).length, 0);
  assert.equal(evidenceRows(store).length, 0);
});

test('Link 4a: retrieval-log rows carry producer_version and producer_sha', () => {
  const store = tempStore();
  runHook('omega speedmaster sale', {}, store);
  const [row] = retrievalRows(store);
  assert.ok(row.producer_version, 'retrieval row missing producer_version');
  assert.ok(row.producer_sha, 'retrieval row missing producer_sha');
});

test('retired: CORE_RETRIEVAL_TRACE=1 no longer writes a trace file', () => {
  const store = tempStore();
  runHook('omega speedmaster sale', { CORE_RETRIEVAL_TRACE: '1' }, store);
  const sessions = join(store, '_sessions');
  const traceFiles = existsSync(sessions)
    ? readdirSync(sessions).flatMap((d) => {
        const f = join(sessions, d, 'retrieval-trace.jsonl');
        return existsSync(f) ? [f] : [];
      })
    : [];
  assert.deepEqual(traceFiles, [], 'retrieval-trace.jsonl must not be written anymore');
});

test('retired: rich-context stream is gone from the shipped tree and the hook source', () => {
  assert.equal(existsSync(join(SCRIPTS, 'rich-context-capture.mjs')), false,
    'rich-context-capture.mjs must be deleted');
  const hookSrc = readFileSync(HOOK, 'utf8');
  assert.equal(/rich[-_]?context/i.test(hookSrc), false, 'hook must not reference rich-context');
  assert.equal(hookSrc.includes('CORE_RETRIEVAL_TRACE'), false, 'hook must not reference CORE_RETRIEVAL_TRACE');
});

test('Link 4a: self-test log rows carry producer identity', async () => {
  const mod = await import(join(SCRIPTS, 'self-test-round.mjs'));
  assert.equal(typeof mod.buildSelfTestLogEvent, 'function',
    'buildSelfTestLogEvent must be exported for stamp verification');
  const record = {
    round: 'round-001',
    corpus_snapshot_id: 'snap-1',
    prereg_goldset_sha256: 'abc',
    headline_arm: 'product',
    headline_k: 10,
    headline: 0.8,
    breakdown: { byKind: {}, forbiddenRate: 0 },
    old_vs_new: { delta: null, skipped: true },
    n_queries: 5,
    store_units: 10,
  };
  const ev = mod.buildSelfTestLogEvent(record, { trigger: 'auto-regrade' });
  assert.ok(ev.producer_version, 'self-test row missing producer_version');
  assert.ok(ev.producer_sha, 'self-test row missing producer_sha');
});
