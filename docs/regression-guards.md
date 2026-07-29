# Regression guards — keeping the five failure patterns from coming back

The plugin's defects cluster into five repeating shapes. The `change-review-prompt.md` in this directory is the *manual* check (a fresh agent, run on a diff). This file is the *automatic* one: a growing set of `tests/scripts/guard-*.test.mjs` files that run every CI pass, so a regression fails the build instead of relying on someone remembering to look.

They run with the normal suite — CI already does `node --test tests/scripts/*.test.mjs`, and `guard-*.test.mjs` matches that glob. No extra wiring.

## The five patterns → their guards

| # | Pattern | Guard file(s) | What it mechanically checks |
|---|---|---|---|
| 1 | Prose obligations the agent won't reliably run | *(manual for now — hard to test mechanically; see change-review-prompt)* | — |
| 2 | Fixed once, never swept (duplication) | `guard-consolidation.test.mjs` | Count-ceiling ratchets: a duplicated implementation can't grow past its frozen baseline |
| 3 | Instruments report healthy while recording nothing | *(per-instrument tests; add as found)* | A write/telemetry failure must surface, not exit 0 |
| 4 | Soft trust boundaries | `retrieve-stray-write.test.mjs`, `close-index-path-validation.test.mjs` | Untrusted-repo input can't trigger a write/spawn/trust-pass |
| 5 | Read-side invariant with no single owner | `guard-read-invariants.test.mjs` | Every store-read path suppresses retired + invalidated units |

## How to grow this (the important part)

The whole point is that the set *grows as defects are found and fixed*. The rule: **when you fix an instance of one of these patterns, add its guard here in the same commit.** Concretely:

- **Pattern 2 (a ratchet):** when you consolidate a duplication, *lower* its baseline number in `guard-consolidation.test.mjs`. The ratchet only ever clicks tighter. A new copy pushes the count over the ceiling and fails CI. Target for every ratchet is 1 (a single shared owner).
- **Pattern 5 (read invariants):** when you add a new way to read/rank/retrieve units, add it to the `READERS` map in `guard-read-invariants.test.mjs`. One fixture, checked against every reader — so a new read path that forgets the suppression check fails immediately.
- **Pattern 4 (trust boundary):** when you fix a place a hostile repo could reach a real action, add a test that the untrusted input is now rejected (an empty-store dir writes nothing; an out-of-`~/.core` index path is ignored; a planted `_memories/` isn't treated as registered).
- **Pattern 3 (instrument honesty):** when you make a logger/validator fail loud, add a test that a forced write failure produces a non-success signal instead of a clean "0 / all good."
- **Pattern 1 (prose obligations):** the mechanical proxies worth adding when you touch protocols: a doc-lint that a documented env-var default matches the code default (the retrieval-hook polarity drift), and a check that a "run this command" block in a protocol maps to a tracked op or is marked best-effort.

## Why ratchets instead of "assert exactly 1"

Several duplications (slug encoders, CLI-entry guards, frontmatter parsers) are *known debt* that isn't fixed yet. Asserting "exactly one" would fail today and force a big cleanup before anything else can merge. A ceiling ratchet is honest: it freezes the debt where it is, blocks it from growing, and lets you pay it down one commit at a time by lowering the number. The baselines in `guard-consolidation.test.mjs` are dated; each names its target of 1.
