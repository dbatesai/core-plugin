import { test } from 'node:test';
import assert from 'node:assert/strict';
// Validity predicates now live in priority.mjs (the canonical unit module) per the
// 2026-06-02 validity-dimension consolidation — increment 2. These imports failing
// would mean the consolidation regressed (predicates moved back out, or never landed).
import {
  effectiveValidity, validAt, isInvalidated, parseIsoDate,
  parseFrontmatter, normalizeNewlines, _todayFromArg,
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
