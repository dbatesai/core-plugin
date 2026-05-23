/**
 * Analyze retrieval-log corpus across a project's _sessions/<YYYY-MM-DD>/retrieval-log.jsonl files.
 *
 * Reads per-event JSONL records, computes:
 *   - per-unit dip-back rate (precision proxy)
 *   - per-topic tier-escalation frequency (recall proxy)
 *   - overall tier distribution
 *
 * Per DC-77 the script lives in the plugin, not per-project.
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { buildReport, loadEvents, formatReport } from './analyze-retrieval-quality.mjs';
 *   const events = loadEvents('<project>', { sinceDays: 30 });
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

export const DEFAULT_SINCE_DAYS = 30;
export const TOP_DIP_BACK = 10;
export const TOP_ESCALATION = 10;

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
  try { entries = readdirSync(sessionsDir); } catch { return []; }

  const t = today || _todayUTC();
  const cutoff = allTime ? null : new Date(t.getTime() - sinceDays * 86_400_000);

  const events = [];
  for (const name of entries.sort()) {
    const date = _parseSessionDate(name);
    if (!date) continue;
    if (cutoff && date < cutoff) continue;
    const logPath = join(sessionsDir, name, 'retrieval-log.jsonl');
    let raw;
    try { raw = readFileSync(logPath, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* malformed line — skip */ }
    }
  }
  return events;
}

// ---------- Aggregations ----------

export function computeDipBackRates(events) {
  const byUnit = new Map();
  for (const ev of events) {
    const units = Array.isArray(ev.units_retrieved) ? ev.units_retrieved : null;
    if (!units || !units.length) continue;
    const dipped = (ev.dip_back_count || 0) > 0;
    for (const u of units) {
      if (!u || !u.id) continue;
      const rec = byUnit.get(u.id) || { unit_id: u.id, retrievals: 0, dip_backs: 0 };
      rec.retrievals += 1;
      if (dipped) rec.dip_backs += 1;
      byUnit.set(u.id, rec);
    }
  }
  const rows = [];
  for (const rec of byUnit.values()) {
    rows.push({ unit_id: rec.unit_id, retrievals: rec.retrievals, rate: rec.dip_backs / rec.retrievals });
  }
  rows.sort((a, b) => b.rate - a.rate || b.retrievals - a.retrievals || a.unit_id.localeCompare(b.unit_id));
  return rows;
}

export function computeTierEscalation(events) {
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

// ---------- Report assembly ----------

export function buildReport(events) {
  const sessions = new Set();
  for (const ev of events) {
    if (ev && ev.session) sessions.add(String(ev.session));
  }
  return {
    sessions: sessions.size,
    total_events: events.length,
    tier_distribution: computeTierDistribution(events),
    dip_back_rates: computeDipBackRates(events).slice(0, TOP_DIP_BACK),
    tier_escalation: computeTierEscalation(events).slice(0, TOP_ESCALATION),
  };
}

export function formatReport(report) {
  if (!report.total_events) {
    return 'No retrieval events found in the analyzed window.';
  }
  const td = report.tier_distribution;
  const pct = v => `${Math.round(v * 100)}%`;
  const lines = [];
  lines.push(`Sessions analyzed: ${report.sessions} | Total retrieval events: ${report.total_events}`);
  lines.push(`Tier distribution: T1=${pct(td.t1.pct)}, T2=${pct(td.t2.pct)}, T3=${pct(td.t3.pct)}`);
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
