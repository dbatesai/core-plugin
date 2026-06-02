import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadUnit } from '../../plugins/core/skills/core/scripts/priority.mjs';
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

test('TERMINAL_STATUSES covers retired/superseded/archived', () => {
  assert.ok(TERMINAL_STATUSES.has('retired'));
  assert.ok(TERMINAL_STATUSES.has('superseded'));
  assert.ok(TERMINAL_STATUSES.has('archived'));
  assert.ok(!TERMINAL_STATUSES.has('active'));
});
