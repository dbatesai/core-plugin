import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VALID_STATUSES, TERMINAL_STATUSES, VALID_TYPES, VALID_EDGE_TYPES,
  VALID_CONFIDENCE_LEVELS, VALID_STABILITY_CLASSES, EXEMPT_FROM_STALENESS,
} from '../../plugins/core/skills/core/scripts/unit-vocab.mjs';
import {
  VALID_STATUSES as cuStatuses, TERMINAL_STATUSES as cuTerminal,
  VALID_TYPES as cuTypes, VALID_EDGE_TYPES as cuEdgeTypes,
  EXEMPT_FROM_STALENESS as cuExempt, checkIntegrity,
} from '../../plugins/core/skills/core/scripts/check-units.mjs';
import { TERMINAL_STATUSES as biTerminal } from '../../plugins/core/skills/core/scripts/bitemporal.mjs';
import { TERMINAL_STATUSES as dmTerminal } from '../../plugins/core/skills/core/scripts/demote-moves.mjs';
import {
  TERMINAL_STATUSES as dsTerminal, classifyStateBullet, parseStateBullets,
} from '../../plugins/core/skills/core/scripts/demote-state-narrative.mjs';

test('SYN-005: TERMINAL_STATUSES is exactly VALID_STATUSES minus active', () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ['archived', 'retired', 'superseded']);
  for (const s of TERMINAL_STATUSES) assert.ok(VALID_STATUSES.has(s), `${s} must be a valid status`);
  assert.ok(VALID_STATUSES.has('active') && !TERMINAL_STATUSES.has('active'));
});

test('SYN-005: retired is terminal; resolved/closed are not blessed anywhere', () => {
  assert.ok(TERMINAL_STATUSES.has('retired'), 'retired units must demote their bullets');
  for (const s of ['resolved', 'closed']) {
    assert.ok(!VALID_STATUSES.has(s), `${s} was never a schema status`);
    assert.ok(!TERMINAL_STATUSES.has(s), `${s} must not gate demotion`);
  }
});

test('SYN-005: every enforcement script shares the SAME Set objects (one vocabulary, not four copies)', () => {
  assert.equal(cuStatuses, VALID_STATUSES);
  assert.equal(cuTerminal, TERMINAL_STATUSES);
  assert.equal(cuTypes, VALID_TYPES);
  assert.equal(cuEdgeTypes, VALID_EDGE_TYPES);
  assert.equal(biTerminal, TERMINAL_STATUSES);
  assert.equal(dmTerminal, TERMINAL_STATUSES);
  assert.equal(dsTerminal, TERMINAL_STATUSES);
});

test('SYN-005: annotation vocabularies match the source-registration framework', () => {
  assert.deepEqual([...VALID_CONFIDENCE_LEVELS].sort(), ['inferred', 'reconstructed', 'sourced']);
  assert.deepEqual([...VALID_STABILITY_CLASSES].sort(), ['durably-correct', 'durably-suspect']);
});

test('premise is a blessed type (no type-value WARN) and is exempt from staleness', () => {
  assert.ok(VALID_TYPES.has('premise'), 'premise must be a valid type');
  assert.equal(cuExempt, EXEMPT_FROM_STALENESS, 'check-units shares the same exemption Set');
  assert.ok(EXEMPT_FROM_STALENESS.has('premise'), 'premise must be staleness-exempt');
});

test('an old, untouched premise unit does NOT get flagged as an archive candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-premise-'));
  try {
    const mem = join(dir, '_memories');
    mkdirSync(mem, { recursive: true });
    // A premise created/updated long ago — low R·S — would normally flag 'stale'.
    writeFileSync(join(mem, 'premise-axiom-x.md'),
      '---\nid: premise-axiom-x\ntype: premise\nstatus: active\ncreated: 2025-01-01\nupdated: 2025-01-01\ntopics:\n  - memory-architecture\n---\n\n# An axiom that governs decisions\n');
    // A decision of the same age SHOULD flag stale — proves the exemption is type-scoped, not a no-op.
    writeFileSync(join(mem, 'dc-99-old.md'),
      '---\nid: dc-99-old\ntype: decision\nstatus: active\ncreated: 2025-01-01\nupdated: 2025-01-01\ntopics:\n  - memory-architecture\n---\n\n# An old decision\n');
    const report = [];
    checkIntegrity(
      [
        { path: join(mem, 'premise-axiom-x.md'), fm: { id: 'premise-axiom-x', type: 'premise', status: 'active', created: '2025-01-01', updated: '2025-01-01' }, body: '' },
        { path: join(mem, 'dc-99-old.md'), fm: { id: 'dc-99-old', type: 'decision', status: 'active', created: '2025-01-01', updated: '2025-01-01' }, body: '' },
      ],
      mem, new Date('2026-06-28'), report);
    const stale = report.filter(r => r.check === 'stale').map(r => r.unit_id);
    assert.ok(!stale.includes('premise-axiom-x'), 'premise must not be an archive candidate');
    assert.ok(stale.includes('dc-99-old'), 'a same-age decision still flags stale (exemption is type-scoped)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SYN-005: a §State bullet backed by a retired unit now demotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-state-'));
  try {
    const mem = join(dir, '_memories');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'dc-50-old.md'),
      '---\nid: dc-50-old\ntype: decision\nstatus: retired\ncreated: 2026-01-01\nupdated: 2026-03-01\n---\n\n# dc-50-old\n');
    const [bullet] = parseStateBullets('\n- **Old state.** Long settled. *Backed by `dc-50-old`.*\n');
    const r = classifyStateBullet(bullet, dir, { today: '2026-06-09' });
    // Pre-fix this returns keep/cited-unit-still-active because 'retired' was not in the array.
    assert.equal(r.decision, 'demote');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
