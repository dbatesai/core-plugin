/**
 * analyze-retrieval-skip.mjs — the behavioral consumer of read-transcript.
 *
 * The retrieval-skip gate. memory-accessed-probe answers a session-level binary — was
 * the CORE store reached AT ALL this session? This asks the sharper, ordering-aware
 * question named in review: was a memory-DEPENDENT turn answered WITHOUT reaching the store
 * first? That is the recognition-failure signature: the agent used / was asked
 * about a project term that lives in _memories/ and answered from its own head instead
 * of grepping. memory-accessed misses it when the store is grepped later for something
 * else (core>0 → PASS) while an individual term-turn was still answered cold.
 *
 * Honest boundary (both-layers — no overclaim):
 *  - "memory-dependent" is a HEURISTIC: a user turn contains a high-signal project term
 *    (a DC-/R- id, an acronym, a product/CamelCase name, or a multi-word topic phrase).
 *    Term presence != certain dependence, so output is CANDIDATES for review, not a
 *    hard FAIL. The term set is deliberately conservative to avoid false-positive floods.
 *  - It abstains (UNKNOWN) when it cannot see tool calls (Codex tool extraction pending)
 *    — it never claims "not reached" when it simply cannot observe access.
 *  - A skip means: between the question and its answer, NO tool touched a CORE surface.
 *    Only an access INSIDE that interval clears the turn — an earlier lookup answered a
 *    different question, and a later one came after the answer was already given.
 *
 * Consumes the read-transcript adapter verb (harness paths/schemas stay there).
 * Wired into /finalize + /process-memory as a session-closeout signal (review: the
 * consumer must be behavioral; CI is a supplement, the failure mode is session behavior).
 *
 * Ships with the plugin as a script; .mjs only.
 *
 * CLI:
 *   node analyze-retrieval-skip.mjs <project-root> [--harness <h>] [--transcript <path>] [--json]
 * Library:
 *   import { analyzeRetrievalSkip, buildProjectTerms, classifyRetrievalSkips, formatReport } from './analyze-retrieval-skip.mjs';
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTranscript } from './read-transcript.mjs';
import { CORE_SURFACE_RE } from './capability/memory-accessed-probe.mjs';

export const SCHEMA_VERSION = '1.0.0';

// A short stop-list so frontmatter topic tokens that are bare common words never become
// terms. The structural filters below (id-shape, acronym, CamelCase, multi-word/hyphen)
// already exclude most noise; this is a backstop for single-word topics.
const COMMON_WORDS = new Set([
  'is', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'project',
  'memory', 'data', 'state', 'notes', 'people', 'risk', 'decision', 'design', 'plan',
]);

/** True for a high-signal identifier: a DC-nn decision id, R-17, IGM (acronym), BBLens (CamelCase). */
function isHighSignalToken(tok) {
  if (/^(?:DC|R)-\d+$/.test(tok)) return true;          // decision / risk ids
  if (/^[A-Z]{2,6}$/.test(tok)) return true;             // acronym (IGM, RTM, PRD)
  if (/^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(tok)) return true; // CamelCase product (BBLens)
  return false;
}

/**
 * Build a conservative, high-signal project-term set from the store.
 * Sources: _memories/ unit bodies/names for id+acronym+CamelCase tokens, and `topics:`
 * frontmatter for multi-word / hyphenated phrases. Single common words are dropped.
 */
export function buildProjectTerms(projectRoot) {
  const terms = new Set();
  const selfNames = projectSelfNames(projectRoot); // the project's own name is ambient, not a retrieval trigger
  const memDir = join(projectRoot, '_memories');
  const files = [];
  walkMd(memDir, files);
  for (const f of files) {
    let content;
    try { content = readFileSync(f, 'utf8'); } catch { continue; }
    // High-signal tokens anywhere in the unit (ids, acronyms, product names).
    for (const m of content.matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) {
      const tok = m[0];
      if (isHighSignalToken(tok) && !selfNames.has(tok.toLowerCase())) terms.add(normalizeId(tok));
    }
    // topics: frontmatter — multi-word or hyphenated phrases (intentional vocabulary).
    const fm = content.match(/topics:\s*\[([^\]]*)\]/i);
    if (fm) {
      for (const raw of fm[1].split(',')) {
        const phrase = raw.trim().replace(/^['"]|['"]$/g, '');
        if (!phrase) continue;
        const isMultiWord = /[\s-]/.test(phrase);
        if (isMultiWord && !COMMON_WORDS.has(phrase.toLowerCase())) terms.add(phrase);
      }
    }
  }
  return terms;
}

// Normalize id casing so a lowercase-typed id matches its canonical uppercase form.
function normalizeId(tok) {
  const m = tok.match(/^(dc|r)-(\d+)$/i);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : tok;
}

// The project's own name appears constantly (skill prompt, headings, every summary) and
// is not a retrieval trigger — drop it so it doesn't flood candidates (without this, a
// project named CORE self-flags on every line). Sources: project dir basename +
// workspace.json name.
function projectSelfNames(projectRoot) {
  const names = new Set();
  const base = String(projectRoot).replace(/[/\\]+$/, '').split(/[/\\]/).pop();
  if (base) names.add(base.toLowerCase());
  try {
    const ws = JSON.parse(readFileSync(join(projectRoot, 'workspace.json'), 'utf8'));
    for (const tok of String(ws.name || '').split(/\s+/)) if (tok) names.add(tok.toLowerCase());
  } catch { /* no workspace.json — basename only */ }
  return names;
}

// An injected skill prompt / system-reminder / pasted blob is a "user" turn full of
// project terms but it is NOT a question — and its content is already in-context, so it
// is not store-dependent. These markers + an oversized backstop isolate genuine asks.
const SCAFFOLDING_MARKERS = ['<command-name>', '<command-message>', 'Base directory for this skill', 'ARGUMENTS:', '<system-reminder>', '<persisted-output>'];
const MAX_QUESTION_CHARS = 4000;
function isGenuineUserQuestion(text) {
  const t = String(text || '');
  if (t.length > MAX_QUESTION_CHARS) return false;
  return !SCAFFOLDING_MARKERS.some((m) => t.includes(m));
}

function walkMd(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith('archive')) walkMd(p, out); }
    else if (e.name.endsWith('.md') && !e.name.startsWith('INDEX')) out.push(p);
  }
}

/** Does a user turn reference a project term? Case-insensitive for phrases; ids normalized. */
function turnTerms(text, terms) {
  const hits = [];
  const t = String(text || '');
  for (const term of terms) {
    // word-ish boundary so 'IGM' doesn't match inside 'paradigm'; ids/phrases matched whole.
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9-])${esc}(?:[^A-Za-z0-9-]|$)`, term === term.toUpperCase() ? '' : 'i');
    if (re.test(t)) hits.push(term);
  }
  return hits;
}

/**
 * Walk normalized transcript events; flag memory-dependent user turns whose answer was
 * not preceded by any CORE-store tool access. Pure over its inputs.
 */
export function classifyRetrievalSkips({ events = [], terms, coreStorePresent = true, transcriptAvailable = true, toolExtractionPending = false }) {
  if (!coreStorePresent) return { status: 'NO-STORE', reason: 'no CORE store (_memories/ or PROJECT.md) — nothing to skip', skips: [], memoryDependentTurns: [], firstCoreAccessIdx: null };
  if (!transcriptAvailable) return { status: 'UNKNOWN', reason: 'transcript unavailable — cannot judge retrieval ordering', skips: [], memoryDependentTurns: [], firstCoreAccessIdx: null };
  if (toolExtractionPending) return { status: 'UNKNOWN', reason: 'tool extraction pending for this harness — cannot observe store access, so cannot prove a skip', skips: [], memoryDependentTurns: [], firstCoreAccessIdx: null };

  const ordered = [...events].sort((a, b) => a.idx - b.idx);
  const coreAccessIdxs = ordered.filter((e) => e.kind === 'tool' && CORE_SURFACE_RE.test(String(e.text || ''))).map((e) => e.idx);
  const firstCoreAccessIdx = coreAccessIdxs.length ? coreAccessIdxs[0] : null;

  const skips = [];
  const memoryDependentTurns = [];
  for (let i = 0; i < ordered.length; i++) {
    const ev = ordered[i];
    if (ev.kind !== 'text' || ev.role !== 'user') continue;
    if (!isGenuineUserQuestion(ev.text)) continue; // skip injected scaffolding / oversized in-context blobs
    const hits = turnTerms(ev.text, terms);
    if (!hits.length) continue;
    memoryDependentTurns.push(ev.idx);
    // find the next assistant text turn (the answer)
    const answer = ordered.slice(i + 1).find((e) => e.kind === 'text' && e.role === 'assistant');
    if (!answer) continue; // unanswered — nothing to judge
    // The interval of judgment is this question to its answer. An access outside it is
    // evidence for some other turn, so it cannot clear this one.
    const storeReachedInInterval = coreAccessIdxs.some((idx) => idx > ev.idx && idx <= answer.idx);
    if (!storeReachedInInterval) {
      skips.push({ term: hits[0], terms: hits, userIdx: ev.idx, answerIdx: answer.idx, snippet: String(ev.text).slice(0, 100) });
    }
  }
  return { status: skips.length ? 'SKIPS-FOUND' : 'CLEAN', skips, memoryDependentTurns, firstCoreAccessIdx };
}

/** Full pipeline: read transcript for the harness, build terms, classify. Fail-open. */
export function analyzeRetrievalSkip({ projectRoot = process.cwd(), harness = 'claude-code', home = homedir(), transcriptPath = null } = {}) {
  const coreStorePresent = existsSync(join(projectRoot, '_memories')) || existsSync(join(projectRoot, 'PROJECT.md'));
  const t = readTranscript({ harness, cwd: projectRoot, home, override: transcriptPath });
  // The producer (read-transcript) emits 'implemented' (codex, tools extractable) or
  // 'n/a' (other harnesses). Any value that is neither known-good abstains, so a
  // future schema drift produces UNKNOWN instead of silently flooding false SKIPs.
  const extraction = t.meta?.codex_tool_extraction;
  const toolExtractionPending = extraction != null && extraction !== 'implemented' && extraction !== 'n/a';
  const terms = coreStorePresent ? buildProjectTerms(projectRoot) : new Set();
  const r = classifyRetrievalSkips({
    events: t.events, terms, coreStorePresent, transcriptAvailable: t.available, toolExtractionPending,
  });
  return { schema_version: SCHEMA_VERSION, harness, coreStorePresent, transcriptAvailable: t.available, termsTracked: terms.size, ...r };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`retrieval-skip: ${report.status}`);
  if (report.status === 'NO-STORE' || report.status === 'UNKNOWN') {
    lines.push(`  ${report.reason || ''}`.trimEnd());
    return lines.join('\n');
  }
  lines.push(`  memory-dependent turns: ${report.memoryDependentTurns.length} | candidate skips: ${report.skips.length}`);
  for (const s of report.skips) {
    lines.push(`  - candidate skip: "${s.term}" asked at idx ${s.userIdx}, answered at idx ${s.answerIdx} with no CORE-store access first`);
    lines.push(`      ${s.snippet}`);
  }
  lines.push(`  (candidates, not verdicts — term presence is a heuristic for memory-dependence; review before acting)`);
  return lines.join('\n');
}

// ---------- CLI ----------

function isMain() {
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}

/**
 * Index-advancing arg parse. The first BARE token is the project root — but
 * space-form flag values (`--harness codex`) are bare tokens too, so a `.find()`
 * over non-`--` tokens grabbed `codex` as the root and reported NO-STORE on a
 * directory with no `_memories/` (M4). Advancing past known value-flags fixes it.
 * Returns rawRoot un-resolved (null if none) so callers/tests stay deterministic.
 */
export function parseSkipArgs(args) {
  let rawRoot = null, harness = 'claude-code', transcriptPath = null, json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--harness') { harness = args[++i]; }
    else if (a.startsWith('--harness=')) { harness = a.split('=')[1]; }
    else if (a === '--transcript') { transcriptPath = args[++i]; }
    else if (a === '--json') { json = true; }
    else if (!a.startsWith('--')) { if (rawRoot === null) rawRoot = a; }
  }
  return { rawRoot, harness, transcriptPath, json };
}

if (isMain()) {
  const { rawRoot, harness, transcriptPath, json } = parseSkipArgs(process.argv.slice(2));
  const projectRoot = resolve(rawRoot || process.cwd());
  const report = analyzeRetrievalSkip({ projectRoot, harness, transcriptPath });
  process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report) + '\n');
}
