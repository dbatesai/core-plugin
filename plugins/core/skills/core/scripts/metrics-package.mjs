#!/usr/bin/env node
/**
 * metrics-package.mjs — the anonymized memory-efficacy feedback package.
 * Spec: CORE workshop `docs/specs/2026-07-16-metrics-package-spec.md`.
 *
 * ONE PURPOSE: feedback data for refining CORE itself. The package must be safe
 * to hand across strict data boundaries (the Crest/T-Mobile rule: de-identified
 * aggregates only, no reconstruction risk), so the design is whitelist-generation:
 * every byte in the package is COMPUTED here from raw sources — no raw file is
 * ever copied, and the only value types that survive are numbers, dates, fixed
 * CORE vocabulary (enum states, op names, check ids, capability ids), and salted
 * pseudonyms. Free text (query words, titles, bodies, paths, validator messages)
 * is dropped, never hashed. Per DC-77 this boundary lives in prescriptive code,
 * not skill prose; per DC-80, zero dependencies.
 *
 * Pseudonyms: HMAC-SHA256 over a per-install secret salt (~/.core/metrics-package-salt,
 * 0600, NEVER shipped). Stable across packages from the same install (David's
 * ratified call, 2026-07-16) so trend lines are comparable; meaningless elsewhere.
 * Deleting the salt rotates every pseudonym.
 *
 * Self-healing: every source is optional — absent/unparseable sources emit
 * `{available:false, reason}` blocks and land in manifest.coverage; one broken
 * project never sinks an --all run. Fail-closed the other way: a leakage
 * self-scan runs over the staged bytes before zipping, and any hit aborts the
 * package entirely (exit 2).
 *
 * CLI: node metrics-package.mjs <project-dir> [--all] [--out <dir>] [--json] [--home <dir>]
 *   --all   package every workspace registered in ~/.core/index.json whose path
 *           exists and contains _memories/
 *   --out   destination dir (default: the platform Desktop, else home)
 *   --home  test seam: treat <dir> as the user home (tests must never touch ~)
 * Exit: 0 complete · 1 partial (sources or projects unavailable, package produced)
 *       · 2 aborted (leakage hit or fatal; nothing shipped)
 */
import {
  existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync,
  mkdtempSync, rmSync, chmodSync, appendFileSync, cpSync, realpathSync,
} from 'node:fs';
import { join, resolve, basename, dirname, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadUnit } from './priority.mjs';
import { trustedHome } from './trusted-home.mjs';
import { buildReportMd, buildReportHtml } from './metrics-package-report.mjs';
import { resolveOutcomeAuthority } from './record-retrieval-outcome.mjs';

export const SCHEMA_VERSION = '1.0.0';
const SALT_FILE = 'metrics-package-salt';
const HISTORY_DIR = 'metrics-package-history';

// Closed CORE vocabulary — the only strings (besides pseudonyms, dates, and
// numbers) allowed into the package. Anything outside a whitelist folds to 'other'.
const UNIT_TYPES = ['decision', 'risk', 'observation', 'person', 'reference', 'principle', 'value', 'explainer', 'review-finding', 'open-question', 'premise', 'episode'];
const UNIT_STATUSES = ['active', 'retired', 'archived', 'superseded', 'draft'];
const EDGE_TYPES = ['cites', 'depends-on', 'supersedes', 'supersedes-claim', 'refines', 'amends', 'conflicts-with', 'references-topic'];
// The classifier's ACTUAL state vocabulary (classify-turns.mjs is the producer —
// Hale's 2026-07-17 audit caught the previous invented list collapsing 5 of 6
// canonical states to 'other').
const RECOGNITION_STATES = ['rec-fail-tier-0', 'rec-fail-tier-1-3-trigger', 'tier-0-win', 'tier-1-3-win', 'capture-miss', 'mechanics-failure'];
// Code-owned enums for every remaining string source (Hale audit e1490d4 finding 7:
// a shape check like kebab-case is NOT a privacy boundary — user-derived values can
// be kebab-shaped. Only these exact values pass; everything else folds to 'other').
const HYGIENE_KINDS = ['compact-project', 'demote-moves', 'demote-moves-large-batch', 'demote-state', 'demote-state-large-batch', 'project-md-over-cap', 'maintenance-run'];
const MAINTENANCE_OPS = ['decisions-index', 'risks-index', 'summary-index'];
const CAPABILITY_IDS = ['plugin-root-resolution', 'target-surface-collab-files', 'auto-memory-injection', 'anti-anchoring-mechanism', 'instruction-surface-resolution', 'memory-visible-in-agent-context', 'memory-accessed'];
// Committed trust vocabulary (proven-live / direct / proxy / provisional) — the
// same enum /metrics uses; a separate basis string explains, never upgrades.
const TRUST = { PROVEN_LIVE: 'proven-live', DIRECT: 'direct', PROXY: 'proxy', PROVISIONAL: 'provisional' };
// k-anonymity-style small-cell threshold for histograms keyed by open-ended
// dimensions (months); cells under k fold into a suppressed aggregate.
const SMALL_CELL_K = 3;
// Per-unit rankings only ship from stores large enough that a row can't
// fingerprint a specific unit's identity by position.
const RANKING_MIN_POPULATION = 50;
const RANKING_MIN_COUNT = 3;

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ---------- small utilities ----------

function fold(value, whitelist) {
  return whitelist.includes(value) ? value : 'other';
}

// Small-cell suppression: cells with 0 < count < k fold into one aggregate so a
// rare category can't fingerprint the store across packages (Hale finding 6).
function suppressSmallCells(hist, k = SMALL_CELL_K) {
  const out = {};
  let suppressedCells = 0; let suppressedTotal = 0;
  for (const [key, count] of Object.entries(hist)) {
    if (count > 0 && count < k) { suppressedCells += 1; suppressedTotal += count; }
    else out[key] = count;
  }
  if (suppressedCells) out.suppressed = { cells: suppressedCells, total: suppressedTotal, k };
  return out;
}

function readJsonlSafe(file) {
  const rows = [];
  let bad = 0;
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { rows, bad: 0, missing: true }; }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { bad += 1; }
  }
  return { rows, bad, missing: false };
}

function num(x) { return (typeof x === 'number' && Number.isFinite(x)) ? x : null; }

function isoDay(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function round3(x) { return x == null ? null : Math.round(x * 1000) / 1000; }

function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return d.toISOString().slice(0, 10);
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (num(value) != null) target[key] = (target[key] || 0) + value;
  }
}

function weeklyRetrieval(days) {
  const weeks = {};
  for (const [day, row] of Object.entries(days || {})) {
    const week = weekStart(day);
    if (!week) continue;
    const out = weeks[week] ||= {
      events: 0, tiers: {}, escalations: 0, dip_backs: 0,
      dipback_observed_rows: 0, misses: 0, no_hits: 0, suppressed: {},
    };
    for (const key of ['events', 'escalations', 'dip_backs', 'dipback_observed_rows', 'misses', 'no_hits']) {
      out[key] += num(row[key]) || 0;
    }
    addCounts(out.tiers, row.tiers);
    addCounts(out.suppressed, row.suppressed);
    if (row.outcomes) { out.outcomes ||= {}; addCounts(out.outcomes, row.outcomes); }
  }
  return weeks;
}

function weeklyHygiene(days) {
  const weeks = {};
  for (const [day, row] of Object.entries(days || {})) {
    const week = weekStart(day);
    if (!week) continue;
    const out = weeks[week] ||= { ops: {} };
    addCounts(out.ops, row.ops);
  }
  return weeks;
}

function weeklyRecognition(days) {
  const weeks = {};
  for (const [day, row] of Object.entries(days || {})) {
    const week = weekStart(day);
    if (!week) continue;
    const out = weeks[week] ||= { turns: 0, states: {}, provisional_count: 0 };
    out.turns += num(row.turns) || 0;
    out.provisional_count += num(row.provisional_count) || 0;
    addCounts(out.states, row.states);
  }
  for (const row of Object.values(weeks)) {
    row.provisional_share = row.turns ? round3(row.provisional_count / row.turns) : null;
    delete row.provisional_count;
  }
  return weeks;
}

export function projectForShare(blocks) {
  const out = { ...blocks };
  const retrieval = blocks['retrieval-stats'];
  if (retrieval?.available) {
    const { days, ...rest } = retrieval;
    out['retrieval-stats'] = { ...rest, weeks: weeklyRetrieval(days) };
  }
  const hygiene = blocks['hygiene-stats'];
  if (hygiene?.available) {
    const { days, ...rest } = hygiene;
    out['hygiene-stats'] = { ...rest, weeks: weeklyHygiene(days) };
  }
  const workspace = blocks['workspace-metrics'];
  if (workspace?.available && workspace.recognition?.available) {
    const { days, ...recognition } = workspace.recognition;
    out['workspace-metrics'] = {
      ...workspace,
      recognition: { ...recognition, weeks: weeklyRecognition(days) },
    };
  }
  return out;
}

// ---------- pseudonymization ----------

export function loadOrCreateSalt(coreDir) {
  const p = join(coreDir, SALT_FILE);
  if (existsSync(p)) return { salt: readFileSync(p, 'utf8').trim(), created: false };
  mkdirSync(coreDir, { recursive: true });
  const salt = randomBytes(32).toString('hex');
  writeFileSync(p, salt + '\n', { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* windows: mode is advisory */ }
  return { salt, created: true };
}

export function makeSeal(salt) {
  return (kind, id) => `${kind}-${createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 12)}`;
}

// ---------- per-source collectors ----------
// Every collector returns { available, reason?, _trust, ...aggregates }.
// _trust labels reuse the /metrics vocabulary: what kind of evidence this is.

function listSessionLogs(projectDir, logName) {
  const root = join(projectDir, '_sessions');
  if (!existsSync(root)) return [];
  const out = [];
  for (const d of readdirSync(root).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const f = join(root, d, logName);
    if (existsSync(f)) out.push({ date: d, file: f });
  }
  return out;
}

export function retrievalStats(projectDir, seal) {
  const logs = listSessionLogs(projectDir, 'retrieval-log.jsonl');
  const trust = { _trust: TRUST.PROXY, _trust_basis: 'event log with mixed provenance: agent-recorded rows plus (from 2026-07-17) product-emitted per-turn-hook rows; label upgrades to direct when the corpus is fully product-emitted' };
  if (!logs.length) return { available: false, reason: 'no retrieval-log.jsonl under _sessions/', ...trust };
  const days = {};
  const unitFreq = new Map();
  let badLines = 0;
  const totals = { events: 0, dip_backs: 0, misses: 0, escalations: 0 };
  const entries = [];
  for (const { date, file } of logs) {
    const { rows, bad } = readJsonlSafe(file);
    badLines += bad;
    for (const row of rows) entries.push({ date, row });
  }
  // Outcomes live in the SEPARATE later outcome-log (Hale stop-note): read
  // them alongside retrieval rows so the join sees both sides.
  for (const { date, file } of listSessionLogs(projectDir, 'outcome-log.jsonl')) {
    const { rows, bad } = readJsonlSafe(file);
    badLines += bad;
    for (const row of rows) entries.push({ date, row });
  }

  // Outcomes are later rows, joined to exactly one product retrieval by the
  // immutable retrieval_id. They never count as additional retrieval events.
  const baseById = new Map();
  for (const entry of entries) {
    const r = entry.row;
    if ((r.kind && r.kind !== 'retrieval') || typeof r.retrieval_id !== 'string' || !r.retrieval_id.trim()) continue;
    const id = r.retrieval_id.trim();
    const matches = baseById.get(id) || [];
    matches.push(entry);
    baseById.set(id, matches);
  }
  // Outcome resolution (Hale corrections 5–7, 2026-07-17, sharpened in the
  // 2026-07-17 HOLD audit: "share one authority resolver across consumers").
  // Only JOINED rows aggregate; orphans are surfaced as counts only. Multiple
  // rows per retrieval resolve through resolveOutcomeAuthority() — the SAME
  // function analyze-retrieval-quality.mjs uses — never first-row-wins, so an
  // automatic 'unknown' can never permanently block later stronger evidence,
  // and both consumers agree on which outcome is authoritative for the same
  // retrieval. 'unknown' itself never enters usefulness denominators.
  const outcomeRowsById = new Map();
  let orphanOutcomeRows = 0;
  let duplicateOutcomeRows = 0;
  for (const { row: r } of entries) {
    if (r.kind !== 'retrieval-outcome') continue;
    const id = typeof r.retrieval_id === 'string' ? r.retrieval_id.trim() : '';
    if (!id || baseById.get(id)?.length !== 1) { orphanOutcomeRows += 1; continue; }
    const rows = outcomeRowsById.get(id) || [];
    if (rows.length) duplicateOutcomeRows += 1;
    rows.push(r);
    outcomeRowsById.set(id, rows);
  }
  const outcomesById = new Map();
  const unknownOutcomeIds = new Set();
  for (const [id, rows] of outcomeRowsById) {
    const resolved = resolveOutcomeAuthority(rows);
    if (!resolved || resolved === 'unknown') { unknownOutcomeIds.add(id); continue; } // coverage, never a denominator
    outcomesById.set(id, resolved);
  }

  for (const { date } of logs) {
    const rows = entries.filter(entry => entry.date === date).map(entry => entry.row);
    const day = {
      events: 0, tiers: {}, escalations: 0, dip_backs: 0, misses: 0,
      candidates_sum: 0, selected_sum: 0, counted: 0,
      suppressed: { retired: 0, stale: 0, native: 0 },
    };
    for (const r of rows) {
      if (r.kind && r.kind !== 'retrieval') continue;
      day.events += 1;
      const tier = num(r.tier_reached);
      if (tier != null) {
        day.tiers[String(tier)] = (day.tiers[String(tier)] || 0) + 1;
        if (tier >= 2) { day.escalations += 1; totals.escalations += 1; }
      }
      day.dip_backs += num(r.dip_back_count) || 0;
      if (r.result === 'miss') { day.misses += 1; totals.misses += 1; }
      if (r.result === 'no-hit') { day.no_hits = (day.no_hits || 0) + 1; totals.no_hits = (totals.no_hits || 0) + 1; }
      const retrievalId = typeof r.retrieval_id === 'string' ? r.retrieval_id.trim() : '';
      const joinedOutcome = retrievalId && baseById.get(retrievalId)?.length === 1 ? outcomesById.get(retrievalId) : undefined;
      if (joinedOutcome !== undefined) {
        day.outcomes = day.outcomes || {};
        day.outcomes[joinedOutcome] = (day.outcomes[joinedOutcome] || 0) + 1;
        totals.outcome_rows = (totals.outcome_rows || 0) + 1;
      }
      if (num(r.dip_back_count) != null) {
        day.dipback_observed = (day.dipback_observed || 0) + 1;
        totals.dipback_observed = (totals.dipback_observed || 0) + 1;
      }
      if (num(r.candidate_count) != null && num(r.selected_count) != null) {
        day.candidates_sum += r.candidate_count;
        day.selected_sum += r.selected_count;
        day.counted += 1;
      }
      day.suppressed.retired += num(r.retired_suppressed_count) || 0;
      day.suppressed.stale += num(r.stale_suppressed_count) || 0;
      day.suppressed.native += num(r.native_memory_suppressed_count) || 0;
      for (const u of Array.isArray(r.units_retrieved) ? r.units_retrieved : []) {
        if (u && u.id) unitFreq.set(String(u.id), (unitFreq.get(String(u.id)) || 0) + 1);
      }
    }
    totals.events += day.events;
    totals.dip_backs += day.dip_backs;
    days[date] = {
      events: day.events, tiers: day.tiers, escalations: day.escalations,
      dip_backs: day.dip_backs, dipback_observed_rows: day.dipback_observed || 0,
      misses: day.misses, no_hits: day.no_hits || 0,
      ...(day.outcomes ? { outcomes: day.outcomes } : {}),
      mean_candidates: day.counted ? round3(day.candidates_sum / day.counted) : null,
      mean_selected: day.counted ? round3(day.selected_sum / day.counted) : null,
      suppressed: day.suppressed,
    };
  }
  // Rankings ship only above the population/count floors — set by the caller
  // (collectProject) which knows the store size; raw frequency map stays internal.
  const topUnits = [...unitFreq.entries()]
    .filter(([, n]) => n >= RANKING_MIN_COUNT)
    .sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([id, n]) => ({ unit: seal('unit', id), retrievals: n }));
  const eligibleOutcomeRows = [...baseById.values()].filter(rows => rows.length === 1).length;
  return {
    available: true, ...trust, days, totals,
    escalation_rate: totals.events ? round3(totals.escalations / totals.events) : null,
    // Unknown-aware (Hale: missing is not "no dip-back"): the rate divides by
    // rows that OBSERVED the field; rows that omitted it are counted as
    // coverage, never as zeros.
    dip_back: {
      observed_rows: totals.dipback_observed || 0,
      total_rows: totals.events,
      rate: (totals.dipback_observed || 0) > 0 ? round3(totals.dip_backs / totals.dipback_observed) : null,
    },
    outcome_coverage: {
      eligible_retrieval_rows: eligibleOutcomeRows,
      joined_outcome_rows: totals.outcome_rows || 0,
      orphan_outcome_rows: orphanOutcomeRows,
      duplicate_outcome_rows: duplicateOutcomeRows,
      rate: eligibleOutcomeRows ? round3((totals.outcome_rows || 0) / eligibleOutcomeRows) : null,
    },
    top_retrieved_units: topUnits, malformed_lines: badLines,
  };
}

export function hygieneStats(projectDir) {
  const logs = listSessionLogs(projectDir, 'hygiene-log.jsonl');
  if (!logs.length) return { available: false, reason: 'no hygiene-log.jsonl under _sessions/', _trust: TRUST.DIRECT, _trust_basis: 'script-written op log' };
  const days = {};
  const demoteBatches = [];
  let overCap = 0;
  for (const { date, file } of logs) {
    const { rows } = readJsonlSafe(file);
    const ops = {};
    for (const r of rows) {
      const kind = fold(String(r.kind || 'other'), HYGIENE_KINDS);
      ops[kind] = (ops[kind] || 0) + 1;
      if (kind === 'demote-moves' && num(r.demoted) != null) demoteBatches.push(r.demoted);
      if (kind === 'project-md-over-cap') overCap += 1;
    }
    days[date] = { ops };
  }
  return { available: true, _trust: TRUST.DIRECT, _trust_basis: 'script-written op log', days, demote_batches: demoteBatches, over_cap_events: overCap };
}

export function storeCensus(projectDir) {
  const store = join(projectDir, '_memories');
  if (!existsSync(store)) return { available: false, reason: 'no _memories/ unit store', _trust: TRUST.DIRECT, _trust_basis: 'store walk' };
  const unitFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (!name.startsWith('_')) walk(p);
      } else if (name.endsWith('.md') && !name.startsWith('_') && !name.startsWith('INDEX')) {
        unitFiles.push(p);
      }
    }
  };
  walk(store);
  const byType = {}; const byStatus = {}; const edgesByType = {}; const createdByMonth = {};
  const outgoing = new Map(); const incoming = new Map();
  const ids = new Set();
  // Orphan rate is measured over ACTIVE units only — archived/retired/superseded
  // units are terminal by design and would inflate the rate with dead weight.
  const activeIds = new Set();
  for (const f of unitFiles) {
    let unit;
    try { unit = loadUnit(f); } catch { continue; }
    ids.add(unit.id);
    const t = fold(String(unit.fm.type || 'other'), UNIT_TYPES);
    const s = fold(String(unit.fm.status || 'active'), UNIT_STATUSES);
    if (s === 'active' || s === 'draft') activeIds.add(unit.id);
    byType[t] = (byType[t] || 0) + 1;
    byStatus[s] = (byStatus[s] || 0) + 1;
    const created = isoDay(unit.fm.created);
    if (created) {
      const month = created.slice(0, 7);
      createdByMonth[month] = (createdByMonth[month] || 0) + 1;
    }
    const edges = Array.isArray(unit.fm.edges) ? unit.fm.edges : [];
    let outs = 0;
    for (const e of edges) {
      const target = e && (e.to || e.target || e.unit);
      const type = fold(String((e && e.type) || 'cites'), EDGE_TYPES);
      edgesByType[type] = (edgesByType[type] || 0) + 1;
      outs += 1;
      if (target) incoming.set(String(target), (incoming.get(String(target)) || 0) + 1);
    }
    outgoing.set(unit.id, outs);
  }
  let orphans = 0; let linked = 0;
  for (const id of activeIds) {
    const deg = (outgoing.get(id) || 0) + (incoming.get(id) || 0);
    if (deg === 0) orphans += 1; else linked += 1;
  }
  const active = activeIds.size;
  return {
    available: true, _trust: TRUST.DIRECT, _trust_basis: 'store walk',
    units_total: ids.size, units_active: active, by_type: suppressSmallCells(byType), by_status: suppressSmallCells(byStatus),
    edges_by_type: suppressSmallCells(edgesByType),
    edges_total: Object.values(edgesByType).reduce((a, b) => a + b, 0),
    orphans, orphan_rate: active ? round3(orphans / active) : null,
    // NOT 1-orphan_rate (Hale caught the earlier redundant stat): edges per
    // active unit measures graph richness; the active-to-active fraction
    // measures how much of the edge mass is traversable among live units.
    edges_per_active_unit: active ? round3(Object.values(edgesByType).reduce((a, b) => a + b, 0) / active) : null,
    // Honest name for what the maps can actually measure: the share of edge
    // TARGETS that are active units (a low value = the graph points at dead
    // weight and Tier-2 walks land on retired/archived nodes).
    edge_targets_active_fraction: (() => {
      let activeTargets = 0; let allTargets = 0;
      for (const [target, n] of incoming) { allTargets += n; if (activeIds.has(target)) activeTargets += n; }
      return allTargets ? round3(activeTargets / allTargets) : null;
    })(),
    created_by_month: suppressSmallCells(createdByMonth),
  };
}

export function validatorStats(projectDir) {
  const checker = join(scriptDir, 'check-units.mjs');
  if (!existsSync(checker)) return { available: false, reason: 'check-units.mjs not found beside this script', _trust: TRUST.DIRECT, _trust_basis: 'validator run' };
  const res = spawnSync(process.execPath, [checker, '--store', projectDir, '--integrity'], { encoding: 'utf8', timeout: 120_000 });
  if (res.error || res.stdout == null) return { available: false, reason: 'check-units run failed', _trust: TRUST.DIRECT, _trust_basis: 'validator run' };
  const out = res.stdout;
  const summary = out.match(/PASS:\s*(\d+)\s+WARN:\s*(\d+)\s+FAIL:\s*(\d+)/);
  const byCheck = {};
  for (const m of out.matchAll(/^\s{2}([a-z0-9-]+): \[/gm)) {
    byCheck[m[1]] = (byCheck[m[1]] || 0) + 1;
  }
  return {
    available: true, _trust: TRUST.DIRECT, _trust_basis: 'validator run',
    pass: summary ? +summary[1] : null, warn: summary ? +summary[2] : null, fail: summary ? +summary[3] : null,
    warns_by_check: byCheck, exit_code: res.status,
  };
}

export function projectMdStats(projectDir) {
  const p = join(projectDir, 'PROJECT.md');
  if (!existsSync(p)) return { available: false, reason: 'no PROJECT.md', _trust: TRUST.DIRECT, _trust_basis: 'file stat' };
  const bytes = statSync(p).size;
  return {
    available: true, _trust: TRUST.DIRECT, _trust_basis: 'file stat', bytes,
    estimated_tokens: Math.round(bytes * 0.30),
    over_soft_cap: bytes > 70 * 1024,
  };
}

export function maintenanceStats(projectDir) {
  const out = { available: false, reason: 'no _maintenance-state.json or _pm-state.json', _trust: TRUST.DIRECT, _trust_basis: 'state file' };
  const mPath = join(projectDir, '_memories', '_maintenance-state.json');
  const pmPath = join(projectDir, '_memories', '_pm-state.json');
  const ops = {};
  let any = false;
  if (existsSync(mPath)) {
    try {
      const j = JSON.parse(readFileSync(mPath, 'utf8'));
      for (const [name, v] of Object.entries(j.ops || {})) {
        ops[fold(String(name), MAINTENANCE_OPS)] = { run_count: num(v.run_count), last_run: isoDay(v.last_run) };
      }
      any = true;
    } catch { /* fall through to availability */ }
  }
  let pmLastRun = null;
  if (existsSync(pmPath)) {
    try { pmLastRun = isoDay(JSON.parse(readFileSync(pmPath, 'utf8')).last_run); any = true; } catch { /* ignore */ }
  }
  if (!any) return out;
  return { available: true, _trust: TRUST.DIRECT, _trust_basis: 'state file', ops, pm_last_run: pmLastRun };
}

export function workspaceMetrics(home, workspaceId) {
  if (!workspaceId) return { available: false, reason: 'no workspace.json pointer (project not registered)', _trust: TRUST.DIRECT, _trust_basis: 'metrics layer' };
  const wsDir = join(home, '.core', 'workspaces', workspaceId);
  if (!existsSync(wsDir)) return { available: false, reason: 'workspace meta dir absent', _trust: TRUST.DIRECT, _trust_basis: 'metrics layer' };

  const recognition = { available: false, reason: 'no classified turn files', _trust: TRUST.PROVISIONAL, _trust_basis: 'classifier has not cleared its calibration gate — trends only, never levels', days: {} };
  const clsDir = join(wsDir, 'metrics', 'classified');
  if (existsSync(clsDir)) {
    for (const f of readdirSync(clsDir).sort()) {
      const day = isoDay(f);
      if (!day || !f.endsWith('.jsonl')) continue;
      const { rows } = readJsonlSafe(join(clsDir, f));
      const states = {};
      let provisional = 0;
      for (const r of rows) {
        const s = fold(String(r.state || 'unclassified'), RECOGNITION_STATES);
        states[s] = (states[s] || 0) + 1;
        if (r.provisional) provisional += 1;
      }
      recognition.days[day] = {
        turns: rows.length,
        states,
        provisional_count: provisional,
        provisional_share: rows.length ? round3(provisional / rows.length) : null,
      };
    }
    if (Object.keys(recognition.days).length) { recognition.available = true; delete recognition.reason; }
  }

  let calibration = { available: false, reason: 'no calibration-state.json' };
  const calPath = join(wsDir, 'metrics', 'calibration-state.json');
  if (existsSync(calPath)) {
    try {
      const j = JSON.parse(readFileSync(calPath, 'utf8'));
      // Field names match the producer (calibrate-classifier.mjs writes
      // labeled_count / is_calibrated — Hale's audit caught the earlier
      // labels_count / cleared misread returning permanent nulls).
      calibration = {
        available: true,
        labeled_count: num(j.labeled_count) ?? null,
        is_calibrated: j.is_calibrated === true,
        provisional: j.provisional !== false,
        classifier_version: (typeof j.classifier_version === 'string' && /^\d+\.\d+\.\d+$/.test(j.classifier_version)) ? j.classifier_version : null,
        proxy_version: Number.isInteger(j.proxy_version) ? j.proxy_version : null,
        by_harness: Object.fromEntries(['claude-code', 'codex'].map((harness) => {
          const row = j.by_harness?.[harness];
          return [harness, row ? {
            is_calibrated: row.is_calibrated === true,
            labeled_count: num(row.labeled_count),
            min_labeled: num(row.min_labeled),
            overall_precision: num(row.overall_precision),
            coverage_complete: row.coverage_complete === true,
            per_class_pass: row.per_class_pass === true,
            blinded: row.blinded === true,
            provenance_complete: row.provenance_complete === true,
          } : { is_calibrated: false }];
        })),
      };
    } catch { calibration = { available: false, reason: 'calibration-state.json unparseable' }; }
  }

  let capability = { available: false, reason: 'no capability-history.jsonl' };
  const capPath = join(wsDir, 'capability-history.jsonl');
  if (existsSync(capPath)) {
    const { rows } = readJsonlSafe(capPath);
    const byCap = {};
    for (const r of rows) {
      const row = r.row || r;
      const id = fold(String(row.capability_id || 'other'), CAPABILITY_IDS);
      if (id === 'other') continue;
      const raw = JSON.stringify(row);
      const verdict = /"DEGRADED"/.test(raw) ? 'degraded' : (/"PASS"/.test(raw) ? 'pass' : 'other');
      byCap[id] = byCap[id] || { pass: 0, degraded: 0, other: 0, last: null };
      byCap[id][verdict] += 1;
      byCap[id].last = verdict;
    }
    if (Object.keys(byCap).length) capability = { available: true, _trust: TRUST.DIRECT, _trust_basis: 'probe history', by_capability: byCap, snapshots: rows.length };
  }

  return { available: true, recognition, calibration, capability };
}

// ---------- headline, deltas, flags ----------

export function headline(blocks) {
  const h = {};
  const r = blocks['retrieval-stats'];
  if (r?.available) {
    h.retrieval_events_total = r.totals.events;
    h.escalation_rate = r.escalation_rate;
    h.dip_back_rate = r.dip_back ? r.dip_back.rate : null;
    h.dip_back_observed = r.dip_back ? r.dip_back.observed_rows : 0;
    h.miss_total = r.totals.misses;
  }
  const c = blocks['store-census'];
  if (c?.available) {
    h.units_total = c.units_total;
    h.orphan_rate = c.orphan_rate;
    h.edges_per_active_unit = c.edges_per_active_unit;
    h.edges_total = c.edges_total;
  }
  const v = blocks['validator'];
  if (v?.available) { h.warn_total = v.warn; h.fail_total = v.fail; }
  const p = blocks['project-md'];
  if (p?.available) { h.project_md_bytes = p.bytes; }
  const w = blocks['workspace-metrics'];
  if (w?.available && w.recognition?.available) {
    const days = Object.keys(w.recognition.days).sort();
    const last = days.length ? w.recognition.days[days[days.length - 1]] : null;
    // Denominator floor (Hale: never headline a rate from three provisional
    // turns) — below 20 turns the rate ships as null with the sample size.
    if (last && last.turns) {
      h.recfail_latest_sample = last.turns;
      h.recfail_latest_rate = last.turns >= 20 ? round3((last.states['rec-fail-tier-0'] || 0) / last.turns) : null;
    }
  }
  return h;
}

export function computeDeltas(home, projectPseudonym, current) {
  const dir = join(home, '.core', HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${projectPseudonym}.jsonl`);
  let previous = null;
  if (existsSync(file)) {
    const { rows } = readJsonlSafe(file);
    if (rows.length) previous = rows[rows.length - 1];
  }
  const deltas = { available: !!previous, reason: previous ? undefined : 'first package from this install for this project' };
  if (previous) {
    deltas.since = previous.generated_at || null;
    deltas.changes = {};
    for (const [k, v] of Object.entries(current)) {
      const prev = num(previous[k]);
      if (num(v) != null && prev != null) deltas.changes[k] = round3(v - prev);
    }
  }
  return deltas;
}

// Called ONLY after the leak scan passed and the artifact shipped — an aborted
// package never advances the delta baseline.
export function appendHistory(home, projectPseudonym, current) {
  const dir = join(home, '.core', HISTORY_DIR);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${projectPseudonym}.jsonl`), JSON.stringify({ generated_at: new Date().toISOString(), ...current }) + '\n');
}

export function computeFlags(blocks, hl) {
  const flags = [];
  const add = (level, code, text) => flags.push({ level, code, text });
  if (hl.orphan_rate != null && hl.orphan_rate > 0.3) add('serious', 'orphan-rate-high', `Orphan rate ${(hl.orphan_rate * 100).toFixed(0)}% — edge-walk retrieval (Tier 2) is degraded; write-time linking backfill indicated.`);
  else if (hl.orphan_rate != null && hl.orphan_rate < 0.1) add('good', 'orphan-rate-low', `Orphan rate ${(hl.orphan_rate * 100).toFixed(0)}% — the graph is traversable.`);
  if (hl.escalation_rate != null && hl.escalation_rate > 0.2) add('warning', 'escalation-high', `Retrieval escalates past the lexical tier on ${(hl.escalation_rate * 100).toFixed(0)}% of events — Tier 1 recall may be short.`);
  if (hl.dip_back_rate != null && hl.dip_back_rate > 0.15) add('warning', 'dip-back-high', `Dip-back rate ${(hl.dip_back_rate * 100).toFixed(0)}% — first retrieval often insufficient.`);
  if (hl.fail_total) add('critical', 'validator-fails', `${hl.fail_total} validator FAIL(s) — store integrity broken somewhere.`);
  if (hl.warn_total != null && hl.warn_total > 50) add('warning', 'validator-warn-volume', `${hl.warn_total} validator warnings — hygiene debt accumulating.`);
  const p = blocks['project-md'];
  if (p?.available && p.over_soft_cap) add('warning', 'project-md-over-cap', `PROJECT.md is ${Math.round(p.bytes / 1024)}KB, over the ~70KB soft cap — bootstrap reads degrade.`);
  const w = blocks['workspace-metrics'];
  if (w?.available && w.capability?.available) {
    const degraded = Object.entries(w.capability.by_capability).filter(([, v]) => v.last === 'degraded').map(([k]) => k);
    if (degraded.length) add('warning', 'capability-degraded', `${degraded.length} capability(ies) currently degraded: ${degraded.join(', ')}.`);
  }
  if (w?.available && w.recognition?.available) add('warning', 'recognition-provisional', 'Recognition-state numbers are PROVISIONAL — the classifier has not cleared its calibration gate; read trends, not absolute levels.');
  return flags;
}

// ---------- leakage self-scan (fail-closed backstop) ----------

// CORE product vocabulary that legitimately appears in package fixed strings —
// excluded from pattern building so a project literally named "core" or
// "metrics" doesn't false-positive every package. Anything longer/rarer scans.
const PATTERN_ALLOWLIST = new Set(['core', 'metrics', 'memory', 'project', 'claude', 'main', 'next', 'docs', 'test', 'tests']);

export function buildLeakPatterns({ home, projectDirs, indexEntries }) {
  const words = new Set();
  const paths = new Set();
  paths.add(home);
  paths.add(home.split(sep).join('/'));
  paths.add(home.split(sep).join('\\'));
  for (const p of projectDirs) {
    paths.add(p);
    const base = basename(p);
    if (base.length >= 4 && !PATTERN_ALLOWLIST.has(base.toLowerCase())) words.add(base);
  }
  for (const e of indexEntries || []) {
    if (e.id && e.id.length >= 4 && !PATTERN_ALLOWLIST.has(String(e.id).toLowerCase())) words.add(String(e.id));
    if (e.path) {
      const base = basename(String(e.path));
      if (base.length >= 4 && !PATTERN_ALLOWLIST.has(base.toLowerCase())) words.add(base);
    }
  }
  return {
    words: [...words],
    paths: [...paths].filter(Boolean),
    shapes: [/\/(Users|home)\/[A-Za-z]/, /\\Users\\[A-Za-z]/, /[A-Za-z]:\\\\?Users/, /\/Volumes\//, /\\\\[A-Za-z0-9.$_-]+\\/, /file:\/\//i],
  };
}

export function leakScanDir(stagingDir, patterns) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const text = readFileSync(p, 'utf8');
      const lower = text.toLowerCase();
      for (const w of patterns.words) {
        const re = new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').toLowerCase()}([^a-z0-9]|$)`);
        if (re.test(lower)) hits.push({ file: name, pattern: w, kind: 'identifier' });
      }
      for (const pp of patterns.paths) {
        if (pp && lower.includes(pp.toLowerCase())) hits.push({ file: name, pattern: pp, kind: 'path' });
      }
      for (const s of patterns.shapes) {
        if (s.test(text)) hits.push({ file: name, pattern: String(s), kind: 'path-shape' });
      }
    }
  };
  walk(stagingDir);
  return hits;
}

// ---------- project collection ----------

export function collectProject(projectDir, { home, seal }) {
  const wsPointer = join(projectDir, 'workspace.json');
  let workspaceId = null;
  if (existsSync(wsPointer)) {
    try { workspaceId = JSON.parse(readFileSync(wsPointer, 'utf8')).workspace_id || null; } catch { workspaceId = null; }
  }
  const pseudonym = seal('project', workspaceId || basename(projectDir));
  const localBlocks = {
    'retrieval-stats': retrievalStats(projectDir, seal),
    'hygiene-stats': hygieneStats(projectDir),
    'store-census': storeCensus(projectDir),
    'validator': validatorStats(projectDir),
    'project-md': projectMdStats(projectDir),
    'maintenance': maintenanceStats(projectDir),
    'workspace-metrics': workspaceMetrics(home, workspaceId),
  };
  // Population gate on per-unit rankings (Hale finding 6): below the floor a
  // ranking row can fingerprint a specific unit across packages.
  const census = localBlocks['store-census'];
  const retrieval = localBlocks['retrieval-stats'];
  if (retrieval?.available && (!census?.available || (census.units_active || 0) < RANKING_MIN_POPULATION)) {
    retrieval.top_retrieved_units = [];
    retrieval.top_retrieved_units_suppressed = `population below ${RANKING_MIN_POPULATION} active units`;
  }
  const hl = headline(localBlocks);
  const flags = computeFlags(localBlocks, hl);
  const blocks = projectForShare(localBlocks);
  return { pseudonym, blocks, headline: hl, flags };
}

// ---------- zip ----------

// Relative archive path (David-approved fix, corrected 2026-07-18 after the
// first attempt failed local verification): on windows-latest, tar parses a
// Windows drive-letter path's colon (e.g. C:\Users\...\out.zip) passed to -f
// as its remote host:path syntax and exits 128 ("Cannot connect to C: resolve
// failed") — confirmed from live CI stderr, not inferred. The first fix
// attempt added --force-local to disable that, but macOS/Linux bsdtar (the
// same libarchive-based tar that ships on Windows too) does not recognize
// that flag at all ("Option --force-local is not supported" — confirmed by
// direct local invocation before this fix shipped, unlike the first attempt).
// The portable fix instead avoids the ambiguous colon entirely: run tar with
// destZip's directory as the process cwd and pass only its basename to -f, so
// -f never contains a drive letter. -C's argument for the source tree stays
// absolute and is unaffected by the process cwd change.
// ZIP local-file-header magic number (PK\x03\x04). `-a` auto-selects the archive
// format from destZip's extension, but ZIP support behind `-a` is NOT consistent
// across tar builds (Meridian, live Windows box, 2026-07-20): GNU tar (what Git
// Bash/MSYS2 put first on PATH on her machine) has no ZIP support at all and
// silently emits an uncompressed TAR wearing a .zip extension, exit 0. The `tar -t`
// listing check below does NOT catch this -- GNU tar happily lists its own tar
// output, and manifest.json is right there, so the old code returned ok:true for a
// file that is not actually a zip. Checking the real magic bytes is the only
// verification that can't be fooled by a tar binary lying about its own output.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// Pure and directly testable on purpose: zipStaging() below shells out to the real
// `tar` binary, whose ZIP-support behavior is exactly what's non-deterministic
// across platforms/PATH order -- a test can't reliably force a specific tar's
// buggy behavior. This function is the actual verification logic; test it directly
// against synthetic fixture files instead.
export function verifyZipMagic(path) {
  let header;
  try { header = readFileSync(path).subarray(0, 4); } catch (e) { return { ok: false, reason: `cannot read produced archive: ${e.message}` }; }
  if (!header.equals(ZIP_MAGIC)) {
    return { ok: false, reason: `produced file is not a real zip (magic bytes ${header.toString('hex')}, expected ${ZIP_MAGIC.toString('hex')} -- the local tar likely has no zip support and silently wrote a plain tar wearing a .zip extension)` };
  }
  return { ok: true };
}

export function zipStaging(stagingDir, destZip) {
  const destDir = dirname(destZip);
  const destBase = basename(destZip);
  const res = spawnSync('tar', ['-a', '-c', '-f', destBase, '-C', stagingDir, '.'], { cwd: destDir, encoding: 'utf8', timeout: 120_000 });
  if (res.error || res.status !== 0 || !existsSync(destZip)) return { ok: false, reason: res.error ? String(res.error.message) : `tar exit ${res.status}` };
  const list = spawnSync('tar', ['-t', '-f', destBase], { cwd: destDir, encoding: 'utf8', timeout: 60_000 });
  if (list.status !== 0 || !/manifest\.json/.test(list.stdout || '')) return { ok: false, reason: 'zip verification failed (manifest.json not listed)' };
  return verifyZipMagic(destZip);
}

function desktopDir(home) {
  const d = join(home, 'Desktop');
  return existsSync(d) ? d : home;
}

// ---------- main ----------

export function runPackage(argv, { homeOverride } = {}) {
  const args = [...argv];
  const flagsIn = { all: false, out: null, json: false, home: homeOverride || null };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--all') flagsIn.all = true;
    else if (args[i] === '--json') flagsIn.json = true;
    else if (args[i] === '--out') { flagsIn.out = args[i + 1]; i += 1; }
    else if (args[i] === '--home') { flagsIn.home = args[i + 1]; i += 1; }
    else positional.push(args[i]);
  }
  const home = flagsIn.home || trustedHome() || homedir();
  const coreDir = join(home, '.core');
  const { salt, created: saltCreated } = loadOrCreateSalt(coreDir);
  const seal = makeSeal(salt);

  // resolve project set
  let indexEntries = [];
  const indexPath = join(coreDir, 'index.json');
  if (existsSync(indexPath)) {
    try { indexEntries = JSON.parse(readFileSync(indexPath, 'utf8')); } catch { indexEntries = []; }
    if (!Array.isArray(indexEntries)) indexEntries = indexEntries.workspaces || [];
  }
  let projectDirs = [];
  if (flagsIn.all) {
    for (const e of indexEntries) {
      const p = e && (e.path || e.project_path);
      if (p && existsSync(join(p, '_memories'))) projectDirs.push(resolve(p));
    }
    if (!projectDirs.length) return { exit: 2, error: '--all found no registered workspaces with a _memories/ store' };
  } else {
    const p = resolve(positional[0] || process.cwd());
    projectDirs = [p];
  }

  // collect
  const coverage = [];
  const projects = [];
  for (const dir of projectDirs) {
    try {
      const collected = collectProject(dir, { home, seal });
      projects.push(collected);
      coverage.push({ project: collected.pseudonym, available: true });
    } catch (err) {
      // The reason is an error CODE, never err.message — raw messages embed real
      // filesystem paths (the leak scan caught exactly this during development).
      const code = (err && typeof err.code === 'string') ? err.code : 'collection-error';
      coverage.push({ project: seal('project', basename(dir)), available: false, reason: code });
    }
  }
  if (!projects.length) return { exit: 2, error: 'no project could be collected', coverage };

  // Deltas are computed READ-ONLY here; the history append happens only after
  // the package actually ships (Hale: history was advancing before leakage
  // validation — an aborted run must not consume a history slot).
  for (const proj of projects) {
    proj.deltas = computeDeltas(home, proj.pseudonym, proj.headline);
  }

  // Generator identity — honest provenance (Hale: a source-tree run must not
  // identify itself as the released build). The manifest version is reported
  // AS the manifest's claim; `generator` records where this code actually ran
  // from, and the source SHA is captured when the tree is a git checkout.
  let plugin = null;
  try {
    const manifest = JSON.parse(readFileSync(join(scriptDir, '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    plugin = { manifest_version: manifest.version, manifest_build: manifest.build || null };
  } catch { plugin = null; }
  const generator = (() => {
    const isInstalledCache = /[\\/]plugins[\\/]cache[\\/]/.test(scriptDir);
    const out = { ran_from: isInstalledCache ? 'installed-cache' : 'source-tree', source_sha: null };
    if (!isInstalledCache) {
      const r = spawnSync('git', ['-C', scriptDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000 });
      if (r.status === 0) out.source_sha = (r.stdout || '').trim().slice(0, 12) || null;
    }
    return out;
  })();

  // stage
  const staging = mkdtempSync(join(tmpdir(), 'core-metrics-package-'));
  const generatedAt = new Date().toISOString();
  const manifestOut = {
    schema_version: SCHEMA_VERSION,
    generated_at: generatedAt,
    mode: flagsIn.all ? 'all-projects' : 'single-project',
    plugin,
    generator,
    pseudonym_note: 'Ids are HMAC pseudonyms from a local salt that never ships; stable per install. Deleting ~/.core/metrics-package-salt rotates them.',
    residual_risk: 'Designed to minimize reconstruction risk, not to zero it: stable pseudonyms allow linking the same anonymous project across packages from one install (rotate the salt to sever); daily counts could correlate with externally visible activity. Small cells are suppressed at k=3 and per-unit rankings gate on store population.',
    salt_rotated_this_run: saltCreated,
    coverage,
  };
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifestOut, null, 2));
  for (const proj of projects) {
    const pdir = join(staging, 'projects', proj.pseudonym);
    mkdirSync(pdir, { recursive: true });
    for (const [name, block] of Object.entries(proj.blocks)) {
      writeFileSync(join(pdir, `${name}.json`), JSON.stringify(block, null, 2));
    }
    writeFileSync(join(pdir, 'headline.json'), JSON.stringify({ ...proj.headline, flags: proj.flags, deltas: proj.deltas }, null, 2));
  }
  writeFileSync(join(staging, 'REPORT.md'), buildReportMd({ manifest: manifestOut, projects }));
  writeFileSync(join(staging, 'report.html'), buildReportHtml({ manifest: manifestOut, projects }));

  // fail-closed leakage scan
  const patterns = buildLeakPatterns({ home, projectDirs, indexEntries });
  const hits = leakScanDir(staging, patterns);
  if (hits.length) {
    rmSync(staging, { recursive: true, force: true });
    return { exit: 2, error: 'LEAKAGE SCAN HIT — package aborted, nothing shipped', hits: hits.slice(0, 10) };
  }

  // ship
  const outDir = flagsIn.out ? resolve(flagsIn.out) : desktopDir(home);
  mkdirSync(outDir, { recursive: true });
  const stamp = generatedAt.replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  let zipPath = join(outDir, `core-metrics-package-${stamp}.zip`);
  let suffix = 2;
  while (existsSync(zipPath)) { zipPath = join(outDir, `core-metrics-package-${stamp}-${suffix}.zip`); suffix += 1; }
  const zip = zipStaging(staging, zipPath);
  let shipped;
  if (zip.ok) {
    rmSync(staging, { recursive: true, force: true });
    shipped = { kind: 'zip', path: zipPath };
  } else {
    // self-healing fallback: leave a folder instead of failing the run
    const folder = zipPath.replace(/\.zip$/, '');
    cpSync(staging, folder, { recursive: true });
    rmSync(staging, { recursive: true, force: true });
    shipped = { kind: 'folder', path: folder, reason: zip.reason };
  }
  // Ship succeeded — NOW the delta baseline may advance (never on abort).
  for (const proj of projects) {
    try { appendHistory(home, proj.pseudonym, proj.headline); } catch { /* history is best-effort */ }
  }

  // Partial detection descends one level: a workspace-metrics block whose
  // recognition/calibration/capability sub-blocks are unavailable is partial
  // coverage too (Hale: nested missing sources must force partial status).
  const blockPartial = (b) => b && (b.available === false
    || Object.values(b).some((v) => v && typeof v === 'object' && v.available === false));
  const partial = coverage.some(c => !c.available)
    || projects.some(p => Object.values(p.blocks).some(blockPartial));
  return {
    exit: partial ? 1 : 0, shipped, coverage, desktop_fallback: !flagsIn.out && !existsSync(join(home, 'Desktop')),
    projects: projects.map(p => ({ project: p.pseudonym, flags: p.flags, headline: p.headline })),
  };
}

// ---------- CLI entry ----------

const isCliEntry = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();

if (isCliEntry) {
  const result = runPackage(process.argv.slice(2));
  if (result.error) {
    process.stderr.write(`error: ${result.error}\n`);
    if (result.hits) for (const h of result.hits) process.stderr.write(`  leak-hit: ${h.kind} pattern in ${h.file}\n`);
  } else {
    process.stdout.write(`package: ${result.shipped.path}\n`);
    if (result.shipped.kind === 'folder') process.stdout.write(`note: zip unavailable (${result.shipped.reason}) — staged folder shipped instead\n`);
    const covered = result.coverage.filter(c => c.available).length;
    process.stdout.write(`coverage: ${covered}/${result.coverage.length} project(s)\n`);
    for (const p of result.projects) {
      for (const f of p.flags) process.stdout.write(`flag[${p.project}] ${f.level}: ${f.text}\n`);
    }
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  process.exit(result.exit);
}
