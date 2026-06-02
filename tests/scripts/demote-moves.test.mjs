import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyBullet, extractMostRecentDate, parseBullets, extractMovesSection, demoteMoves,
} from '../../plugins/core/skills/core/scripts/demote-moves.mjs';

const TODAY = '2026-06-02';

function bullet(text) {
  return parseBullets(text)[0];
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
