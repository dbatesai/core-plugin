import { test } from 'node:test';
import assert from 'node:assert';
import { checkContextIntegrity } from '../../plugins/core/skills/core/scripts/check-context-integrity.mjs';

// Task 7: the startup Tier-0 step reads PROJECT.md in full and records the
// read-extent. These guards lock the contract that a full read is accounted for and
// a partial read is never silent. They pass against the Task-4 check-context-integrity
// code — that is by design: this is the regression guard for the startup-side change.

test('large PROJECT.md fully read is accounted for (no shortfall)', () => {
  const total = 2200, read = 2200;
  const res = checkContextIntegrity({ memoryBytes: 0, projectTotalLines: total, projectReadLines: read });
  assert.equal(res.ok, true);
  assert.match(res.marker, /CONTEXT-COMPLETE/);
});

test('a partial PROJECT.md read is reported, never silent', () => {
  const res = checkContextIntegrity({ memoryBytes: 0, projectTotalLines: 2200, projectReadLines: 80 });
  assert.equal(res.ok, false);
  assert.match(res.marker, /80\/2200/);
});

test('the head-slice failure mode (first-80-lines of a large file) is caught', () => {
  // The exact regression this task closes: reading only the first screen of a
  // 2200-line PROJECT.md must register as partial, not as a complete load.
  const res = checkContextIntegrity({ memoryBytes: 0, projectTotalLines: 2200, projectReadLines: 80 });
  assert.ok(res.dropped.some(d => /PROJECT/.test(d.file) && d.readLines === 80 && d.totalLines === 2200));
});
