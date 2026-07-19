/**
 * text-truncate.mjs — one grapheme-cluster-safe truncate(), shared by every
 * index generator that summarizes unit text to a character bound.
 *
 * Extracted 2026-07-19 after an independent review caught the bug fixed in
 * generate-summary-index.mjs's truncate() (String.slice splits a UTF-16
 * surrogate pair — most emoji, CJK extension characters — orphaning the high
 * surrogate, which serializes as a U+FFFD replacement character) ALSO present,
 * unfixed, in two other hand-duplicated copies: generate-decisions-index.mjs
 * and generate-risks-index.mjs. Fix-in-one-copy is exactly the failure this
 * collapses — one shared function, so there is no second copy left to drift.
 *
 * Upgraded same day (Antigravity's review, "ponytail" pass): a surrogate-pair
 * boundary check stops literal encoding corruption (the reported bug — a
 * U+FFFD replacement character) but is not the full correctness bar. A cut
 * between a base character and a combining diacritical mark, or inside a ZWJ
 * sequence (family emoji — multiple codepoints joined by U+200D), is still
 * valid UTF-16/UTF-8 — no replacement character, no thrown error — but is
 * VISUALLY corrupted: a stray combining mark with no base, or a broken emoji
 * fragment. Intl.Segmenter's grapheme granularity is the native (ECMA-402,
 * no new dependency, Node 16+) way to find "the last complete user-perceived
 * character" — it already treats surrogate pairs, ZWJ sequences, and
 * base+combining-mark clusters all as one atomic segment, so respecting its
 * boundaries subsumes the narrower surrogate-only check this replaces.
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
