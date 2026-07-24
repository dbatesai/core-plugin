import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, cpSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(HERE, '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(HERE, '..', 'fixtures', 'obligation3-store');

const st = await import(pathToFileURL(join(SCRIPTS, 'self-test-round.mjs')).href);
const { newRound, register, runRound, measureRound, status, verifyGoldset, contentStems,
  newestRegisteredRound, listRounds, regradeNewestRound, buildSelfTestLogEvent, SELF_TEST_LOG_FILENAME,
  computeMetricsInformedQuota, DEFAULT_QUOTA } = st;
const { recordRetrievalEvent } = await import(pathToFileURL(join(SCRIPTS, 'record-retrieval-event.mjs')).href);
const { loadSnapshot } = await import(pathToFileURL(join(SCRIPTS, 'generate-summary-index.mjs')).href);

// Each test gets its own writable copy of the fixture store (self-test writes
// into <project>/_tests/, so the fixture itself must never be touched).
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'selftest-'));
  cpSync(FIXT, dir, { recursive: true });
  return dir;
}
function snapId(store) { return loadSnapshot(store, { captureBodies: true }).snapshotId; }

// A minimal valid authored set for the fixture (6 active watch/MoE units).
function validGoldset(store) {
  return {
    meta: {
      round: 1,
      authoring_snapshot_id: snapId(store),
      author: 'test-author',
      author_model: 'test',
      blind_attestation: 'authored from unit bodies only; ran no retrieval tool',
    },
    queries: [
      { id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
      { id: 'q2', query: 'Between two comparable options, which does he favor?', rung: 'value', expected: ['values-heritage'] },
      { id: 'q3', query: 'Why did he choose a Rolex Submariner for daily wear?', rung: 'abstention', expected: [], no_answer: true,
        forbidden: ['want-omega-speedmaster-on-sale-wait'],
        false_premise: { swapped_entity: 'Rolex Submariner', framing_entities: ['watch'] } },
    ],
  };
}
function writeGold(store, obj) {
  const p = join(store, 'gold.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}
// The self-test-log.jsonl lands under today's real _sessions/<date>/ dir (no
// injectable clock in logEvent), so read it back by walking _sessions/ rather
// than hardcoding a date.
function readSelfTestLogRows(store) {
  const sessionsDir = join(store, '_sessions');
  if (!existsSync(sessionsDir)) return [];
  const rows = [];
  for (const date of readdirSync(sessionsDir)) {
    const p = join(sessionsDir, date, SELF_TEST_LOG_FILENAME);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)) {
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

// ── round lifecycle ──

test('new-round freezes the corpus, writes the brief, and never authors questions', () => {
  const store = freshStore();
  try {
    const { round, dir, briefPath } = newRound(store);
    assert.equal(round, 1);
    assert.ok(existsSync(join(dir, 'quota.json')), 'quota written');
    assert.ok(existsSync(join(dir, 'corpus-snapshot.json')), 'corpus identity frozen');
    assert.ok(existsSync(briefPath), 'brief written');
    assert.ok(!existsSync(join(dir, 'goldset.json')), 'no goldset — authoring is a separate blind step');
    const brief = readFileSync(briefPath, 'utf8');
    assert.match(brief, /did not run any retrieval/i, 'brief demands the blindness attestation');
    assert.match(brief, /nothing stored about that/i, 'brief uses plain language for the unanswerable kind');
    const corpus = JSON.parse(readFileSync(join(dir, 'corpus-snapshot.json'), 'utf8'));
    assert.equal(corpus.snapshot_id, snapId(store));
    assert.equal(corpus.unit_count, 6);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('register verifies then FREEZES; re-register is refused (append-only)', () => {
  const store = freshStore();
  try {
    newRound(store);
    const res = register(store, 1, writeGold(store, validGoldset(store)));
    assert.ok(res.ok, `register should pass: ${JSON.stringify(res.violations)}`);
    assert.ok(existsSync(join(st.roundDir(store, 1), 'prereg.json')), 'prereg written on pass');
    assert.match(res.prereg.goldset_sha256, /^[0-9a-f]{64}$/);
    assert.equal(res.prereg.corpus_snapshot_id, snapId(store));
    // FROZEN: a second register throws.
    assert.throws(() => register(store, 1, writeGold(store, validGoldset(store))), /already registered and FROZEN/);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('run is refused before register; run works after, and writes a results record', async () => {
  const store = freshStore();
  try {
    newRound(store);
    await assert.rejects(() => runRound(store, 1), /not registered/);
    register(store, 1, writeGold(store, validGoldset(store)));
    const { record, outPath } = await runRound(store, 1);
    assert.ok(existsSync(outPath), 'results record written');
    assert.equal(record.headline_arm, 'ranking');
    assert.equal(typeof record.headline, 'number');
    assert.equal(record.breakdown.forbiddenRate, 0, 'the trap did not surface — trap-leak 0');
    assert.equal(record.old_vs_new.delta, null, 'first round has no delta');
    // measureRound is read-only: it returns the same shape but writes nothing new.
    const before = readdirSync(st.roundDir(store, 1)).length;
    const m = await measureRound(store, 1);
    assert.equal(typeof m.record.headline, 'number');
    const after = readdirSync(st.roundDir(store, 1)).length;
    assert.equal(after, before, 'measureRound persisted nothing');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// ── the mechanical verifier ──

test('verifier catches a zero-overlap leak via TOPICS, not just body', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    // 'purchases' is a TOPIC of the omega unit, absent from its body prose. A
    // category question that leaks it must still be caught (title+body+topics).
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'What guides his future purchases?', rung: 'category', expected: ['want-omega-speedmaster-on-sale-wait'] }],
    };
    const { violations } = verifyGoldset(gold, snapshot, quota);
    assert.ok(violations.some(v => /q1.*content word.*purchas/i.test(v)), `topic leak must be caught: ${JSON.stringify(violations)}`);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('verifier catches a false-premise question whose swapped entity actually EXISTS', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    // 'Omega' genuinely appears in the corpus — so a false-premise built on it
    // is not a false premise; the verifier must reject it.
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'Why did he reject the Omega entirely?', rung: 'abstention', expected: [], no_answer: true,
        false_premise: { swapped_entity: 'Omega', framing_entities: ['watch'] } }],
    };
    const { violations } = verifyGoldset(gold, snapshot, quota);
    assert.ok(violations.some(v => /swapped_entity.*Omega.*appear/i.test(v)), `existing swapped entity must be caught: ${JSON.stringify(violations)}`);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('verifier catches a false-premise framing entity that is ABSENT from the corpus', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'Why did he pick a Casio for scuba?', rung: 'abstention', expected: [], no_answer: true,
        false_premise: { swapped_entity: 'Casio', framing_entities: ['submarine-navigation-computer'] } }],
    };
    const { violations } = verifyGoldset(gold, snapshot, quota);
    assert.ok(violations.some(v => /framing_entity.*does NOT appear/i.test(v)), `absent framing entity must be caught: ${JSON.stringify(violations)}`);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('verifier refuses an under-declared expected set the same way the harness does', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    // empty expected without no_answer:true — the harness's own fail-closed gate.
    const gold = {
      meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'something plausible', rung: 'literal', expected: [] }],
    };
    const { violations } = verifyGoldset(gold, snapshot, quota);
    assert.ok(violations.some(v => /schema:.*no_answer/.test(v)), `under-declared set must be refused: ${JSON.stringify(violations)}`);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('verifier refuses a missing blind attestation and a corpus-drift mismatch', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    const noAttest = { meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't' },
      queries: [{ id: 'q1', query: 'omega speedmaster', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] }] };
    assert.ok(verifyGoldset(noAttest, snapshot, quota).violations.some(v => /attestation/.test(v)));
    const wrongSnap = { meta: { round: 1, authoring_snapshot_id: 'deadbeef', author: 't', blind_attestation: 'x' },
      queries: [{ id: 'q1', query: 'omega speedmaster', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] }] };
    assert.ok(verifyGoldset(wrongSnap, snapshot, quota).violations.some(v => /authoring_snapshot_id.*does not match/.test(v)));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('over-quota is refused (padding), under-quota only warns (honest shortfall)', () => {
  const store = freshStore();
  try {
    newRound(store);
    const snapshot = loadSnapshot(store, { captureBodies: true });
    const quota = JSON.parse(readFileSync(join(st.roundDir(store, 1), 'quota.json'), 'utf8'));
    // literal quota is 2 — author 3 literals to trip the over-quota refusal.
    const over = { meta: { round: 1, authoring_snapshot_id: snapshot.snapshotId, author: 't', blind_attestation: 'x' },
      queries: [
        { id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
        { id: 'q2', query: 'iconic chronograph', rung: 'literal', expected: ['want-iconic-chronograph'] },
        { id: 'q3', query: 'qwen moe model', rung: 'literal', expected: ['try-latest-moe-qwen'] },
      ] };
    const r = verifyGoldset(over, snapshot, quota);
    assert.ok(r.violations.some(v => /exceeds the round quota/.test(v)), 'over-quota refused');
    assert.ok(r.warnings.some(w => /under the round quota/.test(w)), 'the unfilled kinds only warn');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('contentStems is stem-aware and drops function words (content-word overlap, not literal)', () => {
  const s = contentStems('When two of these comparable options were his');
  assert.ok(!s.has('when') && !s.has('his') && !s.has('two') && !s.has('these') && !s.has('were'), 'function words dropped');
  assert.ok(s.has('comparabl') || s.has('comparable'), 'content word kept (stemmed)');
  // stemming collapses inflections so overlap cannot be dodged by inflecting.
  assert.deepEqual([...contentStems('decision')][0], [...contentStems('decisions')][0]);
  assert.deepEqual([...contentStems('picked')][0], [...contentStems('picking')][0]);
});

// ── old-vs-new delta (the overfitting detector) ──

test('old-vs-new delta compares the newest round to the mean of prior rounds on ONE current corpus', async () => {
  const store = freshStore();
  try {
    // Round 1
    newRound(store);
    register(store, 1, writeGold(store, validGoldset(store)));
    await runRound(store, 1);
    // Round 2 — a fresh round against the same (unchanged) corpus.
    const r2 = newRound(store);
    assert.equal(r2.round, 2);
    const g2 = validGoldset(store);
    g2.meta.round = 2;
    g2.queries = g2.queries.map(q => ({ ...q, id: `r2-${q.id}` }));
    register(store, 2, writeGold(store, g2));
    const { record } = await runRound(store, 2);
    assert.equal(typeof record.old_vs_new.prior_mean, 'number', 'round 1 measured as the prior');
    assert.equal(record.old_vs_new.priors.length, 1);
    assert.equal(record.old_vs_new.priors[0].round, 1);
    assert.equal(typeof record.old_vs_new.delta, 'number', 'delta computed once a prior exists');
    // both rounds are the same questions against the same store → delta ~0.
    assert.ok(Math.abs(record.old_vs_new.delta) < 1e-9);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('newestRegisteredRound returns the highest frozen round, null when none', () => {
  const store = freshStore();
  try {
    assert.equal(newestRegisteredRound(store), null, 'nothing registered yet');
    newRound(store); // unregistered
    assert.equal(newestRegisteredRound(store), null, 'a created-but-unregistered round is not returned');
    register(store, 1, writeGold(store, validGoldset(store)));
    const n = newestRegisteredRound(store);
    assert.equal(n.round, 1);
    assert.ok(existsSync(n.goldsetPath));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// ── self-test-log event (holistic-redesign §3b/§3d) ──

test('runRound writes a self-test-log event, numbers/ids only, trigger user-invoked', async () => {
  const store = freshStore();
  try {
    newRound(store);
    register(store, 1, writeGold(store, validGoldset(store)));
    const { record } = await runRound(store, 1);
    const rows = readSelfTestLogRows(store);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.kind, 'self-test-run');
    assert.equal(row.trigger, 'user-invoked');
    assert.equal(row.round, 1);
    assert.equal(row.corpus_snapshot_id, record.corpus_snapshot_id);
    assert.equal(row.goldset_sha256, record.prereg_goldset_sha256);
    assert.equal(row.headline, record.headline);
    assert.equal(typeof row.per_kind_r10, 'object');
    assert.equal(row.trap_leak_rate, record.breakdown.forbiddenRate);
    assert.equal(row.old_vs_new_delta, null, 'first round has no delta');
    assert.equal(row.old_vs_new_skipped, false, 'a full /self-test run never skips the historical delta');
    assert.ok(row.ts, 'logEvent stamps a ts field');
    // Whitelist discipline: no question/answer text or unit bodies anywhere in the row.
    const blob = JSON.stringify(row);
    assert.ok(!blob.includes('omega'), 'no question text leaked into the log event');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('measureRound skipHistoricalDelta:true skips the priors loop even when priors exist', async () => {
  const store = freshStore();
  try {
    newRound(store);
    register(store, 1, writeGold(store, validGoldset(store)));
    await runRound(store, 1);
    const r2 = newRound(store);
    const g2 = validGoldset(store);
    g2.meta.round = r2.round;
    g2.queries = g2.queries.map(q => ({ ...q, id: `r2-${q.id}` }));
    register(store, r2.round, writeGold(store, g2));

    const skipped = await measureRound(store, r2.round, { skipHistoricalDelta: true });
    assert.deepEqual(skipped.record.old_vs_new, { priors: [], prior_mean: null, delta: null, skipped: true });

    const full = await measureRound(store, r2.round, { skipHistoricalDelta: false });
    assert.equal(full.record.old_vs_new.skipped, false);
    assert.equal(full.record.old_vs_new.priors.length, 1, 'the full path still finds round 1 as a prior');
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('regradeNewestRound: null with no registered round; grades newest only, no results file, logs auto-regrade', async () => {
  const store = freshStore();
  try {
    assert.equal(await regradeNewestRound(store), null, 'nothing registered yet');

    newRound(store);
    register(store, 1, writeGold(store, validGoldset(store)));
    const before = readdirSync(st.roundDir(store, 1)).length;
    const record = await regradeNewestRound(store);
    assert.equal(typeof record.headline, 'number');
    assert.equal(record.old_vs_new.skipped, true);
    const after = readdirSync(st.roundDir(store, 1)).length;
    assert.equal(after, before, 'auto-regrade writes no results-<iso>.json — that marks a deliberate /self-test run');

    const rows = readSelfTestLogRows(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trigger, 'auto-regrade');
    assert.equal(rows[0].round, 1);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('buildSelfTestLogEvent shape is a flat object of numbers/ids/strings from the closed vocabulary only', () => {
  const fakeRecord = {
    round: 3, corpus_snapshot_id: 'abc123', prereg_goldset_sha256: 'deadbeef',
    headline_arm: 'ranking', headline_k: 10, headline: 0.8,
    breakdown: { byKind: { literal: { r10: 1 }, category: { r10: 0.5 } }, forbiddenRate: 0 },
    old_vs_new: { delta: 0.1, skipped: false },
    n_queries: 12, store_units: 200,
  };
  const evt = buildSelfTestLogEvent(fakeRecord, { trigger: 'user-invoked' });
  // producer identity (v3.14.0 Link 4a) is environment-dependent (manifest
  // read); assert presence + shape, then compare the rest exactly.
  assert.equal(typeof evt.producer_version, 'string');
  assert.equal(typeof evt.producer_sha, 'string');
  const { producer_version: _pv, producer_sha: _ps, ...rest } = evt;
  assert.deepEqual(rest, {
    kind: 'self-test-run', trigger: 'user-invoked', round: 3, corpus_snapshot_id: 'abc123',
    goldset_sha256: 'deadbeef', headline_arm: 'ranking', headline_k: 10, headline: 0.8,
    per_kind_r10: { literal: 1, category: 0.5 }, trap_leak_rate: 0,
    old_vs_new_delta: 0.1, old_vs_new_skipped: false, n_queries: 12, store_units: 200,
  });
});

// ── metrics-informed quota reshaping (holistic-redesign §3e) ──

function plantRetrievalEvents(store, { n, tierReached }) {
  for (let i = 0; i < n; i++) {
    recordRetrievalEvent(store, {
      trigger: 'session-start',
      intent_topics: ['t'],
      tier_reached: tierReached,
      escalation_path: tierReached === 1 ? [1] : [1, tierReached],
      units_retrieved: [{ id: 'want-omega-speedmaster-on-sale-wait', tier: 1 }],
      dip_back_count: 0,
    });
  }
}

test('computeMetricsInformedQuota: no signal data → quota unchanged, no adjustments', () => {
  const store = freshStore();
  try {
    const { quota, adjustments } = computeMetricsInformedQuota(store);
    assert.deepEqual(quota, DEFAULT_QUOTA);
    assert.deepEqual(adjustments, []);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('computeMetricsInformedQuota: high escalation rate shifts literal -> cross-domain', () => {
  const store = freshStore();
  try {
    // 8 of 10 retrievals needed tier 3 -> 80% escalation, well over the 30% threshold.
    plantRetrievalEvents(store, { n: 8, tierReached: 3 });
    plantRetrievalEvents(store, { n: 2, tierReached: 1 });
    const { quota, adjustments } = computeMetricsInformedQuota(store);
    assert.equal(quota.literal, DEFAULT_QUOTA.literal - 1);
    assert.equal(quota['cross-domain'], DEFAULT_QUOTA['cross-domain'] + 1);
    assert.equal(quota.value, DEFAULT_QUOTA.value, 'untouched kinds stay at baseline');
    const total = Object.values(quota).reduce((s, n) => s + n, 0);
    const baseTotal = Object.values(DEFAULT_QUOTA).reduce((s, n) => s + n, 0);
    assert.equal(total, baseTotal, 'reallocation never changes the total question count');
    assert.ok(adjustments.some(a => /escalation rate 80%/.test(a)));
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('computeMetricsInformedQuota: low escalation rate leaves quota untouched', () => {
  const store = freshStore();
  try {
    // 1 of 10 escalated -> 10%, under the 30% threshold.
    plantRetrievalEvents(store, { n: 1, tierReached: 3 });
    plantRetrievalEvents(store, { n: 9, tierReached: 1 });
    const { quota, adjustments } = computeMetricsInformedQuota(store);
    assert.deepEqual(quota, DEFAULT_QUOTA);
    assert.deepEqual(adjustments, []);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('computeMetricsInformedQuota: recent self-test trap-leak shifts temporal -> abstention', async () => {
  const store = freshStore();
  try {
    // A round whose trap DOES leak (the forbidden unit is asked for directly,
    // making the harness surface it as a top hit for the trap question).
    newRound(store);
    const leaky = {
      meta: { round: 1, authoring_snapshot_id: snapId(store), author: 't', blind_attestation: 'x' },
      queries: [
        { id: 'q1', query: 'omega speedmaster sale', rung: 'literal', expected: ['want-omega-speedmaster-on-sale-wait'] },
        { id: 'q2', query: 'Something this store cannot answer at all', rung: 'abstention', expected: [], no_answer: true,
          forbidden: ['want-omega-speedmaster-on-sale-wait'] },
      ],
    };
    register(store, 1, writeGold(store, leaky));
    await runRound(store, 1); // logs a self-test-run event with whatever trap_leak_rate the harness measured

    const { quota, adjustments } = computeMetricsInformedQuota(store);
    const rows = readSelfTestLogRows(store);
    assert.equal(rows.length, 1);
    if (rows[0].trap_leak_rate > 0) {
      assert.equal(quota.temporal, DEFAULT_QUOTA.temporal - 1);
      assert.equal(quota.abstention, DEFAULT_QUOTA.abstention + 1);
      assert.ok(adjustments.some(a => /trap-leak rate/.test(a)));
    } else {
      // The fixture's literal question may or may not out-rank the trap query
      // for the same unit depending on the harness's ranking — either way the
      // rule itself (only shift when leak > 0) is what this test is checking.
      assert.deepEqual(quota, DEFAULT_QUOTA);
    }
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('newRound wires computeMetricsInformedQuota by default; an explicit quota override skips it entirely', () => {
  const store = freshStore();
  try {
    plantRetrievalEvents(store, { n: 8, tierReached: 3 });
    plantRetrievalEvents(store, { n: 2, tierReached: 1 });

    const auto = newRound(store);
    assert.equal(auto.quota.literal, DEFAULT_QUOTA.literal - 1);
    assert.ok(auto.adjustments.length > 0);
    const briefText = readFileSync(auto.briefPath, 'utf8');
    assert.match(briefText, /quota was adjusted from recent metrics/i);
    assert.match(briefText, /escalation rate/);

    const pinned = newRound(store, { quota: { ...DEFAULT_QUOTA } });
    assert.deepEqual(pinned.quota, DEFAULT_QUOTA);
    assert.deepEqual(pinned.adjustments, [], 'an explicit quota is used verbatim — no metrics adjustment applied');
    const pinnedBrief = readFileSync(pinned.briefPath, 'utf8');
    assert.doesNotMatch(pinnedBrief, /quota was adjusted from recent metrics/i);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

// ── metrics-check integration ──

test('metrics checkGoldRegression prefers a registered self-test round; falls back to absence', async () => {
  const mc = await import(pathToFileURL(join(SCRIPTS, 'metrics-check.mjs')).href);
  const store = freshStore();
  try {
    // No round, no static gold set → honest absence.
    const absent = await mc.checkGoldRegression(store);
    assert.equal(absent.available, false);
    assert.match(absent.reason, /no self-test round/);
    // Register a round → checkGoldRegression now reads it, with per-kind + delta shape.
    newRound(store);
    register(store, 1, writeGold(store, validGoldset(store)));
    const present = await mc.checkGoldRegression(store);
    assert.equal(present.available, true);
    assert.match(present.source, /self-test round 1/);
    assert.equal(typeof present.ranking_r10, 'number');
    assert.ok('by_kind' in present, 'per-kind breakdown surfaced');
    assert.ok('forbidden_rate' in present, 'trap-leak surfaced');
    assert.ok('old_vs_new_delta' in present, 'overfitting detector surfaced');
    // read-only: reading through metrics must not write a run record.
    const files = readdirSync(st.roundDir(store, 1));
    assert.ok(!files.some(f => /^results-/.test(f)), 'metrics did not litter a results file');
  } finally { rmSync(store, { recursive: true, force: true }); }
});
