/**
 * Analyze retrieval-log corpus across a project's _sessions/<YYYY-MM-DD>/retrieval-log.jsonl files.
 *
 * Reads per-event JSONL records, computes:
 *   - per-unit dip-back rate (precision proxy)
 *   - per-topic tier-escalation frequency (recall proxy)
 *   - overall tier distribution
 *
 * Schema validation: loadEvents()
 * validates every row against validateRetrievalLogRow() below and rejects —
 * never silently drops — any row that is JSON-unparseable or claims to be a
 * retrieval event (kind:'retrieval', or legacy rows without a `kind` that
 * duck-type as retrieval-shaped) but fails the schema. Rows stamped with the
 * CURRENT schema_version (record-retrieval-event.mjs's
 * RETRIEVAL_EVENT_SCHEMA_VERSION) are validated by reusing that file's own
 * normalizeRetrievalEvent() — the single canonical producer contract, not a
 * weaker sibling schema. Rows with no schema_version at all (every row any
 * project wrote before this existed) get a narrow backward-compatibility
 * check and are tagged 'legacy' — counted separately, never implied to meet
 * current-producer conformance. Rejections ride along on the returned array
 * as `.rejected` (an array of {file, schema, code} — CLOSED reason codes
 * only, never a raw echoed value); buildReport() folds that into
 * `report.rejected` (current/legacy/other counts broken out by closed code),
 * and formatReport() always prints it, even when it's all zero.
 *
 * By design the script lives in the plugin, not per-project.
 * The plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { buildReport, loadEvents, formatReport } from './analyze-retrieval-quality.mjs';
 *   const events = loadEvents('<project>', { sinceDays: 30 }); // events.rejected also available
 *   const report = buildReport(events);
 *   console.log(formatReport(report));
 *
 * CLI:
 *   node analyze-retrieval-quality.mjs <project-root> [--since-days N | --all]
 *                                       [--today YYYY-MM-DD] [--json]
 */

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOutcomeAuthority } from './record-retrieval-outcome.mjs';
import { normalizeRetrievalEvent, RETRIEVAL_EVENT_SCHEMA_VERSION } from './record-retrieval-event.mjs';

export const DEFAULT_SINCE_DAYS = 30;
export const TOP_DIP_BACK = 10;
export const TOP_ESCALATION = 10;

export function isRetrievalShapedEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  return (
    Object.hasOwn(ev, 'tier_reached')
    || Object.hasOwn(ev, 'units_retrieved')
    || Object.hasOwn(ev, 'intent_topics')
    || Object.hasOwn(ev, 'escalation_path')
    || Object.hasOwn(ev, 'dip_back_count')
  );
}

// ---------- Row-level schema validation ----------
//
// Every row is validated so that no failure mode is invisible to a caller: a
// row that fails JSON.parse is rejected and counted (never silently dropped),
// and a row that parses but claims to be a retrieval event while failing the
// schema is rejected and counted too. Any row stamped with the CURRENT
// schema version is validated by reusing `normalizeRetrievalEvent()` from
// record-retrieval-event.mjs — the ONE canonical producer contract — instead
// of maintaining a second, drifting definition of "valid" here.
//
// Rows with no `schema_version` cannot be held to that full contract —
// trigger and a tier-consistent escalation_path are not guaranteed present in
// them. Those get a NARROW backward-compatibility check instead, and the
// result is always tagged 'legacy' — counted separately, never folded into or
// implied to meet current-producer conformance. A row carrying some OTHER,
// unrecognized schema_version is rejected outright as
// 'unknown-schema-version' rather than guessed at.
//
// Every rejection carries a CLOSED reason CODE only (REJECTION_CODES below) —
// never an interpolated raw field value. A malformed row can contain
// anything (including secret-shaped strings); that content must never
// reappear in a report or package surface, so codes are the only thing any
// caller threads into rendered/exported output. Raw detail (file path, the
// underlying exception message) is available on the `.rejected` array
// loadEvents() returns for LOCAL diagnostic use only — buildReport() below
// never copies raw values into the report object it returns.
export const REJECTION_CODES = new Set([
  'invalid-row-shape', 'invalid-json', 'unknown-schema-version',
  // current-schema (full producer-contract) rejections:
  'invalid-trigger', 'invalid-intent-topics', 'missing-tier', 'invalid-tier',
  'invalid-escalation-path', 'invalid-units', 'invalid-result', 'invalid-mechanism',
  'invalid-retrieval-id', 'schema-invalid',
  // legacy (pre-versioning, narrow-compatibility) rejections:
  'legacy-missing-tier', 'legacy-invalid-tier', 'legacy-invalid-units', 'legacy-invalid-topics',
]);

// Classifies a normalizeRetrievalEvent() throw into a closed code by the
// field name embedded in its message ("invalid retrieval event: <field> ...").
// Never touches the row's actual value — only the field NAME the canonical
// validator already put in its own error, which is itself a closed set.
function codeForProducerRejection(ev, message) {
  const m = String(message).match(/^invalid retrieval event: (\S+)/);
  const field = m ? m[1].split(/[[.]/)[0] : null;
  switch (field) {
    case 'trigger': return 'invalid-trigger';
    case 'intent_topics': return 'invalid-intent-topics';
    case 'tier_reached': return ev.tier_reached === undefined ? 'missing-tier' : 'invalid-tier';
    case 'escalation_path': return 'invalid-escalation-path';
    case 'units_retrieved': return 'invalid-units';
    case 'result': return 'invalid-result';
    case 'mechanism': return 'invalid-mechanism';
    case 'retrieval_id': return 'invalid-retrieval-id';
    default: return 'schema-invalid';
  }
}

// This validator only judges rows that are ATTEMPTING to be a retrieval
// event: kind === 'retrieval' explicitly, or (for pre-`kind`-field legacy
// rows) anything that duck-types as retrieval-shaped. Any other explicit
// kind (retrieval-outcome, hot-section-synthesis, hot-section-over-budget,
// a future kind this file doesn't know about yet) is a different event type
// entirely and is never validated or counted as a rejected retrieval row —
// 'not-applicable', not 'rejected'.
export function validateRetrievalLogRow(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    return { status: 'rejected', schema: 'unknown', code: 'invalid-row-shape' };
  }
  const isCandidate = ev.kind === 'retrieval' || (ev.kind === undefined && isRetrievalShapedEvent(ev));
  if (!isCandidate) return { status: 'not-applicable' };

  // Known-compatible versions, all validated under the current producer
  // contract: 1.1.0 (current — adds producer_version/producer_sha, additive)
  // and 1.0.0 (its strict subset, still present in stored rows).
  // An additive bump must never turn real history into 'unknown-schema-version'.
  if (ev.schema_version === RETRIEVAL_EVENT_SCHEMA_VERSION || ev.schema_version === '1.0.0') {
    try {
      normalizeRetrievalEvent(ev);
      return { status: 'valid', schema: 'current' };
    } catch (e) {
      return { status: 'rejected', schema: 'current', code: codeForProducerRejection(ev, e.message) };
    }
  }

  if (ev.schema_version !== undefined) {
    // A defined but unrecognized version — never assume forward/backward
    // compatibility with a schema this code doesn't know about.
    return { status: 'rejected', schema: 'unknown-version', code: 'unknown-schema-version' };
  }

  // No schema_version at all: pre-versioning history. Narrow check only —
  // covers exactly the fields the aggregations below consume numerically
  // (tier_reached, units_retrieved[].id, intent_topics). Passing this check
  // is 'legacy-valid', never 'valid' under the current producer contract.
  if (ev.tier_reached === undefined) return { status: 'rejected', schema: 'legacy', code: 'legacy-missing-tier' };
  if (!Number.isInteger(ev.tier_reached) || ev.tier_reached < 1 || ev.tier_reached > 3) {
    return { status: 'rejected', schema: 'legacy', code: 'legacy-invalid-tier' };
  }
  if (ev.units_retrieved !== undefined) {
    if (!Array.isArray(ev.units_retrieved) || ev.units_retrieved.some((u) => !u || typeof u !== 'object' || typeof u.id !== 'string' || !u.id.trim())) {
      return { status: 'rejected', schema: 'legacy', code: 'legacy-invalid-units' };
    }
  }
  if (ev.intent_topics !== undefined) {
    if (!Array.isArray(ev.intent_topics) || ev.intent_topics.some((t) => typeof t !== 'string')) {
      return { status: 'rejected', schema: 'legacy', code: 'legacy-invalid-topics' };
    }
  }
  return { status: 'valid', schema: 'legacy' };
}

// ---------- Date helpers ----------

function _todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

function _parseSessionDate(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

// ---------- Event loading ----------

export function loadEvents(projectRoot, { sinceDays = DEFAULT_SINCE_DAYS, allTime = false, today = null } = {}) {
  const sessionsDir = join(projectRoot, '_sessions');
  let entries;
  try { entries = readdirSync(sessionsDir); } catch { return Object.assign([], { rejected: [] }); }

  const t = today || _todayUTC();
  // A non-finite sinceDays (e.g. `--since-days abc` → NaN) would make the cutoff
  // NaN and silently include ALL events. Fall back to the default window instead.
  const days = Number.isFinite(sinceDays) ? sinceDays : DEFAULT_SINCE_DAYS;
  const cutoff = allTime ? null : new Date(t.getTime() - days * 86_400_000);

  const events = [];
  // Malformed rows are REJECTED and COUNTED here, not silently dropped — a
  // JSON.parse failure and a schema-invalid retrieval row both land here with
  // a CLOSED reason code (never the raw offending value — arbitrary
  // malformed values must not flow into reports/packages), and
  // the local absolute file path stays here for diagnostics only. `.rejected`
  // rides along on the returned array as a plain extra property so every
  // existing `loadEvents(...)` caller that treats the result as a plain
  // array keeps working unchanged; buildReport() below is the one place that
  // reads it, and it never copies the raw `file` value into the report it
  // returns — only closed-code counts.
  const rejected = [];
  for (const name of entries.sort()) {
    const date = _parseSessionDate(name);
    if (!date) continue;
    if (cutoff && date < cutoff) continue;
    for (const logName of ['retrieval-log.jsonl', 'outcome-log.jsonl']) {
      const logPath = join(sessionsDir, name, logName);
      let raw;
      try { raw = readFileSync(logPath, 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed;
        try { parsed = JSON.parse(trimmed); }
        catch { rejected.push({ file: logPath, schema: 'unknown', code: 'invalid-json' }); continue; }
        const check = validateRetrievalLogRow(parsed);
        if (check.status === 'rejected') { rejected.push({ file: logPath, schema: check.schema, code: check.code }); continue; }
        events.push(parsed);
      }
    }
  }
  return Object.assign(events, { rejected });
}

// ---------- Aggregations ----------

export function computeDipBackRates(events) {
  events = events.filter(isRetrievalShapedEvent);
  const byUnit = new Map();
  for (const ev of events) {
    const units = Array.isArray(ev.units_retrieved) ? ev.units_retrieved : null;
    if (!units || !units.length) continue;
    // Unknown-aware: rows that OMITTED dip_back_count (the per-turn
    // hook cannot observe dip-backs) leave both numerator and denominator —
    // missing is not "no dip-back". Observed coverage rides each row.
    const observed = Number.isInteger(ev.dip_back_count);
    const dipped = observed && ev.dip_back_count > 0;
    for (const u of units) {
      if (!u || !u.id) continue;
      const rec = byUnit.get(u.id) || { unit_id: u.id, retrievals: 0, dip_backs: 0, dipback_observed: 0 };
      rec.retrievals += 1;
      if (observed) rec.dipback_observed += 1;
      if (dipped) rec.dip_backs += 1;
      byUnit.set(u.id, rec);
    }
  }
  const rows = [];
  for (const rec of byUnit.values()) {
    rows.push({
      unit_id: rec.unit_id, retrievals: rec.retrievals,
      dipback_observed: rec.dipback_observed,
      rate: rec.dipback_observed > 0 ? rec.dip_backs / rec.dipback_observed : null,
    });
  }
  rows.sort((a, b) => ((b.rate ?? -1) - (a.rate ?? -1)) || b.retrievals - a.retrievals || a.unit_id.localeCompare(b.unit_id));
  return rows;
}

export function computeTierEscalation(events) {
  events = events.filter(isRetrievalShapedEvent);
  const byTopic = new Map();
  for (const ev of events) {
    const topics = Array.isArray(ev.intent_topics) ? ev.intent_topics : null;
    if (!topics || !topics.length) continue;
    const tier = Number(ev.tier_reached) || 1;
    for (const topic of topics) {
      if (typeof topic !== 'string') continue;
      const rec = byTopic.get(topic) || { topic, events: 0, escalated_t2_plus: 0 };
      rec.events += 1;
      if (tier >= 2) rec.escalated_t2_plus += 1;
      byTopic.set(topic, rec);
    }
  }
  const rows = [];
  for (const rec of byTopic.values()) {
    rows.push({
      topic: rec.topic,
      events: rec.events,
      escalated_t2_plus: rec.escalated_t2_plus,
      rate_t2_plus: rec.escalated_t2_plus / rec.events,
    });
  }
  rows.sort((a, b) => b.rate_t2_plus - a.rate_t2_plus || b.events - a.events || a.topic.localeCompare(b.topic));
  return rows;
}

export function computeTierDistribution(events) {
  events = events.filter(isRetrievalShapedEvent);
  const counts = { t1: 0, t2: 0, t3: 0 };
  for (const ev of events) {
    const t = Number(ev.tier_reached) || 1;
    if (t >= 3) counts.t3 += 1;
    else if (t === 2) counts.t2 += 1;
    else counts.t1 += 1;
  }
  const total = events.length;
  const pct = c => (total ? c / total : 0);
  return {
    t1: { count: counts.t1, pct: pct(counts.t1) },
    t2: { count: counts.t2, pct: pct(counts.t2) },
    t3: { count: counts.t3, pct: pct(counts.t3) },
    total,
  };
}

function outcomeEvidence(events) {
  const retrievals = events.filter(ev => isRetrievalShapedEvent(ev) && typeof ev.retrieval_id === 'string' && ev.retrieval_id.trim());
  const byId = new Map();
  for (const ev of retrievals) {
    const id = ev.retrieval_id.trim();
    const rows = byId.get(id) || [];
    rows.push(ev);
    byId.set(id, rows);
  }
  // Multiple outcome rows per retrieval_id resolve via the SAME authority
  // resolver metrics-package.mjs uses — the two consumers must never
  // disagree about which outcome is authoritative for the same retrieval.
  const outcomeRowsById = new Map();
  for (const ev of events) {
    if (ev?.kind !== 'retrieval-outcome' || typeof ev.retrieval_id !== 'string') continue;
    const id = ev.retrieval_id.trim();
    if (!id || byId.get(id)?.length !== 1) continue;
    const rows = outcomeRowsById.get(id) || [];
    rows.push(ev);
    outcomeRowsById.set(id, rows);
  }
  const outcomes = new Map();
  for (const [id, rows] of outcomeRowsById) {
    const resolved = resolveOutcomeAuthority(rows);
    // 'unknown' (explicit or tie-resolved) is coverage, never a denominator —
    // matches metrics-package.mjs's outcomesById semantics exactly.
    if (resolved && resolved !== 'unknown') outcomes.set(id, resolved);
  }
  const eligibleIds = [...byId.entries()].filter(([, rows]) => rows.length === 1).map(([id]) => id);
  const harmfulIds = eligibleIds.filter(id => ['noisy', 'miss'].includes(outcomes.get(id)));
  return { eligibleIds, outcomes, harmfulIds };
}

export function buildUserReceipt(events) {
  const retrievalCount = events.filter(isRetrievalShapedEvent).length;
  if (retrievalCount === 0) {
    return {
      checked: '0 retrieval events in analyzed window',
      safe: null,
      impact: 'effectiveness unknown: no retrieval evidence',
      action: 'collect-retrieval-evidence',
      user_action: 'Use CORE normally, then run this analyzer again after retrieval events exist.',
    };
  }

  const { eligibleIds, outcomes, harmfulIds } = outcomeEvidence(events);
  const observed = outcomes.size;
  const eligible = eligibleIds.length;
  if (harmfulIds.length > 0) {
    return {
      checked: `${observed} of ${eligible} answer outcomes checked`,
      safe: false,
      impact: `${harmfulIds.length} observed answer outcome(s) were noisy or missed`,
      action: 'inspect-harmful-outcomes',
      user_action: `Inspect retrieval ${harmfulIds[0]} and correct the memory or retrieval policy before trusting similar answers.`,
    };
  }
  if (eligible === 0 || observed < eligible) {
    return {
      checked: `${observed} of ${eligible} answer outcomes checked across ${retrievalCount} retrieval event(s)`,
      safe: null,
      impact: 'answer outcome unknown for one or more retrievals',
      action: 'collect-answer-outcomes',
      user_action: 'Record an evidence-qualified answer outcome after each retrieval-backed answer.',
    };
  }
  // NEVER `safe: true` from answer telemetry alone: outcome rows say nothing about privacy or
  // anti-resurrection state, and field telemetry is not a safety proof. The
  // strongest claim this receipt can honestly make is "no observed harm."
  return {
    checked: `${observed} of ${eligible} answer outcomes checked`,
    safe: null,
    impact: 'no noisy or missed outcomes observed in the analyzed window (no-harm-observed is not a global safety claim)',
    action: 'none',
    user_action: 'No immediate action; continue collecting outcomes and recheck trends.',
  };
}

// ---------- Report assembly ----------

// Folds raw `.rejected` entries ({file, schema, code}) into CLOSED-vocabulary
// counts only — no file paths, no raw values. This is the shape that is safe
// to appear in any rendered report or shareable package: closed reason-code
// counts only, never absolute paths.
function summarizeRejections(rejected) {
  const current = { count: 0, by_code: {} };
  const legacy = { count: 0, by_code: {} };
  const other = { count: 0, by_code: {} }; // invalid-json / invalid-row-shape / unknown-schema-version
  for (const r of rejected) {
    const bucket = r.schema === 'current' ? current : r.schema === 'legacy' ? legacy : other;
    bucket.count += 1;
    bucket.by_code[r.code] = (bucket.by_code[r.code] || 0) + 1;
  }
  return { current, legacy, other, total: current.count + legacy.count + other.count };
}

function formatByCode(bucket) {
  const codes = Object.entries(bucket.by_code).sort((a, b) => b[1] - a[1]);
  return codes.map(([code, n]) => `${code}: ${n}`).join(', ');
}

export function buildReport(events) {
  const retrievalEvents = events.filter(isRetrievalShapedEvent);
  // Count distinct calendar DAYS from event timestamps (reported as such — these are
  // not sessions; more reliable than counting unique ev.session IDs, which are absent
  // in events written without a session context, producing a misleading "Sessions: 0"
  // when events exist).
  const DATE_RE = /^\d{4}-\d{2}-\d{2}/;
  const sessions = new Set(
    events
      .map(ev => (ev && ev.ts ? String(ev.ts).slice(0, 10) : ''))
      .filter(d => DATE_RE.test(d))
  );
  // Rejection counts ride in on `events.rejected` when the caller got `events`
  // from loadEvents() above; a plain array passed directly (every unit test in
  // this file does this) has no `.rejected` and honestly reports zero — there
  // is nothing to have rejected when the caller already hand-built the array.
  const rejected = Array.isArray(events.rejected) ? events.rejected : [];
  return {
    sessions: sessions.size,
    total_events: events.length,
    retrieval_events: retrievalEvents.length,
    telemetry_only_events: events.length - retrievalEvents.length,
    tier_distribution: computeTierDistribution(retrievalEvents),
    dip_back_rates: computeDipBackRates(retrievalEvents).slice(0, TOP_DIP_BACK),
    tier_escalation: computeTierEscalation(retrievalEvents).slice(0, TOP_ESCALATION),
    receipt: buildUserReceipt(events),
    rejected: summarizeRejections(rejected),
  };
}

export function formatReport(report) {
  const rej = report.rejected || summarizeRejections([]);
  if (!report.total_events) {
    // Zero valid events is NOT the same claim as zero rows seen — a corpus that
    // is all malformed rows must never read identically to a truly empty one.
    const rejectedLine = rej.total > 0
      ? `\nRejected malformed rows: ${rej.total} (${formatByCode({ by_code: { ...rej.current.by_code, ...rej.legacy.by_code, ...rej.other.by_code } })}) — these are NOT zero valid events, they are rows that failed schema validation`
      : '';
    return `No retrieval events found in the analyzed window.${rejectedLine}\nChecked: ${report.receipt.checked}\nSafe: unknown\nImpact: ${report.receipt.impact}\nAction: ${report.receipt.action}\nUser action: ${report.receipt.user_action}`;
  }
  const td = report.tier_distribution;
  const pct = v => `${Math.round(v * 100)}%`;
  const lines = [];
  const retrievalEvents = report.retrieval_events ?? report.total_events;
  const telemetryOnlyEvents = report.telemetry_only_events ?? 0;
  lines.push(`Calendar days with events: ${report.sessions} | Total events: ${report.total_events}`);
  lines.push(`Retrieval-shaped events: ${retrievalEvents} | telemetry-only rows: ${telemetryOnlyEvents}`);
  // Always shown, even at zero — an explicit "0 rejected" is itself evidence
  // the row was checked, not just assumed clean. Malformed rows are rejected
  // AND counted, using CLOSED codes only — never an interpolated raw field
  // value.
  const currentPart = rej.current.count > 0 ? `${rej.current.count} current-schema (${formatByCode(rej.current)})` : '0 current-schema';
  const legacyPart = rej.legacy.count > 0 ? `${rej.legacy.count} legacy (${formatByCode(rej.legacy)})` : '0 legacy';
  const otherPart = rej.other.count > 0 ? `; ${rej.other.count} unreadable (${formatByCode(rej.other)})` : '';
  lines.push(`Rejected malformed rows: ${rej.total} — ${currentPart}, ${legacyPart}${otherPart}`);
  lines.push(`Checked: ${report.receipt.checked}`);
  lines.push(`Safe: ${report.receipt.safe === null ? 'unknown' : report.receipt.safe}`);
  lines.push(`Impact: ${report.receipt.impact}`);
  lines.push(`Action: ${report.receipt.action}`);
  lines.push(`User action: ${report.receipt.user_action}`);
  if (telemetryOnlyEvents > 0) {
    lines.push('Telemetry-only rows are not retrieval proof.');
  }
  if (retrievalEvents === 0) {
    return lines.join('\n');
  }
  lines.push(`Tier distribution: T1=${pct(td.t1.pct)}, T2=${pct(td.t2.pct)}, T3=${pct(td.t3.pct)}`);
  lines.push('Note: T1 counts only logged retrievals — days with no retrieval events are excluded, not counted as perfect T1.');
  lines.push('');

  const noisyDipBacks = report.dip_back_rates.filter(r => r.rate > 0);
  if (noisyDipBacks.length) {
    lines.push('High dip-back rate (precision problems):');
    for (const r of noisyDipBacks) {
      lines.push(`  ${r.unit_id}: ${r.retrievals} retrievals, ${pct(r.rate)} dip-back`);
    }
  }

  const noisyEscalations = report.tier_escalation.filter(e => e.rate_t2_plus > 0);
  if (noisyEscalations.length) {
    lines.push('');
    lines.push('Frequent Tier 2+ escalation (recall problems):');
    for (const e of noisyEscalations) {
      lines.push(`  topic '${e.topic}': ${e.events} events, ${pct(e.rate_t2_plus)} needed Tier 2+`);
    }
  }

  return lines.join('\n');
}

// ---------- CLI ----------

export function main(argv) {
  let projectRoot = '.';
  let sinceDays = DEFAULT_SINCE_DAYS;
  let allTime = false;
  let todayArg = null;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since-days') { sinceDays = parseInt(argv[++i], 10); }
    else if (a === '--all') { allTime = true; }
    else if (a === '--today') { todayArg = argv[++i]; }
    else if (a === '--json') { asJson = true; }
    else if (!a.startsWith('--')) { projectRoot = a; }
  }

  const root = resolve(projectRoot);
  try {
    const st = statSync(root);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    process.stderr.write(`error: ${root} is not a directory\n`);
    return 2;
  }

  const today = todayArg
    ? new Date(`${todayArg}T00:00:00Z`)
    : _todayUTC();
  const events = loadEvents(root, { sinceDays, allTime, today });
  const report = buildReport(events);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return 0;
}

// CLI entry guard. Set CORE_DEBUG_CLI_ENTRY=1 to log both strings if invocation
// silently no-ops (path-normalization, symlinks, OneDrive virtualization, etc.).
const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (process.env.CORE_DEBUG_CLI_ENTRY) {
  process.stderr.write(`[cli-entry] argv[1]=${JSON.stringify(_cliEntryArgv1)}\n[cli-entry] self  =${JSON.stringify(_cliEntrySelf)}\n[cli-entry] match=${_cliEntryArgv1 === _cliEntrySelf}\n`);
}
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
