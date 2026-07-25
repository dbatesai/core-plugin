/**
 * text-truncate.mjs — one grapheme-cluster-safe truncate(), shared by every
 * index generator that summarizes unit text to a character bound.
 *
 * One shared function, so there is no second copy left to drift —
 * hand-duplicated copies of this logic are exactly how a fix lands in one
 * generator and misses the others. A naive String.slice splits a UTF-16
 * surrogate pair (most emoji, CJK extension characters), orphaning the high
 * surrogate, which serializes as a U+FFFD replacement character.
 *
 * A surrogate-pair
 * boundary check stops that literal encoding corruption (the
 * U+FFFD replacement character) but is not the full correctness bar. A cut
 * between a base character and a combining diacritical mark, or inside a ZWJ
 * sequence (family emoji — multiple codepoints joined by U+200D), is still
 * valid UTF-16/UTF-8 — no replacement character, no thrown error — but is
 * VISUALLY corrupted: a stray combining mark with no base, or a broken emoji
 * fragment. Intl.Segmenter's grapheme granularity is the native (ECMA-402,
 * no new dependency, Node 16+) way to find "the last complete user-perceived
 * character" — it already treats surrogate pairs, ZWJ sequences, and
 * base+combining-mark clusters all as one atomic segment, so respecting its
 * boundaries subsumes a narrower surrogate-only check.
 */

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function truncate(text, maxLen) {
  const t = String(text ?? '');
  if (t.length <= maxLen) return t;
  let out = '';
  for (const { segment } of GRAPHEMES.segment(t)) {
    if (out.length + segment.length > maxLen - 1) break;
    out += segment;
  }
  return out.trimEnd() + '…';
}
