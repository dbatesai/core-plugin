import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyTurn, classifyTurns, pairTurns, isClarifying, isLadderWalk, extractAskedTerm, summarize, containsTerm,
  runClassification, buildPredicates, CLASSIFIER_VERSION, PROXY_VERSION,
} from '../../plugins/core/skills/core/scripts/classify-turns.mjs';
import { mapProjectPathToSlug } from '../../plugins/core/skills/core/scripts/project-slug.mjs';

const inCtx = (terms) => (t) => terms.includes(t);
const onDisk = (terms) => (t) => terms.includes(t);

test('isClarifying detects the agent asking instead of answering', () => {
  assert.ok(isClarifying('What is the IGM framework?'));
  assert.ok(isClarifying("I'm not familiar with that term, could you remind me?"));
  assert.ok(!isClarifying('The IGM framework aligns intention, goal, and measure.'));
});

test('isLadderWalk detects a tool touching the CORE store', () => {
  assert.ok(isLadderWalk([{ kind: 'tool', text: 'Grep _memories/ for IGM' }]));
  assert.ok(!isLadderWalk([{ kind: 'tool', text: 'Bash: ls /tmp' }]));
});

test('extractAskedTerm pulls DC-ids, [[wikilinks]], and hyphenated handles', () => {
  assert.equal(extractAskedTerm('what is DC-104 about?'), 'DC-104');
  assert.equal(extractAskedTerm('not familiar with [[dc-94-memory]]'), 'dc-94-memory');
  assert.equal(extractAskedTerm('what does register-trigger mean'), 'register-trigger');
});

test('M6: extractAskedTerm does not treat ordinary hyphenated English as a project term', () => {
  assert.equal(extractAskedTerm('should this be opt-in or always on?'), null, 'opt-in is not a project handle');
  assert.equal(extractAskedTerm('is this real-time or batched?'), null);
  // A real lowercase project term is still picked even when an English hyphenation is present.
  assert.equal(extractAskedTerm('is register-trigger opt-in?'), 'register-trigger');
});

test('M6: containsTerm matches on a word boundary, not a bare substring', () => {
  assert.equal(containsTerm('please opt-in to the beta', 'opt-in'), true);
  assert.equal(containsTerm('we adopt-inline rendering here', 'opt-in'), false, 'substring of a larger word must not match');
  assert.equal(containsTerm('see dc-104 for the rationale', 'DC-104'), true, 'case-insensitive, id with digits');
  assert.equal(containsTerm('see dc-1040 for the rationale', 'DC-104'), false, 'dc-104 must not match inside dc-1040');
});

test('DC-94a: isInContext proxy does not over-fire on a substring inside a large blob', () => {
  // The plan's exact scenario: "master" must NOT count as in-context just because
  // "speedmaster" appears somewhere in a 180KB blob. (Already fixed by M6/MET-004;
  // this locks the specific large-PROJECT.md case as a regression guard.)
  const bigDoc = 'x'.repeat(120000) + ' speedmaster ' + 'y'.repeat(60000);
  assert.equal(containsTerm(bigDoc, 'master'), false, 'substring of speedmaster must not count');
  assert.equal(containsTerm('we discussed the speedmaster today', 'speedmaster'), true, 'whole-token hit still fires');
});

test('DC-94a: PROXY_VERSION is 2 (word-boundary + read-gated, supersedes the v1 .includes proxy)', () => {
  assert.equal(PROXY_VERSION, 2);
});

test('M6: ladder walked AND returned content but the agent still asked → rec-fail-tier-0 (discriminator wired)', () => {
  const longResult = 'Read _memories/dc-104.md ' + 'x'.repeat(100); // >80 chars on a ladder surface
  const r = classifyTurn(
    { assistantText: 'What is DC-104? Remind me.', toolEvents: [{ kind: 'tool', text: longResult }] },
    { isInContext: inCtx([]), isOnDisk: onDisk(['DC-104']) });
  assert.equal(r.state, 'rec-fail-tier-0', 'a successful ladder return means the content was effectively in context');
  assert.equal(r.evidence.found, 'context-via-ladder');
});

// The six states — the load-bearing classification logic.
test('tier-0-win: no clarifying question, no ladder walk', () => {
  const r = classifyTurn({ assistantText: 'The answer is X, per PROJECT.md.', toolEvents: [] },
    { isInContext: inCtx([]), isOnDisk: onDisk([]) });
  assert.equal(r.state, 'tier-0-win');
});

test('tier-1-3-win: no clarifying question, ladder walk fired', () => {
  const r = classifyTurn(
    { assistantText: 'Found it in the units.', toolEvents: [{ kind: 'tool', text: 'Read _memories/dc-104.md' }] },
    { isInContext: inCtx([]), isOnDisk: onDisk([]) });
  assert.equal(r.state, 'tier-1-3-win');
});

test('rec-fail-tier-0: agent asked; term WAS in context (the headline failure)', () => {
  const r = classifyTurn(
    { assistantText: 'What is DC-104? I am not familiar with it.', toolEvents: [] },
    { isInContext: inCtx(['DC-104']), isOnDisk: onDisk(['DC-104']) });
  assert.equal(r.state, 'rec-fail-tier-0');
  assert.equal(r.evidence.term, 'DC-104');
});

test('rec-fail-tier-1-3-trigger: agent asked; term on disk but no ladder walk', () => {
  const r = classifyTurn(
    { assistantText: 'What is DC-104? Could you remind me?', toolEvents: [] },
    { isInContext: inCtx([]), isOnDisk: onDisk(['DC-104']) });
  assert.equal(r.state, 'rec-fail-tier-1-3-trigger');
});

test('mechanics-failure: agent walked the ladder but it came back empty', () => {
  const r = classifyTurn(
    { assistantText: 'What is DC-104? I could not find it.', toolEvents: [{ kind: 'tool', text: 'Grep _memories/ DC-104' }] },
    { isInContext: inCtx([]), isOnDisk: onDisk(['DC-104']) });
  assert.equal(r.state, 'mechanics-failure');
});

test('capture-miss: agent asked; term genuinely nowhere', () => {
  const r = classifyTurn(
    { assistantText: 'What is Frobnicator-9? Not familiar.', toolEvents: [] },
    { isInContext: inCtx([]), isOnDisk: onDisk([]) });
  assert.equal(r.state, 'capture-miss');
});

test('pairTurns groups user prompt + following assistant text/tools', () => {
  const events = [
    { role: 'user', kind: 'text', text: 'q1' },
    { role: 'assistant', kind: 'tool', text: 'Read _memories/x.md' },
    { role: 'assistant', kind: 'text', text: 'a1' },
    { role: 'user', kind: 'text', text: 'q2' },
    { role: 'assistant', kind: 'text', text: 'a2' },
  ];
  const turns = pairTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].userText, 'q1');
  assert.equal(turns[0].toolEvents.length, 1);
  assert.match(turns[0].assistantText, /a1/);
});

test('classifyTurns + summarize produce a state distribution', () => {
  const events = [
    { role: 'user', kind: 'text', text: 'q1' },
    { role: 'assistant', kind: 'text', text: 'plain answer' },
    { role: 'user', kind: 'text', text: 'q2' },
    { role: 'assistant', kind: 'text', text: 'What is DC-104? not familiar' },
  ];
  const classified = classifyTurns(events, { isInContext: inCtx(['DC-104']), isOnDisk: onDisk(['DC-104']) });
  const s = summarize(classified);
  assert.equal(s.total, 2);
  assert.equal(s.distribution['tier-0-win'], 1);
  assert.equal(s.distribution['rec-fail-tier-0'], 1);
});

test('MET-008: runClassification classifies the session passed in, not the newest transcript', () => {
  const home = mkdtempSync(join(tmpdir(), 'ct-sid-'));
  const project = mkdtempSync(join(tmpdir(), 'ct-proj-'));
  try {
    const dir = join(home, '.claude', 'projects', mapProjectPathToSlug(project));
    mkdirSync(dir, { recursive: true });
    const turn = (u, a) => [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: u }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: a }] } }),
    ].join('\n') + '\n';
    // The session being closed: ONE turn.
    writeFileSync(join(dir, 'sess-mine.jsonl'), turn('hello', 'The answer is 42.'));
    // A newer session already started: THREE turns. mtime-latest would pick this.
    writeFileSync(join(dir, 'sess-newer.jsonl'),
      turn('a', 'r1.') + turn('b', 'r2.') + turn('c', 'r3.'));
    const r = runClassification({ project, harness: 'claude-code', home, sessionId: 'sess-mine', workspaceId: 'ct-test-ws', env: {} });
    assert.equal(r.status, 'OK');
    assert.equal(r.transcript_resolution, 'session-id');
    assert.equal(r.total, 1, 'classified the 1-turn session, not the 3-turn newer one');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test('DC-94a: each classified record is stamped with proxy_version', () => {
  const home = mkdtempSync(join(tmpdir(), 'ct-pv-'));
  const project = mkdtempSync(join(tmpdir(), 'ct-pvp-'));
  try {
    const dir = join(home, '.claude', 'projects', mapProjectPathToSlug(project));
    mkdirSync(dir, { recursive: true });
    const turn = (u, a) => [
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: u }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: a }] } }),
    ].join('\n') + '\n';
    writeFileSync(join(dir, 'sess-pv.jsonl'), turn('hello', 'The answer is 42.'));
    const r = runClassification({ project, harness: 'claude-code', home, sessionId: 'sess-pv', workspaceId: 'ct-pv-ws', today: '2026-06-01', env: {} });
    assert.equal(r.status, 'OK');
    assert.ok(r.records.length >= 1);
    assert.equal(r.records[0].proxy_version, PROXY_VERSION, 'record carries the proxy version so calibration can invalidate across a proxy change');
    assert.equal(r.records[0].harness, 'claude-code', 'calibration never pools anonymous harness rows');
    assert.equal(r.records[0].turn_evidence.user_text, 'hello');
    assert.equal(r.records[0].turn_evidence.assistant_text, 'The answer is 42.');
    const classifiedFile = join(home, '.core', 'workspaces', 'ct-pv-ws', 'metrics', 'classified', '2026-06-01.jsonl');
    // Windows: chmod cannot express owner-only (only toggles read-only), so
    // mode stays 0o666 regardless -- structurally unsatisfiable there, not a
    // regression (Meridian, 2026-07-21).
    if (process.platform !== 'win32') {
      assert.equal(statSync(classifiedFile).mode & 0o777, 0o600, 'raw calibration evidence is owner-only');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

function predicateFixture() {
  const project = mkdtempSync(join(tmpdir(), 'ct-pred-'));
  writeFileSync(join(project, 'CLAUDE.md'), 'Project rules mention alpha-injected-term here.\n');
  writeFileSync(join(project, 'PROJECT.md'), '# Synthesis\nThe beta-disk-term decision lives here.\n');
  mkdirSync(join(project, '_memories'), { recursive: true });
  writeFileSync(join(project, '_memories', 'dc-9-gamma-thing.md'),
    '---\ntype: decision\ntopics: delta-frontmatter-term\n---\n# Gamma unit about epsilon-heading-term\n\nbody\n');
  return project;
}

test('MET-004: PROJECT.md is NOT in-context unless the transcript shows it was read', () => {
  const project = predicateFixture();
  try {
    const cold = buildPredicates(project, { events: [] });
    assert.equal(cold.isInContext('alpha-injected-term'), true, 'harness-injected CLAUDE.md counts');
    assert.equal(cold.isInContext('beta-disk-term'), false, 'unread PROJECT.md must not count as context');
    assert.equal(cold.isOnDisk('beta-disk-term'), true, 'PROJECT.md content counts as on-disk');
    const warm = buildPredicates(project, { events: [{ kind: 'tool', text: `Read ${project}/PROJECT.md` }] });
    assert.equal(warm.isInContext('beta-disk-term'), true, 'a transcript-evidenced read promotes it to context');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('MET-005: a term in a unit frontmatter or first heading (not its filename) reads as on-disk', () => {
  const project = predicateFixture();
  try {
    const p = buildPredicates(project, { events: [] });
    assert.equal(p.isOnDisk('delta-frontmatter-term'), true, 'frontmatter topics are indexed');
    assert.equal(p.isOnDisk('epsilon-heading-term'), true, 'H1 headings are indexed');
    assert.equal(p.isOnDisk('zeta-nowhere-term'), false, 'absent terms still read as nowhere');
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('MET-004/005: predicate changes bumped the classifier version (R-1 calibration invalidation)', () => {
  assert.notEqual(CLASSIFIER_VERSION, '0.2.0');
  assert.equal(CLASSIFIER_VERSION, '0.3.0');
});

test('classified-store retention: date files older than the window are deleted, the window is validated', async () => {
  const { runClassifiedRetention } = await import('../../plugins/core/skills/core/scripts/classify-turns.mjs');
  const home = mkdtempSync(join(tmpdir(), 'classified-retention-'));
  try {
    const dir = join(home, '.core', 'workspaces', 'ws-x', 'metrics', 'classified');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-01-01.jsonl'), '{"state":"ok"}\n');
    writeFileSync(join(dir, '2026-07-27.jsonl'), '{"state":"ok"}\n');

    const bad = runClassifiedRetention('.', { workspaceId: 'ws-x', home, windowDays: -5, now: new Date('2026-07-28T00:00:00Z') });
    assert.equal(bad.ran, false, 'a non-positive window must refuse before naming candidates');

    const r = runClassifiedRetention('.', { workspaceId: 'ws-x', home, windowDays: 30, now: new Date('2026-07-28T00:00:00Z') });
    assert.ok(r.ran);
    assert.ok(!existsSync(join(dir, '2026-01-01.jsonl')), 'the stale file is deleted');
    assert.ok(existsSync(join(dir, '2026-07-27.jsonl')), 'the in-window file stays');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
