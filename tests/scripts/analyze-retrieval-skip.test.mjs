import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyRetrievalSkips, buildProjectTerms, formatReport,
} from '../../plugins/core/skills/core/scripts/analyze-retrieval-skip.mjs';

// Transcript events use the read-transcript shape: { idx, kind:'text'|'tool', role, name?, text }.
const userT = (idx, text) => ({ idx, kind: 'text', role: 'user', text });
const asstT = (idx, text) => ({ idx, kind: 'text', role: 'assistant', text });
const tool = (idx, name, text) => ({ idx, kind: 'tool', role: 'assistant', name, text });

const TERMS = new Set(['IGM', 'DC-64', 'BBLens']);

// --- classifyRetrievalSkips: the behavioral ordering signal ---

test('SKIP: memory-dependent user turn answered with NO preceding CORE-store access', () => {
  const events = [
    userT(1, 'what does IGM mean for this project?'),
    asstT(2, 'IGM is the intention/goal/measure frame...'),
  ];
  const r = classifyRetrievalSkips({ events, terms: TERMS });
  assert.equal(r.status, 'SKIPS-FOUND');
  assert.equal(r.skips.length, 1);
  assert.equal(r.skips[0].term, 'IGM');
  assert.equal(r.skips[0].userIdx, 1);
  assert.equal(r.skips[0].answerIdx, 2);
});

test('CLEAN: a CORE-store Grep before the answer clears the turn', () => {
  const events = [
    userT(1, 'what does IGM mean?'),
    tool(2, 'Grep', JSON.stringify({ pattern: 'IGM', path: '_memories/' })),
    asstT(3, 'Per _memories/, IGM is...'),
  ];
  const r = classifyRetrievalSkips({ events, terms: TERMS });
  assert.equal(r.status, 'CLEAN');
  assert.equal(r.skips.length, 0);
});

test('CLEAN: a Read of PROJECT.md before the answer clears the turn', () => {
  const events = [
    userT(1, 'remind me about DC-64'),
    tool(2, 'Read', JSON.stringify({ file_path: '/p/PROJECT.md' })),
    asstT(3, 'DC-64 reframed CORE as project intelligence...'),
  ];
  assert.equal(classifyRetrievalSkips({ events, terms: TERMS }).status, 'CLEAN');
});

test('no false positive: user turn with no project term is not memory-dependent', () => {
  const events = [userT(1, 'can you fix this typo?'), asstT(2, 'done')];
  const r = classifyRetrievalSkips({ events, terms: TERMS });
  assert.equal(r.status, 'CLEAN');
  assert.equal(r.memoryDependentTurns.length, 0);
});

test('unanswered memory-dependent turn is NOT flagged (no answer to judge)', () => {
  const events = [userT(1, 'tell me about BBLens')];
  assert.equal(classifyRetrievalSkips({ events, terms: TERMS }).skips.length, 0);
});

test('no CORE store present → NO-STORE, nothing to skip', () => {
  const events = [userT(1, 'about IGM'), asstT(2, 'x')];
  const r = classifyRetrievalSkips({ events, terms: TERMS, coreStorePresent: false });
  assert.equal(r.status, 'NO-STORE');
  assert.equal(r.skips.length, 0);
});

test('transcript unavailable → UNKNOWN (cannot judge)', () => {
  const r = classifyRetrievalSkips({ events: [], terms: TERMS, transcriptAvailable: false });
  assert.equal(r.status, 'UNKNOWN');
});

test('tool extraction pending (Codex) → UNKNOWN, never a false skip', () => {
  // Without tool visibility we cannot prove the store was NOT reached → must abstain.
  const events = [userT(1, 'about IGM'), asstT(2, 'x')];
  const r = classifyRetrievalSkips({ events, terms: TERMS, toolExtractionPending: true });
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.skips.length, 0);
});

test('multiple turns: one skip then a load, later term-turn is clean', () => {
  const events = [
    userT(1, 'what is IGM?'),          // skip — no access yet
    asstT(2, 'igm answer'),
    tool(3, 'Grep', '_memories/ DC-64'),
    userT(4, 'and DC-64?'),
    asstT(5, 'dc-64 answer'),          // clean — store reached at idx 3
  ];
  const r = classifyRetrievalSkips({ events, terms: TERMS });
  assert.equal(r.skips.length, 1);
  assert.equal(r.skips[0].userIdx, 1);
});

// Real-corpus false-positive class caught on the live smoke (session 56): an injected
// skill prompt / system-reminder is a huge "user" turn full of project terms but is NOT
// a question — and its content is already in-context, so it is not store-dependent.
test('no false positive: skill-scaffolding turn is not memory-dependent', () => {
  const events = [
    userT(1, 'Base directory for this skill: /x\n<command-name>/core</command-name>\nThis mentions IGM and DC-64.'),
    asstT(2, 'ok'),
  ];
  const r = classifyRetrievalSkips({ events, terms: TERMS });
  assert.equal(r.memoryDependentTurns.length, 0, 'scaffolding turn excluded');
  assert.equal(r.skips.length, 0);
});

test('no false positive: oversized context-laden turn is not memory-dependent', () => {
  const big = 'IGM '.repeat(2000); // >4000 chars — the content is already in the turn
  const r = classifyRetrievalSkips({ events: [userT(1, big), asstT(2, 'ok')], terms: TERMS });
  assert.equal(r.skips.length, 0);
});

// --- buildProjectTerms: conservative, high-signal term set ---

test('buildProjectTerms: extracts DC/R ids, acronyms, product names; skips common words', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  try {
    mkdirSync(join(root, '_memories'), { recursive: true });
    writeFileSync(join(root, '_memories', 'dc-64-reframe.md'),
      '---\ntopics: [project-intelligence, igm-framework]\n---\n# DC-64 reframe\nCORE is project intelligence.\n');
    writeFileSync(join(root, '_memories', 'risk-17-anchoring.md'),
      '---\ntopics: [anti-anchoring]\n---\n# R-17 trust-based\n');
    const terms = buildProjectTerms(root);
    assert.ok(terms.has('DC-64'), 'DC id captured');
    assert.ok(terms.has('R-17'), 'R id captured');
    // multi-word / hyphenated topic phrases captured
    assert.ok([...terms].some((t) => t.toLowerCase() === 'igm-framework' || t.toLowerCase() === 'anti-anchoring'));
    // common english words are NOT terms
    assert.ok(!terms.has('is'));
    assert.ok(!terms.has('project'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('buildProjectTerms: excludes the project own name (ambient self-reference)', () => {
  const root = mkdtempSync(join(tmpdir(), 'rs-'));
  try {
    mkdirSync(join(root, '_memories'), { recursive: true });
    writeFileSync(join(root, 'workspace.json'), JSON.stringify({ name: 'ACME Platform', workspace_id: 'acme' }));
    writeFileSync(join(root, '_memories', 'note.md'), '# ACME overview\nACME uses IGM. See DC-64.\n');
    const terms = buildProjectTerms(root);
    assert.ok(!terms.has('ACME'), 'project self-name (acronym-shaped) excluded as ambient');
    assert.ok(terms.has('IGM') && terms.has('DC-64'), 'real terms still captured');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('formatReport: human-readable, names the candidates and the honesty caveat', () => {
  const report = { status: 'SKIPS-FOUND', coreStorePresent: true, transcriptAvailable: true,
    skips: [{ term: 'IGM', userIdx: 1, answerIdx: 2, snippet: 'what does IGM mean' }],
    memoryDependentTurns: [1], firstCoreAccessIdx: null };
  const s = formatReport(report);
  assert.match(s, /IGM/);
  assert.match(s, /candidate/i); // honest framing — candidates, not verdicts
});
