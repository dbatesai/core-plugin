import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAffectsGraph, downstreamOf, traceSupersededImpact, IMPACT_VERSION,
} from '../../plugins/core/skills/core/scripts/impact-trace.mjs';

function unit(id, fm = {}) {
  return { path: `/x/${id}.md`, fm: { id, ...fm }, body: '', id };
}

test('buildAffectsGraph: depends-on means target affects the dependent', () => {
  const units = [
    unit('a', { edges: [{ type: 'depends-on', target: 'b' }] }), // a depends on b
  ];
  const affects = buildAffectsGraph(units);
  assert.ok(affects.get('b')?.has('a'), 'b affects a');
  assert.ok(!affects.get('a'), 'a affects nothing');
});

test('buildAffectsGraph: depended-on-by edge feeds the same direction', () => {
  const units = [
    unit('b', { edges: [{ type: 'depended-on-by', target: 'a' }] }), // b depended-on-by a
  ];
  const affects = buildAffectsGraph(units);
  assert.ok(affects.get('b')?.has('a'), 'b affects a (same relation, inverse edge)');
});

test('downstreamOf walks transitively', () => {
  const units = [
    unit('a', { edges: [{ type: 'depends-on', target: 'b' }] }), // a→b
    unit('b', { edges: [{ type: 'depends-on', target: 'c' }] }), // b→c
  ];
  const affects = buildAffectsGraph(units);
  // changing c affects b, and transitively a
  assert.deepEqual(downstreamOf('c', affects), ['a', 'b']);
  assert.deepEqual(downstreamOf('b', affects), ['a']);
  assert.deepEqual(downstreamOf('a', affects), []);
});

test('downstreamOf is cycle-safe', () => {
  const units = [
    unit('a', { edges: [{ type: 'depends-on', target: 'b' }] }),
    unit('b', { edges: [{ type: 'depends-on', target: 'a' }] }), // cycle
  ];
  const affects = buildAffectsGraph(units);
  // should terminate and exclude the start
  assert.deepEqual(downstreamOf('a', affects), ['b']);
});

test('traceSupersededImpact surfaces invalidated units that still have dependents', () => {
  const today = new Date(Date.UTC(2026, 5, 2));
  const units = [
    unit('dc-old', { status: 'retired', created: '2026-01-01', t_invalid: '2026-03-01' }),
    unit('dc-dependent', { status: 'active', created: '2026-02-01', edges: [{ type: 'depends-on', target: 'dc-old' }] }),
  ];
  const traces = traceSupersededImpact(units, today);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].invalidated, 'dc-old');
  assert.deepEqual(traces[0].dependents, ['dc-dependent']);
});

test('traceSupersededImpact stays quiet when invalidated units have no live dependents', () => {
  const today = new Date(Date.UTC(2026, 5, 2));
  const units = [
    unit('dc-old', { status: 'retired', created: '2026-01-01', t_invalid: '2026-03-01' }),
    unit('dc-unrelated', { status: 'active', created: '2026-02-01' }),
  ];
  assert.equal(traceSupersededImpact(units, today).length, 0);
});

test('IMPACT_VERSION is exported', () => {
  assert.equal(typeof IMPACT_VERSION, 'string');
});
