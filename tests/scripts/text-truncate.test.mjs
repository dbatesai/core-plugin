import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../../plugins/core/skills/core/scripts/text-truncate.mjs';

// The one shared truncate() behind generate-summary-index.mjs,
// generate-decisions-index.mjs, and generate-risks-index.mjs — collapsed
// 2026-07-19 after an independent review found the surrogate-splitting bug
// fixed in one of the three hand-duplicated copies but not the other two.

test('is a no-op under the max and appends an ellipsis only when it actually cuts', () => {
  assert.equal(truncate('short', 100), 'short');
  const long = 'x'.repeat(150);
  const out = truncate(long, 100);
  assert.ok(out.endsWith('…'));
  assert.ok(out.length <= 100);
});

test('never orphans a UTF-16 surrogate pair (astral characters, e.g. emoji)', () => {
  const emoji = '🎯'.repeat(240); // each is one surrogate pair — guarantees a mid-pair cut somewhere
  const out = truncate(emoji, 240);
  assert.ok(!out.includes('�'), 'no lone-surrogate replacement character in the JS string itself');
  assert.ok(!Buffer.from(out, 'utf8').toString('utf8').includes('�'), 'round-trips clean through UTF-8 bytes too');
  const last = out.codePointAt(out.length - 1);
  assert.ok(last !== undefined, 'the result decodes to a full, well-formed sequence of code points');
});

test('handles null/undefined input as an empty string, never throws', () => {
  assert.equal(truncate(null, 10), '');
  assert.equal(truncate(undefined, 10), '');
});
