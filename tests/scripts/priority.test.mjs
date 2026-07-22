import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// Validity predicates now live in priority.mjs (the canonical unit module) per the
// 2026-06-02 validity-dimension consolidation — increment 2. These imports failing
// would mean the consolidation regressed (predicates moved back out, or never landed).
import {
  effectiveValidity, validAt, isInvalidated, parseIsoDate,
  parseFrontmatter, normalizeNewlines, _todayFromArg,
  rankUnits, main as priorityMain, iterArchivedUnits,
  score, signalS, NO_SOURCES_DEFAULT_S,
} from '../../plugins/core/skills/core/scripts/priority.mjs';

test('M3: a malformed --today falls back to today, never null (no TypeError at toISOString)', () => {
  const d = _todayFromArg('garbage');
  assert.ok(d instanceof Date, 'returns a Date, not null');
  assert.doesNotThrow(() => d.toISOString(), 'the display path can stamp it');
  // a well-formed date still parses through
  assert.equal(_todayFromArg('2026-03-01').toISOString().slice(0, 10), '2026-03-01');
});
// bitemporal.mjs must re-export the same functions so its CLI + existing importers keep working.
import {
  effectiveValidity as biEffectiveValidity,
  isInvalidated as biIsInvalidated,
} from '../../plugins/core/skills/core/scripts/bitemporal.mjs';

const u = (fm) => ({ fm });

test('predicates are exported from priority.mjs (canonical home)', () => {
  assert.equal(typeof effectiveValidity, 'function');
  assert.equal(typeof validAt, 'function');
  assert.equal(typeof isInvalidated, 'function');
});

test('bitemporal.mjs re-exports the SAME function objects (one definition, not a copy)', () => {
  assert.equal(biEffectiveValidity, effectiveValidity);
  assert.equal(biIsInvalidated, isInvalidated);
});

test('effectiveValidity defaults t_valid to created, leaves t_invalid open', () => {
  assert.deepEqual(effectiveValidity(u({ created: '2026-01-01' })), { t_valid: '2026-01-01', t_invalid: null });
});

test('effectiveValidity honors explicit t_valid / t_invalid (the overlay world-time case)', () => {
  assert.deepEqual(
    effectiveValidity(u({ created: '2026-01-01', t_valid: '2025-06-01', t_invalid: '2026-03-01' })),
    { t_valid: '2025-06-01', t_invalid: '2026-03-01' },
  );
});

test('validAt: inside the interval is valid; before t_valid and at/after t_invalid are not', () => {
  const unit = u({ t_valid: '2026-01-01', t_invalid: '2026-06-01' });
  assert.equal(validAt(unit, '2026-03-01'), true);
  assert.equal(validAt(unit, '2025-12-31'), false);   // before t_valid
  assert.equal(validAt(unit, '2026-06-01'), false);    // at t_invalid (half-open)
});

test('validAt: open interval (no t_invalid) is valid for any date >= t_valid', () => {
  assert.equal(validAt(u({ created: '2026-01-01' }), '2030-01-01'), true);
});

test('isInvalidated: true once t_invalid is at/before today, false while open', () => {
  const today = parseIsoDate('2026-06-02');
  assert.equal(isInvalidated(u({ t_invalid: '2026-05-01' }), today), true);
  assert.equal(isInvalidated(u({ t_invalid: '2026-07-01' }), today), false);
  assert.equal(isInvalidated(u({ created: '2026-01-01' }), today), false);
});

// ---------- CRLF tolerance (review M1) ----------

test('parseFrontmatter parses a CRLF unit the same as an LF unit', () => {
  const lf = '---\nid: x\ntype: decision\ncreated: 2026-01-01\n---\n\nbody line';
  const crlf = lf.replace(/\n/g, '\r\n');
  const [fmLf] = parseFrontmatter(lf);
  const [fmCrlf, bodyCrlf] = parseFrontmatter(crlf);
  // The CRLF delimiter must still be detected and values must not carry a trailing \r.
  assert.equal(fmCrlf.id, 'x');
  assert.equal(fmCrlf.type, 'decision');
  assert.equal(fmCrlf.created, '2026-01-01', 'value has no trailing \\r');
  assert.deepEqual(fmCrlf, fmLf);
  assert.ok(!bodyCrlf.includes('\r'), 'body normalized to LF');
});

test('normalizeNewlines collapses CRLF and lone CR to LF; passes non-strings through', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd'), 'a\nb\nc\nd');
  assert.equal(normalizeNewlines(null), null);
});

// ---------- SOD-003 / MEM-011: suppression invariant + malformed-frontmatter surfacing ----------

function rankVault() {
  const dir = mkdtempSync(join(tmpdir(), 'priority-rank-'));
  const mem = join(dir, '_memories');
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, 'dc-live.md'),
    '---\nid: dc-live\ntype: decision\nstatus: active\ncreated: 2026-06-01\nupdated: 2026-06-01\ntopics: [a]\n---\n\n# live\n');
  writeFileSync(join(mem, 'dc-dead.md'),
    '---\nid: dc-dead\ntype: decision\nstatus: superseded\ncreated: 2026-01-01\nupdated: 2026-06-01\nt_invalid: 2026-03-01\ntopics: [a]\n---\n\n# dead\n');
  return { dir, mem };
}

function quiet(stream, fn) {
  const orig = stream.write;
  const chunks = [];
  stream.write = (c) => { chunks.push(String(c)); return true; };
  try { return [fn(), chunks.join('')]; } finally { stream.write = orig; }
}

test('SOD-003: rankUnits excludes invalidated units by default', () => {
  const { dir, mem } = rankVault();
  try {
    const ids = rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id);
    assert.ok(ids.includes('dc-live'));
    assert.ok(!ids.includes('dc-dead'), 't_invalid in the past must suppress the unit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SOD-003: includeInvalidated:true ranks cold history', () => {
  const { dir, mem } = rankVault();
  try {
    const ids = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true }).map(([, u]) => u.id);
    assert.ok(ids.includes('dc-dead'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SOD-003: the CLI ranking inherits the filter (invalidated id absent from --top output)', () => {
  const { dir, mem } = rankVault();
  try {
    const [, out] = quiet(process.stdout, () => priorityMain([mem, '--today', '2026-06-09', '--top', '10']));
    assert.match(out, /dc-live/);
    assert.doesNotMatch(out, /dc-dead/, 'main() must not rank an invalidated unit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('iterArchivedUnits: returns units physically relocated to archive/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-'));
  try {
    const mem = join(dir, '_memories');
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'risk-1-archived.md'),
      '---\nid: risk-1-archived\ntype: risk\nstatus: retired\ncreated: 2026-01-01\nupdated: 2026-01-01\ntopics: [a]\n---\n\n# archived\n');
    const units = iterArchivedUnits(mem);
    assert.deepEqual(units.map(u => u.id), ['risk-1-archived']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('iterArchivedUnits: no archive/ subdir at all returns empty, not a throw (ENOENT-only tolerance)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-absent-'));
  try {
    const mem = join(dir, '_memories');
    mkdirSync(mem, { recursive: true });
    assert.deepEqual(iterArchivedUnits(mem), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("iterArchivedUnits: malformed (frontmatter-less) archive content is excluded, not ranked (Hale's 2026-07-22 finding)", () => {
  const dir = mkdtempSync(join(tmpdir(), 'priority-archive-malformed-'));
  try {
    const mem = join(dir, '_memories');
    const archive = join(mem, 'archive');
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, 'broken.md'), 'no frontmatter here at all\n');
    const units = iterArchivedUnits(mem);
    const broken = units.find(u => u.id === 'broken');
    assert.ok(broken && broken.fm._load_error, 'malformed archive unit is tagged _load_error, same as a top-level malformed unit');
    const ranked = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true });
    assert.ok(ranked.every(([, u]) => u.id !== 'broken'), 'malformed archive unit must not appear in ranked output');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SOD-003: includeInvalidated:true reaches a unit physically relocated to archive/ (Hale\'s 2026-07-21 finding)', () => {
  const { dir, mem } = rankVault();
  try {
    mkdirSync(join(mem, 'archive'), { recursive: true });
    writeFileSync(join(mem, 'archive', 'dc-relocated.md'),
      '---\nid: dc-relocated\ntype: decision\nstatus: retired\ncreated: 2026-01-01\nupdated: 2026-01-01\nt_invalid: 2026-02-01\ntopics: [a]\n---\n\n# relocated\n');
    const withInvalid = rankUnits(mem, { today: parseIsoDate('2026-06-09'), includeInvalidated: true }).map(([, u]) => u.id);
    assert.ok(withInvalid.includes('dc-relocated'), 'a retired unit physically moved to archive/ must still be reachable via includeInvalidated');
    const withoutInvalid = rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id);
    assert.ok(!withoutInvalid.includes('dc-relocated'), 'default ranking still excludes archive/ entirely');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('MEM-011: a frontmatter-less unit is excluded from ranking and warned to stderr', () => {
  const { dir, mem } = rankVault();
  try {
    writeFileSync(join(mem, 'broken.md'), '---\nid: broken\nNO CLOSING FENCE\n');
    const [ids, errOut] = quiet(process.stderr, () =>
      rankUnits(mem, { today: parseIsoDate('2026-06-09') }).map(([, u]) => u.id));
    assert.ok(!ids.includes('broken'), 'damaged unit must not rank on default scores');
    assert.match(errOut, /broken\.md.*no parseable frontmatter/, 'the damage is surfaced, not swallowed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- D7: priority scoring calibration (MEM-005, MEM-018) ----------

test('MEM-018: no-sources units score S=0.3 — below summary-sourced, above transcript', () => {
  assert.equal(NO_SOURCES_DEFAULT_S, 0.3);
  assert.equal(signalS({ fm: {} }), 0.3, 'unknown provenance no longer ties with summary');
  assert.equal(signalS({ fm: { sources: ['summary-2026-06-01.md'] } }), 0.5, 'explicit summary still 0.5');
});

test('scalar sources string coerces to a single-element list — not the no-sources default', () => {
  assert.equal(signalS({ fm: { sources: 'PROJECT.md' } }), 1.0,
    'a scalar `sources: PROJECT.md` must score as one PROJECT.md source, not S=0.3');
  assert.equal(signalS({ fm: { sources: 'summary-2026-06-01.md' } }), 0.5,
    'a scalar summary source scores the summary tier');
  assert.equal(signalS({ fm: { sources: '' } }), NO_SOURCES_DEFAULT_S,
    'an empty-string scalar still scores the no-sources default');
});

test('MEM-005: pinned:false is neutral — identical score to an unpinned unit (decided behavior)', () => {
  const today = parseIsoDate('2026-06-09');
  const base = { fm: { created: '2026-06-01', topics: ['a'] } };
  const pinnedFalse = { fm: { created: '2026-06-01', topics: ['a'], pinned: false } };
  assert.equal(score(pinnedFalse, [], today), score(base, [], today));
});
