/**
 * analyze-capability-drift.mjs — drift + regression detection over capability history.
 *
 * v2.7.0 deliverable. Consumes capability-history.jsonl (written by capability-history.mjs)
 * and surfaces two things:
 *   - DRIFT: a capability's identity_status changed in the DEGRADING direction between
 *     consecutive observations (PASS→DEGRADED, PASS→NOT-YET, etc.). Healing-direction
 *     transitions (DEGRADED→PASS) are recorded as informational, not drift.
 *   - REGRESSION: a capability that reported in an earlier session is absent in the latest
 *     session's row set (the descriptor changed / capability disappeared).
 *
 * Output: <project>/_memories/_capability-drift-log.md — a render-only file the agent reads
 * on demand. NOT a unit. Per v2.7 plan §3-4.
 *
 * Attribution is HYPOTHESIS, never asserted fact (HC bar): every likely-cause line is
 * qualified with confidence low|med|high.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readHistory } from './capability-history.mjs';

// identity_status rank — higher is healthier. Drift = new rank < old rank.
const STATUS_RANK = { PASS: 3, DEGRADED: 2, 'NOT-YET': 1, UNKNOWN: 0 };

function rankOf(status) {
  return STATUS_RANK[status] ?? 0;
}

/**
 * Group history entries by capability_id, sorted by observed_at ascending.
 * @param {object[]} history — entries from readHistory()
 * @returns {Map<string, object[]>}
 */
export function groupByCapability(history) {
  const byCap = new Map();
  for (const entry of history) {
    const id = entry?.row?.capability_id;
    if (!id) continue;
    if (!byCap.has(id)) byCap.set(id, []);
    byCap.get(id).push(entry);
  }
  for (const entries of byCap.values()) {
    entries.sort((a, b) => String(a.observed_at ?? '').localeCompare(String(b.observed_at ?? '')));
  }
  return byCap;
}

/**
 * Detect drift: identity_status transitions between consecutive observations of the
 * same capability. Returns { drift: [...], healing: [...] }.
 * drift = degrading direction (the actionable signal); healing = informational.
 */
export function detectDrift(history) {
  const drift = [];
  const healing = [];
  const byCap = groupByCapability(history);
  for (const [capabilityId, entries] of byCap) {
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const cur = entries[i];
      const prevStatus = prev.row?.identity_status;
      const curStatus = cur.row?.identity_status;
      if (!prevStatus || !curStatus || prevStatus === curStatus) continue;
      const event = {
        capability_id: capabilityId,
        from_status: prevStatus,
        to_status: curStatus,
        from_observed_at: prev.observed_at,
        to_observed_at: cur.observed_at,
        from_session: prev.session_id ?? null,
        to_session: cur.session_id ?? null,
        attribution: attributeDrift(prev.row, cur.row),
      };
      if (rankOf(curStatus) < rankOf(prevStatus)) {
        event.direction = 'degrading';
        drift.push(event);
      } else {
        event.direction = 'healing';
        healing.push(event);
      }
    }
  }
  return { drift, healing };
}

/**
 * Hypothesize a cause for a drift event by diffing evidence-source codes.
 * ALWAYS a hypothesis with a confidence level — never asserted as fact (HC bar).
 */
export function attributeDrift(prevRow, curRow) {
  const prevSources = new Set((prevRow?.evidence ?? []).map(e => e.source));
  const curSources = new Set((curRow?.evidence ?? []).map(e => e.source));
  const appeared = [...curSources].filter(s => !prevSources.has(s));
  const disappeared = [...prevSources].filter(s => !curSources.has(s));
  if (appeared.length === 0 && disappeared.length === 0) {
    return { hypothesis: 'status changed with no evidence-source change; cause unclear', confidence: 'low' };
  }
  const parts = [];
  if (appeared.length) parts.push(`new evidence source(s): ${appeared.join(', ')}`);
  if (disappeared.length) parts.push(`evidence source(s) gone: ${disappeared.join(', ')}`);
  // A single appeared conflicting/degrading source is a stronger signal than a vague diff.
  const confidence = (appeared.length === 1 && disappeared.length === 0) ? 'med' : 'low';
  return { hypothesis: `likely related to ${parts.join('; ')}`, confidence };
}

/**
 * Detect regression: a capability that reported in the prior session's row set is
 * absent in the latest session's row set. Uses session_id to delimit sessions.
 */
export function detectRegression(history) {
  // Group entries by session, preserving session order by earliest observed_at.
  // M14: entries with no session_id can't be session-delimited. The old code merged them
  // ALL into one `__no-session__` pseudo-session — which then collides with the last-2-session
  // comparison below and produces spurious or masked regressions (a capability present in some
  // untagged rows but not others reads as a session-to-session change it never was). Skip them
  // from regression detection; the count is surfaced by countUntaggedSessions() so it's not silent.
  const bySession = new Map();
  for (const entry of history) {
    const sid = entry.session_id;
    if (sid == null || sid === '') continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(entry);
  }
  const sessions = [...bySession.entries()].map(([sid, entries]) => ({
    sid,
    earliest: entries.reduce((min, e) => String(e.observed_at) < min ? String(e.observed_at) : min, '￿'),
    capabilities: new Set(entries.map(e => e.row?.capability_id).filter(Boolean)),
  }));
  sessions.sort((a, b) => a.earliest.localeCompare(b.earliest));
  if (sessions.length < 2) return [];
  const prior = sessions[sessions.length - 2];
  const latest = sessions[sessions.length - 1];
  const regressions = [];
  for (const cap of prior.capabilities) {
    if (!latest.capabilities.has(cap)) {
      regressions.push({
        capability_id: cap,
        prior_session: prior.sid,
        latest_session: latest.sid,
        attribution: { hypothesis: 'capability absent from latest row set; descriptor likely changed (capability removed)', confidence: 'med' },
      });
    }
  }
  return regressions;
}

/** Render the drift log markdown (render-only artifact, not a unit). */
export function renderDriftLog(drift, healing, regressions, now) {
  const lines = [];
  lines.push('# Capability Drift Log');
  lines.push('');
  lines.push(`> Render-only artifact (not a unit). Regenerated by analyze-capability-drift.mjs. Generated ${now}.`);
  lines.push('');
  if (drift.length === 0 && regressions.length === 0) {
    lines.push('No degrading drift or regression detected.');
    lines.push('');
  }
  if (drift.length) {
    lines.push('## Drift (degrading direction)');
    lines.push('');
    for (const d of drift) {
      lines.push(`### ${d.to_observed_at} — ${d.capability_id}: ${d.from_status} → ${d.to_status}`);
      lines.push('');
      lines.push(`**From session:** ${d.from_session ?? '(unknown)'} at ${d.from_observed_at}`);
      lines.push(`**To session:** ${d.to_session ?? '(unknown)'} at ${d.to_observed_at}`);
      lines.push(`**Likely cause (confidence: ${d.attribution.confidence}):** ${d.attribution.hypothesis}`);
      lines.push('');
    }
  }
  if (regressions.length) {
    lines.push('## Regression (capability disappeared)');
    lines.push('');
    for (const r of regressions) {
      lines.push(`### ${r.capability_id} no longer reports`);
      lines.push('');
      lines.push(`**Prior session:** ${r.prior_session}`);
      lines.push(`**Latest session:** ${r.latest_session}`);
      lines.push(`**Likely cause (confidence: ${r.attribution.confidence}):** ${r.attribution.hypothesis}`);
      lines.push('');
    }
  }
  if (healing.length) {
    lines.push('## Healing (informational — not drift)');
    lines.push('');
    for (const h of healing) {
      lines.push(`- ${h.to_observed_at} — ${h.capability_id}: ${h.from_status} → ${h.to_status}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Count entries with no resolvable session_id — surfaced so the regression skip isn't silent. */
export function countUntaggedSessions(history) {
  return history.filter(e => e.session_id == null || e.session_id === '').length;
}

export function loadCapabilityHistory(workspaceId, project = null, opts = {}) {
  const histories = [];
  try { histories.push(...readHistory(workspaceId, { home: opts.home })); } catch { /* unavailable home history */ }
  if (project) {
    try { histories.push(...readHistory(workspaceId, { project })); } catch { /* unavailable project history */ }
  }
  // M14: the same observation can exist in BOTH the home and project store. Concatenating
  // double-counts it, inflating drift transitions and regression comparisons. Dedup on the
  // fields that identify one observation — session, timestamp, capability, content hash.
  const seen = new Set();
  const deduped = [];
  for (const e of histories) {
    const key = [e.session_id ?? '', e.observed_at ?? '', e.row?.capability_id ?? '', e.row_content_hash ?? ''].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(e);
  }
  return deduped.sort((a, b) =>
    String(a.observed_at ?? '').localeCompare(String(b.observed_at ?? '')));
}

// Legacy sweep: the drift log lives at the `_`-prefixed filename
// so check-units skips it. A non-prefixed `capability-drift-log.md` left over from
// an older layout is treated as a real unit and fails schema (missing required
// fields). Remove it when we write the current file so upgraders self-heal. Only
// ever touches that exact legacy filename.
export function removeLegacyDriftLog(project) {
  const legacy = join(project, '_memories', 'capability-drift-log.md');
  if (existsSync(legacy)) { unlinkSync(legacy); return true; }
  return false;
}

export function main(argv) {
  let project = null, workspaceId = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (!argv[i].startsWith('--') && project === null) project = argv[i];
  }
  if (!project) { process.stderr.write('usage: analyze-capability-drift.mjs <project> [--workspace-id <id>]\n'); return 2; }

  // Resolve workspace id from <project>/workspace.json if not passed
  if (!workspaceId) {
    try {
      const wsPath = join(project, 'workspace.json');
      if (existsSync(wsPath)) {
        workspaceId = JSON.parse(readFileSync(wsPath, 'utf8')).workspace_id;
      }
    } catch { /* fall through */ }
  }
  if (!workspaceId) { process.stderr.write('could not resolve workspace id (pass --workspace-id)\n'); return 2; }

  const history = loadCapabilityHistory(workspaceId, project);
  const { drift, healing } = detectDrift(history);
  const regressions = detectRegression(history);
  const now = new Date().toISOString();
  const md = renderDriftLog(drift, healing, regressions, now);

  const outPath = join(project, '_memories', '_capability-drift-log.md');
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md);
  removeLegacyDriftLog(project);
  console.log(JSON.stringify({
    drift: drift.length, healing: healing.length, regressions: regressions.length,
    history_entries: history.length, untagged_skipped: countUntaggedSessions(history), out: outPath,
  }));
  return 0;
}

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
