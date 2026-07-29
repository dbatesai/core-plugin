/**
 * classify-turns.mjs — Layer 2 six-state recognition classifier.
 *
 * Reads a session transcript (via read-transcript.mjs) and labels each
 * user→assistant turn with one of the six recognition states from the metrics
 * spec (§3, §6). This is the headline instrument: `rec-fail-tier-0` (the answer
 * was in context and the agent asked anyway) is the number the whole memory
 * system is trying to drive down.
 *
 *   tier-0-win                    context held it, agent used it, no ladder walk
 *   tier-1-3-win                  agent walked the ladder and surfaced it
 *   rec-fail-tier-0               agent asked; term WAS in baseline context
 *   rec-fail-tier-1-3-trigger     agent asked; term on disk but no ladder walk fired
 *   mechanics-failure             agent walked the ladder; it came back empty anyway
 *   capture-miss                  agent asked; term genuinely nowhere
 *
 * HONESTY GATE (spec §17.12, Anvil A4): this output is PROVISIONAL until the
 * Phase-3 calibration set proves the heuristics at >0.7 precision. Every record
 * carries `provisional: true` and `classifier_version`; rollups must NOT render
 * state distributions as evidence-grade until calibration clears. Capture (the
 * transcript) is ground truth; this interpretation is tunable and replayable.
 *
 * CADENCE (honesty): there is NO automatic trigger for this script. It
 * runs only from user-invoked /finalize and /process-memory. A session closed
 * without them produces no classified records, so the rollup and orient-signal
 * go STALE (not wrong) until the next finalize. Never describe the rec-fail
 * trend as continuous monitoring.
 *
 * Ships with the plugin by convention; .mjs (Node.js) only. Fail-open: never throws.
 *
 * CLI:  node classify-turns.mjs <project> [--harness claude-code|codex] [--json]
 */

import { readFileSync, readdirSync, appendFileSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readTranscript } from './read-transcript.mjs';
import { todayUTC, resolveSessionId, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';

// Version stamp for classification BEHAVIOR. Any behavior-affecting change
// (predicates, matching rules, discriminators — anything that shifts the state
// distribution) MUST bump this, so the R-1
// honesty guard (metrics-rollup gates the PROVISIONAL tag on a classifier_version match)
// correctly invalidates a calibration cleared under a different behavior.
export const CLASSIFIER_VERSION = '0.3.0';

// The classified-record schema version stamped on every row. Exported so the
// read side (metrics-rollup.mjs, metrics-package.mjs) can select the exact
// current-instrument cohort (schema, classifier, proxy) before aggregating —
// validating calibration against current constants
// while aggregating rows from ANY version would silently mix instruments.
export const CLASSIFIED_SCHEMA_VERSION = '1.0.0';

// The in-context PROXY version, distinct from the classifier version. The current
// proxy (v2) is the
// word-boundary `containsTerm` test plus the rule that PROJECT.md only counts as
// in-context when this session's transcript shows it was actually read. Stamped on
// every record so the calibration layer can invalidate any label set cleared
// under a different proxy — same R-1 honesty guard the classifier_version match enforces.
// The label-independence half stays Gate G4 (the product owner vouches); this only versions the proxy.
export const PROXY_VERSION = 2;

// A clarifying question — the agent asking the user instead of answering.
const CLARIFYING_RE = /\b(what (is|does|are|do you mean)|what'?s|which|i'?m not (sure|familiar)|could you (remind|clarify|explain)|can you (remind|clarify|explain)|remind me|not familiar with|haven'?t (seen|come across)|don'?t (have|see) (context|background)|where (is|does)|tell me (more )?about)\b/i;

// A ladder walk: a tool call touching the CORE store (the retrieval ladder).
const LADDER_SURFACE_RE = /_memories|_summaries|PROJECT\.md|MEMORY\.md|\.core\//i;

export function isClarifying(text) { return CLARIFYING_RE.test(text || ''); }

export function isLadderWalk(toolEvents) {
  return (toolEvents || []).some((e) => e.kind === 'tool' && LADDER_SURFACE_RE.test(e.text || ''));
}

export function ladderReturnedContent(toolEvents) {
  // Heuristic proxy: a ladder-surface tool whose serialized result is non-trivial.
  return (toolEvents || []).some(
    (e) => e.kind === 'tool' && LADDER_SURFACE_RE.test(e.text || '') && (e.text || '').length > 80,
  );
}

/**
 * Extract the most likely term the agent is asking about. Heuristic: a project-
 * vocabulary-shaped token (DC-xx / R-xx / [[name]] / a multi-cap or hyphenated id)
 * near the clarifying phrase; else the longest capitalized/hyphenated token.
 */
// Common English hyphenations that look like a project handle to the regex but aren't.
// Not exhaustive — covers the noise that actually shows up in clarifying questions.
const COMMON_HYPHENATED = new Set([
  'opt-in', 'opt-out', 'in-context', 'out-of', 'well-known', 'real-time', 'end-to-end',
  'follow-up', 'day-to-day', 'up-to-date', 'state-of-the-art', 'so-called', 'long-term',
  'short-term', 'full-time', 'part-time', 'high-level', 'low-level', 'self-referential',
  're-run', 're-read', 'one-line', 'two-tier', 'first-class', 'load-bearing',
]);

export function extractAskedTerm(text) {
  if (!text) return null;
  // Structured project ids first: DC-xx / R-xx / [[wikilink]] — unambiguous.
  const structured = text.match(/\b(?:DC-\d+|R-\d+)\b|\[\[[^\]]+\]\]/g);
  if (structured && structured.length) {
    return structured.sort((a, b) => b.length - a.length)[0].replace(/[[\]]/g, '');
  }
  // Generic hyphenated tokens, but NOT ordinary hyphenated English ("opt-in", "well-known").
  // A bare hyphenated-token match would take those greedily and pollute the asked-term.
  // A denylist of common English hyphenations filters the noise while keeping lowercase project terms like
  // "register-trigger" (a structural digit/uppercase rule would wrongly drop those).
  const hyphenated = (text.match(/\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,}\b/g) || [])
    .filter((t) => !COMMON_HYPHENATED.has(t.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  if (hyphenated.length) return hyphenated[0];
  const caps = (text.match(/\b[A-Z][A-Za-z0-9]{3,}\b/g) || []).sort((a, b) => b.length - a.length);
  return caps[0] || null;
}

/**
 * Classify one user→assistant turn. Pure: predicates injected for testability.
 * @param {object} turn  { userText, toolEvents, assistantText }
 * @param {object} ctx   { isInContext(term), isOnDisk(term) }
 */
export function classifyTurn(turn, ctx) {
  const { isInContext, isOnDisk } = ctx;
  const { userText = '', toolEvents = [], assistantText = '' } = turn;
  const ladder = isLadderWalk(toolEvents);

  if (!isClarifying(assistantText)) {
    return ladder
      ? { state: 'tier-1-3-win', evidence: { ladder_walk: true } }
      : { state: 'tier-0-win', evidence: { ladder_walk: false } };
  }

  const term = extractAskedTerm(assistantText) || extractAskedTerm(userText);
  const inContext = term ? !!isInContext(term) : false;
  const onDisk = term ? !!isOnDisk(term) : false;

  const contextExcerpt = ctx.contextEvidence?.(term) || null;
  const diskExcerpt = ctx.diskEvidence?.(term) || null;
  if (inContext) return { state: 'rec-fail-tier-0', evidence: { term, found: 'context', context_excerpt: contextExcerpt } };
  if (onDisk) {
    if (!ladder) return { state: 'rec-fail-tier-1-3-trigger', evidence: { term, found: 'disk', ladder_walk: false, disk_excerpt: diskExcerpt } };
    // M6: mechanics-failure is defined as "agent walked the ladder; it came back EMPTY anyway"
    // — so it requires the ladder to have surfaced nothing. The dead ladderReturnedContent
    // discriminator is the test. If the ladder walked AND returned content but the agent still
    // asked, the mechanism worked — the content was effectively in context for this turn — so
    // that's a tier-0-grade recognition failure, not a mechanics failure.
    return ladderReturnedContent(toolEvents)
      ? { state: 'rec-fail-tier-0', evidence: { term, found: 'context-via-ladder', ladder_walk: true, context_excerpt: contextExcerpt } }
      : { state: 'mechanics-failure', evidence: { term, found: 'disk', ladder_walk: true, ladder_empty: true, disk_excerpt: diskExcerpt } };
  }
  return { state: 'capture-miss', evidence: { term, found: 'nowhere' } };
}

/** Pair a flat event stream into user→assistant turns. */
export function pairTurns(events) {
  const turns = [];
  let cur = null;
  for (const ev of events || []) {
    if (ev.role === 'user' && ev.kind === 'text') {
      if (cur) turns.push(cur);
      cur = { userText: ev.text || '', toolEvents: [], assistantText: '' };
    } else if (cur) {
      if (ev.kind === 'tool') cur.toolEvents.push(ev);
      else if (ev.role === 'assistant' && ev.kind === 'text') cur.assistantText += '\n' + (ev.text || '');
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

export function classifyTurns(events, ctx) {
  return pairTurns(events).map((turn, i) => ({
    turnIdx: i,
    ...classifyTurn(turn, ctx),
    turn_evidence: {
      user_text: turn.userText,
      assistant_text: turn.assistantText.trim(),
      tool_events: turn.toolEvents.map((event) => event.text || ''),
    },
  }));
}

export function summarize(classified) {
  const dist = {};
  for (const c of classified) dist[c.state] = (dist[c.state] || 0) + 1;
  return { total: classified.length, distribution: dist };
}

// ---- CLI plumbing: build the context/disk predicates from the real project ----

const _escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Word-boundary containment over an already-lowercased blob. A bare `.includes` made any
 * substring (e.g. "opt-in" inside "adopt-inline") read as present; a token boundary that
 * tolerates the hyphen/colon characters in project ids (references-topic) fixes that.
 */
export function containsTerm(blob, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  return new RegExp('(^|[^a-z0-9])' + _escapeRe(t) + '([^a-z0-9]|$)').test(blob);
}

export function buildPredicates(project, { events = [] } = {}) {
  // Only harness-auto-injected surfaces are unconditionally "in context"
  // (CLAUDE.md, MEMORY.md). PROJECT.md is a disk file the agent must explicitly
  // read — counting it unconditionally would under-report rec-fail-tier-0. It joins
  // the context blob only when this session's transcript shows a tool touching it.
  const injected = ['CLAUDE.md', 'MEMORY.md'].map((f) => safeRead(join(project, f)));
  const projectMdRead = (events || []).some((e) => e.kind === 'tool' && /PROJECT\.md/i.test(e.text || ''));
  if (projectMdRead) injected.push(safeRead(join(project, 'PROJECT.md')));
  const contextBlob = injected.join('\n').toLowerCase();
  // PROJECT.md always counts as on-disk (it IS reachable by the ladder).
  const diskBlob = (listDiskTerms(project) + '\n' + safeRead(join(project, 'PROJECT.md'))).toLowerCase();
  const excerpt = (blob, term) => {
    const needle = String(term || '').toLowerCase();
    const at = needle ? blob.indexOf(needle) : -1;
    if (at < 0) return null;
    return blob.slice(Math.max(0, at - 120), Math.min(blob.length, at + needle.length + 120));
  };
  return {
    isInContext: (term) => containsTerm(contextBlob, term),
    isOnDisk: (term) => containsTerm(diskBlob, term),
    contextEvidence: (term) => excerpt(contextBlob, term),
    diskEvidence: (term) => excerpt(diskBlob, term),
  };
}

function listDiskTerms(project) {
  // Filenames + each unit's frontmatter and first heading (filenames alone
  // would make body-only terms read as "nowhere on disk" → false capture-miss).
  const parts = [];
  for (const sub of ['_memories', '_summaries', 'docs']) {
    walkNames(join(project, sub), parts);
  }
  return parts.join('\n');
}

function walkNames(dir, out, depth = 0) {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    out.push(e.name.replace(/\.md$/, '').replace(/-/g, ' '));
    if (e.isDirectory()) { walkNames(join(dir, e.name), out, depth + 1); continue; }
    if (e.name.endsWith('.md')) out.push(unitHeadTerms(join(dir, e.name)));
  }
}

/** Frontmatter block + first markdown heading of a unit (first 2KB — cheap, bounded). */
function unitHeadTerms(path) {
  let head;
  try { head = readFileSync(path, 'utf8').slice(0, 2048); } catch { return ''; }
  head = head.replace(/\r\n?/g, '\n');
  const parts = [];
  const fm = head.match(/^---\n([\s\S]*?)\n---/);
  if (fm) parts.push(fm[1]);
  const h1 = head.match(/^#\s+(.+)$/m);
  if (h1) parts.push(h1[1]);
  return parts.join('\n');
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

export function runClassification({ project, harness = 'claude-code', cwd, home = homedir(), sessionId, today, workspaceId, env }) {
  // Capture gate (spec §18, metrics policy): default-on, opt-out. Captures nothing
  // — reads no transcript content, writes no records — when the user has opted out.
  if (!metricsEnabled({ project, env })) {
    return { status: 'DISABLED', reason: 'metrics opted out (CORE_METRICS_ENABLED=0 or workspace.json metrics_enabled:false)', provisional: true };
  }
  const t = readTranscript({ harness, cwd: cwd || project, home, sessionId, env });
  if (!t.available) {
    return { status: 'UNAVAILABLE', reason: 'transcript unavailable', provisional: true };
  }
  const ctx = buildPredicates(project, { events: t.events });
  const classified = classifyTurns(t.events, ctx);
  const sid = resolveSessionId({ explicit: sessionId });
  const date = today || todayUTC();
  const wid = workspaceId || resolveWorkspaceId(project);
  const records = classified.map((c) => ({
    schema_version: CLASSIFIED_SCHEMA_VERSION,
    classifier_version: CLASSIFIER_VERSION,
    proxy_version: PROXY_VERSION, // versions the in-context proxy so calibration invalidates across proxy changes
    harness,
    provisional: true, // honesty gate — not evidence-grade until calibration
    session_id: sid,
    turn_idx: c.turnIdx,
    state: c.state,
    evidence: c.evidence,
    turn_evidence: c.turn_evidence,
  }));
  // Write to the operational-meta classified store (derived, regeneratable; §17.6).
  try {
    const dir = join(operationalMetricsDir(wid, { home }), 'classified');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${date}.jsonl`);
    for (const r of records) appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch { /* best-effort */ }
  return { status: 'OK', provisional: true, workspace_id: wid, transcript_resolution: t.meta.transcript_resolution, ...summarize(classified), records };
}


/** Retention window for the classified turn log — same bound as turn capture. */
export const CLASSIFIED_RETENTION_DAYS = 30;

/**
 * Delete classified day-files older than the window. The classified store
 * carries turn text, so it gets the same retention bound the capture stream
 * has. The window is validated before any deletion arithmetic runs.
 */
export function runClassifiedRetention(projectDir, { workspaceId, home, windowDays = CLASSIFIED_RETENTION_DAYS, now = new Date() } = {}) {
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    return { ran: false, reason: 'invalid-window', windowDays };
  }
  const wid = workspaceId || resolveWorkspaceId(projectDir);
  const dir = join(operationalMetricsDir(wid, { home }), 'classified');
  if (!existsSync(dir)) return { ran: true, deleted: [], kept: [], windowDays };
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const cutoffDay = cutoff.toISOString().slice(0, 10);
  const deleted = [];
  const kept = [];
  let names = [];
  try { names = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)); } catch { return { ran: false, reason: 'unreadable', windowDays }; }
  for (const name of names) {
    const day = name.slice(0, 10);
    if (day < cutoffDay) {
      try {
        rmSync(join(dir, name), { force: true });
        if (existsSync(join(dir, name))) kept.push(`${name} (deletion-unverified)`);
        else deleted.push(name);
      } catch (e) {
        kept.push(`${name} (retention-error: ${String(e && e.message).slice(0, 80)})`);
      }
    } else kept.push(name);
  }
  return { ran: true, deleted, kept, cutoff: cutoffDay, windowDays };
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const project = argv.find((a) => !a.startsWith('--')) || process.cwd();
  const r = runClassification({ project, harness: opt('harness') || 'claude-code' });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else {
    process.stdout.write(`classify-turns [PROVISIONAL — not calibrated] ${r.status}\n`);
    if (r.distribution) {
      for (const [s, n] of Object.entries(r.distribution).sort((a, b) => b[1] - a[1])) {
        process.stdout.write(`  ${s}: ${n}\n`);
      }
    }
  }
  process.exit(0);
}
