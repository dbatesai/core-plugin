/**
 * text-truncate.mjs — one UTF-16-surrogate-safe truncate(), shared by every
 * index generator that summarizes unit text to a character bound.
 *
 * Extracted 2026-07-19 after an independent review caught the bug fixed in
 * generate-summary-index.mjs's truncate() (String.slice splits a UTF-16
 * surrogate pair — most emoji, CJK extension characters — orphaning the high
 * surrogate, which serializes as a U+FFFD replacement character) ALSO present,
 * unfixed, in two other hand-duplicated copies: generate-decisions-index.mjs
 * and generate-risks-index.mjs. Fix-in-one-copy is exactly the failure this
 * collapses — one shared function, so there is no second copy left to drift.
 */

export function truncate(text, maxLen) {
  const t = String(text ?? '');
  if (t.length <= maxLen) return t;
  let end = maxLen - 1;
  // Never split a surrogate pair: if the code unit just before the cut is a
  // high surrogate (0xD800-0xDBFF), its low-surrogate partner sits AT `end`
  // and would be excluded — back off one more so the whole pair drops together.
  if (end > 0 && t.charCodeAt(end - 1) >= 0xD800 && t.charCodeAt(end - 1) <= 0xDBFF) end--;
  return t.slice(0, end).trimEnd() + '…';
}
