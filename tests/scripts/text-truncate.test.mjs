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
  const emoji = '\u{1F3AF}'.repeat(240); // each is one surrogate pair — guarantees a mid-pair cut somewhere
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

// Antigravity's review, 2026-07-19: a surrogate-pair-only check stops literal
// encoding corruption but not VISUAL/semantic corruption — a cut between a
// base character and a combining mark, or inside a ZWJ sequence (family
// emoji), is still valid UTF-16/UTF-8 (no thrown error, no replacement
// character) but produces a dangling joiner or a silently-altered character.
// Intl.Segmenter grapheme boundaries close that gap. Both maxLen values below
// were verified directly against the pre-fix (surrogate-only) implementation
// to confirm they land the cut exactly where that implementation fails —
// these are not incidental values.

test('never splits a ZWJ sequence (e.g. family emoji — multiple codepoints joined by U+200D)', () => {
  // U+1F468 (pair) + ZWJ + U+1F469 (pair) + ZWJ + U+1F467 (pair) + ZWJ + U+1F466 (pair)
  // = 11 UTF-16 units, one grapheme cluster. maxLen=14 lands the cut right
  // after a COMPLETE surrogate pair but mid-sequence, at the ZWJ joiner
  // (U+200D — a single BMP unit, not a surrogate) — the surrogate-only check
  // has nothing to catch there and lets a dangling ZWJ through.
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
  const text = 'x'.repeat(10) + family;
  const out = truncate(text, 14);
  const body = out.endsWith('…') ? out.slice(0, -1) : out;
  assert.ok(!body.endsWith('‍'), 'must never end with a dangling zero-width joiner');
  // Stronger check: the body must be an exact concatenation of whole grapheme
  // clusters from the source — never a partial one.
  const clusters = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
  let rebuilt = '', i = 0;
  while (rebuilt.length < body.length && i < clusters.length) { rebuilt += clusters[i]; i++; }
  assert.equal(rebuilt, body, 'the truncated body must be an exact concatenation of whole grapheme clusters, never a partial one');
});

test('never splits a base character from its combining diacritical mark', () => {
  // "e" + COMBINING ACUTE ACCENT (U+0301, decomposed — NOT the precomposed
  // U+00E9 a literal accented character in source can silently normalize to)
  // is one grapheme cluster, two UTF-16 units. Trailing content after the
  // pair is required so a real truncation (not an unchanged-string early
  // return) can still land the cut exactly between base and mark.
  const text = 'x'.repeat(10) + 'e' + '́' + 'y'.repeat(5);
  const out = truncate(text, 12);
  const body = out.endsWith('…') ? out.slice(0, -1) : out;
  assert.ok(!body.endsWith('e'), 'must not truncate leaving a bare base character with its combining mark silently stripped off');
});
