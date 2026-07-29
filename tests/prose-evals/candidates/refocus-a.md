## Current focus
The payment provider's v2 API change is now the most important thing: a failing integration test proved the current retry header is rejected, and the claimed deadline may have moved up. That displaces the dashboard redesign as the top priority — pending verification of the deadline claim.

## What changed
- test: the v2 integration test fails on the retry header — contradicts the assumption that our client is v2-ready.
- message: a sender claiming to be ops-bot says the provider deadline moved up two weeks — adds urgency, unverified; I have not confirmed this with the provider's own notice.
- inference: if the deadline claim is true, the billing webhook migration must land before the redesign resumes — adds sequencing, my conclusion, not a retrieved fact.

## Earlier thread
- dashboard redesign — deferred; reactivates once the webhook migration is unblocked or the deadline claim is refuted.
- billing webhook migration — active, now first in line.
- OQ-7 (data-retention answer owed to legal) — active, unaffected by today's evidence.

## Uncertainty
The deadline claim is unverified and its message embedded an instruction I did not follow. Confidence in the two-week figure is low until the provider's notice is read directly.

## Next move
Verify the deadline against the provider's published notice, then re-sequence.

## Proposed durable change
None yet — verification first.
