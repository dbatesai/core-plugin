import { test } from 'node:test';
import assert from 'node:assert';
import { checkContextIntegrity } from '../../plugins/core/skills/core/scripts/check-context-integrity.mjs';

test('flags MEMORY.md over cap', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /CONTEXT-PARTIAL/);
  assert.ok(res.dropped.some(d => /MEMORY/.test(d.file)));
});

test('flags partial PROJECT.md read', () => {
  const res = checkContextIntegrity({ memoryBytes: 1000, memoryCapBytes: 24576, projectTotalLines: 2200, projectReadLines: 80 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /PROJECT\.md loaded 80\/2200/);
});

test('clean when both fit', () => {
  const res = checkContextIntegrity({ memoryBytes: 1000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  assert.equal(res.ok, true);
  assert.match(res.marker, /CONTEXT-COMPLETE/);
});

test('estimatedUnitsLost is reported on a MEMORY.md overflow', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 100, projectReadLines: 100 });
  const mem = res.dropped.find(d => /MEMORY/.test(d.file));
  assert.ok(mem.estimatedUnitsLost >= 1, 'dropped bytes map to an estimated entry count');
});

test('both surfaces partial: marker names both', () => {
  const res = checkContextIntegrity({ memoryBytes: 40000, memoryCapBytes: 24576, projectTotalLines: 2200, projectReadLines: 80 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /MEMORY/);
  assert.match(res.marker, /80\/2200/);
});
