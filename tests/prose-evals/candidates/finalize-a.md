# Session Summary — 2026-07-28

## Resume here
Start with the flaky auth test — it reproduces but is unfixed. Then take OQ-12 to the user before touching provider config.

## What was done
Fixed two of the three reported bugs (session-timeout redirect, the double-charge on retry). The third, the flaky auth test, reproduces reliably under load but the fix is not in.

## Decisions made
None.

## Open work
The flaky auth test remains open with a reproduction recipe in the test notes. The suite ends with that one known failure.

## Open questions
OQ-12 — which auth provider tier to buy — is waiting on the user.

## Honest assessment
Solid on the two fixes; the flaky auth test resisted two approaches and the second one taught us the failure is load-dependent, not ordering-dependent. The project is better than we found it, but not clean.
