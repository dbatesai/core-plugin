#!/usr/bin/env node
/**
 * render-metrics-artifact.mjs — generate ONE self-contained HTML page from the
 * canonical four-evidence-class metrics object (`gatherMetrics()` in
 * metrics-check.mjs), for explicit, user-confirmed publication as a private
 * hosted artifact (the `/metrics` skill owns the publish flow; THIS SCRIPT
 * NEVER UPLOADS ANYTHING — it generates a local file, prints a preflight
 * manifest, and writes a local generation receipt; that is the whole job).
 *
 * The page's section structure (four
 * plain-question sections), copy voice (every measurement explained in the
 * sentence it appears in — never a bare metric name), visual system (tokens,
 * chips, gauges, hatched empty states, snapshot banner, both themes), and
 * trust-tag legend are fixed; this generator reproduces them mechanically.
 *
 * Hard requirements shared with render-browse-artifact.mjs:
 *   - Zero external references anywhere in the page (strict-CSP survivable;
 *     grep-assertable and asserted in the test suite). This page needs no
 *     JavaScript at all — it is static HTML + inline CSS.
 *   - Truthful producer identity via the shared artifact-provenance.mjs
 *     (real git HEAD in a source checkout, stamped manifest identity in an
 *     installed tree, FAIL CLOSED with neither — no unknown-provenance page
 *     is ever rendered for publish).
 *   - Both themes (system preference + explicit data-theme override), and
 *     reduced motion respected (the gauge transition only plays when the
 *     viewer has no reduced-motion preference).
 *   - Snapshot banner with the DOES-NOT-UPDATE-ITSELF framing.
 *   - Audit trail via the shared artifact-receipts.mjs: a generation receipt
 *     at write time, and `--record-publish` / `--record-revocation` for the
 *     consent/publish outcome (publish-receipt kind:
 *     core-metrics-artifact-publish).
 *
 * Unlike the browse page, this page embeds NO memory-unit bodies and no unit
 * ids — aggregate numbers and topic-level labels only — so the manifest is
 * lighter: `content_class: "aggregates-only"` replaces the unit-count and
 * sensitivity machinery, and says so.
 *
 * CLI:
 *   node render-metrics-artifact.mjs <project-dir> --out <path>
 *        [--json-in <canonical-metrics.json>] [--home <dir>]
 *
 *   node render-metrics-artifact.mjs --record-publish
 *        --generation-receipt <path> --status declined|failed|published-private
 *        [--artifact-url <url>] [--private-verified-evidence <s>]
 *        [--consent-by <who>] [--consent-mechanism <s>] [--note <s>]
 *
 *   node render-metrics-artifact.mjs --record-revocation <publish-receipt-path>
 *
 *   --out is REQUIRED — there is deliberately no default output location.
 *   --json-in renders from a pre-captured canonical metrics object instead of
 *   running gatherMetrics() fresh (tests, replays); the page then carries the
 *   captured object's own gathered-at timestamp and data producer, while the
 *   RENDERER identity stays live and truthful.
 *   --home is a test-isolation override for the receipt root.
 *
 * Exit codes: 0 success; 2 usage error (missing --out, --out inside
 * _memories/, unreadable/malformed --json-in, bad record-mode input);
 * 1 fatal failure (including fail-closed producer identity).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatherMetrics, parseRecognitionSignal } from './metrics-check.mjs';
import { truthfulProducerIdentity } from './artifact-provenance.mjs';
import { requireTrustedHome } from './trusted-home.mjs';
import {
  generationReceiptLocation, runRecordCli, artifactContentDigest,
  publishArtifactWithReceipt, resolveArtifactDestination,
} from './artifact-receipts.mjs';

export const METRICS_ARTIFACT_MANIFEST_SCHEMA_VERSION = '1.0.0';
export const METRICS_ARTIFACT_CONTENT_CLASS = 'aggregates-only';

// Fixed content note (the aggregates-only counterpart of the browse page's
// sensitivity warning) — one string, stable across runs, so the skill can
// relay it verbatim and tests can assert it exactly.
export const METRICS_ARTIFACT_CONTENT_NOTE =
  'CONTENT: this page embeds aggregate health numbers and topic-level labels only — no memory-unit ' +
  'bodies and no unit ids, so there is no unit-count or per-unit sensitivity breakdown to review. ' +
  'Publishing still uploads the numbers shown; state what is going up in the conversation as it publishes.';

// ============================================================
// Small render helpers
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const pctInt = (x) => Math.round(Number.isFinite(x) ? x : 0);
const plural = (n, one, many) => (n === 1 ? one : many);

function humanTimestamp(iso) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(iso));
  } catch { return String(iso); }
}

const chip = (cls, label) => `<span class="chip ${cls}">${escapeHtml(label)}</span>`;
const gaugeBar = (width, cls) => `<div class="gauge"><i class="${cls}" style="width:${Math.max(0, Math.min(100, pctInt(width)))}%"></i></div>`;
const gaugeEmpty = () => '<div class="gauge empty"></div>';

/** One report row: label + trust chip on the left, gauge (or nothing) + explained value on the right. */
function row({ label, chipHtml, gaugeHtml = '', bodyHtml }) {
  return `  <div class="row"><div class="rlabel">${label}<br>${chipHtml}</div>
    <div class="rbody">${gaugeHtml}
      ${bodyHtml}</div></div>`;
}

const val = (inner) => `<div class="val">${inner}</div>`;
const valMore = (inner) => `<div class="val" style="margin-top:4px">${inner}</div>`;

// ============================================================
// Plain-language row builders — one per report row, each handling every state
// metrics-check.mjs can put that row in. The prototype's copy is the
// template: numbers are parameterized, the explanatory sentences stay.
// ============================================================

// ---- Section 1, row 1: the live round-trip probe ----
function saveAndFindRow(mech) {
  const probe = mech.probe || {};
  if (probe.round_trip) {
    return row({
      label: 'Save-and-find test',
      chipHtml: chip('good', 'proven-live'),
      gaugeHtml: gaugeBar(100, 'g'),
      bodyHtml: val('<b>Passed, demonstrated just now.</b> While building this page, CORE created a scratch memory store, wrote a test memory into it, searched for it by content, got it back, and confirmed that a memory marked as deleted stays hidden from search. The whole cycle worked end to end.'),
    });
  }
  const broke = [];
  if (probe.validate && probe.validate.pass === false) broke.push('the saved memory failed its format check');
  if (probe.retrieve && probe.retrieve.pass === false) broke.push('searching could not find the memory again');
  if (probe.suppress_retired && probe.suppress_retired.pass === false) broke.push('a memory marked as deleted still showed up in search');
  const what = broke.length ? `What broke: ${broke.join('; and ')}.` : 'The test could not run to completion.';
  return row({
    label: 'Save-and-find test',
    chipHtml: chip('crit', 'proven-live'),
    gaugeHtml: gaugeBar(100, 'c'),
    bodyHtml: val(`<b>Failed.</b> While building this page, CORE created a scratch memory store and ran its basic cycle — save a test memory, find it again by its content, and confirm a memory marked as deleted stays hidden from search. ${escapeHtml(what)} Until this passes, no other number on this page can be trusted.`),
  });
}

// ---- Section 1, row 2: this store's validator counts + unit census ----
function fileHealthRow(mech) {
  const store = mech.store || {};
  const label = 'Memory file health';
  if (!store.present) {
    return row({
      label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeEmpty(),
      bodyHtml: val('<b>No memory store exists in this project yet.</b> There are no stored memories to health-check — this row fills in once the project has a store.'),
    });
  }
  const census = store.census || {};
  const total = census.total ?? 0;
  if (total === 0) {
    return row({
      label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeEmpty(),
      bodyHtml: val('<b>The memory store is empty.</b> It exists, but holds zero memory files so far — nothing to health-check yet.'),
    });
  }
  const attention = store.warning_triage?.attention ?? 0;
  const clean = Math.max(0, total - attention);
  const tiles = [];
  tiles.push(`<div class="tile"><div class="t">in use</div><div class="v">${census.active ?? 0}</div></div>`);
  if ((census.superseded ?? 0) > 0) tiles.push(`<div class="tile"><div class="t">replaced by newer</div><div class="v">${census.superseded}</div></div>`);
  if ((census.retired ?? 0) > 0) tiles.push(`<div class="tile"><div class="t">retired</div><div class="v">${census.retired}</div></div>`);
  if ((census.archived ?? 0) > 0) tiles.push(`<div class="tile"><div class="t">archived</div><div class="v">${census.archived}</div></div>`);
  if ((census.other ?? 0) > 0) tiles.push(`<div class="tile"><div class="t">other</div><div class="v">${census.other}</div></div>`);
  const tilesHtml = `<div class="tiles">${tiles.join('')}</div>`;
  if (attention === 0) {
    return row({
      label, chipHtml: chip('good', 'direct'), gaugeHtml: gaugeBar(100, 'g'),
      bodyHtml: val(`<b>All ${total} memory files are healthy.</b> Every stored memory passed its format and consistency checks — nothing needs attention. The counts: most are active memories in use; the rest are older ones kept for history.`) + tilesHtml,
    });
  }
  return row({
    label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeBar((clean / total) * 100, 'w'),
    bodyHtml: val(`<b>${attention} of ${total} memory files ${plural(attention, 'needs', 'need')} attention.</b> ${plural(attention, 'It', 'They')} failed a consistency check that the next cleanup pass (or a person) should look at; the other ${clean} passed everything.`) + tilesHtml,
  });
}

// ---- Section 1, row 3: telemetry capture (activity counts, never a score) ----
function rejectedBreakdown(rejected) {
  const parts = [];
  if ((rejected?.current?.count ?? 0) > 0) parts.push(`${rejected.current.count} in the current record format`);
  if ((rejected?.legacy?.count ?? 0) > 0) parts.push(`${rejected.legacy.count} in an older record format`);
  if ((rejected?.other?.count ?? 0) > 0) parts.push(`${rejected.other.count} unreadable`);
  return parts.join(', ');
}

function lookupRecordsRow(mech) {
  const t = mech.telemetry || {};
  const label = 'Lookup record-keeping';
  const rejected = t.rejected || { total: 0 };
  if (t.available) {
    const days = t.days ?? 0;
    const events = t.retrievalEvents ?? 0;
    const deep = (t.t2Pct ?? 0) + (t.t3Pct ?? 0);
    const rejectedClause = (rejected.total ?? 0) > 0
      ? `, and threw out <b class="num">${rejected.total}</b> ${plural(rejected.total, 'record', 'records')} whose format was broken (${escapeHtml(rejectedBreakdown(rejected))}) — broken records are counted, never silently ignored`
      : ', and every record is well-formed — none were malformed or thrown out';
    const tierSentence = deep === 0
      ? 'Every lookup was answered by the fast first-pass search; none needed the deeper, slower search.'
      : `<b class="num">${t.t1Pct ?? 0}%</b> of lookups were answered by the fast first-pass search; <b class="num">${deep}%</b> needed the deeper, slower search.`;
    let body = val(`<b>CORE has been keeping records of its own memory lookups.</b> Over the past <b class="num">${days}</b> ${plural(days, 'day', 'days')} it logged <b class="num">${events}</b> ${plural(events, 'lookup', 'lookups')}${rejectedClause}. ${tierSentence} (This is a count of activity, not a quality score — that's why there's no bar here.)`);
    if (t.topEscalationTopic) {
      body += valMore(`One flag worth knowing: lookups about one particular topic (stored under the label &lsquo;${escapeHtml(t.topEscalationTopic)}&rsquo;) needed the deeper search <b class="num">${t.topEscalationRate}%</b> of the time — a weak spot in how that topic is stored.`);
    }
    return row({ label, chipHtml: chip((rejected.total ?? 0) > 0 ? 'warn' : 'good', 'direct'), bodyHtml: body });
  }
  const reason = String(t.reason || '');
  if ((rejected.total ?? 0) > 0) {
    return row({
      label, chipHtml: chip('crit', 'direct'),
      bodyHtml: val(`<b>Lookup records exist, but every one of them is broken.</b> ${rejected.total} ${plural(rejected.total, 'record was', 'records were')} found and all failed the format check (${escapeHtml(rejectedBreakdown(rejected))}). That's real evidence the record-keeping itself needs fixing — different from having no records at all.`),
    });
  }
  if (/^no retrieval events recorded/.test(reason) || reason === '') {
    return row({
      label, chipHtml: chip('prov', 'direct'),
      bodyHtml: val("<b>No lookup records yet.</b> CORE hasn't recorded any memory lookups for this project, so there's no activity to report — an absence, not a zero score."),
    });
  }
  return row({
    label, chipHtml: chip('warn', 'direct'),
    bodyHtml: val(`<b>The lookup records could not be read.</b> The technical reason: ${escapeHtml(reason)}.`),
  });
}

// ---- Section 2: the gold-set search quiz ----
function searchQuizRow(regression) {
  const gold = regression?.gold || {};
  if (gold.available) {
    const n = gold.n ?? 0;
    const r3 = gold.context3_r3 ?? 0;
    const r3Pct = pctInt(r3 * 100);
    const hits = Math.round(r3 * n);
    const rankingPct = gold.ranking_r10 != null ? pctInt(gold.ranking_r10 * 100) : null;
    const widen = rankingPct != null
      ? ` Widening to the top 10 results (before they're trimmed down to the final three), the right answer appeared <b class="num">${rankingPct}%</b> of the time.`
      : '';
    // A frozen blind self-test round earns a richer, more honest line: it also
    // covers questions the store should NOT be able to answer, and it watches
    // for the store being tuned to its own test.
    const fromRound = typeof gold.source === 'string' && gold.source.startsWith('self-test');
    let selfTestBits = '';
    if (fromRound) {
      const trap = gold.forbidden_rate != null
        ? ` It also includes questions the store deliberately can't answer — where the right behavior is saying &ldquo;nothing stored about that&rdquo; — and a wrong answer surfaced on <b class="num">${pctInt(gold.forbidden_rate * 100)}%</b> of those (lower is better).`
        : '';
      const delta = gold.old_vs_new_delta != null
        ? ` Compared with the earlier rounds on the same store, this round's questions scored <b class="num">${gold.old_vs_new_delta >= 0 ? '+' : ''}${pctInt(gold.old_vs_new_delta * 100)}</b> points different — a large positive gap would hint the store was tuned to the older questions.`
        : '';
      selfTestBits = trap + delta;
    }
    const keySource = fromRound
      ? 'a separate agent wrote the questions blind — reading only the stored facts, never the search code — and the set was mechanically checked and frozen before scoring'
      : 'the agent wrote both the questions and the answer key';
    return row({
      label: 'Search quiz',
      chipHtml: chip('prov', 'provisional'),
      gaugeHtml: gaugeBar(r3Pct, 'a'),
      bodyHtml:
        val(`<b>The right memory landed in the top 3 results for <span class="num">${hits} of ${n}</span> quiz questions (${r3Pct}%).</b> The quiz: ${n} questions, each with a known correct memory as its answer, run against the real search machinery while building this page.${widen}${selfTestBits}`) +
        valMore(`<b>The caveat, plainly:</b> ${keySource}. A self-generated quiz is a useful direction check, but it can't prove the search is good — that's why this line is tagged provisional, and why ${r3Pct}% is &ldquo;a snapshot,&rdquo; not a passing grade. No pass/fail bar was ever agreed in advance.`),
    });
  }
  const reason = String(gold.reason || '');
  if (/retrieval-gold-set\.json/.test(reason) || reason === '') {
    return row({
      label: 'Search quiz',
      chipHtml: chip('crit', 'not-evaluated'),
      gaugeHtml: gaugeEmpty(),
      bodyHtml: val("<b>Never measured for this project.</b> Measuring search quality takes a quiz — a saved set of questions, each with a known correct memory as its answer, run against the real search machinery. This project doesn't have that answer key yet, so nothing here can say how good the search is. Writing one is the way to change this row."),
    });
  }
  return row({
    label: 'Search quiz',
    chipHtml: chip('warn', 'not-evaluated'),
    gaugeHtml: gaugeEmpty(),
    bodyHtml: val(`<b>The quiz could not be run this time.</b> A quiz file exists for this project, but running it failed, so no measurement happened. The technical reason: ${escapeHtml(reason)}.`),
  });
}

// ---- Section 3, row 1: the "forgot to check memory" estimate ----
function forgotToCheckRow(readiness) {
  const rec = parseRecognitionSignal(readiness?.recognition_signal?.text);
  const label = '&ldquo;Forgot to check memory&rdquo; estimate';
  if (rec.available) {
    let trend;
    if (rec.avgPct != null) {
      if (rec.arrow === '↑') trend = ` — up from the recent average of ${rec.avgPct}%, and moving in the wrong direction. Worth a look.`;
      else if (rec.arrow === '↓') trend = ` — down from the recent average of ${rec.avgPct}%, moving in the right direction.`;
      else trend = ` — about in line with the recent average of ${rec.avgPct}%.`;
    } else {
      trend = '. There is no longer-run average to compare against yet.';
    }
    const calibrated = !!readiness?.calibration?.is_calibrated;
    const tail = calibrated
      ? ' The grader behind this estimate has passed its human verification (next line), so the number carries real weight.'
      : " But: the grader itself hasn't been verified yet (next line), so treat this as a smoke alarm, not a diagnosis.";
    return row({
      label,
      chipHtml: chip('prov', 'provisional'),
      gaugeHtml: gaugeBar(rec.todayPct, 'w'),
      bodyHtml: val(`<b>An automatic grader estimates that in <span class="num">${rec.todayPct}%</span> of today's conversation turns, the agent answered without checking its memory when it probably should have</b>${trend}${tail}`),
    });
  }
  const reason = String(rec.reason || '');
  let body;
  if (reason === 'no recognition signal recorded yet') {
    body = "<b>No estimate yet.</b> The automatic grader that estimates how often the agent answers without checking its memory hasn't produced a reading for this project — an absence, not a zero.";
  } else if (reason === 'no classified turns yet this period') {
    body = "<b>No estimate this period.</b> No conversation turns have been graded yet today by the automatic grader that estimates how often the agent answers without checking its memory — an absence, not a zero.";
  } else if (/unparseable/.test(reason)) {
    body = "<b>A reading exists but couldn't be understood.</b> The automatic grader wrote something this page's generator couldn't parse, so treat the estimate as missing rather than guess at it.";
  } else {
    body = `<b>No estimate available.</b> ${escapeHtml(reason)}.`;
  }
  return row({ label, chipHtml: chip('prov', 'provisional'), gaugeHtml: gaugeEmpty(), bodyHtml: val(body) });
}

// ---- Section 3, row 2: the calibration pool that verifies the grader ----
function graderVerificationRow(readiness) {
  const cal = readiness?.calibration || {};
  const label = 'Verifying that grader';
  if (!cal.available) {
    return row({
      label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeEmpty(),
      bodyHtml: val(`<b>The verification status couldn't be read.</b> The technical reason: ${escapeHtml(String(cal.reason || 'unknown'))}. Until it can be, treat the grader above as unverified.`),
    });
  }
  const labeled = cal.labeled_count ?? 0;
  const min = cal.min_needed ?? 100;
  if (cal.is_calibrated) {
    const p = cal.overall_precision;
    const precision = p != null
      ? ` When the grader flagged a turn, the human reviewer agreed with it <b class="num">${pctInt(p * 100)}%</b> of the time.`
      : '';
    return row({
      label, chipHtml: chip('good', 'direct'), gaugeHtml: gaugeBar(Math.min(100, (labeled / min) * 100), 'g'),
      bodyHtml: val(`<b>The grader has passed its verification: a human hand-checked <span class="num">${labeled}</span> of its judgments against the ${min} required, and it held up.</b>${precision} That verification is what lets the estimate above carry real weight.`),
    });
  }
  if (labeled === 0) {
    return row({
      label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeEmpty(),
      bodyHtml: val(`<b>To prove the grader can be trusted, a human needs to hand-check ${min} of its judgments. So far: <span class="num">0 of ${min}</span>.</b> Until that happens, everything the grader says (including the estimate above) stays officially unverified.`),
    });
  }
  if (labeled >= min) {
    return row({
      label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeBar(100, 'a'),
      bodyHtml: val(`<b>Enough judgments are hand-checked (<span class="num">${labeled} of ${min}</span>), but the grader hasn't passed verification yet.</b> Everything it says (including the estimate above) stays officially unverified until it does.`),
    });
  }
  return row({
    label, chipHtml: chip('warn', 'direct'), gaugeHtml: gaugeBar((labeled / min) * 100, 'a'),
    bodyHtml: val(`<b>A human has hand-checked <span class="num">${labeled} of the ${min}</span> grader judgments needed for verification.</b> Until the full ${min} are checked, everything the grader says (including the estimate above) stays officially unverified.`),
  });
}


// ---- The verdict block, scoped to mechanics exactly like the terminal heading ----
function verdictBlock(mech) {
  const attention = mech.store?.warning_triage?.attention ?? 0;
  switch (mech.status) {
    case 'WORKING':
      return { cls: 'good', big: 'The storage machinery works.', scope: "That's the only thing this green verdict claims — saving, finding, and deleting memories all function. Search quality and real usefulness are judged separately below." };
    case 'WORKING-WITH-CAVEATS':
      return { cls: 'warn', big: 'The storage machinery works — with warnings worth a look.', scope: `Saving, finding, and deleting all function, but ${attention} stored ${plural(attention, 'memory', 'memories')} failed a consistency check — part 1 has the details. Search quality and real usefulness are judged separately below.` };
    case 'MACHINERY-WORKING-NO-STORE':
      return { cls: 'prov', big: 'The machinery works, but this project has no memory store yet.', scope: "CORE's plumbing passed its live test on a scratch store, but there are no stored memories in this project to measure." };
    case 'DEGRADED':
      return { cls: 'crit', big: 'The storage machinery has a real problem.', scope: 'A basic check failed while this page was being generated — part 1 names exactly what broke. Fix that before trusting anything else here.' };
    default:
      return { cls: 'prov', big: 'The state of the storage machinery could not be determined.', scope: 'The health check did not report a verdict — treat every number below with suspicion until a clean run exists.' };
  }
}

// ============================================================
// Raw-data embed — the canonical object, minus the terminal-report text and
// minus unit-id lists (this page stays aggregates-only; unit ids belong to
// the browse page's explicitly-consented disclosure, not this one).
// ============================================================

// The embed ships only what the page renders, enforced recursively AND by
// type: every leaf is typed — SCALAR keeps null/string/number/boolean and
// drops anything composite, STRING_ARRAY keeps an array's string elements
// only, SCALAR_MAP keeps a one-level map of scalar values. A known key is
// never enough on its own: an object arriving where a scalar belongs is
// dropped and disclosed by count, so nothing rides into a published page by
// squatting on a known name.
const SCALAR = Symbol('scalar');
const STRING_ARRAY = Symbol('string-array');
const SCALAR_MAP = Symbol('scalar-map');
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const EMBED_SCHEMA = {
  schema_version: SCALAR,
  generated_at: SCALAR,
  producer: { script: SCALAR, plugin: SCALAR, plugin_version: SCALAR, source_sha: SCALAR, source_sha_from: SCALAR },
  mechanics: {
    status: SCALAR,
    probe: {
      validate: { pass: SCALAR, exit: SCALAR },
      retrieve: { pass: SCALAR, evidence: SCALAR },
      suppress_retired: { pass: SCALAR, evidence: SCALAR },
      round_trip: SCALAR,
    },
    store: {
      present: SCALAR,
      schema: { exit: SCALAR, pass: SCALAR, warn: SCALAR, fail: SCALAR },
      integrity: { exit: SCALAR, pass: SCALAR, warn: SCALAR, fail: SCALAR },
      warning_triage: { informational: SCALAR, routine_upkeep: SCALAR, attention: SCALAR, attention_items: STRING_ARRAY, attention_items_omitted: SCALAR },
      census: { active: SCALAR, retired: SCALAR, archived: SCALAR, superseded: SCALAR, other: SCALAR, total: SCALAR },
      retrieval_log: { files: SCALAR, rows: SCALAR },
    },
    telemetry: {
      available: SCALAR, days: SCALAR, retrievalEvents: SCALAR,
      rejected: {
        current: { count: SCALAR, by_code: SCALAR_MAP },
        legacy: { count: SCALAR, by_code: SCALAR_MAP },
        other: { count: SCALAR, by_code: SCALAR_MAP },
        total: SCALAR,
      },
      t1Pct: SCALAR, t2Pct: SCALAR, t3Pct: SCALAR,
      topEscalationTopic: SCALAR, topEscalationRate: SCALAR,
    },
    capture: SCALAR_MAP,
  },
  regression: {
    gold: { available: SCALAR, n: SCALAR, storeUnits: SCALAR, context3_r3: SCALAR, ranking_r10: SCALAR, bm25_r10: SCALAR },
    self_test: SCALAR_MAP,
  },
  readiness: {
    recognition_signal: { text: SCALAR, age_hours: SCALAR },
    calibration: { available: SCALAR, labeled_count: SCALAR, min_needed: SCALAR, is_calibrated: SCALAR, overall_precision: SCALAR, notes: SCALAR },
  },
  caveats: STRING_ARRAY,
};

const DROP = Symbol('drop');

function projectBySchema(value, schema, drops) {
  if (schema === SCALAR) {
    if (isScalar(value)) return value;
    drops.count++;
    return DROP;
  }
  if (schema === STRING_ARRAY) {
    if (!Array.isArray(value)) { drops.count++; return DROP; }
    const out = value.filter((v) => typeof v === 'string');
    drops.count += value.length - out.length;
    return out;
  }
  if (schema === SCALAR_MAP) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { drops.count++; return DROP; }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isScalar(v)) out[k] = v;
      else drops.count++;
    }
    return out;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { drops.count++; return DROP; }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, k)) { drops.count++; continue; }
    const projected = projectBySchema(v, schema[k], drops);
    if (projected !== DROP) out[k] = projected;
  }
  return out;
}

export function sanitizeForEmbed(metrics) {
  const source = JSON.parse(JSON.stringify(metrics));
  const drops = { count: 0 };
  const clone = projectBySchema(source, EMBED_SCHEMA, drops);
  if (drops.count > 0) clone.embed_fields_omitted = drops.count;
  const triage = clone.mechanics?.store?.warning_triage;
  if (triage && Array.isArray(triage.attention_items)) {
    triage.attention_items_omitted = triage.attention_items.length;
    delete triage.attention_items;
  }
  if (Array.isArray(clone.caveats)) {
    clone.caveats = clone.caveats.map((c) =>
      typeof c === 'string' && c.includes('need a look:')
        ? `${c.split(':')[0]} (details omitted — this page stays aggregate-only)`
        : c);
  }
  return clone;
}

// ============================================================
// The page — static HTML + inline CSS, no JavaScript, zero external
// references. Visual system taken from the approved prototype verbatim.
// ============================================================

export function buildMetricsArtifactHtml(metrics, { projectName, producer }) {
  const mech = metrics.mechanics || {};
  const verdict = verdictBlock(mech);
  const gatheredAt = humanTimestamp(metrics.generated_at);
  const shaShort = producer.source_sha ? String(producer.source_sha).slice(0, 12) : 'unknown';
  const shaExplain = producer.source_sha_from === 'git'
    ? 'that identity is the exact source-code commit that generated this page, read live from the source checkout'
    : 'that identity comes from the installed release manifest — the exact packaged version that generated this page';
  const embedded = escapeHtml(JSON.stringify(sanitizeForEmbed(metrics), null, 2));

  return `<title>CORE Metrics — ${escapeHtml(projectName)}</title>
<style>
:root{
  --ink:#1A1E23; --muted:#5A6472; --faint:#8A93A0;
  --surface:#FAFAF8; --card:#FFFFFF; --line:#E4E4DE;
  --accent:#0E5E6E; --accent-ink:#0A4854;
  --good:#1E7F4F; --good-bg:#E8F4EC;
  --warn:#B26B00; --warn-bg:#F9F0DF;
  --crit:#B3382C; --crit-bg:#F9E9E7;
  --prov:#5A6472; --prov-bg:#EEEFF1;
  --track:#ECECE7;
}
@media (prefers-color-scheme: dark){:root{
  --ink:#E8EAED; --muted:#9AA3AE; --faint:#6E7883;
  --surface:#15181B; --card:#1D2126; --line:#2C3238;
  --accent:#4FB3C4; --accent-ink:#7FCCD9;
  --good:#4CAF7D; --good-bg:#1A2E23;
  --warn:#D79A3D; --warn-bg:#2E2617;
  --crit:#D96A5E; --crit-bg:#2E1B18;
  --prov:#9AA3AE; --prov-bg:#252A30;
  --track:#2A2F35;
}}
:root[data-theme="dark"]{
  --ink:#E8EAED; --muted:#9AA3AE; --faint:#6E7883;
  --surface:#15181B; --card:#1D2126; --line:#2C3238;
  --accent:#4FB3C4; --accent-ink:#7FCCD9;
  --good:#4CAF7D; --good-bg:#1A2E23;
  --warn:#D79A3D; --warn-bg:#2E2617;
  --crit:#D96A5E; --crit-bg:#2E1B18;
  --prov:#9AA3AE; --prov-bg:#252A30;
  --track:#2A2F35;
}
:root[data-theme="light"]{
  --ink:#1A1E23; --muted:#5A6472; --faint:#8A93A0;
  --surface:#FAFAF8; --card:#FFFFFF; --line:#E4E4DE;
  --accent:#0E5E6E; --accent-ink:#0A4854;
  --good:#1E7F4F; --good-bg:#E8F4EC;
  --warn:#B26B00; --warn-bg:#F9F0DF;
  --crit:#B3382C; --crit-bg:#F9E9E7;
  --prov:#5A6472; --prov-bg:#EEEFF1;
  --track:#ECECE7;
}
body{background:var(--surface);color:var(--ink);
  font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
  margin:0;padding:0 16px 64px;}
.wrap{max-width:860px;margin:0 auto;}
.mono{font-family:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;}
.banner{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline;
  border-block:3px solid var(--warn);
  background:repeating-linear-gradient(45deg,var(--warn-bg),var(--warn-bg) 12px,transparent 12px,transparent 24px);
  margin:18px 0 26px;padding:10px 14px;font-size:13px;color:var(--muted);}
.banner strong{color:var(--ink);letter-spacing:.06em;font-size:12px;}
h1{font-size:26px;font-weight:650;margin:26px 0 4px;text-wrap:balance;}
.sub{color:var(--muted);margin:0 0 18px;font-size:14.5px;max-width:64ch;}
.legend{background:var(--card);border:1px solid var(--line);padding:12px 16px;
  margin-bottom:24px;font-size:13.5px;color:var(--muted);line-height:1.7;}
.legend b{color:var(--ink);}
.verdict{display:flex;align-items:center;gap:12px;background:var(--card);
  border:1px solid var(--line);border-left:5px solid var(--good);
  padding:14px 18px;margin-bottom:26px;flex-wrap:wrap;}
.verdict.warn{border-left-color:var(--warn);}
.verdict.crit{border-left-color:var(--crit);}
.verdict.prov{border-left-color:var(--prov);}
.verdict .big{font-size:18px;font-weight:650;}
.verdict .scope{color:var(--muted);font-size:13.5px;max-width:52ch;}
section{background:var(--card);border:1px solid var(--line);margin-bottom:18px;padding:16px 18px 6px;}
.sechead{margin-bottom:4px;}
.sechead h2{font-size:16px;margin:0 0 2px;font-weight:650;}
.sechead .note{color:var(--muted);font-size:13.5px;}
.chip{display:inline-block;font-size:11.5px;font-weight:600;letter-spacing:.03em;
  padding:2px 9px;border-radius:999px;white-space:nowrap;}
.chip.good{background:var(--good-bg);color:var(--good);}
.chip.warn{background:var(--warn-bg);color:var(--warn);}
.chip.crit{background:var(--crit-bg);color:var(--crit);}
.chip.prov{background:var(--prov-bg);color:var(--prov);}
.row{display:grid;grid-template-columns:200px 1fr;gap:4px 18px;
  padding:13px 0;border-top:1px solid var(--line);align-items:start;}
.row:first-of-type{border-top:none;}
.rlabel{font-weight:600;font-size:14.5px;padding-top:1px;line-height:1.35;}
.rlabel .chip{margin-top:6px;display:inline-block;}
.rbody{min-width:0;max-width:62ch;}
.gauge{height:10px;background:var(--track);border-radius:5px;overflow:hidden;
  margin:7px 0 6px;max-width:420px;}
.gauge>i{display:block;height:100%;border-radius:0 5px 5px 0;}
.gauge>i.g{background:var(--good);} .gauge>i.a{background:var(--accent);}
.gauge>i.w{background:var(--warn);} .gauge>i.c{background:var(--crit);}
.gauge.empty{background:repeating-linear-gradient(135deg,var(--track),var(--track) 6px,var(--card) 6px,var(--card) 10px);}
.val{font-size:14px;color:var(--muted);}
.val b{color:var(--ink);font-weight:650;}
.num{font-variant-numeric:tabular-nums;}
.tiles{display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 10px;}
.tile{border:1px solid var(--line);padding:8px 14px;min-width:96px;}
.tile .t{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);}
.tile .v{font-size:21px;font-weight:650;font-variant-numeric:tabular-nums;}
details{margin:22px 0 0;}
summary{cursor:pointer;color:var(--muted);font-size:13.5px;}
pre{background:var(--card);border:1px solid var(--line);padding:14px;overflow-x:auto;
  font-size:12px;line-height:1.5;}
footer{margin-top:30px;color:var(--faint);font-size:12.5px;line-height:1.7;max-width:70ch;}
footer .mono{font-size:11.5px;}
@media (max-width:560px){.row{grid-template-columns:1fr;}}
@media (prefers-reduced-motion:no-preference){.gauge>i{transition:width .5s ease;}}
</style>

<div class="wrap">
<div class="banner"><strong>SNAPSHOT &mdash; DOES NOT UPDATE ITSELF</strong>
  <span>Numbers gathered <span class="mono">${escapeHtml(gatheredAt)}</span></span>
  <span>Project: <span class="mono">${escapeHtml(projectName)}</span></span>
  <span>Ask the agent to republish for fresh numbers.</span>
</div>

<h1>Is CORE's memory working?</h1>
<p class="sub">This page answers that question in four parts, from what's solidly proven down to what hasn't been measured at all. The parts are kept separate on purpose: the machinery working (part 1) doesn't mean the search is good (part 2), and neither means it's actually helping you (part 4).</p>

<div class="legend"><b>How to read the colored tags on each line:</b><br>
<b>proven-live</b> &mdash; this was actually demonstrated, from scratch, while generating this page.&nbsp;
<b>direct</b> &mdash; a real number read from real records on disk, but not re-demonstrated.&nbsp;
<b>provisional</b> &mdash; the measuring tool itself hasn't been proven trustworthy yet, so treat its number as a hint.&nbsp;
<b>not-evaluated</b> &mdash; no measurement exists at all.</div>

<div class="verdict ${verdict.cls}"><span class="big">${verdict.big}</span>
  <span class="scope">${verdict.scope}</span></div>

<section>
  <div class="sechead"><h2>1 &middot; Does the machinery work?</h2>
    <span class="note">The basics: can CORE save a memory, find it again, and keep deleted things deleted?</span></div>
${saveAndFindRow(mech)}
${fileHealthRow(mech)}
${lookupRecordsRow(mech)}
</section>

<section>
  <div class="sechead"><h2>2 &middot; How good is the memory search?</h2>
    <span class="note">When something IS stored, does searching actually surface it? Measured with a quiz &mdash; with an honest caveat.</span></div>
${searchQuizRow(metrics.regression)}
</section>

<section>
  <div class="sechead"><h2>3 &middot; Can we trust CORE's self-measurements?</h2>
    <span class="note">CORE tries to grade its own memory habits. These two lines say how far that self-grading can be trusted.</span></div>
${forgotToCheckRow(metrics.readiness)}
${graderVerificationRow(metrics.readiness)}
</section>

<details><summary>The raw data behind this page (the machine-readable object it was generated from; terminal-report text and unit-id lists omitted &mdash; this page stays aggregate-only)</summary>
<pre class="mono">${embedded}</pre></details>

<footer>
  Made by: <span class="mono">${escapeHtml(producer.script || 'render-metrics-artifact.mjs')} (numbers gathered by metrics-check.mjs) &middot; ${escapeHtml(producer.plugin || 'core')} v${escapeHtml(producer.plugin_version || 'unknown')} &middot; source code version ${escapeHtml(shaShort)}</span> &mdash; ${shaExplain}.<br>
  This page was generated mechanically from the health-check data. It does not update itself &mdash; ask the agent to republish for fresh numbers.
</footer>
</div>
`;
}

// ============================================================
// Orchestration — generate, manifest, receipt.
// ============================================================

function validateCanonicalMetrics(obj, source) {
  const missing = ['schema_version', 'mechanics', 'regression', 'readiness', 'generated_at']
    .filter((k) => !(obj && typeof obj === 'object' && k in obj));
  if (missing.length) {
    throw Object.assign(new Error(
      `${source} is not a canonical metrics object (missing: ${missing.join(', ')}) — expected the exact shape gatherMetrics()/--json emits`), { code: 'BAD_JSON_IN' });
  }
}

export async function renderMetricsArtifact(projectDir, {
  outPath,
  jsonIn = null,
  home = null,
  now = () => new Date(),
  // Injectable for tests: defaults to the real canonical gatherer.
  metricsProvider = (dir) => gatherMetrics(dir),
  // Injection point for the mutation window between the artifact write and the
  // post-write verification.
  onArtifactWritten = null,
} = {}) {
  const root = resolve(projectDir);
  if (!outPath) throw Object.assign(new Error('--out <path> is required — there is no default output location'), { code: 'OUT_REQUIRED' });
  const memoriesRoot = join(root, '_memories');
  // Canonical containment: a linked --out is rejected on its real target, not
  // on its spelling.
  const outAbs = resolveArtifactDestination(outPath, { forbiddenRoot: memoriesRoot });

  // Fail closed on producer identity BEFORE gathering or writing anything: a
  // page whose provenance cannot be established must never be rendered for
  // publish (same rule as the browse generator — no unknown-sha render).
  const producer = truthfulProducerIdentity('render-metrics-artifact.mjs');
  if (!producer.source_sha) {
    throw Object.assign(new Error(
      'cannot establish producer identity: not a git source checkout and the plugin manifest carries no source_sha — ' +
      'failing closed rather than rendering a page with unknown provenance'), { code: 'NO_SOURCE_SHA' });
  }

  let metrics;
  let dataSource;
  if (jsonIn) {
    dataSource = 'json-in';
    let parsed;
    try { parsed = JSON.parse(readFileSync(resolve(jsonIn), 'utf8')); }
    catch (e) {
      throw Object.assign(new Error(`cannot read --json-in ${jsonIn}: ${e.message}`), { code: 'BAD_JSON_IN' });
    }
    validateCanonicalMetrics(parsed, `--json-in ${jsonIn}`);
    metrics = parsed;
  } else {
    dataSource = 'live';
    metrics = await metricsProvider(root);
    validateCanonicalMetrics(metrics, 'the metrics provider result');
  }

  const generatedAt = now().toISOString();
  const html = buildMetricsArtifactHtml(metrics, { projectName: basename(root), producer });

  const { workspaceId, receiptDir, receiptPath } = generationReceiptLocation({
    // The receipt is the audit trail; its root comes from the OS-account home
    // unless a caller names one explicitly (test isolation, --home).
    home: home || requireTrustedHome(), projectDir: root, generatedAt,
  });

  const manifest = {
    kind: 'core-metrics-artifact-preflight',
    schema_version: METRICS_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    generated_at: generatedAt,
    data_generated_at: metrics.generated_at ?? null,
    data_source: dataSource,
    producer,
    data_producer: metrics.producer ?? null,
    project: root,
    workspace_id: workspaceId,
    mechanics_status: metrics.mechanics?.status ?? null,
    content_class: METRICS_ARTIFACT_CONTENT_CLASS,
    content_note: METRICS_ARTIFACT_CONTENT_NOTE,
    total_bytes: Buffer.byteLength(html),
    // Exact-byte identity of the generated page — the publish receipt copies
    // this and binds the publish to these specific bytes.
    artifact_sha256: artifactContentDigest(html),
    out_path: outAbs,
    receipt_path: receiptPath,
    receipt_fallback: workspaceId === null,
  };

  // One transaction: the bytes are placed, read back, and proven to be the
  // rendered bytes before the receipt that describes them is written; a receipt
  // that cannot land takes the artifact with it.
  publishArtifactWithReceipt({
    outPath: outAbs, html, receiptDir, receiptPath, manifest,
    forbiddenRoot: memoriesRoot, afterWrite: onArtifactWritten,
  });

  return { manifest, html, receiptWritten: true };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = { outPath: null, jsonIn: null, home: null };
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { opts.outPath = argv[++i]; }
    else if (a === '--json-in') { opts.jsonIn = argv[++i]; }
    else if (a === '--home') { opts.home = argv[++i]; }
    else if (a.startsWith('--')) { throw Object.assign(new Error(`unknown option ${a}`), { code: 'BAD_OPTION' }); }
    else positionals.push(a);
  }
  opts.projectDir = positionals[0] || process.cwd();
  return opts;
}

async function main(argv) {
  if (argv.includes('--record-publish') || argv.includes('--record-revocation')) {
    return runRecordCli(argv, { label: 'render-metrics-artifact' });
  }
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    process.stderr.write(`render-metrics-artifact: ${e.message}\n`);
    return 2;
  }
  try {
    const { manifest, receiptWritten } = await renderMetricsArtifact(opts.projectDir, {
      outPath: opts.outPath,
      jsonIn: opts.jsonIn,
      ...(opts.home ? { home: opts.home } : {}),
    });
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    if (!receiptWritten) {
      process.stderr.write(`render-metrics-artifact: WROTE the HTML but the local receipt failed (${manifest.receipt_error}) — the audit trail for this generation is missing; do not publish until a receipt lands.\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e.code === 'OUT_REQUIRED' || e.code === 'OUT_IN_STORE' || e.code === 'BAD_JSON_IN') {
      process.stderr.write(`render-metrics-artifact: ${e.message}\n`);
      return 2;
    }
    if (e.code === 'NO_SOURCE_SHA') {
      // Fail closed for publish: no HTML was written, no manifest printed.
      process.stderr.write(`render-metrics-artifact: ${e.message}\n`);
      return 1;
    }
    process.stderr.write(`render-metrics-artifact: failed — ${e.stack || e}\n`);
    return 1;
  }
}

// Entry check compares REAL paths on both sides (same rationale as the browse
// generator: a naive string compare can silently skip main() behind symlinked
// temp paths — a lying instrument).
const _cliEntry = (() => {
  try {
    const self = fileURLToPath(import.meta.url);
    const invoked = resolve(process.argv[1] || '');
    if (self === invoked) return true;
    try { return self === realpathSync(invoked); } catch { return false; }
  } catch { return false; }
})();
if (_cliEntry) {
  process.exit(await main(process.argv.slice(2)));
}
