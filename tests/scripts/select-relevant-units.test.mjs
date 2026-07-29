import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import * as selector from '../../plugins/core/skills/core/scripts/select-relevant-units.mjs';

const selectAll = (query, store, opts = {}) => selector.selectCandidateShards(query, store, opts)
  .flatMap((shard) => shard.candidates);

const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'obligation3-store');

test('candidate shortlist includes the value unit for an abstract query', () => {
  // The key design seam: the shortlist is RECALL-oriented, so the value-rung unit
  // (values-heritage) must be present for the reasoning step to choose it — even
  // though lexical scoring ranks it near zero for "zenith el primero on sale".
  const cands = selectAll('zenith el primero on sale', FIXT);
  assert.ok(cands.some(c => c.id === 'values-heritage'),
    'shortlist must contain the unit even when lexical rank is low');
});

test('shortlist excludes retired units (anti-resurrection)', () => {
  const cands = selectAll('rolex daytona watch', FIXT);
  assert.ok(!cands.some(c => c.id === 'distractor-retired-rolex'));
});

test('each candidate carries id/summary/topics for the reasoning step', () => {
  const cands = selectAll('watch chronograph', FIXT);
  assert.ok(cands.length > 0);
  for (const c of cands) {
    assert.ok(typeof c.id === 'string' && c.id.length > 0);
    assert.ok(typeof c.summary === 'string');
    assert.ok(Array.isArray(c.topics));
  }
});

test('selector returns numbered shards from one exhaustive ordering', () => {
  const shards = selector.selectCandidateShards('watch', FIXT, { shardSize: 3 });
  assert.equal(shards[0].candidates.length, 3);
  assert.ok(shards[1].candidates.length > 0 && shards[1].candidates.length <= 3);
  assert.equal(new Set(shards.flatMap((shard) => shard.candidates).map((candidate) => candidate.id)).size, 6);
});

test('deterministic — same query, same ordered ids', () => {
  const a = selectAll('omega speedmaster', FIXT).map(c => c.id);
  const b = selectAll('omega speedmaster', FIXT).map(c => c.id);
  assert.deepEqual(a, b);
});

test('default shard size is bounded without claiming one-shard full-corpus recall', () => {
  const shards = selector.selectCandidateShards('watch', FIXT);
  assert.ok(shards[0].candidates.length > 0 && shards[0].candidates.length <= 80);
});

test('exports an exhaustive reasoning-shard selector', () => {
  assert.equal(typeof selector.selectCandidateShards, 'function');
});

test('selectCandidates is the exhaustive shard API, not a fixed-row shortlist', () => {
  assert.equal(typeof selector.selectCandidates, 'function');
  const shards = selector.selectCandidates('watch', FIXT, { shardSize: 3 });
  assert.ok(Array.isArray(shards) && Array.isArray(shards[0].candidates));
});

function makeLargeStore(count = 205) {
  const root = mkdtempSync(join(tmpdir(), 'core-reasoning-shards-'));
  const memories = join(root, '_memories');
  mkdirSync(memories, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const id = `unit-${String(i).padStart(3, '0')}`;
    const body = i === count - 1
      ? 'The body alone records the quokka recovery protocol.'
      : `Ordinary unrelated body ${i}.`;
    writeFileSync(join(memories, `${id}.md`), `---\nid: ${id}\ntype: observation\nstatus: active\ncreated: 2026-07-17\nupdated: 2026-07-17\nconfidence: 0.9\ntopics:\n  - infrastructure\nsources:\n  - test\nedges: []\n---\n# Generic memory ${i}\n\n${body}\n`);
  }
  return root;
}

test('reasoning shards cover every active unit exactly once above 100 units', () => {
  const root = makeLargeStore();
  const shards = selector.selectCandidateShards('abstract request', root, { shardSize: 80 });
  const ids = shards.flatMap((shard) => shard.candidates.map((candidate) => candidate.id));
  assert.equal(shards.length, 3);
  assert.equal(ids.length, 205);
  assert.equal(new Set(ids).size, 205);
  assert.ok(shards.every((shard) => shard.candidates.length <= 80));
  assert.ok(shards.every((shard) => shard.units_scanned === 205 && shard.units_total === 205));
});

test('reasoning order starts with the full-body product ranking before exhaustive fallback', () => {
  const root = makeLargeStore();
  const shards = selector.selectCandidateShards('quokka recovery', root, { shardSize: 80 });
  assert.equal(shards[0].candidates[0].id, 'unit-204');
});

test('CLI exposes one numbered shard with explicit full-corpus coverage', () => {
  const root = makeLargeStore();
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'select-relevant-units.mjs');
  const run = spawnSync(process.execPath, [script, root, 'abstract request', '--shard', '2', '--shard-size', '80'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Reasoning shard 3\/3; units_scanned=205; units_total=205/);
  assert.match(run.stdout, /unit-204/);
  assert.doesNotMatch(run.stdout, /unit-000/);
});

test('CLI: shard flags are validated at the boundary — NaN and fractions are rejected, not truncated', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugins', 'core', 'skills', 'core', 'scripts', 'select-relevant-units.mjs');
  for (const args of [['--shard', 'abc'], ['--shard', '-1'], ['--shard-size', '2.5'], ['--shard-size', '0']]) {
    const r = spawnSync(process.execPath, [script, FIXT, 'query', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')} must be rejected (got ${r.status})`);
  }
});
