/**
 * metrics-detectors.mjs — Layer 2 silent-failure detectors.
 *
 * Standard observability is "X happened, log it." Silent-failure detection is
 * "X should have happened given Y — did it?" This module runs the process-failure
 * detectors that have a crisp ground truth (spec §8, §17.12). v1 ships the
 * gold-standard one Anvil named first:
 *
 *   citation-resolver — every DC-XX / R-XX / [[name]] the agent asserted is
 *   resolved against the unit store. A broken reference inside a confident
 *   assertion is a silent-citation-failure: the agent cited authority that
 *   doesn't exist.
 *
 * Future slices (tracked in the roadmap): stale-context tripwire, anticipation-gap.
 *
 * Privacy-gated (spec §18) and fail-open. Per DC-77 ships with the plugin;
 * per DC-80 .mjs only.
 *
 * CLI:  node metrics-detectors.mjs <project> [--harness claude-code|codex] [--json]
 */

import { readdirSync, readFileSync, appendFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTranscript } from './read-transcript.mjs';
import { todayUTC, resolveSessionId, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';

export const DETECTOR_VERSION = '0.1.0';

const CITATION_RE = /\bDC-(\d+)\b|\bR-(\d+)\b|\[\[([^\]]+)\]\]/g;

/** Extract every unit-citation the agent made. Returns [{raw, kind, key}]. */
export function extractCitations(text) {
  const out = [];
  if (!text) return out;
  let m;
  CITATION_RE.lastIndex = 0;
  while ((m = CITATION_RE.exec(text))) {
    if (m[1]) out.push({ raw: m[0], kind: 'decision', key: `dc-${m[1]}` });
    else if (m[2]) out.push({ raw: m[0], kind: 'risk', key: `risk-${m[2]}` });
    else if (m[3]) out.push({ raw: m[0], kind: 'wikilink', key: m[3].trim().toLowerCase() });
  }
  return out;
}

/**
 * Index the unit store: the set of unit ids (filenames sans .md, lowercased) and
 * the set of claim-keys (`dc-<n>`, `risk-<n>`) derived from those filenames so a
 * `DC-104` citation resolves to `dc-104-harness-agnostic-...md`.
 */
export function buildUnitIndex(memoriesDir) {
  const ids = new Set();
  const claimKeys = new Set();
  walkMd(memoriesDir, (name) => {
    const id = name.replace(/\.md$/, '').toLowerCase();
    ids.add(id);
    const m = id.match(/^(dc|risk|r)-(\d+)/);
    if (m) claimKeys.add(`${m[1] === 'r' ? 'risk' : m[1]}-${m[2]}`);
  });
  return { ids, claimKeys };
}

function walkMd(dir, cb, depth = 0) {
  if (depth > 5) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) walkMd(join(dir, e.name), cb, depth + 1);
    else if (e.name.endsWith('.md') && !e.name.startsWith('INDEX')) cb(e.name);
  }
}

/** Does a citation resolve to a real unit? */
export function resolveCitation(citation, index) {
  if (citation.kind === 'wikilink') {
    if (index.ids.has(citation.key)) return true;
    // tolerate a wikilink that names a prefix of a longer id
    for (const id of index.ids) if (id.startsWith(citation.key)) return true;
    return false;
  }
  return index.claimKeys.has(citation.key);
}

export function runCitationResolver(events, index) {
  const broken = [];
  const seen = new Set();
  for (const ev of events || []) {
    if (ev.role !== 'assistant' || ev.kind !== 'text') continue;
    for (const c of extractCitations(ev.text)) {
      if (seen.has(c.raw)) continue;
      seen.add(c.raw);
      if (!resolveCitation(c, index)) broken.push(c);
    }
  }
  return broken;
}

export function runDetectors({ project, harness = 'claude-code', cwd, home = homedir(), sessionId, today, workspaceId, env }) {
  if (!metricsEnabled({ project, env })) {
    return { status: 'DISABLED', reason: 'metrics opt-in not set' };
  }
  const t = readTranscript({ harness, cwd: cwd || project, home });
  if (!t.available) return { status: 'UNAVAILABLE', reason: 'transcript unavailable' };

  const index = buildUnitIndex(join(project, '_memories'));
  const broken = runCitationResolver(t.events, index);

  const sid = resolveSessionId({ explicit: sessionId });
  const date = today || todayUTC();
  const wid = workspaceId || resolveWorkspaceId(project);
  const records = broken.map((c) => ({
    schema_version: '1.0.0',
    detector: 'citation-resolver',
    detector_version: DETECTOR_VERSION,
    session_id: sid,
    severity: 'high', // a cited authority that doesn't exist
    raw: c.raw,
    kind: c.kind,
    key: c.key,
  }));
  try {
    const dir = join(operationalMetricsDir(wid, { home }), 'detectors');
    mkdirSync(dir, { recursive: true });
    for (const r of records) appendFileSync(join(dir, `${date}.jsonl`), JSON.stringify(r) + '\n');
  } catch { /* best-effort */ }

  return { status: 'OK', workspace_id: wid, broken_citations: broken.length, records, unit_count: index.ids.size };
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const r = runDetectors({ project, harness: opt('harness') || 'claude-code' });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (r.status !== 'OK') process.stdout.write(`metrics-detectors: ${r.status} (${r.reason})\n`);
  else if (r.broken_citations === 0) process.stdout.write(`citation-resolver: clean (${r.unit_count} units indexed)\n`);
  else {
    process.stdout.write(`citation-resolver: ${r.broken_citations} broken reference(s) — cited authority that doesn't resolve:\n`);
    for (const c of r.records) process.stdout.write(`  ✖ ${c.raw}\n`);
  }
  process.exit(0);
}
