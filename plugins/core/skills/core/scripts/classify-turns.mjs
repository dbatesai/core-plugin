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
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Fail-open: never throws.
 *
 * CLI:  node classify-turns.mjs <project> [--harness claude-code|codex] [--json]
 */

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readTranscript } from './read-transcript.mjs';
import { todayUTC, resolveSessionId, resolveWorkspaceId, operationalMetricsDir, metricsEnabled } from './log-event.mjs';

export const CLASSIFIER_VERSION = '0.1.0';

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
// Not exhaustive — covers the noise that actually shows up in clarifying questions (M6).
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
  // M6: the old regex matched those greedily and polluted the asked-term. A denylist of common
  // English hyphenations filters the noise while keeping lowercase project terms like
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
export function classifyTurn(turn, { isInContext, isOnDisk }) {
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

  if (inContext) return { state: 'rec-fail-tier-0', evidence: { term, found: 'context' } };
  if (onDisk) {
    if (!ladder) return { state: 'rec-fail-tier-1-3-trigger', evidence: { term, found: 'disk', ladder_walk: false } };
    // M6: mechanics-failure is defined as "agent walked the ladder; it came back EMPTY anyway"
    // — so it requires the ladder to have surfaced nothing. The dead ladderReturnedContent
    // discriminator is the test. If the ladder walked AND returned content but the agent still
    // asked, the mechanism worked — the content was effectively in context for this turn — so
    // that's a tier-0-grade recognition failure, not a mechanics failure.
    return ladderReturnedContent(toolEvents)
      ? { state: 'rec-fail-tier-0', evidence: { term, found: 'context-via-ladder', ladder_walk: true } }
      : { state: 'mechanics-failure', evidence: { term, found: 'disk', ladder_walk: true, ladder_empty: true } };
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
  return pairTurns(events).map((turn, i) => ({ turnIdx: i, ...classifyTurn(turn, ctx) }));
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
 * tolerates the hyphen/colon characters in project ids (DC-99, references-topic) fixes that.
 */
export function containsTerm(blob, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return false;
  return new RegExp('(^|[^a-z0-9])' + _escapeRe(t) + '([^a-z0-9]|$)').test(blob);
}

function buildPredicates(project) {
  const contextBlob = ['CLAUDE.md', 'MEMORY.md', 'PROJECT.md']
    .map((f) => safeRead(join(project, f)))
    .join('\n')
    // CLAUDE.md is usually at repo root / home; MEMORY.md is in the harness store.
    // PROJECT.md is the load-bearing one and lives in the project — good enough v1.
    .toLowerCase();
  const diskBlob = listDiskTerms(project).toLowerCase();
  // M6: a bare substring test made any term that's a SUBSTRING of the 184KB PROJECT.md read
  // "in context" — a short token like "opt-in" matches inside unrelated words, biasing the
  // headline rec-fail-tier-0 rate upward. Match on a word boundary instead.
  return {
    isInContext: (term) => containsTerm(contextBlob, term),
    isOnDisk: (term) => containsTerm(diskBlob, term),
  };
}

function listDiskTerms(project) {
  // Cheap proxy: the filenames + first lines under _memories/ + _summaries/ + docs/.
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
    if (e.isDirectory()) walkNames(join(dir, e.name), out, depth + 1);
  }
}

function safeRead(p) { try { return readFileSync(p, 'utf8'); } catch { return ''; } }

export function runClassification({ project, harness = 'claude-code', cwd, home = homedir(), sessionId, today, workspaceId, env }) {
  // Privacy gate (spec §18): default-off; opt-in per workspace. Captures nothing
  // — reads no transcript content, writes no records — unless explicitly enabled.
  if (!metricsEnabled({ project, env })) {
    return { status: 'DISABLED', reason: 'metrics opt-in not set (CORE_METRICS_ENABLED env or workspace.json metrics_enabled)', provisional: true };
  }
  const t = readTranscript({ harness, cwd: cwd || project, home });
  if (!t.available) {
    return { status: 'UNAVAILABLE', reason: 'transcript unavailable', provisional: true };
  }
  const ctx = buildPredicates(project);
  const classified = classifyTurns(t.events, ctx);
  const sid = resolveSessionId({ explicit: sessionId });
  const date = today || todayUTC();
  const wid = workspaceId || resolveWorkspaceId(project);
  const records = classified.map((c) => ({
    schema_version: '1.0.0',
    classifier_version: CLASSIFIER_VERSION,
    provisional: true, // honesty gate — not evidence-grade until calibration
    session_id: sid,
    turn_idx: c.turnIdx,
    state: c.state,
    evidence: c.evidence,
  }));
  // Write to the operational-meta classified store (derived, regeneratable; §17.6).
  try {
    const dir = join(operationalMetricsDir(wid, { home }), 'classified');
    mkdirSync(dir, { recursive: true });
    for (const r of records) appendFileSync(join(dir, `${date}.jsonl`), JSON.stringify(r) + '\n');
  } catch { /* best-effort */ }
  return { status: 'OK', provisional: true, workspace_id: wid, ...summarize(classified), records };
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
