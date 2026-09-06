import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');
// The committed fixture is never touched — reads write the cached index as a side effect.
const FIXT = mkdtempSync(join(tmpdir(), 'obligation3-store-'));
cpSync(FIXT_SRC, FIXT, { recursive: true });
process.on('exit', () => { try { rmSync(FIXT, { recursive: true, force: true }); } catch { /* tmpdir */ } });

const { thinSignal, shouldEscalate, escalationThresholds, isQuestionPrompt } =
  await import(pathToFileURL(join(SCRIPTS, 'reasoning-shortlist.mjs')).href);

test('thinSignal: a literal question has one clear keyword winner and is not thin', () => {
  const s = thinSignal('Is the Omega Speedmaster on sale yet?', FIXT);
  assert.ok(s.qterms >= 3);
  assert.equal(s.isQuestion, true);
  assert.ok(s.flatTop < 0.8, `literal flatTop ${s.flatTop} should sit under the floor`);
  assert.equal(s.zeroHit, false);
  assert.equal(shouldEscalate(s), false);
});

test('thinSignal: an abstract question with no shared words has a flat top and escalates', () => {
  const q = 'Should I lean toward things that were the very first of their kind and carry a long story behind whoever built them?';
  const s = thinSignal(q, FIXT);
  assert.ok(s.qterms >= 4, `qterms ${s.qterms}`);
  assert.equal(s.isQuestion, true);
  assert.ok(s.flatTop >= 0.8, `abstract flatTop ${s.flatTop} should clear the floor`);
  assert.equal(shouldEscalate(s), true);
});

test('shouldEscalate: commands and short prompts never escalate; a real zero-hit does', () => {
  assert.equal(shouldEscalate({ qterms: 5, isQuestion: false, top: 12, flatTop: 0.96, zeroHit: false }), false, 'a command with a flat top is still a command');
  assert.equal(shouldEscalate({ qterms: 2, isQuestion: true, top: 5, flatTop: 0.99, zeroHit: false }), false, 'too few terms');
  assert.equal(shouldEscalate({ qterms: 3, isQuestion: false, top: 0, flatTop: 1, zeroHit: true }), true, 'zero-hit');
  assert.equal(shouldEscalate({ qterms: 9, isQuestion: true, top: 19, flatTop: 0.6, zeroHit: false }), false, 'clear winner');
});

test('isQuestionPrompt: question words, trailing ?, and should-I shapes; commands are not questions', () => {
  assert.equal(isQuestionPrompt('Should we bring Chroma in for similarity lookups?'), true);
  assert.equal(isQuestionPrompt('Tests are green on my laptop; can I call this finished'), true);
  assert.equal(isQuestionPrompt('update the changelog for the release and push next'), false);
  assert.equal(isQuestionPrompt('/finalize'), false);
});

test('escalationThresholds: env overrides are numeric and fall back to defaults on garbage', () => {
  process.env.CORE_ESCALATION_MIN_TERMS = '5'; process.env.CORE_ESCALATION_FLAT_FLOOR = 'abc';
  const t = escalationThresholds();
  assert.equal(t.minTerms, 5); assert.equal(t.flatFloor, 0.8);
  delete process.env.CORE_ESCALATION_MIN_TERMS; delete process.env.CORE_ESCALATION_FLAT_FLOOR;
});

const { buildReasoningShards } = await import(pathToFileURL(join(SCRIPTS, 'reasoning-shortlist.mjs')).href);
const { writeEnrichment } = await import(pathToFileURL(join(SCRIPTS, 'enrichment-sidecar.mjs')).href);
const { selectCandidateShards } = await import(pathToFileURL(join(SCRIPTS, 'select-relevant-units.mjs')).href);

test('buildReasoningShards: without a sidecar the order equals the exhaustive shard plan and covers every unit once', () => {
  const q = 'something with no keyword overlap at all zzqx';
  const mine = buildReasoningShards(q, FIXT, { shards: 10, shardSize: 3 });
  const theirs = selectCandidateShards(q, FIXT, { shardSize: 3 });
  assert.deepEqual(mine.flatMap(s => s.rows.map(r => r.id)), theirs.flatMap(s => s.candidates.map(c => c.id)));
  const ids = mine.flatMap(s => s.rows.map(r => r.id));
  assert.equal(new Set(ids).size, ids.length, 'no unit appears twice');
  assert.equal(ids.length, mine[0].units_total, 'every active unit appears once');
  assert.equal(mine[0].shard_count, theirs[0].shard_count);
});

test('buildReasoningShards: an enrichment record that matches the prompt pulls its unit to the front of shard 0', () => {
  const store = mkdtempSync(join(tmpdir(), 'obligation3-enriched-'));
  cpSync(FIXT_SRC, store, { recursive: true });
  writeEnrichment(store, {
    unitPath: 'values-heritage.md', writerModelFamily: 'openai', answerModelFamily: 'anthropic',
    likelyQuestions: ['should I lean toward things that were the first of their kind and carry a long story behind whoever built them'],
  });
  const q = 'Should I lean toward things that were the very first of their kind and carry a long story behind whoever built them?';
  const shards = buildReasoningShards(q, store, { shards: 1, shardSize: 3 });
  assert.equal(shards[0].rows[0].id, 'values-heritage');
  assert.ok(shards[0].rows[0].summary.length <= 160);
  assert.ok(shards[0].rows.every(r => typeof r.tier === 'string'));
  rmSync(store, { recursive: true, force: true });
});

const { renderEscalationPack, ESCALATION_HEADER, escalationByteCap, ESCALATION_BYTE_CAP } =
  await import(pathToFileURL(join(SCRIPTS, 'reasoning-shortlist.mjs')).href);

test('renderEscalationPack: header + one row per unit, never split mid-row, honest truncated flag', () => {
  const shards = [{ shard: 0, shard_count: 1, units_total: 3, rows: [
    { id: 'a', tier: 'canonical', summary: 'alpha summary' },
    { id: 'b', tier: 'canonical', summary: 'béta summary with ünïcode' },
    { id: 'c', tier: 'observation', summary: 'gamma' } ] }];
  const full = renderEscalationPack(shards, { byteCap: 100000 });
  assert.ok(full.text.startsWith(ESCALATION_HEADER));
  assert.equal(full.rows, 3); assert.equal(full.truncated, false);
  assert.match(full.text, /^b — béta summary with ünïcode$/m);
  const tight = renderEscalationPack(shards, { byteCap: Buffer.byteLength(ESCALATION_HEADER, 'utf8') + 20 });
  assert.equal(tight.truncated, true);
  assert.ok(tight.rows < 3);
  assert.ok(Buffer.byteLength(tight.text, 'utf8') <= Buffer.byteLength(ESCALATION_HEADER, 'utf8') + 20 + 1);
  for (const line of tight.text.split('\n').slice(1)) if (line) assert.match(line, /^[^ ]+ — .+$/, 'every emitted row is complete');
});

test('escalationByteCap: env can only lower the cap', () => {
  process.env.CORE_ESCALATION_BYTE_CAP = '999999'; assert.equal(escalationByteCap(), ESCALATION_BYTE_CAP);
  process.env.CORE_ESCALATION_BYTE_CAP = '4096'; assert.equal(escalationByteCap(), 4096);
  process.env.CORE_ESCALATION_BYTE_CAP = 'nope'; assert.equal(escalationByteCap(), ESCALATION_BYTE_CAP);
  delete process.env.CORE_ESCALATION_BYTE_CAP;
});

// Trigger bounds (Critic phase-2 change 1): pasted content and compaction
// continuations never fire; a one-word or slash-command zero-hit never fires.

test('shouldEscalate: prompts above maxTerms never fire, however flat the ranking', () => {
  const t = escalationThresholds();
  assert.equal(t.maxTerms, 40);
  assert.equal(shouldEscalate({ qterms: 41, isQuestion: true, flatTop: 0.99, zeroHit: false }, t), false);
  assert.equal(shouldEscalate({ qterms: 40, isQuestion: true, flatTop: 0.99, zeroHit: false }, t), true);
  assert.equal(shouldEscalate({ qterms: 900, isQuestion: true, flatTop: 0.9, zeroHit: true }, t), false, 'a pasted zero-hit wall of text is not a memory question');
});

test('shouldEscalate: a zero-hit fires only for a real prompt — not one term, not a slash command', () => {
  const t = escalationThresholds();
  assert.equal(shouldEscalate(thinSignal('ed', FIXT), t), false);
  assert.equal(shouldEscalate(thinSignal('/finalize', FIXT), t), false);
  assert.equal(shouldEscalate(thinSignal('zzqx unmatchable quark', FIXT), t), true);
});

// Coverage gate (Critic phase-2 change 2): the shard order only carries the
// measured lift when the store is enriched; an unenriched store pays the pack
// cost for substrate order. The pack still goes out when it is exhaustive —
// two shards already cover every active unit — because then order is moot.

test('packAllowed: exhaustive pack on a small unenriched store; large unenriched store is gated off; enriched large store allowed', async () => {
  const { packAllowed, enrichmentCoverage } = await import(pathToFileURL(join(SCRIPTS, 'reasoning-shortlist.mjs')).href);
  const cov = enrichmentCoverage(FIXT);
  assert.equal(cov.covered, 0); assert.ok(cov.total >= 6);
  assert.equal(packAllowed(FIXT, { shards: 2, shardSize: 80 }).allowed, true, 'six units fit in one shard: exhaustive');
  assert.equal(packAllowed(FIXT, { shards: 2, shardSize: 2 }).allowed, false, 'three shards needed, no enrichment: gated');
  const fake = { index: { units: Array.from({ length: 200 }, (_, i) => ({ id: `u${i}` })) }, enrichments: { documents: Array.from({ length: 120 }, (_, i) => ({ id: `u${i}` })) } };
  assert.equal(packAllowed(FIXT, { shards: 2, shardSize: 80, snapshot: fake }).allowed, true, '60% enriched: allowed');
  fake.enrichments.documents.length = 80;
  const r = packAllowed(FIXT, { shards: 2, shardSize: 80, snapshot: fake });
  assert.equal(r.allowed, false, '40% enriched: gated');
  assert.equal(r.reason, 'unenriched');
});
