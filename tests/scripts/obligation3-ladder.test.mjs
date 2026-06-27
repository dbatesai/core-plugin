import { test } from 'node:test';
import assert from 'node:assert';
import { scoreLadder, RUNGS, PROVISIONAL_BAR } from '../../plugins/core/skills/core/scripts/score-ladder.mjs';

test('ladder has four rungs with expected ids', () => {
  assert.equal(RUNGS.length, 4);
  for (const r of RUNGS) {
    assert.ok(r.expectId, 'each rung names the unit it expects to surface');
    assert.ok(r.hook, 'each rung carries a present-day hook query');
    assert.ok(r.rung, 'each rung is named (literal/category/value/crossdomain)');
  }
});

test('scoreLadder computes recall@5 per rung', () => {
  // simulate: literal+category surfaced, value missed, crossdomain surfaced
  const retrieved = {
    'literal':     ['want-omega-speedmaster-on-sale-wait', 'x', 'y'],
    'category':    ['want-iconic-chronograph', 'z'],
    'value':       ['unrelated-1', 'unrelated-2'],
    'crossdomain': ['try-latest-moe-qwen'],
  };
  const res = scoreLadder(retrieved);
  assert.equal(res.perRung.literal.hit, true);
  assert.equal(res.perRung.value.hit, false);
  assert.equal(res.recallAt5.literal, 1);
  assert.equal(res.recallAt5.value, 0);
});

test('provisional bar: literal+category must be 100%, value/crossdomain >= 0.6', () => {
  assert.equal(PROVISIONAL_BAR.literal, 1.0);
  assert.equal(PROVISIONAL_BAR.category, 1.0);
  assert.ok(PROVISIONAL_BAR.value >= 0.6);
  assert.ok(PROVISIONAL_BAR.crossdomain >= 0.6);
});

test('passesProvisionalBar true only when every rung clears its bar', () => {
  const allHit = {
    'literal':     ['want-omega-speedmaster-on-sale-wait'],
    'category':    ['want-iconic-chronograph'],
    'value':       ['values-heritage'],
    'crossdomain': ['try-latest-moe-qwen'],
  };
  assert.equal(scoreLadder(allHit).passesProvisionalBar, true);

  const valueMissed = { ...allHit, value: ['nope'] };
  assert.equal(scoreLadder(valueMissed).passesProvisionalBar, false);
});

test('a hit beyond rank 5 does not count (recall@5)', () => {
  const retrieved = {
    'literal':     ['a', 'b', 'c', 'd', 'e', 'want-omega-speedmaster-on-sale-wait'],
    'category':    ['want-iconic-chronograph'],
    'value':       ['values-heritage'],
    'crossdomain': ['try-latest-moe-qwen'],
  };
  const res = scoreLadder(retrieved);
  assert.equal(res.perRung.literal.hit, false, 'rank-6 hit is outside top-5');
});

test('expected ids match the committed fixture unit ids', () => {
  const ids = RUNGS.map(r => r.expectId).sort();
  assert.deepEqual(ids, [
    'try-latest-moe-qwen',
    'values-heritage',
    'want-iconic-chronograph',
    'want-omega-speedmaster-on-sale-wait',
  ]);
});
