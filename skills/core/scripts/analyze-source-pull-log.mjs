/**
 * Analyze source-pull-log.jsonl for a workspace and produce per-source aggregate statistics.
 *
 * Reads JSONL records written by installation orchestration skills per the source-registration
 * framework's monitoring contract (see references/external-sources/source-registration-framework.md §7).
 *
 * Aggregates over a window:
 *   - pull count
 *   - candidate count (total, avg per pull)
 *   - mode distribution (A / B / C counts and percentages)
 *   - error count + most recent error message
 *   - duration (avg, P50, P95 ms)
 *
 * Per DC-77 the script lives in the plugin, not per-workspace.
 * Per DC-80 the plugin ships Node.js (.mjs) only.
 *
 * Library usage:
 *   import { buildReport, loadEvents, formatReport } from './analyze-source-pull-log.mjs';
 *   const events = loadEvents('<workspace-id>', { sinceDays: 14 });
 *   const report = buildReport(events);
 *   console.log(formatReport(report));
 *
 * CLI:
 *   node analyze-source-pull-log.mjs --workspace <id> [--since-days N | --all]
 *                                    [--source <name>] [--json] [--today YYYY-MM-DD]
 *
 * Exits non-zero only on unrecoverable errors (missing log + workspace not found).
 * Missing log for a real workspace exits 0 with a "no events" report.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SINCE_DAYS = 14;

// ---------- Date helpers ----------

function _nowUTC() {
  return new Date();
}

function _parseTimestamp(s) {
  if (typeof s !== 'string') return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ---------- Path resolution ----------

export function resolveLogPath(workspaceId, { coreHome = null } = {}) {
  const home = coreHome || join(homedir(), '.core');
  return join(home, 'workspaces', workspaceId, 'source-pull-log.jsonl');
}

export function workspaceExists(workspaceId, { coreHome = null } = {}) {
  const home = coreHome || join(homedir(), '.core');
  return existsSync(join(home, 'workspaces', workspaceId));
}

// ---------- Event loading ----------

export function loadEvents(workspaceId, { sinceDays = DEFAULT_SINCE_DAYS, allTime = false, today = null, sourceFilter = null, coreHome = null } = {}) {
  const logPath = resolveLogPath(workspaceId, { coreHome });
  if (!existsSync(logPath)) return [];

  const t = today ? _parseTimestamp(today) || _nowUTC() : _nowUTC();
  const cutoff = allTime ? null : new Date(t.getTime() - sinceDays * 86_400_000);

  let raw;
  try { raw = readFileSync(logPath, 'utf8'); } catch { return []; }

  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    const ts = _parseTimestamp(ev.timestamp);
    if (!ts) continue;
    if (cutoff && ts < cutoff) continue;
    if (sourceFilter && ev.source !== sourceFilter) continue;
    events.push(ev);
  }
  return events;
}

// ---------- Aggregations ----------

function _percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor(sortedNums.length * p));
  return sortedNums[idx];
}

export function buildReport(events) {
  const bySource = new Map();
  for (const ev of events) {
    const src = ev.source || '<unknown>';
    if (!bySource.has(src)) {
      bySource.set(src, {
        source: src,
        cadence: ev.cadence || null,
        pulls: 0,
        candidatesTotal: 0,
        modeA: 0,
        modeB: 0,
        modeC: 0,
        errors: [],
        durations: [],
        firstSeen: ev.timestamp,
        lastSeen: ev.timestamp,
      });
    }
    const s = bySource.get(src);
    s.pulls += 1;
    if (typeof ev.candidates === 'number') s.candidatesTotal += ev.candidates;
    if (typeof ev['mode-a'] === 'number') s.modeA += ev['mode-a'];
    if (typeof ev['mode-b'] === 'number') s.modeB += ev['mode-b'];
    if (typeof ev['mode-c'] === 'number') s.modeC += ev['mode-c'];
    if (Array.isArray(ev.errors) && ev.errors.length) {
      for (const e of ev.errors) s.errors.push({ timestamp: ev.timestamp, error: e });
    }
    if (typeof ev['duration-ms'] === 'number') s.durations.push(ev['duration-ms']);
    s.lastSeen = ev.timestamp;
    // cadence may evolve in registration — record latest non-null value
    if (ev.cadence) s.cadence = ev.cadence;
  }

  const perSource = [];
  for (const s of bySource.values()) {
    const totalModed = s.modeA + s.modeB + s.modeC;
    const sortedDurations = s.durations.slice().sort((a, b) => a - b);
    const durationSum = sortedDurations.reduce((a, b) => a + b, 0);
    perSource.push({
      source: s.source,
      cadence: s.cadence,
      pulls: s.pulls,
      candidates: {
        total: s.candidatesTotal,
        avgPerPull: s.pulls ? +(s.candidatesTotal / s.pulls).toFixed(2) : 0,
      },
      modes: {
        a: s.modeA,
        b: s.modeB,
        c: s.modeC,
        total: totalModed,
        aPct: totalModed ? +((s.modeA / totalModed) * 100).toFixed(1) : null,
        bPct: totalModed ? +((s.modeB / totalModed) * 100).toFixed(1) : null,
        cPct: totalModed ? +((s.modeC / totalModed) * 100).toFixed(1) : null,
      },
      errors: {
        count: s.errors.length,
        mostRecent: s.errors.length ? s.errors[s.errors.length - 1] : null,
      },
      duration: {
        count: sortedDurations.length,
        avgMs: sortedDurations.length ? +(durationSum / sortedDurations.length).toFixed(0) : null,
        p50Ms: _percentile(sortedDurations, 0.5),
        p95Ms: _percentile(sortedDurations, 0.95),
      },
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
    });
  }

  perSource.sort((a, b) => b.pulls - a.pulls);

  return {
    window: { eventCount: events.length },
    perSource,
  };
}

// ---------- Formatting ----------

export function formatReport(report, { includeHeader = true } = {}) {
  if (!report.perSource || report.perSource.length === 0) {
    return includeHeader ? 'No source-pull events in window.' : '';
  }

  const lines = [];
  if (includeHeader) {
    lines.push(`source-pull-log analysis — ${report.window.eventCount} events across ${report.perSource.length} sources`);
    lines.push('');
  }

  for (const s of report.perSource) {
    lines.push(`■ ${s.source}${s.cadence ? ` (${s.cadence})` : ''}`);
    lines.push(`  pulls: ${s.pulls} | candidates: ${s.candidates.total} (avg ${s.candidates.avgPerPull}/pull)`);
    if (s.modes.total > 0) {
      const modeParts = [];
      if (s.modes.aPct !== null) modeParts.push(`A ${s.modes.aPct}%`);
      if (s.modes.bPct !== null) modeParts.push(`B ${s.modes.bPct}%`);
      if (s.modes.cPct !== null) modeParts.push(`C ${s.modes.cPct}%`);
      lines.push(`  modes: ${modeParts.join(' / ')} (${s.modes.total} obs)`);
    }
    if (s.errors.count > 0) {
      const recent = s.errors.mostRecent;
      const errStr = typeof recent.error === 'string' ? recent.error : JSON.stringify(recent.error);
      lines.push(`  errors: ${s.errors.count} (latest @ ${recent.timestamp}: ${errStr.slice(0, 80)})`);
    }
    if (s.duration.count > 0) {
      lines.push(`  duration: avg ${s.duration.avgMs}ms / p50 ${s.duration.p50Ms}ms / p95 ${s.duration.p95Ms}ms`);
    }
    lines.push(`  last seen: ${s.lastSeen}`);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ---------- CLI ----------

function _parseArgs(argv) {
  const out = { workspaceId: null, sinceDays: DEFAULT_SINCE_DAYS, allTime: false, today: null, sourceFilter: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '-w') out.workspaceId = argv[++i];
    else if (a === '--since-days') out.sinceDays = parseInt(argv[++i], 10);
    else if (a === '--all') out.allTime = true;
    else if (a === '--today') out.today = argv[++i];
    else if (a === '--source') out.sourceFilter = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function _printHelp() {
  console.log('Usage: node analyze-source-pull-log.mjs --workspace <id> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --workspace, -w <id>    Workspace id under ~/.core/workspaces/');
  console.log('  --since-days N          Lookback window in days (default 14)');
  console.log('  --all                   Ignore window; include all events');
  console.log('  --today YYYY-MM-DD      Override "today" for deterministic windowing');
  console.log('  --source <name>         Filter to events from a single source');
  console.log('  --json                  Emit JSON report instead of formatted text');
  console.log('  --help, -h              Show this help');
}

export async function main(argv) {
  const args = _parseArgs(argv);

  if (args.help || !args.workspaceId) {
    _printHelp();
    return args.workspaceId ? 0 : 1;
  }

  if (!workspaceExists(args.workspaceId)) {
    console.error(`Workspace not found: ${args.workspaceId}`);
    return 1;
  }

  const events = loadEvents(args.workspaceId, {
    sinceDays: args.sinceDays,
    allTime: args.allTime,
    today: args.today,
    sourceFilter: args.sourceFilter,
  });

  const report = buildReport(events);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  return 0;
}

// CLI entry guard — DC-77 pattern. realpathSync resolves symlinks on both sides so the
// comparison works for symlinked installs (marketplace cache, OneDrive sync, manual symlinks).
// CORE_DEBUG_CLI_ENTRY=1 surfaces argv[1]/import.meta.url match.
const __isCliEntry = (() => {
  try {
    const canonical = (p) => { try { return realpathSync(p); } catch { return p; } };
    const self = canonical(fileURLToPath(import.meta.url));
    const argv1 = canonical(process.argv[1]);
    if (process.env.CORE_DEBUG_CLI_ENTRY) {
      console.error(`[cli-entry] argv[1]=${argv1} self=${self} match=${argv1 === self}`);
    }
    return argv1 === self;
  } catch {
    return false;
  }
})();

if (__isCliEntry) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(err => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
