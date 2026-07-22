import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUnit, iterArchivedUnits } from '../../plugins/core/skills/core/scripts/priority.mjs';
import { iterActiveUnits } from '../../plugins/core/skills/core/scripts/check-units.mjs';
import {
  effectiveValidity, validAt, isInvalidated, classifySupersessions,
  planSupersessionStamps, setFrontmatterField, applySupersessionStamps,
  asOf, storageMetrics, TERMINAL_STATUSES,
} from '../../plugins/core/skills/core/scripts/bitemporal.mjs';

// ---------------------------------------------------------------- helpers ---

function unit(fm) {
  // Build a minimal unit object as loadUnit would return.
  return { path: `/x/${fm.id}.md`, fm, body: '', id: fm.id };
}

function withStore(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bitemp-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(mem, name), content);
  try { return fn(mem); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function unitFile({ id, status = 'active', created = '2026-01-01', tValid, tInvalid, supersedes }) {
  const lines = ['---', `id: ${id}`, 'type: decision', `status: ${status}`, `created: ${created}`, `updated: ${created}`, 'topics: []'];
  if (tValid) lines.push(`t_valid: ${tValid}`);
  if (tInvalid) lines.push(`t_invalid: ${tInvalid}`);
  if (supersedes) { lines.push('edges:'); lines.push(`  - { type: supersedes, target: ${supersedes} }`); }
  lines.push('---', `# ${id}`, '');
  return lines.join('\n');
}

// ============================================================
// effectiveValidity — created-default
// ============================================================

test('effectiveValidity defaults t_valid to created when not explicit', () => {
  const v = effectiveValidity(unit({ id: 'x', created: '2026-03-01' }));
  assert.equal(v.t_valid, '2026-03-01');
  assert.equal(v.t_invalid, null);
});

test('effectiveValidity uses explicit t_valid over created (world-time divergence)', () => {
  const v = effectiveValidity(unit({ id: 'x', created: '2026-03-01', t_valid: '2026-01-15' }));
  assert.equal(v.t_valid, '2026-01-15');
});

// ============================================================
// M5: the stamp-writer honors the t_valid <= t_invalid invariant
// (the validator in check-units enforces it; the writer must not create it)
// ============================================================

test('planSupersessionStamps refuses a t_invalid earlier than the target t_valid (M5)', () => {
  // Target A is terminal with an explicit world-time t_valid LATER than the
  // superseder B's t_valid. Stamping A.t_invalid = B.t_valid would make
  // A.t_invalid < A.t_valid — valid-nowhere — so the writer must refuse.
  const a = unit({ id: 'dc-a', status: 'retired', created: '2026-03-01', t_valid: '2026-03-01' });
  const b = unit({ id: 'dc-b', created: '2026-01-01', edges: [{ type: 'supersedes', target: 'dc-a' }] });
  assert.deepEqual(planSupersessionStamps([a, b]), [], 'no invariant-violating stamp planned');
});

test('classifySupersessions surfaces the invariant-violating supersession as a conflict, not a silent confirm (M5)', () => {
  const a = unit({ id: 'dc-a', status: 'retired', created: '2026-03-01', t_valid: '2026-03-01' });
  const b = unit({ id: 'dc-b', created: '2026-01-01', edges: [{ type: 'supersedes', target: 'dc-a' }] });
  const { confirmed, conflicts } = classifySupersessions([a, b]);
  assert.equal(confirmed.length, 0, 'not confirmed');
  assert.ok(Array.isArray(conflicts) && conflicts.some((c) => c.target === 'dc-a'),
    'invariant-violating supersession surfaced as a conflict');
});

test('planSupersessionStamps still stamps a legitimate supersession (superseder at/after target t_valid)', () => {
  // Regression guard: the invariant fix must not block normal stamping.
  const a = unit({ id: 'dc-a', status: 'retired', created: '2026-01-01', t_valid: '2026-01-01' });
  const b = unit({ id: 'dc-b', created: '2026-02-01', edges: [{ type: 'supersedes', target: 'dc-a' }] });
  const stamps = planSupersessionStamps([a, b]);
  assert.equal(stamps.length, 1);
  assert.equal(stamps[0].target, 'dc-a');
  assert.equal(stamps[0].t_invalid, '2026-02-01');
});

test('storageMetrics surfaces validity conflicts (the invariant-violating supersession is visible, not dropped)', () => {
  const a = unit({ id: 'dc-a', status: 'retired', created: '2026-03-01', t_valid: '2026-03-01' });
  const b = unit({ id: 'dc-b', created: '2026-01-01', edges: [{ type: 'supersedes', target: 'dc-a' }] });
  const m = storageMetrics([a, b], new Date('2026-12-01'));
  assert.equal(m.validity_conflicts, 1, 'conflict counted in storage-health metrics');
});

// ============================================================
// validAt / isInvalidated
// ============================================================

test('validAt: open interval is valid from t_valid onward', () => {
  const u = unit({ id: 'x', created: '2026-03-01' });
  assert.equal(validAt(u, '2026-02-01'), false, 'before t_valid');
  assert.equal(validAt(u, '2026-03-01'), true, 'at t_valid');
  assert.equal(validAt(u, '2027-01-01'), true, 'open interval, far future');
});

test('validAt: closed interval excludes dates at/after t_invalid', () => {
  const u = unit({ id: 'x', created: '2026-01-01', t_invalid: '2026-06-01' });
  assert.equal(validAt(u, '2026-05-31'), true, 'before t_invalid');
  assert.equal(validAt(u, '2026-06-01'), false, 'at t_invalid (exclusive)');
  assert.equal(validAt(u, '2026-07-01'), false, 'after t_invalid');
});

test('isInvalidated reflects t_invalid relative to today', () => {
  const today = new Date(Date.UTC(2026, 5, 2));
  assert.equal(isInvalidated(unit({ id: 'x', created: '2026-01-01', t_invalid: '2026-05-01' }), today), true);
  assert.equal(isInvalidated(unit({ id: 'x', created: '2026-01-01' }), today), false, 'open interval never invalidated');
});

// ============================================================
// classifySupersessions — terminal-only stamping + loose-edge signal
// ============================================================

test('classifySupersessions stamps only terminal-status targets', () => {
  const units = [
    unit({ id: 'dc-old', status: 'retired', created: '2026-01-01' }),
    unit({ id: 'dc-new', status: 'active', created: '2026-02-01', edges: [{ type: 'supersedes', target: 'dc-old' }] }),
  ];
  const { confirmed, loose } = classifySupersessions(units);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].target, 'dc-old');
  assert.equal(confirmed[0].t_invalid, '2026-02-01', 'A.t_invalid = superseder world-time');
  assert.equal(loose.length, 0);
});

test('classifySupersessions surfaces loose edge when target still active (never invalidates it)', () => {
  const units = [
    unit({ id: 'dc-live', status: 'active', created: '2026-01-01' }), // foundational, still active
    unit({ id: 'obs-reframe', status: 'active', created: '2026-02-01', edges: [{ type: 'supersedes', target: 'dc-live' }] }),
  ];
  const { confirmed, loose } = classifySupersessions(units);
  assert.equal(confirmed.length, 0, 'active target is NOT auto-invalidated');
  assert.equal(loose.length, 1);
  assert.equal(loose[0].target, 'dc-live');
  assert.equal(loose[0].target_status, 'active');
});

test('classifySupersessions dedupes multiple superseders, takes earliest t_invalid', () => {
  const units = [
    unit({ id: 'dc-old', status: 'retired', created: '2026-01-01' }),
    unit({ id: 'dc-b', status: 'active', created: '2026-05-22', edges: [{ type: 'supersedes', target: 'dc-old' }] }),
    unit({ id: 'dc-a', status: 'active', created: '2026-05-17', edges: [{ type: 'supersedes', target: 'dc-old' }] }),
  ];
  const { confirmed } = classifySupersessions(units);
  assert.equal(confirmed.length, 1, 'one stamp per target');
  assert.equal(confirmed[0].t_invalid, '2026-05-17', 'earliest superseder wins');
  assert.equal(confirmed[0].superseders.length, 2);
});

test('classifySupersessions never overwrites an explicit t_invalid', () => {
  const units = [
    unit({ id: 'dc-old', status: 'retired', created: '2026-01-01', t_invalid: '2026-03-03' }),
    unit({ id: 'dc-new', status: 'active', created: '2026-05-01', edges: [{ type: 'supersedes', target: 'dc-old' }] }),
  ];
  assert.equal(classifySupersessions(units).confirmed.length, 0, 'explicit value preserved');
});

// ============================================================
// setFrontmatterField — the mutating helper (handles edges blocks)
// ============================================================

test('setFrontmatterField inserts a new field after updated, preserving edges', () => {
  const text = unitFile({ id: 'dc-x', status: 'retired', created: '2026-01-01', supersedes: 'dc-y' });
  const next = setFrontmatterField(text, 't_invalid', '2026-03-01');
  assert.match(next, /t_invalid: 2026-03-01/);
  assert.match(next, /type: supersedes, target: dc-y/, 'edges block intact');
  assert.match(next, /# dc-x/, 'body intact');
});

test('setFrontmatterField replaces an existing field in place', () => {
  const text = unitFile({ id: 'dc-x', status: 'retired', created: '2026-01-01', tInvalid: '2026-02-02' });
  const next = setFrontmatterField(text, 't_invalid', '2026-09-09');
  assert.match(next, /t_invalid: 2026-09-09/);
  assert.doesNotMatch(next, /2026-02-02/, 'old value gone');
});

test('setFrontmatterField leaves text without frontmatter untouched', () => {
  assert.equal(setFrontmatterField('no frontmatter here', 't_invalid', '2026-01-01'), 'no frontmatter here');
});

test('H2: setFrontmatterField stamps a CRLF-authored unit (Windows/OneDrive), not silently skips it', () => {
  // A CRLF unit opens with `---\r\n`; an LF-only fence regex returns the text
  // unchanged, the caller sees next===text, the write is skipped, and the
  // superseded unit stays "valid forever". Mirror the sibling readers' CRLF normalize.
  const crlf = '---\r\nid: dc-x\r\nstatus: retired\r\ncreated: 2026-01-01\r\n---\r\n\r\nbody\r\n';
  const out = setFrontmatterField(crlf, 't_invalid', '2026-03-01');
  assert.match(out, /^t_invalid: 2026-03-01$/m, 't_invalid written into the CRLF unit');
  assert.notEqual(out, crlf, 'did not no-op on CRLF input');
});

// ============================================================
// applySupersessionStamps — round-trip through real files
// ============================================================

test('planSupersessionStamps + applySupersessionStamps writes t_invalid to disk', () => {
  withStore({
    'dc-old.md': unitFile({ id: 'dc-old', status: 'retired', created: '2026-01-01' }),
    'dc-new.md': unitFile({ id: 'dc-new', status: 'active', created: '2026-02-01', supersedes: 'dc-old' }),
  }, (mem) => {
    const units = [loadUnit(join(mem, 'dc-old.md')), loadUnit(join(mem, 'dc-new.md'))];
    const stamps = planSupersessionStamps(units);
    assert.equal(stamps.length, 1);
    const written = applySupersessionStamps(stamps);
    assert.equal(written, 1);
    const reloaded = loadUnit(join(mem, 'dc-old.md'));
    assert.equal(String(reloaded.fm.t_invalid).trim(), '2026-02-01');
  });
});

// ============================================================
// asOf — point-in-time reconstruction
// ============================================================

test('asOf returns the set valid at a date', () => {
  const units = [
    unit({ id: 'a', created: '2026-01-01', t_invalid: '2026-04-01' }), // valid Jan–Apr
    unit({ id: 'b', created: '2026-03-01' }),                          // valid Mar onward
    unit({ id: 'c', created: '2026-06-01' }),                          // valid Jun onward
  ];
  assert.deepEqual(asOf(units, '2026-03-15'), ['a', 'b'], 'a and b valid mid-March; c not yet');
  assert.deepEqual(asOf(units, '2026-05-01'), ['b'], 'a invalidated, c not yet');
});

test('CLI-equivalent pool (iterActiveUnits + iterArchivedUnits) reconstructs history through a physically relocated unit (Hale\'s 2026-07-21 finding)', () => {
  withStore({
    'dc-live.md': '---\nid: dc-live\ntype: decision\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\ntopics: [a]\n---\n\n# live\n',
  }, (mem) => {
    mkdirSync(join(mem, 'archive'), { recursive: true });
    writeFileSync(join(mem, 'archive', 'dc-relocated.md'),
      '---\nid: dc-relocated\ntype: decision\nstatus: active\narchived: true\narchived_at: 2026-04-01\ncreated: 2026-01-01\nupdated: 2026-01-01\nt_invalid: 2026-04-01\ntopics: [a]\n---\n\n# relocated\n');

    // What the real CLI's --as-of branch does: merge active + archived pools.
    const pool = iterActiveUnits(mem).concat(iterArchivedUnits(mem));
    const ids = asOf(pool, '2026-02-01');
    assert.ok(ids.includes('dc-relocated'), 'an archived unit must still be reconstructable at a past date');

    // iterActiveUnits alone (the pre-fix behavior) must NOT see it -- proves
    // the fix is the concat, not some other accidental path.
    const activeOnlyIds = asOf(iterActiveUnits(mem), '2026-02-01');
    assert.ok(!activeOnlyIds.includes('dc-relocated'), 'iterActiveUnits alone still excludes archive/ by design');
  });
});

// ============================================================
// storageMetrics
// ============================================================

test('storageMetrics counts invalidated, loose edges, and intervals', () => {
  const today = new Date(Date.UTC(2026, 5, 2));
  const units = [
    unit({ id: 'dc-old', status: 'retired', created: '2026-01-01', t_invalid: '2026-03-01' }), // invalidated, 59d interval
    unit({ id: 'dc-live', status: 'active', created: '2026-01-01' }),
    unit({ id: 'obs-reframe', status: 'active', created: '2026-02-01', edges: [{ type: 'supersedes', target: 'dc-live' }] }), // loose
  ];
  const m = storageMetrics(units, today);
  assert.equal(m.total, 3);
  assert.equal(m.invalidated, 1);
  assert.equal(m.valid_now, 2);
  assert.equal(m.loose_supersession_edges, 1);
  assert.equal(m.closed_interval_days.count, 1);
});

test('SYN-006: storageMetrics counts terminal units the conservative writer can never stamp', () => {
  const units = [
    // terminal, no t_invalid, NO incoming supersedes — unreachable by the writer
    unit({ id: 'dc-stranded', status: 'retired', created: '2026-01-01' }),
    // terminal, no t_invalid, HAS incoming supersedes — the writer CAN stamp it
    unit({ id: 'dc-covered', status: 'retired', created: '2026-01-01' }),
    unit({ id: 'dc-new', status: 'active', created: '2026-02-01', edges: [{ type: 'supersedes', target: 'dc-covered' }] }),
  ];
  const m = storageMetrics(units, new Date(Date.UTC(2026, 5, 9)));
  assert.equal(m.unstamped_terminal, 1);
  assert.deepEqual(m.unstamped_terminal_units, ['dc-stranded']);
});

const BITEMPORAL_SRC = readFileSync(
  new URL('../../plugins/core/skills/core/scripts/bitemporal.mjs', import.meta.url), 'utf8');

test('MEM-009: unit stamps route through atomicWriteFileSync, never a bare writeFileSync', () => {
  // An interrupted bare write truncates the unit — body and frontmatter gone.
  // Crash-safety is not behaviorally testable without fault injection
  // (fs-atomic.test.mjs covers the helper), so this is the static guard the
  // suite already uses for MEMORY.md (generate-memory-index H1).
  assert.match(BITEMPORAL_SRC, /from '\.\/fs-atomic\.mjs'/, 'imports the atomic writer');
  assert.match(BITEMPORAL_SRC, /atomicWriteFileSync\(s\.path/, 'stamps written atomically');
  assert.doesNotMatch(BITEMPORAL_SRC, /\bwriteFileSync\(s\.path/, 'no bare write on unit files');
});

test('TERMINAL_STATUSES covers retired/superseded/archived', () => {
  assert.ok(TERMINAL_STATUSES.has('retired'));
  assert.ok(TERMINAL_STATUSES.has('superseded'));
  assert.ok(TERMINAL_STATUSES.has('archived'));
  assert.ok(!TERMINAL_STATUSES.has('active'));
});
