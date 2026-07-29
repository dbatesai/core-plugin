import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractCitations, buildUnitIndex, resolveCitation, runCitationResolver,
  parseFrontmatter, extractReadUnitFilenames, runStaleContextTripwire,
  buildVocabulary, runAnticipationGap, isCommandInjection, runAbsenceWithDeadline,
  runDetectors,
} from '../../plugins/core/skills/core/scripts/metrics-detectors.mjs';

// ---------------------------------------------------------------- helpers ---

function withStore(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'detstore-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [name, content] of Object.entries(
    Array.isArray(files) ? Object.fromEntries(files.map((f) => [f, '# unit\n'])) : files,
  )) writeFileSync(join(mem, name), content);
  try { return fn(mem, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function unitContent({ status = 'active', updated = '2026-01-01', stabilityClass = null } = {}) {
  const sc = stabilityClass ? `\nstability-class: ${stabilityClass}` : '';
  return `---\nid: test\ntype: decision\nstatus: ${status}\nupdated: ${updated}${sc}\n---\n# test\n`;
}

// ============================================================
// Citation resolver (existing)
// ============================================================

test('extractCitations pulls DC-XX, R-XX, and [[wikilinks]]', () => {
  const cs = extractCitations('Per DC-104 and R-5, see [[obs-foo-2026]].');
  assert.deepEqual(cs.map((c) => c.key), ['dc-104', 'risk-5', 'obs-foo-2026']);
  assert.deepEqual(cs.map((c) => c.kind), ['decision', 'risk', 'wikilink']);
});

test('buildUnitIndex derives ids + dc/risk claim-keys from filenames', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md', 'obs-foo-2026.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    assert.ok(idx.claimKeys.has('dc-104'));
    assert.ok(idx.claimKeys.has('risk-5'));
    assert.ok(idx.ids.has('obs-foo-2026'));
  });
});

test('resolveCitation: real references resolve, fabricated ones do not', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md', 'obs-foo-2026.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    assert.equal(resolveCitation({ kind: 'decision', key: 'dc-104' }, idx), true);
    assert.equal(resolveCitation({ kind: 'risk', key: 'risk-5' }, idx), true);
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-foo-2026' }, idx), true);
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-foo' }, idx), true); // prefix tolerance
    assert.equal(resolveCitation({ kind: 'decision', key: 'dc-999' }, idx), false); // fabricated
    assert.equal(resolveCitation({ kind: 'wikilink', key: 'obs-nonexistent' }, idx), false);
  });
});

test('runCitationResolver flags only the broken references in agent text', () => {
  withStore(['dc-104-harness-agnostic.md', 'risk-5-validation.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    const events = [
      { role: 'assistant', kind: 'text', text: 'Per DC-104 this holds.' },
      { role: 'assistant', kind: 'text', text: 'As DC-999 shows, and [[obs-ghost]].' },
      { role: 'user', kind: 'text', text: 'what about DC-777' }, // user text — ignored
    ];
    const broken = runCitationResolver(events, idx);
    assert.equal(broken.length, 2);
    assert.deepEqual(broken.map((b) => b.key).sort(), ['dc-999', 'obs-ghost']);
  });
});

test('runCitationResolver dedupes repeated citations', () => {
  withStore(['dc-104.md'], (mem) => {
    const idx = buildUnitIndex(mem);
    const events = [{ role: 'assistant', kind: 'text', text: 'DC-999 DC-999 DC-999' }];
    assert.equal(runCitationResolver(events, idx).length, 1, 'one unique broken ref, not three');
  });
});

// ============================================================
// Stale-context tripwire
// ============================================================

test('parseFrontmatter extracts status and updated fields', () => {
  const fm = parseFrontmatter('---\nstatus: active\nupdated: 2026-01-15\nstability-class: stable\n---\n# body');
  assert.equal(fm.status, 'active');
  assert.equal(fm.updated, '2026-01-15');
  assert.equal(fm['stability-class'], 'stable');
});

test('parseFrontmatter returns empty object when no frontmatter', () => {
  const fm = parseFrontmatter('# Just a heading\nno frontmatter here');
  assert.deepEqual(fm, {});
});

test('extractReadUnitFilenames pulls _memories/ paths from tool events', () => {
  const events = [
    { kind: 'tool', text: '{"file_path":"/home/user/proj/_memories/dc-64-foo.md"}' },
    { kind: 'tool', text: '{"file_path":"/home/user/proj/_memories/observations/obs-bar.md"}' },
    { kind: 'text', role: 'assistant', text: 'mentioned _memories/dc-64-foo.md in text' }, // text events ignored
    { kind: 'tool', text: 'no memories path here' },
  ];
  const names = extractReadUnitFilenames(events);
  assert.ok(names.includes('dc-64-foo.md'), 'flat file extracted');
  assert.ok(names.includes('observations/obs-bar.md'), 'nested file extracted');
  assert.equal(names.length, 2);
});

test('runStaleContextTripwire flags units older than threshold', () => {
  withStore(
    { 'dc-64-old.md': unitContent({ status: 'active', updated: '2020-01-01' }) },
    (mem) => {
      const events = [{ kind: 'tool', text: `_memories/dc-64-old.md` }];
      const stale = runStaleContextTripwire(events, mem, '2026-06-02', 30);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].filename, 'dc-64-old.md');
      assert.ok(stale[0].days_stale > 1000);
    },
  );
});

test('runStaleContextTripwire does not flag recently-updated units', () => {
  withStore(
    { 'dc-64-fresh.md': unitContent({ status: 'active', updated: '2026-06-01' }) },
    (mem) => {
      const events = [{ kind: 'tool', text: `_memories/dc-64-fresh.md` }];
      const stale = runStaleContextTripwire(events, mem, '2026-06-02', 30);
      assert.equal(stale.length, 0, 'unit updated yesterday should not fire');
    },
  );
});

test('runStaleContextTripwire flags a superseded (t_invalid past) unit as HIGH, regardless of age', () => {
  withStore(
    { 'dc-superseded.md': `---\nid: dc-superseded\ntype: decision\nstatus: retired\nupdated: 2026-06-01\nt_invalid: 2026-05-01\n---\n# x\n` },
    (mem) => {
      const events = [{ kind: 'tool', text: '_memories/dc-superseded.md' }];
      const stale = runStaleContextTripwire(events, mem, '2026-06-02', 30);
      assert.equal(stale.length, 1);
      assert.equal(stale[0].reason, 'superseded', 'recently-updated but superseded → flagged via t_invalid, not age');
      assert.equal(stale[0].t_invalid, '2026-05-01');
    },
  );
});

test('runAbsenceWithDeadline flags active open-questions past their by-when', () => {
  withStore(
    {
      'oq-overdue.md': `---\nid: oq-overdue\ntype: open-question\nstatus: active\nupdated: 2026-01-01\nby-when: 2026-05-01\n---\n# q\n`,
      'oq-future.md': `---\nid: oq-future\ntype: open-question\nstatus: active\nupdated: 2026-01-01\nby-when: 2026-12-01\n---\n# q\n`,
      'oq-resolved.md': `---\nid: oq-resolved\ntype: open-question\nstatus: archived\nupdated: 2026-01-01\nby-when: 2026-05-01\n---\n# q\n`,
      'dc-notq.md': `---\nid: dc-notq\ntype: decision\nstatus: active\nupdated: 2026-01-01\n---\n# d\n`,
    },
    (mem) => {
      const lapsed = runAbsenceWithDeadline(mem, '2026-06-02');
      assert.equal(lapsed.length, 1, 'only the active, past-due open-question fires');
      assert.equal(lapsed[0].filename, 'oq-overdue.md');
      assert.equal(lapsed[0].days_overdue, 32);
    },
  );
});

test('runStaleContextTripwire skips terminal/durably-correct units regardless of age', () => {
  // fixtures changed from the out-of-schema 'final'/'stable'
  withStore(
    {
      'dc-final.md': unitContent({ status: 'retired', updated: '2020-01-01' }),
      'dc-stable.md': unitContent({ status: 'active', updated: '2020-01-01', stabilityClass: 'durably-correct' }),
    },
    (mem) => {
      const events = [
        { kind: 'tool', text: '_memories/dc-final.md' },
        { kind: 'tool', text: '_memories/dc-stable.md' },
      ];
      const stale = runStaleContextTripwire(events, mem, '2026-06-02', 30);
      assert.equal(stale.length, 0, 'terminal/durably-correct units exempt from stale-context');
    },
  );
});

test('out-of-schema status final is NOT stable — an aged final unit trips stale-context', () => {
  withStore(
    { 'dc-bogus.md': unitContent({ status: 'final', updated: '2020-01-01' }) },
    (mem) => {
      const events = [{ kind: 'tool', text: '_memories/dc-bogus.md' }];
      const stale = runStaleContextTripwire(events, mem, '2026-06-02', 30);
      assert.ok(stale.length >= 1, 'out-of-schema final must not exempt the unit from the tripwire');
    },
  );
});

test('runStaleContextTripwire returns empty when no tool events touch memories', () => {
  withStore(
    { 'dc-old.md': unitContent({ status: 'active', updated: '2020-01-01' }) },
    (mem) => {
      const events = [
        { kind: 'text', role: 'assistant', text: 'no tool calls here' },
      ];
      assert.equal(runStaleContextTripwire(events, mem, '2026-06-02').length, 0);
    },
  );
});

// ============================================================
// Anticipation-gap detector
// ============================================================

test('buildVocabulary extracts meaningful tokens from unit filenames', () => {
  withStore(
    ['dc-64-reframe-project-intelligence.md', 'risk-5-validation-missing.md'],
    (mem) => {
      const vocab = buildVocabulary(mem);
      assert.ok(vocab.has('reframe'), 'substantive token kept');
      assert.ok(vocab.has('intelligence'), 'substantive token kept');
      assert.ok(vocab.has('validation'), 'substantive token kept');
      assert.ok(vocab.has('missing'), 'substantive token kept');
    },
  );
});

test('buildVocabulary filters short and stopword tokens', () => {
  withStore(['dc-64-this-that-have-with.md'], (mem) => {
    const vocab = buildVocabulary(mem);
    assert.ok(!vocab.has('this'), 'stopword filtered');
    assert.ok(!vocab.has('that'), 'stopword filtered');
    assert.ok(!vocab.has('have'), 'stopword filtered');
  });
});

test('buildVocabulary filters generic CORE-domain stopwords', () => {
  withStore(['dc-64-core-project-memory-retrieval.md'], (mem) => {
    const vocab = buildVocabulary(mem);
    assert.ok(!vocab.has('core'), 'generic domain word filtered');
    assert.ok(!vocab.has('project'), 'generic domain word filtered');
    assert.ok(!vocab.has('memory'), 'generic domain word filtered');
    assert.ok(vocab.has('retrieval'), 'distinctive term kept');
  });
});

test('buildVocabulary applies document-frequency rarity filter on a large corpus', () => {
  // 100 units all containing "common", one containing "rarewidget".
  // "common" appears in 100% of units → filtered; "rarewidget" in 1% → kept.
  const files = {};
  for (let i = 0; i < 100; i++) files[`obs-2026060${i % 10}-common-token-${i}.md`] = '# u\n';
  files['dc-99-rarewidget-distinctive.md'] = '# u\n';
  withStore(files, (mem) => {
    const vocab = buildVocabulary(mem);
    assert.ok(!vocab.has('common'), 'high document-frequency term filtered as generic');
    assert.ok(!vocab.has('token'), 'high document-frequency term filtered as generic');
    assert.ok(vocab.has('rarewidget'), 'rare distinctive term kept');
  });
});

test('runAnticipationGap does not fire on generic words against a large corpus', () => {
  const files = {};
  for (let i = 0; i < 100; i++) files[`obs-2026060${i % 10}-project-context-${i}.md`] = '# u\n';
  withStore(files, (mem) => {
    const events = [
      { role: 'user', kind: 'text', text: 'tell me about the project context and the work' },
      { role: 'assistant', kind: 'text', text: 'sure' },
    ];
    // "project", "context", "work" are all generic/high-DF → no gap fired.
    assert.equal(runAnticipationGap(events, mem).length, 0, 'generic words must not over-fire');
  });
});

test('runAnticipationGap flags turn where user introduces a vocabulary term first', () => {
  withStore(['dc-64-retrieval-ladder.md'], (mem) => {
    const events = [
      { role: 'user', kind: 'text', text: 'What about the retrieval ladder?' },
      { role: 'assistant', kind: 'text', text: 'Good question. The retrieval ladder has four tiers.' },
    ];
    const gaps = runAnticipationGap(events, mem);
    assert.equal(gaps.length, 1, 'agent never mentioned retrieval before user did');
    assert.ok(gaps[0].terms.includes('retrieval') || gaps[0].terms.includes('ladder'));
  });
});

test('runAnticipationGap does not flag when agent already mentioned the term', () => {
  withStore(['dc-64-retrieval-ladder.md'], (mem) => {
    const events = [
      // Agent bootstrap mentions retrieval before the user asks.
      { role: 'assistant', kind: 'text', text: 'The retrieval ladder is ready.' },
      { role: 'user', kind: 'text', text: 'Tell me more about the retrieval ladder.' },
      { role: 'assistant', kind: 'text', text: 'It has four tiers.' },
    ];
    const gaps = runAnticipationGap(events, mem);
    assert.equal(gaps.length, 0, 'agent mentioned retrieval first — no gap');
  });
});

test('isCommandInjection recognizes skill/command scaffold text', () => {
  assert.ok(isCommandInjection('<command-name>core:core</command-name>'));
  assert.ok(isCommandInjection('Base directory for this skill: /path/to/skill'));
  assert.ok(isCommandInjection('text with <system-reminder> in it'));
  assert.ok(!isCommandInjection('What about the retrieval ladder?'));
});

test('runAnticipationGap skips command-injection turns (the biggest over-fire source)', () => {
  withStore(['dc-64-retrieval-ladder.md', 'dc-99-anticipation-gap.md'], (mem) => {
    const events = [
      // A /command injection turn that happens to mention distinctive terms.
      { role: 'user', kind: 'text', text: '<command-name>core:core</command-name> work on retrieval and anticipation' },
      { role: 'assistant', kind: 'text', text: 'on it' },
    ];
    assert.equal(runAnticipationGap(events, mem).length, 0, 'command-injection turn must not fire a gap');
  });
});

test('runAnticipationGap returns empty when vocabulary is empty', () => {
  withStore([], (mem) => {
    const events = [
      { role: 'user', kind: 'text', text: 'anything' },
      { role: 'assistant', kind: 'text', text: 'sure' },
    ];
    assert.equal(runAnticipationGap(events, mem).length, 0);
  });
});

test('runAnticipationGap dedupes terms within a single turn', () => {
  withStore(['dc-64-retrieval-ladder.md'], (mem) => {
    const events = [
      // User says "retrieval" multiple times.
      { role: 'user', kind: 'text', text: 'retrieval retrieval retrieval retrieval' },
      { role: 'assistant', kind: 'text', text: 'ok' },
    ];
    const gaps = runAnticipationGap(events, mem);
    if (gaps.length) {
      const retrieval = gaps[0].terms.filter((t) => t === 'retrieval');
      assert.equal(retrieval.length, 1, 'deduped within a turn');
    }
  });
});

test('anticipation-gap records are stamped provisional + low severity at the source', () => {
  const home = mkdtempSync(join(tmpdir(), 'md-prov-'));
  const project = mkdtempSync(join(tmpdir(), 'md-proj-'));
  try {
    mkdirSync(join(project, '_memories'), { recursive: true });
    writeFileSync(join(project, '_memories', 'dc-64-retrieval-ladder.md'), '---\ntype: decision\n---\n# ladder\n');
    const slugDir = join(home, '.claude', 'projects', project.replace(/[/.\\:]/g, '-')); // backslash + drive-colon: Windows temp paths, matches mapProjectPathToSlug
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(join(slugDir, 'sess-d.jsonl'),
      JSON.stringify({ message: { role: 'user', content: [{ type: 'text', text: 'tell me about the retrieval plan' }] } }) + '\n' +
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'sure.' }] } }) + '\n');
    const r = runDetectors({ project, harness: 'claude-code', home, sessionId: 'sess-d', workspaceId: 'md-prov-ws', env: {} });
    assert.equal(r.status, 'OK');
    for (const rec of r.records.filter((x) => x.detector === 'anticipation-gap')) {
      assert.equal(rec.provisional, true, 'every anticipation-gap record self-declares heuristic status');
      assert.equal(rec.severity, 'low');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
