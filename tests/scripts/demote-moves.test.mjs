import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyBullet, extractMostRecentDate, parseBullets, extractMovesSection, demoteMoves,
  SIZE_PRESSURE_AGE_DAYS,
} from '../../plugins/core/skills/core/scripts/demote-moves.mjs';
import { PROJECT_MD_CAP_BYTES } from '../../plugins/core/skills/core/scripts/compact-project.mjs';
import { stampCreatedBaseline } from '../../plugins/core/skills/core/scripts/lifecycle-detect.mjs';

const TODAY = '2026-06-02';

function bullet(text) {
  return parseBullets(text)[0];
}

// Establish PROJECT.md's creation baseline the way the render step now does — a
// no-baseline PROJECT.md fails closed, so a demote
// writer only proceeds against a file CORE has stamped at creation.
function stampPm(dir) {
  const home = join(dir, 'home');
  mkdirSync(join(home, '.core'), { recursive: true });
  stampCreatedBaseline(dir, join(dir, 'PROJECT.md'), { kind: 'project', home });
}

function scratchProject(units = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'demote-moves-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [id, fm] of Object.entries(units)) {
    const lines = ['---', `id: ${id}`];
    for (const [k, v] of Object.entries(fm)) lines.push(`${k}: ${v}`);
    lines.push('---', '', `# ${id}`, '');
    writeFileSync(join(mem, `${id}.md`), lines.join('\n'));
  }
  return dir;
}

// ---------- extractMostRecentDate ----------

test('extractMostRecentDate returns the latest anchored date in the text', () => {
  assert.equal(extractMostRecentDate('shipped 2026-05-01, patched 2026-05-27'), '2026-05-27');
});

test('extractMostRecentDate returns null when no date present', () => {
  assert.equal(extractMostRecentDate('Plugin release workflow complete'), null);
});

test('low: extractMostRecentDate rejects an impossible calendar date instead of rolling it forward', () => {
  // 2026-02-30 passes a bare 1-31 day check but is not a real date; the old code
  // accepted it and new Date() rolled it to Mar 2, yielding a wrong age.
  assert.equal(extractMostRecentDate('closed 2026-02-30'), null, 'Feb 30 is not a date');
  assert.equal(extractMostRecentDate('done 2025-13-01'), null, 'month 13 is not a date');
  // a real date alongside an impossible one still returns the real one
  assert.equal(extractMostRecentDate('shipped 2026-02-30, really 2026-02-27'), '2026-02-27');
});

test('extractMostRecentDate ignores dates embedded in wikilinks and obs-ids', () => {
  // The only "date" here is inside a unit reference — not a completion date.
  assert.equal(extractMostRecentDate('done [[obs-foo-2026-05-20]] and obs-bar-2026-05-21'), null);
});

test('extractMostRecentDate rejects impossible month/day', () => {
  assert.equal(extractMostRecentDate('ref 2026-13-40 only'), null);
});

// ---------- loosened default gate ----------

test('completed item with an old bullet-text date demotes regardless of backing units', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **v2.1.0 shipped 2026-04-01** — release workflow validated.');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'demote');
  assert.equal(r.ageSource, 'bullet-text');
  assert.ok(r.ageDays >= 30);
});

test('completed item demotes even when its cited unit is STILL ACTIVE (the citation-discipline gap fix)', () => {
  const dir = scratchProject({ 'dc-94-thing': { status: 'active', updated: '2026-06-01' } });
  const b = bullet('- [x] **DC-94 external critique shipped 2026-04-10** — see `dc-94-thing`.');
  const r = classifyBullet(b, dir, { today: TODAY });
  // Old strict gate kept this as 'cited-unit-still-active'; loosened gate demotes on the text date.
  assert.equal(r.decision, 'demote');
  assert.equal(r.ageSource, 'bullet-text');
});

test('completed item with no citation but an old date demotes (no-backing-units no longer blocks)', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **Rename a skill 2026-03-15** — mechanical, no unit.');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'demote');
});

test('completed item with a recent date is kept (too-recent)', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **Shipped 2026-06-01** — yesterday.');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'keep');
  assert.equal(r.reason, 'too-recent');
});

test('completed item with no date and no datable unit is kept (no-age-signal — never demote a possibly-recent item)', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **Did a thing** — no date anywhere.');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'keep');
  assert.equal(r.reason, 'no-age-signal');
});

test('falls back to backing-unit dates when the bullet carries no date', () => {
  const dir = scratchProject({ 'dc-50-old': { status: 'archived', updated: '2026-03-01' } });
  const b = bullet('- [x] **Closed an old decision** — see `dc-50-old`.');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'demote');
  assert.equal(r.ageSource, 'backing-unit');
});

test('active [ ] and partial [~] items are never demoted', () => {
  const dir = scratchProject();
  assert.equal(classifyBullet(bullet('- [ ] **Active work 2026-01-01**'), dir, { today: TODAY }).decision, 'keep');
  assert.equal(classifyBullet(bullet('- [~] **Partial work 2026-01-01**'), dir, { today: TODAY }).decision, 'keep');
});

// ---------- --strict restores the conservative gate ----------

test('strict mode keeps a completed item whose cited unit is still active', () => {
  const dir = scratchProject({ 'dc-94-thing': { status: 'active', updated: '2026-03-01' } });
  const b = bullet('- [x] **Old item 2026-03-01** — see `dc-94-thing`.');
  assert.equal(classifyBullet(b, dir, { today: TODAY, strict: true }).reason, 'cited-unit-still-active');
  // ...but the loosened default demotes the same bullet.
  assert.equal(classifyBullet(b, dir, { today: TODAY }).decision, 'demote');
});

test('strict mode keeps a completed item with no backing-unit citation', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **No-unit item 2026-03-01**');
  assert.equal(classifyBullet(b, dir, { today: TODAY, strict: true }).reason, 'no-backing-units');
});

// ---------- end-to-end demoteMoves writes archive + stub ----------

test('demoteMoves moves an aged completed bullet to PROJECT-ARCHIVE.md and leaves a stub', () => {
  const dir = scratchProject();
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '### Active', '',
    '- [x] **Shipped long ago 2026-03-01** — done.',
    '- [ ] **Still active** — keep me.', '',
    '## Notes', '', 'end',
  ].join('\n'));
  stampPm(dir);

  const stats = demoteMoves(dir, { today: TODAY });
  assert.equal(stats.demoted, 1);
  assert.equal(stats.kept, 1);

  const project = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
  assert.ok(/→ see `PROJECT-ARCHIVE\.md §Moves 2026-06-02`/.test(project), 'stub pointer left behind');
  assert.ok(/Still active/.test(project), 'active item untouched');

  assert.ok(existsSync(join(dir, 'PROJECT-ARCHIVE.md')), 'archive file created');
  const archive = readFileSync(join(dir, 'PROJECT-ARCHIVE.md'), 'utf8');
  assert.ok(/Shipped long ago 2026-03-01/.test(archive), 'full bullet preserved in archive');
});

test('demoteMoves dry-run reports candidates without writing', () => {
  const dir = scratchProject();
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '- [x] **Old thing 2026-03-01**', '', '## Notes', '',
  ].join('\n'));
  const stats = demoteMoves(dir, { today: TODAY, dryRun: true });
  assert.equal(stats.demoted, 1);
  assert.equal(existsSync(join(dir, 'PROJECT-ARCHIVE.md')), false, 'dry-run writes nothing');
});

test('extractMovesSection isolates the Moves body', () => {
  const text = '## State\n\nx\n\n## Moves\n\n- [x] a\n\n## Notes\n\ny';
  const m = extractMovesSection(text);
  assert.ok(/- \[x\] a/.test(m));
  assert.ok(!/## Notes/.test(m));
});

// ---------- Adversarial-review fixes (2026-06-02d) ----------

test('a demotion stub is never re-demoted (already-stubbed) — fixes the HIGH idempotency bug', () => {
  const dir = scratchProject();
  const b = bullet('- [x] **Shipped long ago 2026-03-01** → see `PROJECT-ARCHIVE.md §Moves 2026-04-01`');
  const r = classifyBullet(b, dir, { today: TODAY });
  assert.equal(r.decision, 'keep');
  assert.equal(r.reason, 'already-stubbed');
});

test('extractMostRecentDate ignores citation, backtick, and future dates', () => {
  // (DC-106, date) is this project's citation style — the date is the unit's, not the work's.
  assert.equal(extractMostRecentDate('Closed the loop (DC-106, 2026-06-01)', TODAY), null);
  assert.equal(extractMostRecentDate('bumped `cfg-2026-09-01`', TODAY), null);          // backtick span
  assert.equal(extractMostRecentDate('target ship 2099-01-01', TODAY), null);            // future
  assert.equal(extractMostRecentDate('done 2026-03-01, target 2099-01-01', TODAY), '2026-03-01'); // past wins over future
});

test('classifyBullet keeps an item whose only date is a leaked citation (no-age-signal)', () => {
  const dir = scratchProject();
  const r = classifyBullet(bullet('- [x] **Did a thing** — see (DC-106, 2026-01-01)'), dir, { today: TODAY });
  assert.equal(r.decision, 'keep');
  assert.equal(r.reason, 'no-age-signal');
});

function projectWithAgedClosed(n) {
  const dir = scratchProject();
  const lines = ['# P', '', '## Moves', '', '### Active', ''];
  for (let i = 0; i < n; i++) lines.push(`- [x] **Item ${i} shipped 2026-03-01** — done.`);
  lines.push('', '## Notes', '', 'end');
  writeFileSync(join(dir, 'PROJECT.md'), lines.join('\n'));
  stampPm(dir);
  return dir;
}

test('large batch (>=20) is HELD — nothing written — until --apply-large-batch', () => {
  const dir = projectWithAgedClosed(22);
  try {
    const held = demoteMoves(dir, { today: TODAY });
    assert.equal(held.held, true);
    assert.equal(held.demoted, 22);
    assert.equal(existsSync(join(dir, 'PROJECT-ARCHIVE.md')), false, 'held batch writes nothing');
    const applied = demoteMoves(dir, { today: TODAY, applyLargeBatch: true });
    assert.ok(!applied.held);
    assert.ok(existsSync(join(dir, 'PROJECT-ARCHIVE.md')), 'apply-large-batch writes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('multi-bullet demotion preserves an adjacent kept bullet (rewriteMovesWithStubs surgery)', () => {
  const dir = scratchProject();
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '### Active', '',
    '- [x] **Old A 2026-03-01** — done.',
    '- [ ] **Active keep** — keep me.',
    '- [x] **Old B 2026-03-02** — done.',
    '', '## Notes', '', 'end',
  ].join('\n'));
  stampPm(dir);
  try {
    const stats = demoteMoves(dir, { today: TODAY });
    assert.equal(stats.demoted, 2);
    const project = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.ok(/Active keep/.test(project), 'adjacent active bullet survives between two demotions');
    assert.equal((project.match(/→ see `PROJECT-ARCHIVE/g) || []).length, 2, 'two stubs left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--strict end-to-end keeps a cited-active item that the loosened default demotes', () => {
  const dir = scratchProject({ 'dc-99': { status: 'active', updated: '2026-03-01' } });
  writeFileSync(join(dir, 'PROJECT.md'),
    ['# P', '', '## Moves', '', '- [x] **Item 2026-03-01** — see `dc-99`.', '', '## Notes', ''].join('\n'));
  try {
    assert.equal(demoteMoves(dir, { today: TODAY, strict: true }).demoted, 0, 'strict keeps it (cited unit active)');
    assert.equal(demoteMoves(dir, { today: TODAY }).demoted, 1, 'loosened default demotes it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict mode demotes when the cited unit is retired (the schema terminal status)', () => {
  const dir = scratchProject({ 'dc-50-old': { status: 'retired', updated: '2026-03-01' } });
  const b = bullet('- [x] **Closed an old decision** — see `dc-50-old`.');
  const r = classifyBullet(b, dir, { today: TODAY, strict: true });
  // Pre-fix: keep/cited-unit-still-active, because 'retired' was missing from the terminal array.
  assert.equal(r.decision, 'demote');
});

test('crash-retry does not duplicate the archive block', () => {
  const dir = scratchProject();
  const original = ['# P', '', '## Moves', '',
    '- [x] **Old thing 2026-03-01** — done.', '', '## Notes', ''].join('\n');
  writeFileSync(join(dir, 'PROJECT.md'), original);
  stampPm(dir);                                     // creation baseline (the render step's stamp)

  demoteMoves(dir, { today: TODAY });               // completes: archive + stub + baseline stamp
  writeFileSync(join(dir, 'PROJECT.md'), original); // simulate crash AFTER archive append, BEFORE PROJECT.md write
  // The PROJECT.md write and its baseline stamp are COUPLED under one lock:
  // a crash "before the PROJECT.md write"
  // means neither the write NOR the stamp landed. The reverted content is the
  // CORE-authored `original` render, so re-establish its creation baseline (as
  // the render step would) — otherwise the demoted-content stamp still on disk
  // disagrees with the reverted bytes and the writer correctly refuses.
  stampPm(dir);
  const retry = demoteMoves(dir, { today: TODAY });

  assert.equal(retry.demoted, 1, 'retry still stubs the bullet');
  const archive = readFileSync(join(dir, 'PROJECT-ARCHIVE.md'), 'utf8');
  assert.equal((archive.match(/Old thing 2026-03-01/g) || []).length, 1, 'archived exactly once');
  assert.match(readFileSync(join(dir, 'PROJECT.md'), 'utf8'), /→ see `PROJECT-ARCHIVE\.md §Moves/);
});

// ---------- size-pressure fallback (2026-07-21) ----------

function projectOverCapWithAgedBullet(dateStr) {
  const dir = scratchProject();
  const filler = '#'.repeat(PROJECT_MD_CAP_BYTES + 5000); // pushes PROJECT.md over the hard cap
  const text = [
    '# P', '', '## Moves', '', '### Active', '',
    `- [x] **Item shipped ${dateStr}** — done.`,
    '- [ ] **Still active** — keep me.', '',
    '## Notes', '', filler,
  ].join('\n');
  writeFileSync(join(dir, 'PROJECT.md'), text);
  stampPm(dir);
  return dir;
}

test('demoteMoves: an item younger than the 30-day floor but over the 7-day size-pressure floor stays put when PROJECT.md is under cap', () => {
  const dir = scratchProject();
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '### Active', '',
    '- [x] **Item shipped 2026-05-23** — done.', // 10 days before TODAY (2026-06-02)
    '- [ ] **Still active** — keep me.', '',
    '## Notes', '',
  ].join('\n'));
  try {
    const stats = demoteMoves(dir, { today: TODAY });
    assert.equal(stats.demoted, 0, 'under cap: normal 30-day floor applies, 10d item stays');
    assert.equal(stats.sizePressureApplied, undefined, 'no escalation when under cap');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('demoteMoves: the same 10-day-old item demotes once PROJECT.md is over its hard cap (size-pressure escalation)', () => {
  const dir = projectOverCapWithAgedBullet('2026-05-23'); // 10 days before TODAY
  try {
    const stats = demoteMoves(dir, { today: TODAY });
    assert.equal(stats.demoted, 1, 'over cap: escalated 7-day floor demotes the 10d item');
    assert.equal(stats.sizePressureApplied, true, 'stats report the escalation fired');
    assert.equal(stats.ageFloorDays, SIZE_PRESSURE_AGE_DAYS);
    const project = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.ok(/→ see `PROJECT-ARCHIVE\.md §Moves 2026-06-02`/.test(project), 'stub left behind');
    assert.ok(/Still active/.test(project), 'active item untouched');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('demoteMoves: size pressure reports no escalation when the escalated floor finds nothing extra beyond the normal floor', () => {
  const dir = scratchProject();
  const filler = '#'.repeat(PROJECT_MD_CAP_BYTES + 5000);
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '### Active', '',
    '- [x] **Old enough for normal floor 2026-03-01** — done.', // 93 days — demotes at floor 30 already
    '- [x] **Too young even for size pressure 2026-05-30** — done.', // 3 days — younger than 7-day floor too
    '- [ ] **Still active** — keep me.', '',
    '## Notes', '', filler,
  ].join('\n'));
  stampPm(dir);
  try {
    const stats = demoteMoves(dir, { today: TODAY });
    assert.equal(stats.demoted, 1, 'only the already-30d-aged item demotes');
    assert.equal(stats.sizePressureApplied, undefined, 'escalated floor finds nothing extra beyond the normal floor here');
    const project = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.ok(/Too young even for size pressure/.test(project), '3-day item stays even though file is over cap');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("demoteMoves: one old item no longer masks other over-floor items still over cap", () => {
  // Pre-fix bug: the escalation only fired when the normal floor found ZERO
  // candidates. Here the normal floor finds the 93-day item, so escalation
  // never ran under the old gate — the 10-day item sat untouched even though
  // the file was still massively over cap after removing just the one item.
  const dir = scratchProject();
  const filler = '#'.repeat(PROJECT_MD_CAP_BYTES + 5000);
  writeFileSync(join(dir, 'PROJECT.md'), [
    '# P', '', '## Moves', '', '### Active', '',
    '- [x] **Old enough for normal floor 2026-03-01** — done.', // 93 days — demotes at floor 30
    '- [x] **Only old enough for size pressure 2026-05-23** — done.', // 10 days — demotes at floor 7 only
    '- [x] **Too young for either floor 2026-05-30** — done.', // 3 days — demotes at neither
    '- [ ] **Still active** — keep me.', '',
    '## Notes', '', filler,
  ].join('\n'));
  stampPm(dir);
  try {
    const stats = demoteMoves(dir, { today: TODAY });
    assert.equal(stats.demoted, 2, 'both the 93-day and 10-day items demote once escalation runs');
    assert.equal(stats.sizePressureApplied, true, 'escalation reports it fired');
    assert.equal(stats.ageFloorDays, SIZE_PRESSURE_AGE_DAYS);
    const project = readFileSync(join(dir, 'PROJECT.md'), 'utf8');
    assert.ok(/Too young for either floor/.test(project), '3-day item still stays — escalation has a floor too');
    assert.equal((project.match(/→ see `PROJECT-ARCHIVE/g) || []).length, 2, 'two stubs left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
