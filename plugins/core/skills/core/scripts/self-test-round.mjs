/**
 * self-test-round.mjs — round management for the blind memory self-test.
 *
 * The internal self-test a project runs on its OWN memory store. It has three
 * moving parts, and this script owns the two that must be mechanical:
 *
 *   1. new-round  — snapshot the corpus identity, emit a blind-authoring BRIEF
 *                   (which question kinds, how many of each, the zero-overlap
 *                   rules, the deliberately-unanswerable recipes). It does NOT
 *                   author questions — a separate BLIND agent session does that,
 *                   reading only unit bodies, never the retrieval code.
 *   2. register   — mechanically VERIFY an authored question set against the
 *                   frozen corpus (schema, zero-overlap incl. topics, the
 *                   false-premise entity checks, per-kind counts, blind
 *                   attestation, corpus identity), then PRE-REGISTER it: record
 *                   the question-set hash + corpus snapshot id + timestamp and
 *                   FREEZE the round. A registered round is append-only — a new
 *                   round is the only way to add questions.
 *   3. run        — run the REAL retrieval-harness.mjs against the frozen set,
 *                   report the per-kind breakdown, this round's headline, and
 *                   the old-vs-new delta across rounds (the overfitting detector).
 *   + status      — rounds, their freshness, headline history, delta trend.
 *
 * What is mechanical (this script) vs protocol (the /self-test skill): this
 * script enforces everything a machine can check without trusting the author.
 * It CANNOT prove the author was blind — that the author never ran a retrieval
 * tool is a protocol property the skill orchestrates; this script checks only
 * that the required blindness attestation is present in the question-set header.
 *
 * The measurement instrument is retrieval-harness.mjs — this script wraps it
 * with round bookkeeping; it is not a second scorer.
 *
 * Layout (append-only): <project>/_tests/self-test/round-<N>/
 *   quota.json           — the per-kind quota + rules for this round (new-round)
 *   corpus-snapshot.json — frozen corpus identity: snapshot id, unit count, ids
 *   brief.md             — the blind-authoring brief handed to the author
 *   goldset.json         — the frozen, verified question set (register)
 *   prereg.json          — the pre-registration record (register); its presence
 *                          means FROZEN
 *   results-<iso>.json   — one per run (run)
 *
 * CLI:
 *   node self-test-round.mjs new-round <project>
 *   node self-test-round.mjs register <project> <round> <goldset-file>
 *   node self-test-round.mjs run       <project> <round>
 *   node self-test-round.mjs status    <project>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadSnapshot } from './generate-summary-index.mjs';
import { runHarness, validateGold } from './retrieval-harness.mjs';

// ---- the question-kind vocabulary + default per-round quota ----
// The kinds are the shipped harness rungs plus the two the field treats as
// table stakes (temporal, abstention). The weighting leans toward the indirect
// kinds — the direct kind is near-ceiling and kept only as a regression canary.
export const DEFAULT_QUOTA = Object.freeze({
  literal: 2,      // shares surface words with its answer — a lexical retriever should hit it
  category: 3,     // names a specific instance; the answer states the covering general fact
  value: 3,        // a concrete situation; the answer is a value/principle that applies
  'cross-domain': 2, // an indirect/agenda hook; relevance is situational, not lexical
  temporal: 1,     // ordering / what-was-true-when / what-changed
  abstention: 1,   // deliberately unanswerable — the right behavior is "nothing stored about that"
});

// Kinds whose questions must share ZERO content words with their answer unit's
// full text (title + body + topics). literal is allowed to overlap by design;
// temporal phrases in the answer's own vocabulary by design; abstention has no
// answer to overlap with.
export const OVERLAP_REQUIRED = new Set(['category', 'value', 'cross-domain']);

const SELF_TEST_DIRNAME = 'self-test';

// ---- paths ----
export function selfTestDir(project) {
  return join(resolve(project), '_tests', SELF_TEST_DIRNAME);
}
export function roundDir(project, round) {
  return join(selfTestDir(project), `round-${round}`);
}
export function listRounds(project) {
  const base = selfTestDir(project);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map(d => (d.match(/^round-(\d+)$/) || [])[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
}

// ---- corpus identity from the shared snapshot loader ----
function captureCorpusIdentity(project) {
  const snapshot = loadSnapshot(resolve(project), { captureBodies: true });
  return {
    snapshot,
    identity: {
      snapshot_id: snapshot.snapshotId,
      unit_count: snapshot.index.units.length,
      unit_ids: snapshot.index.units.map(u => u.id).sort(),
      captured_at: new Date().toISOString(),
    },
  };
}

// The zero-overlap rule is about CONTENT words, so the overlap check filters a
// fuller function-word list than bm25's deliberately-minimal ranking STOPWORDS
// (which keeps words like "when"/"which"/"one" because they carry ranking
// signal). Reusing that thin list here would flag two questions as "overlapping"
// on shared function words alone — not what content-word overlap means.
// Genuine function words only — NOT content verbs. Deliberately excludes words
// like want/pick/store/use: those carry meaning, so an overlap on them is a real
// overlap the zero-overlap rule must still catch.
export const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'nor', 'so', 'yet', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'without', 'from', 'into', 'onto', 'over', 'under', 'about', 'above', 'below',
  'up', 'down', 'out', 'off', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'do', 'does', 'did', 'doing', 'have', 'has', 'had', 'having', 'will', 'would', 'shall',
  'should', 'can', 'could', 'may', 'might', 'must', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'by', 'he', 'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'we',
  'us', 'our', 'you', 'your', 'i', 'me', 'my', 'who', 'whom', 'whose', 'which', 'what',
  'when', 'where', 'why', 'how', 'if', 'then', 'than', 'else', 'while', 'because', 'though',
  'although', 'not', 'no', 'yes', 'all', 'any', 'some', 'each', 'every', 'one', 'two', 'both',
  'few', 'more', 'most', 'other', 'such', 'only', 'just', 'also', 'very', 'too', 'much',
  'many', 'own', 'same', 'here', 'there', 'now', 'again', 'once', 'ever',
  'himself', 'herself', 'itself', 'themselves', 'whats', 'lets',
]);
// A stem-aware token set for the overlap check. A light suffix strip catches
// store/storage, pick/picked/picking as the same content word so the zero-overlap
// rule can't be dodged by inflection.
const _SUFFIXES = ['ations', 'ation', 'ings', 'ing', 'edly', 'ness', 'ment', 'ions', 'ion', 'ees', 'ers', 'er', 'ed', 'es', 'ly', 's'];
export function lightStem(tok) {
  let t = tok;
  for (const suf of _SUFFIXES) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) { t = t.slice(0, -suf.length); break; }
  }
  return t;
}
export function contentStems(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/)
      .filter(t => t && t.length > 2 && !FUNCTION_WORDS.has(t))
      .map(lightStem),
  );
}

// ============================================================
// new-round — snapshot the corpus, emit the blind-authoring brief.
// ============================================================
export function newRound(project, { quota = DEFAULT_QUOTA } = {}) {
  const root = resolve(project);
  if (!existsSync(join(root, '_memories'))) {
    throw new Error(`no _memories/ store at ${root} — nothing to author a self-test against`);
  }
  const round = (listRounds(project).slice(-1)[0] || 0) + 1;
  const dir = roundDir(project, round);
  mkdirSync(dir, { recursive: true });

  const { identity } = captureCorpusIdentity(project);
  const quotaRecord = {
    round,
    project: root,
    created_at: identity.captured_at,
    authoring_snapshot_id: identity.snapshot_id,
    unit_count: identity.unit_count,
    quota,
    overlap_required_kinds: [...OVERLAP_REQUIRED],
  };
  writeFileSync(join(dir, 'quota.json'), JSON.stringify(quotaRecord, null, 2));
  writeFileSync(join(dir, 'corpus-snapshot.json'), JSON.stringify(identity, null, 2));
  const brief = renderBrief(quotaRecord);
  writeFileSync(join(dir, 'brief.md'), brief);

  return { round, dir, briefPath: join(dir, 'brief.md'), identity, quota };
}

function renderBrief(q) {
  const total = Object.values(q.quota).reduce((s, n) => s + n, 0);
  const lines = [];
  lines.push(`# Blind authoring brief — self-test round ${q.round}`);
  lines.push('');
  lines.push(`Corpus frozen for this round: **${q.unit_count} active units**, snapshot \`${q.authoring_snapshot_id.slice(0, 12)}…\`.`);
  lines.push(`You must author against THIS corpus — do not let the store change under you.`);
  lines.push('');
  lines.push('## The rules that make this a blind test');
  lines.push('');
  lines.push('1. You may READ unit files only. You may NOT run any retrieval, search, or');
  lines.push('   scoring tool, and you may not look at the retrieval code. You are proving');
  lines.push('   the memory can be FOUND from a natural question — running the finder would');
  lines.push('   defeat the point. State plainly in your output header that you did not run');
  lines.push('   any retrieval tool (this attestation is required; the set is refused without it).');
  lines.push('2. Every question is a natural one-sentence hook, the length a person types');
  lines.push('   mid-conversation. No test-ese, no compound questions.');
  lines.push('3. For the indirect kinds (category, value, cross-domain) the question must share');
  lines.push('   ZERO content words with its answer unit — checked against the unit title, body,');
  lines.push('   AND its topics. The only bridge allowed is world knowledge, not shared words.');
  lines.push('4. Name the exact answer unit id(s) for each question. Prefer one primary answer.');
  lines.push('');
  lines.push(`## Author exactly ${total} questions, in this mix`);
  lines.push('');
  lines.push('| kind | count | what it is |');
  lines.push('|---|---|---|');
  const KIND_DESC = {
    literal: 'shares obvious words with its answer — a plain keyword hit',
    category: 'names a specific instance; the answer states the covering general fact; zero shared words',
    value: 'a concrete situation; the answer is a value or principle that applies; zero shared words',
    'cross-domain': 'an indirect/agenda-style hook; relevant through reasoning, not keywords',
    temporal: 'asks about order or change over time ("what did we decide before X", "what changed about Y")',
    abstention: 'deliberately UNANSWERABLE by this store — the right behavior is saying "nothing stored about that"',
  };
  for (const [kind, n] of Object.entries(q.quota)) {
    lines.push(`| ${kind} | ${n} | ${KIND_DESC[kind] || ''} |`);
  }
  lines.push('');
  lines.push('## The two special kinds');
  lines.push('');
  lines.push('**Questions with no answer in the store (abstention).** Write a plausible-sounding');
  lines.push('question this store genuinely cannot answer. Leave `expected` empty and set');
  lines.push('`no_answer: true`. In `forbidden`, list the 1–3 units a finder would most plausibly');
  lines.push('return by mistake (the traps). Success is those traps staying out of the top results.');
  lines.push('');
  lines.push('**False-premise questions (a stronger kind of unanswerable).** Take a real thing the');
  lines.push('store DOES discuss, and ask a question that swaps in a plausible sibling the store never');
  lines.push('mentions — e.g. asking why a choice was made that was never actually made. Set');
  lines.push('`no_answer: true`, and add a `false_premise` block naming the `swapped_entity` (the thing');
  lines.push('the store does NOT contain) and the `framing_entities` (the real things it DOES contain,');
  lines.push('which set up the question). Registration checks the swapped entity is genuinely absent and');
  lines.push('the framing entities are genuinely present — get these exact so the check passes.');
  lines.push('');
  lines.push('## Output');
  lines.push('');
  lines.push('One JSON object. Every question carries: `id`, `query`, `rung` (the kind), `expected`');
  lines.push('(answer unit ids, empty for the unanswerable kinds), optional `secondary` (defensible');
  lines.push('alternates), `forbidden` (traps; empty when none), `no_answer: true` for the unanswerable');
  lines.push('kinds, `false_premise` where it applies, and a short `rationale`. Header carries `meta`:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "meta": {');
  lines.push(`    "round": ${q.round},`);
  lines.push(`    "authoring_snapshot_id": "${q.authoring_snapshot_id}",`);
  lines.push('    "author": "<who/which model authored this>",');
  lines.push('    "author_model": "<model family — rotate across rounds when an alternate is available>",');
  lines.push('    "blind_attestation": "I authored these reading unit bodies only; I did not run any retrieval, search, or scoring tool."');
  lines.push('  },');
  lines.push('  "queries": [ /* ... */ ]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('If the corpus cannot yield enough clean zero-overlap pairs for a kind, deliver FEWER');
  lines.push('and say so — an honest short kind beats a padded one. Do not invent overlap you have to hide.');
  return lines.join('\n') + '\n';
}

// ============================================================
// The mechanical verifier — everything a machine can check without
// trusting the author. Returns { violations, warnings, counts }.
// ============================================================
export function verifyGoldset(goldset, snapshot, quotaRecord) {
  const violations = [];
  const warnings = [];
  const queries = (goldset && goldset.queries) || [];
  const meta = (goldset && goldset.meta) || {};

  // 1. Schema conformance — reuse the harness's own fail-closed gate, so the
  //    round runner refuses exactly what the instrument would refuse.
  try {
    validateGold(queries);
  } catch (e) {
    violations.push(`schema: ${e.message}`);
  }

  // 2. Blind attestation present (its TRUTH is protocol; its PRESENCE is mechanical).
  if (!meta.blind_attestation || !String(meta.blind_attestation).trim()) {
    violations.push('attestation: meta.blind_attestation is missing — the author must state they ran no retrieval tool');
  }
  if (!meta.author || !String(meta.author).trim()) {
    violations.push('attestation: meta.author is missing — record who/which model authored the set');
  }

  // 3. Corpus identity — the author must have authored against THIS round's
  //    frozen corpus, and the store must not have drifted since.
  if (meta.authoring_snapshot_id !== quotaRecord.authoring_snapshot_id) {
    violations.push(`corpus: meta.authoring_snapshot_id (${short(meta.authoring_snapshot_id)}) does not match this round's frozen corpus (${short(quotaRecord.authoring_snapshot_id)}) — author against the round's corpus`);
  }
  if (snapshot.snapshotId !== quotaRecord.authoring_snapshot_id) {
    violations.push(`corpus: the store changed since this round was created (now ${short(snapshot.snapshotId)}, round froze ${short(quotaRecord.authoring_snapshot_id)}) — the answer keys may be stale; start a fresh round against the current corpus`);
  }

  // Body text per unit id, from the frozen snapshot — never a live read.
  const textById = new Map();
  for (const b of (snapshot.bodies || [])) textById.set(b.id, b.text);
  const idSet = new Set(snapshot.index.units.map(u => u.id));
  const corpusBlob = (snapshot.bodies || []).map(b => `${b.id} ${b.text}`).join('\n').toLowerCase();

  // 4. Answer ids must exist in the corpus (a gold pointing at a non-unit is dead).
  for (const q of queries) {
    for (const field of ['expected', 'secondary', 'forbidden']) {
      for (const id of (q[field] || [])) {
        if (!idSet.has(id)) violations.push(`${q.id}: ${field} id '${id}' is not an active unit in the corpus`);
      }
    }
  }

  // 5. Zero-overlap for the indirect kinds — checked vs title+body+TOPICS.
  for (const q of queries) {
    if (!OVERLAP_REQUIRED.has(q.rung)) continue;
    const qStems = contentStems(q.query);
    for (const id of (q.expected || [])) {
      const text = textById.get(id);
      if (text === undefined) continue; // existence already flagged above
      const answerStems = contentStems(text);
      const leaked = [...qStems].filter(s => answerStems.has(s));
      if (leaked.length) {
        violations.push(`${q.id} (${q.rung}): shares ${leaked.length} content word(s) with answer '${id}' — [${leaked.join(', ')}] — the ${q.rung} kind requires ZERO overlap vs title/body/topics`);
      }
    }
  }

  // 6. False-premise entity checks — the swapped entity must be ABSENT, the
  //    framing entities PRESENT. This is what makes an unanswerable question a
  //    real false-premise rather than a typo.
  for (const q of queries) {
    const fp = q.false_premise;
    if (!fp) continue;
    if (q.no_answer !== true) {
      violations.push(`${q.id}: has a false_premise block but is not marked no_answer:true — a false-premise question has no answer`);
    }
    const swapped = String(fp.swapped_entity || '').trim().toLowerCase();
    if (!swapped) {
      violations.push(`${q.id}: false_premise.swapped_entity is empty`);
    } else if (corpusBlob.includes(swapped)) {
      violations.push(`${q.id}: false_premise.swapped_entity '${fp.swapped_entity}' DOES appear in the corpus — it is not a false premise, the store can speak to it`);
    }
    const framing = Array.isArray(fp.framing_entities) ? fp.framing_entities : [];
    if (!framing.length) {
      warnings.push(`${q.id}: false_premise names no framing_entities — the question isn't grounded in anything the store contains`);
    }
    for (const fe of framing) {
      if (!corpusBlob.includes(String(fe).trim().toLowerCase())) {
        violations.push(`${q.id}: false_premise.framing_entity '${fe}' does NOT appear in the corpus — the framing must be real`);
      }
    }
  }

  // 7. Per-kind counts — over quota is refused (padding risk); under quota is an
  //    honest shortfall and only warns (per the brief's "fewer beats padded").
  const counts = {};
  for (const q of queries) counts[q.rung] = (counts[q.rung] || 0) + 1;
  for (const [kind, want] of Object.entries(quotaRecord.quota)) {
    const got = counts[kind] || 0;
    if (got > want) violations.push(`count: ${got} '${kind}' questions exceeds the round quota of ${want} — do not pad a kind`);
    else if (got < want) warnings.push(`count: ${got} '${kind}' questions is under the round quota of ${want} (honest shortfall is allowed)`);
  }
  for (const kind of Object.keys(counts)) {
    if (!(kind in quotaRecord.quota)) violations.push(`count: '${kind}' questions were authored but this round's quota declares no such kind`);
  }

  // 8. Contamination watch — a unit that quotes a question verbatim is a fake
  //    lexical bridge that would inflate future scores. Warn, don't refuse.
  for (const q of queries) {
    const needle = String(q.query || '').trim().toLowerCase();
    if (needle.length > 12 && corpusBlob.includes(needle)) {
      warnings.push(`${q.id}: a unit body contains this question verbatim — a self-referential lexical bridge; consider rephrasing`);
    }
  }

  return { violations, warnings, counts };
}

function short(h) { return h ? String(h).slice(0, 12) : '(none)'; }

// ============================================================
// register — verify, then pre-register + FREEZE.
// ============================================================
export function register(project, round, goldsetFile) {
  const dir = roundDir(project, round);
  const quotaPath = join(dir, 'quota.json');
  const corpusPath = join(dir, 'corpus-snapshot.json');
  if (!existsSync(quotaPath) || !existsSync(corpusPath)) {
    throw new Error(`round ${round} was never created — run 'new-round' first (no ${quotaPath})`);
  }
  const preregPath = join(dir, 'prereg.json');
  if (existsSync(preregPath)) {
    throw new Error(`round ${round} is already registered and FROZEN (${preregPath}) — a registered round is append-only; create a new round to add questions`);
  }
  const quotaRecord = JSON.parse(readFileSync(quotaPath, 'utf8'));
  const goldRaw = readFileSync(goldsetFile, 'utf8');
  const goldset = JSON.parse(goldRaw);

  const { snapshot } = captureCorpusIdentity(project);
  const { violations, warnings, counts } = verifyGoldset(goldset, snapshot, quotaRecord);

  if (violations.length) {
    return { ok: false, violations, warnings, counts };
  }

  // Freeze: write the verified set + the pre-registration record. The prereg
  // record is what a run must echo — the question-set hash and the corpus it was
  // registered against, timestamped.
  const frozenPath = join(dir, 'goldset.json');
  writeFileSync(frozenPath, goldRaw);
  const prereg = {
    round: Number(round),
    registered_at: new Date().toISOString(),
    goldset_sha256: createHash('sha256').update(goldRaw).digest('hex'),
    corpus_snapshot_id: snapshot.snapshotId,
    authoring_snapshot_id: quotaRecord.authoring_snapshot_id,
    n_queries: (goldset.queries || []).length,
    per_kind_counts: counts,
    author: (goldset.meta || {}).author || null,
    author_model: (goldset.meta || {}).author_model || null,
    warnings,
  };
  writeFileSync(preregPath, JSON.stringify(prereg, null, 2));
  return { ok: true, warnings, counts, prereg, frozenPath };
}

// ============================================================
// run — run the frozen set through the REAL harness + old-vs-new delta.
// ============================================================
const HEADLINE_ARM = 'ranking';   // the pre-expansion ranking substrate
const HEADLINE_K = 10;

function armHeadline(harnessOut) {
  const r = harnessOut?.results?.[HEADLINE_ARM]?.recall?.[HEADLINE_K];
  return typeof r === 'number' ? r : null;
}

// per-kind R@10 for the headline arm + the forbidden (trap-leak) rate.
function perKindBreakdown(harnessOut) {
  const arm = harnessOut?.results?.[HEADLINE_ARM] || {};
  const out = {};
  for (const [kind, byK] of Object.entries(arm.perRung || {})) {
    out[kind] = { r10: byK[HEADLINE_K] ?? null };
  }
  return {
    byKind: out,
    forbiddenRate: arm.forbiddenRate ?? null,
    context3_r3: harnessOut?.results?.context3?.recall?.[3] ?? null,
  };
}

// Measure a frozen round against the CURRENT store + compute the old-vs-new
// delta — WITHOUT persisting anything. This is the read-only core; runRound
// wraps it to also write a results file. /metrics consumes measureRound so a
// health check never litters the round directory with run records.
export async function measureRound(project, round, { snapshot: injected = null } = {}) {
  const dir = roundDir(project, round);
  const preregPath = join(dir, 'prereg.json');
  const frozenPath = join(dir, 'goldset.json');
  if (!existsSync(preregPath) || !existsSync(frozenPath)) {
    throw new Error(`round ${round} is not registered — run 'register' before 'run' (no ${preregPath})`);
  }
  const prereg = JSON.parse(readFileSync(preregPath, 'utf8'));

  // ONE snapshot of the CURRENT store; every round measured this run shares it,
  // so the old-vs-new delta compares like against like.
  const snapshot = injected || loadSnapshot(resolve(project), { captureBodies: true });

  const out = await runHarness(resolve(project), frozenPath, { snapshot });
  const headline = armHeadline(out);
  const breakdown = perKindBreakdown(out);

  // Old-vs-new delta (the overfitting detector, TREC-Robust style): run every
  // PRIOR registered round's frozen set against the SAME current corpus, then
  // compare this (newest-run) round's headline to the mean of the older ones.
  const priors = [];
  for (const r of listRounds(project)) {
    if (r === Number(round)) continue;
    const rPre = join(roundDir(project, r), 'prereg.json');
    const rGold = join(roundDir(project, r), 'goldset.json');
    if (!existsSync(rPre) || !existsSync(rGold)) continue;
    try {
      const rOut = await runHarness(resolve(project), rGold, { snapshot });
      priors.push({ round: r, headline: armHeadline(rOut) });
    } catch { /* a prior round with a stale answer key is skipped, not fatal */ }
  }
  const priorHeadlines = priors.map(p => p.headline).filter(h => typeof h === 'number');
  const priorMean = priorHeadlines.length ? priorHeadlines.reduce((s, x) => s + x, 0) / priorHeadlines.length : null;
  const delta = (headline != null && priorMean != null) ? headline - priorMean : null;

  // Gold-id staleness against the current store (runs still proceed — old slices
  // are trainable against the current corpus — but a rotted answer key is surfaced).
  const idSet = new Set(snapshot.index.units.map(u => u.id));
  const staleGold = [];
  for (const q of (out.gold || [])) {
    for (const id of (q.expected || [])) if (!idSet.has(id)) staleGold.push(`${q.id}→${id}`);
  }

  const ranAt = new Date().toISOString();
  const record = {
    round: Number(round),
    ran_at: ranAt,
    prereg_goldset_sha256: prereg.goldset_sha256,
    corpus_snapshot_id: snapshot.snapshotId,
    headline_arm: HEADLINE_ARM,
    headline_k: HEADLINE_K,
    headline,
    breakdown,
    old_vs_new: { priors, prior_mean: priorMean, delta },
    stale_gold: staleGold,
    n_queries: out.nQueries,
    store_units: out.total,
    manifest: out.manifest,
    results: out.results,
  };
  return { record, dir };
}

// run — measure the round AND persist the run record to the round directory.
export async function runRound(project, round, opts = {}) {
  const { record, dir } = await measureRound(project, round, opts);
  const outPath = join(dir, `results-${record.ran_at.replace(/[:.]/g, '-')}.json`);
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  return { record, outPath };
}

// Newest run record on disk for a round, or null.
export function latestResult(project, round) {
  const dir = roundDir(project, round);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter(f => /^results-.*\.json$/.test(f)).sort();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')); } catch { return null; }
}

// The newest FROZEN (registered) round, for consumers that want the current
// answer key (e.g. /metrics). Returns null when no round is registered.
export function newestRegisteredRound(project) {
  for (const r of listRounds(project).slice().reverse()) {
    const dir = roundDir(project, r);
    const preregPath = join(dir, 'prereg.json');
    const goldPath = join(dir, 'goldset.json');
    if (existsSync(preregPath) && existsSync(goldPath)) {
      return { round: r, dir, goldsetPath: goldPath, prereg: JSON.parse(readFileSync(preregPath, 'utf8')) };
    }
  }
  return null;
}

// ============================================================
// status — rounds, freshness, headline history, delta trend.
// ============================================================
export function status(project) {
  const root = resolve(project);
  // captureBodies:true so this id uses the SAME formula register/run stored — the
  // index-only path hashes a different composition and would always read as drift.
  let currentSnapshotId = null;
  try { currentSnapshotId = loadSnapshot(root, { captureBodies: true }).snapshotId; } catch { /* no store */ }
  const rounds = [];
  for (const r of listRounds(project)) {
    const dir = roundDir(project, r);
    const preregPath = join(dir, 'prereg.json');
    const registered = existsSync(preregPath);
    const prereg = registered ? JSON.parse(readFileSync(preregPath, 'utf8')) : null;
    const last = latestResult(project, r);
    rounds.push({
      round: r,
      registered,
      n_queries: prereg ? prereg.n_queries : null,
      corpus_drift: prereg && currentSnapshotId ? prereg.corpus_snapshot_id !== currentSnapshotId : null,
      last_headline: last ? last.headline : null,
      last_delta: last ? last.old_vs_new?.delta ?? null : null,
      last_ran_at: last ? last.ran_at : null,
    });
  }
  return { project: root, current_snapshot_id: currentSnapshotId, rounds };
}

// ============================================================
// CLI
// ============================================================
function pct(v) { return v == null ? '  — ' : `${Math.round(v * 100)}%`; }

function renderRunReport(record) {
  const L = [];
  L.push(`\nSelf-test round ${record.round} — ${record.n_queries} questions over ${record.store_units} units`);
  L.push(`corpus ${short(record.corpus_snapshot_id)}… · question-set ${short(record.prereg_goldset_sha256)}…`);
  L.push(`headline (${record.headline_arm} R@${record.headline_k}): ${pct(record.headline)}`);
  L.push('\nby question kind (recall@10, headline arm):');
  for (const [kind, v] of Object.entries(record.breakdown.byKind)) {
    L.push(`  ${kind.padEnd(13)} ${pct(v.r10)}`);
  }
  if (record.breakdown.forbiddenRate != null) {
    L.push(`  unanswerable trap-leak rate: ${pct(record.breakdown.forbiddenRate)} (lower is better — 0% means no trap surfaced)`);
  }
  const ovn = record.old_vs_new;
  if (ovn.delta != null) {
    const arrow = ovn.delta > 0.001 ? '↑' : ovn.delta < -0.001 ? '↓' : '→';
    L.push(`\nold-vs-new delta (overfitting detector): ${arrow} ${(ovn.delta * 100 >= 0 ? '+' : '')}${Math.round(ovn.delta * 100)} pts vs the older rounds' mean (${pct(ovn.prior_mean)})`);
    L.push('  (a big positive delta — new questions much harder than old — can mean the store was tuned to the old set)');
  } else if (ovn.priors.length === 0) {
    L.push('\nold-vs-new delta: none yet — this is the first round; the detector needs a prior round');
  }
  if (record.stale_gold.length) {
    L.push(`\nWARNING: ${record.stale_gold.length} answer id(s) no longer in the store: ${record.stale_gold.join(', ')}`);
  }
  return L.join('\n');
}

async function main(argv) {
  const [cmd, project, ...rest] = argv;
  if (!cmd || !project) {
    process.stderr.write('usage:\n  self-test-round.mjs new-round <project>\n  self-test-round.mjs register <project> <round> <goldset-file>\n  self-test-round.mjs run <project> <round>\n  self-test-round.mjs status <project>\n');
    return 2;
  }
  try {
    if (cmd === 'new-round') {
      const { round, dir, briefPath, identity } = newRound(project);
      process.stdout.write(`Created self-test round ${round} at ${dir}\n`);
      process.stdout.write(`Corpus frozen: ${identity.unit_count} units, snapshot ${short(identity.snapshot_id)}…\n`);
      process.stdout.write(`Blind-authoring brief: ${briefPath}\n`);
      process.stdout.write(`Next: hand the brief to a BLIND author, then 'register ${project} ${round} <goldset-file>'.\n`);
      return 0;
    }
    if (cmd === 'register') {
      const [round, goldsetFile] = rest;
      if (!round || !goldsetFile) { process.stderr.write('register needs <round> <goldset-file>\n'); return 2; }
      const res = register(project, round, goldsetFile);
      if (!res.ok) {
        process.stdout.write(`REGISTRATION REFUSED — round ${round} not frozen. Fix these and re-run (send back to the author; do not silently patch):\n`);
        for (const v of res.violations) process.stdout.write(`  ✗ ${v}\n`);
        for (const w of res.warnings) process.stdout.write(`  ! ${w}\n`);
        return 1;
      }
      process.stdout.write(`Round ${round} REGISTERED and FROZEN.\n`);
      process.stdout.write(`  question-set sha256: ${res.prereg.goldset_sha256}\n`);
      process.stdout.write(`  corpus snapshot:     ${res.prereg.corpus_snapshot_id}\n`);
      process.stdout.write(`  registered at:       ${res.prereg.registered_at}\n`);
      process.stdout.write(`  counts: ${Object.entries(res.counts).map(([k, n]) => `${k}:${n}`).join(' ')}\n`);
      for (const w of res.warnings) process.stdout.write(`  ! ${w}\n`);
      return 0;
    }
    if (cmd === 'run') {
      const [round] = rest;
      if (!round) { process.stderr.write('run needs <round>\n'); return 2; }
      const { record, outPath } = await runRound(project, round);
      process.stdout.write(renderRunReport(record) + '\n');
      process.stdout.write(`\nresults: ${outPath}\n`);
      return 0;
    }
    if (cmd === 'status') {
      const s = status(project);
      process.stdout.write(`\nSelf-test status — ${s.project}\n`);
      if (!s.rounds.length) { process.stdout.write('  no rounds yet — run new-round to start one\n'); return 0; }
      for (const r of s.rounds) {
        const state = r.registered ? 'frozen' : 'unregistered';
        const drift = r.corpus_drift === null ? '' : r.corpus_drift ? ' · corpus DRIFTED since registration' : ' · corpus current';
        const head = r.last_headline != null ? ` · last headline ${pct(r.last_headline)}` : ' · never run';
        const delta = r.last_delta != null ? ` · delta ${r.last_delta >= 0 ? '+' : ''}${Math.round(r.last_delta * 100)}pts` : '';
        process.stdout.write(`  round ${r.round} [${state}] n=${r.n_queries ?? '—'}${drift}${head}${delta}\n`);
      }
      return 0;
    }
    process.stderr.write(`unknown command: ${cmd}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(c => process.exit(c));
}
