import { test } from 'node:test';
import assert from 'node:assert/strict';
// Validity predicates now live in priority.mjs (the canonical unit module) per the
// 2026-06-02 validity-dimension consolidation — increment 2. These imports failing
// would mean the consolidation regressed (predicates moved back out, or never landed).
import {
  effectiveValidity, validAt, isInvalidated, parseIsoDate,
} from '../../plugins/core/skills/core/scripts/priority.mjs';
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
