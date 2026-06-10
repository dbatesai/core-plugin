/**
 * audit-memory-boundary.mjs — v3.0 memory-authority boundary audit.
 *
 * Native harness memory (Claude MEMORY.md / cross-project ~/.claude/memory, Codex
 * ~/.codex/memories) and CORE's unit store drift apart over time. This surfaces the
 * HEALTH of that boundary — read-only — so the user can act, without ever silently
 * merging the two.
 *
 * The hard invariant (DC-83 user-control / anti-resurrection): a native entry absent
 * from CORE is NOT automatically a missing unit — it may be a fact the user DELETED from
 * CORE, and deleted facts stay deleted. So this is:
 *   - SAMPLED, never swept (a bounded sample; never iterate-and-promote)
 *   - SURFACE-CANDIDATES, never auto-promote (promotion stays on the graduation path,
 *     which already respects anti-resurrection)
 *   - read-only — no mutation, no release gate.
 *
 * v1 reports native-only candidates (sampled, anti-resurrection-labeled) + boundary
 * stats. Per the design Q3 (docs/specs/2026-05-30-audit-memory-boundary-design.md),
 * content-CONFLICT detection is DEFERRED — it's the noisiest signal and needs Hale's
 * matcher decision; shipping a noisy conflict flag would create resurrection pressure.
 * Match function is deterministic high-signal-term overlap (Q1 lean), so paraphrases can
 * read as "absent" — which is exactly why output is candidates, not a verdict.
 *
 * SCOPE (MET-009): current-project-only by design. The audit reads only this
 * project's native surface and this project's unit store, so it cannot detect
 * cross-project contamination (a fact from Project A landing in Project B's
 * MEMORY.md). If that becomes a real concern, the right tool is a separate
 * audit scanning ALL projects' MEMORY.md files for overlapping high-signal
 * terms — not a widening of this one.
 *
 * The native surface is provided by the caller (resolved per harness via the
 * read-auto-memory adapter, DC-75) so this stays harness-agnostic.
 *
 * Per DC-77 ships as a script; per DC-80 .mjs only.
 *
 * CLI: node audit-memory-boundary.mjs <project-root> [--native <MEMORY.md>] [--sample N] [--json]
 */

import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapProjectPathToSlug } from './project-slug.mjs';

export const SCHEMA_VERSION = '1.0.0';
export const DEFAULT_SAMPLE = 25;

/**
 * Default native-memory surface for a project on Claude Code:
 * ~/.claude/projects/<canonical-slug>/memory/MEMORY.md. Uses the canonical
 * mapProjectPathToSlug so a dotted corporate username encodes dots→dashes and
 * matches the real folder (the dotted-username bug project-slug.mjs kills).
 */
export function mappedNativePath(projectRoot, { home = homedir() } = {}) {
  return join(home, '.claude', 'projects', mapProjectPathToSlug(String(projectRoot)), 'memory', 'MEMORY.md');
}

// High-signal identifier shapes (mirrors analyze-retrieval-skip's term policy): DC-/R-
// ids, acronyms, CamelCase product names. Low-signal prose never becomes a term, so a
// vague native reflection is never flagged.
function highSignalTerms(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/[A-Za-z][A-Za-z0-9-]*/g)) {
    const t = m[0];
    if (/^(?:DC|R)-\d+$/.test(t)) out.add(normId(t));
    else if (/^[A-Z]{2,6}$/.test(t)) out.add(t);                 // pure acronym: IGM, PRD, CORE
    else if (/[a-z][A-Z]/.test(t) || /^[A-Z]{2,}[a-z]/.test(t)) out.add(t); // mixed-case product: camelCase, iPhone, BBLens (NOT "Quality")
  }
  return [...out];
}
function normId(t) { const m = t.match(/^(dc|r)-(\d+)$/i); return m ? `${m[1].toUpperCase()}-${m[2]}` : t; }

// Turn a native-memory surface (markdown) into entries (bullet/non-empty lines) with their
// high-signal terms. Headings and term-less lines are dropped (no audit value).
export function extractNativeEntries(content) {
  const entries = [];
  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const terms = highSignalTerms(line);
    if (terms.length) entries.push({ text: line.slice(0, 160), terms });
  }
  return entries;
}

const ANTI_RESURRECTION_NOTE = 'candidate — may be intentionally absent from CORE (anti-resurrection); review, do not auto-promote';

// Pure: which sampled native entries have NO high-signal term represented in CORE.
export function auditMemoryBoundary({ nativeEntries = [], coreTerms = new Set(), coreText = '', sampleSize = DEFAULT_SAMPLE }) {
  const sample = nativeEntries.slice(0, sampleSize);
  const nativeOnly = [];
  for (const e of sample) {
    if (!e.terms || e.terms.length === 0) continue; // no high-signal term → not audit-relevant
    const representedInCore = e.terms.some((t) => coreTerms.has(t) || (coreText && coreText.includes(t)));
    if (!representedInCore) nativeOnly.push({ text: e.text, terms: e.terms, note: ANTI_RESURRECTION_NOTE });
  }
  return {
    schema_version: SCHEMA_VERSION,
    scope: 'current project only — audits this project\'s native memory against this project\'s CORE store; cross-project contamination (Project A facts in Project B\'s MEMORY.md) is out of scope and needs a separate all-projects scan',
    nativeOnly,
    stats: { nativeTotal: nativeEntries.length, sampled: sample.length, withTerms: sample.filter((e) => e.terms && e.terms.length).length, nativeOnly: nativeOnly.length },
    conflict_detection: 'deferred — see design Q3 (too noisy without a stronger matcher)',
  };
}

// CORE-side terms: high-signal tokens from unit filenames + PROJECT.md.
function loadCoreTerms(projectRoot) {
  const terms = new Set();
  let coreText = '';
  const memDir = join(projectRoot, '_memories');
  const walk = (dir) => {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('archive')) walk(p); }
      else if (e.name.endsWith('.md')) { try { const c = readFileSync(p, 'utf8'); coreText += '\n' + c; for (const t of highSignalTerms(c)) terms.add(t); } catch { /* skip */ } }
    }
  };
  walk(memDir);
  try { const pm = readFileSync(join(projectRoot, 'PROJECT.md'), 'utf8'); coreText += '\n' + pm; for (const t of highSignalTerms(pm)) terms.add(t); } catch { /* none */ }
  return { coreTerms: terms, coreText };
}

export function formatReport(report) {
  const lines = [`memory-boundary: ${report.nativeOnly.length} native-only candidate(s) / ${report.stats.sampled} sampled of ${report.stats.nativeTotal} native entries`];
  for (const c of report.nativeOnly) lines.push(`  - [${c.terms.join(', ')}] ${c.text}\n      ${c.note}`);
  lines.push('  (read-only; native-only ≠ missing unit — could be a deleted fact. conflict detection deferred. review before any graduation.)');
  return lines.join('\n');
}

// Canonicalize BOTH sides so a symlinked/virtualized install doesn't make the
// CLI silently no-op (read-only audit, so low-stakes, but kept consistent with
// its sibling gates).
function isMain() { try { const canon = (p) => realpathSync(p); return canon(process.argv[1]) === canon(fileURLToPath(import.meta.url)); } catch { return false; } }

if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
  const projectRoot = resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  // Default native surface on Claude Code: the project's auto-memory MEMORY.md.
  const nativePath = opt('native') || mappedNativePath(projectRoot);
  const nativeContent = existsSync(nativePath) ? readFileSync(nativePath, 'utf8') : '';
  const { coreTerms, coreText } = loadCoreTerms(projectRoot);
  const report = auditMemoryBoundary({ nativeEntries: extractNativeEntries(nativeContent), coreTerms, coreText, sampleSize: Number(opt('sample')) || DEFAULT_SAMPLE });
  process.stdout.write((args.includes('--json') ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n');
}
