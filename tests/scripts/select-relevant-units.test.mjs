import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { selectCandidates } from '../../plugins/core/skills/core/scripts/select-relevant-units.mjs';

const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

test('candidate shortlist includes the value unit for an abstract query', () => {
  // The key design seam: the shortlist is RECALL-oriented, so the value-rung unit
  // (values-heritage) must be present for the reasoning step to choose it — even
  // though lexical scoring ranks it near zero for "zenith el primero on sale".
  const cands = selectCandidates('zenith el primero on sale', FIXT, { max: 30 });
  assert.ok(cands.some(c => c.id === 'values-heritage'),
    'shortlist must contain the unit even when lexical rank is low');
});

test('shortlist excludes retired units (anti-resurrection)', () => {
  const cands = selectCandidates('rolex daytona watch', FIXT, { max: 30 });
  assert.ok(!cands.some(c => c.id === 'distractor-retired-rolex'));
});

test('each candidate carries id/summary/topics for the reasoning step', () => {
  const cands = selectCandidates('watch chronograph', FIXT, { max: 30 });
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.ok(typeof c.summary === 'string');
    assert.ok(Array.isArray(c.topics));
  }
});

test('respects the max cap', () => {
  const cands = selectCandidates('watch', FIXT, { max: 3 });
  assert.ok(cands.length <= 3);
});

test('deterministic — same query, same ordered ids', () => {
  const a = selectCandidates('omega speedmaster', FIXT, { max: 30 }).map(c => c.id);
  const b = selectCandidates('omega speedmaster', FIXT, { max: 30 }).map(c => c.id);
  assert.deepEqual(a, b);
});

test('DC-117: default shortlist width is 100 (ratified 2026-07-15)', () => {
  // The promotion evidence: 12/12 blind-reasoning whenever the gold was in the
  // shortlist; every miss belonged to the old 30-row width. Guard the default.
  const wide = selectCandidates('watch', FIXT);
  const capped = selectCandidates('watch', FIXT, { max: 3 });
  assert.ok(capped.length <= 3);
  // fixture store is smaller than 100, so the default returns ALL active units
  const all = selectCandidates('completely unrelated query zzz', FIXT);
  assert.deepEqual(new Set(wide.map(c => c.id)), new Set(all.map(c => c.id)),
    'default width covers the whole small store (recall move)');
});
