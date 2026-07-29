import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  auditMemoryBoundary, extractNativeEntries, formatReport, mappedNativePath,
} from '../../plugins/core/skills/core/scripts/audit-memory-boundary.mjs';

test('entry guard canonicalizes BOTH sides (consistent with sibling gates)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../plugins/core/skills/core/scripts/audit-memory-boundary.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /realpathSync\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)/,
    'one-sided guard must be gone');
  assert.match(src, /canon\(process\.argv\[1\]\) === canon\(fileURLToPath\(import\.meta\.url\)\)/,
    'both sides canonicalized');
});

// --- extractNativeEntries: native surface → sampled entries with terms ---

test('extractNativeEntries: bullet/line entries with high-signal terms', () => {
  const md = `# MEMORY
## Recent activity
- DC-64 reframed CORE as project intelligence.
- BBLens migration shipped.
- a trivial note.
`;
  const entries = extractNativeEntries(md);
  assert.ok(entries.length >= 2);
  assert.ok(entries.some((e) => e.terms.includes('DC-64')));
  assert.ok(entries.some((e) => e.terms.includes('BBLens')));
});

// --- auditMemoryBoundary (pure): native-only detection + stats ---

const coreTerms = new Set(['DC-64', 'BBLens']);

test('audit: a native entry whose terms ARE in CORE is not native-only', () => {
  const r = auditMemoryBoundary({
    nativeEntries: [{ text: 'DC-64 note', terms: ['DC-64'] }],
    coreTerms, coreText: 'DC-64 lives here',
  });
  assert.equal(r.nativeOnly.length, 0);
});

test('audit: a native entry with a strong term NOT in CORE → native-only candidate (anti-resurrection labeled)', () => {
  const r = auditMemoryBoundary({
    nativeEntries: [{ text: 'R-99 phantom risk', terms: ['R-99'] }],
    coreTerms, coreText: 'nothing relevant',
  });
  assert.equal(r.nativeOnly.length, 1);
  assert.equal(r.nativeOnly[0].terms[0], 'R-99');
  assert.match(r.nativeOnly[0].note, /anti-resurrection|do not auto-promote|candidate/i);
});

test('audit: entries with no high-signal terms are not flagged (avoid noise)', () => {
  const r = auditMemoryBoundary({
    nativeEntries: [{ text: 'a vague reflection', terms: [] }],
    coreTerms, coreText: '',
  });
  assert.equal(r.nativeOnly.length, 0);
});

test('audit: sampleSize caps how many native entries are examined; stats report the cap', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ text: `R-${i} x`, terms: [`R-${i}`] }));
  const r = auditMemoryBoundary({ nativeEntries: many, coreTerms: new Set(), coreText: '', sampleSize: 10 });
  assert.equal(r.stats.sampled, 10, 'only sampleSize entries examined');
  assert.equal(r.stats.nativeTotal, 50);
  assert.ok(r.stats.sampled < r.stats.nativeTotal, 'sampled, never swept');
});

test('audit: never mutates / never returns a promote action — read-only surface', () => {
  const r = auditMemoryBoundary({ nativeEntries: [{ text: 'R-99 x', terms: ['R-99'] }], coreTerms, coreText: '' });
  assert.ok(!('promoted' in r) && !('written' in r), 'no mutation in the result shape');
  assert.ok(Array.isArray(r.nativeOnly) && r.stats);
});

test('formatReport: read-only, names candidates + the anti-resurrection caveat', () => {
  const r = auditMemoryBoundary({ nativeEntries: [{ text: 'R-99 phantom', terms: ['R-99'] }], coreTerms, coreText: '' });
  const s = formatReport(r);
  assert.match(s, /R-99/);
  assert.match(s, /candidate/i);
  assert.match(s, /anti-resurrection|do not auto-promote|review/i);
});

test('audit: empty native surface → clean, zero candidates', () => {
  const r = auditMemoryBoundary({ nativeEntries: [], coreTerms, coreText: '' });
  assert.equal(r.nativeOnly.length, 0);
  assert.equal(r.stats.nativeTotal, 0);
});

// --- mappedNativePath: canonical slug for the default MEMORY.md location (M2) ---

test('mappedNativePath: dotted username maps dots→dashes (matches Claude projects folder)', () => {
  // The default native surface is ~/.claude/projects/<slug>/memory/MEMORY.md.
  // A slash-only encoder leaves the dot and mislocates MEMORY.md on a corporate
  // dotted username — the same dotted-username bug project-slug.mjs exists to kill.
  assert.equal(
    mappedNativePath('/Users/David.Bates28/proj', { home: '/h' }),
    '/h/.claude/projects/-Users-David-Bates28-proj/memory/MEMORY.md',
  );
});

test('the report self-declares its current-project-only scope', () => {
  const report = auditMemoryBoundary({ nativeEntries: [], coreTerms: new Set(), coreText: '' });
  assert.match(report.scope, /current project only/i);
  assert.match(report.scope, /cross-project/i, 'names what it does NOT detect');
});
