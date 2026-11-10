# CORE 4 rewrite plan — gauntlet results

**Final plan: v5.** Published as one page with D1–D4 cross-linked: https://claude.ai/artifact/Raonh3U2X9ZQxUQifZS1A8 (private until the owner shares it).

The same documents in this folder:

| Document | File | What it is |
|---|---|---|
| D1 — The Case | [v5-d1.md](v5-d1.md) | Problem, solution, competitors, and the verdict |
| D2 — The Machine | [v5-d2.md](v5-d2.md) | How it works, the ladder-down table, measurement and security design |
| D3 — The Build | [v5-d3.md](v5-d3.md) | Step-by-step build plan an agent can execute, with an Accept and "If it fails" per step |
| D4 — The Critic Log | [v5-d4.md](v5-d4.md) | The case against the plan, professional questions, and all 463 findings with their rulings |

## How it was made

1. **Contract** — the brief restated as acceptance tests: [contract.md](contract.md).
2. **Grounding** — CORE 3.20.1 source, harness docs, and prior art, with citations: [grounding.md](grounding.md), `research-*.md`, `source-*.md`.
3. **Draft v1**, then four review rounds. Each round, seven fresh reviewers (fact-checker, gap auditor, harness auditor, practitioner, executor, premise attacker, reader) worked from the file paths and [reviewer-brief.md](reviewer-brief.md) only. The drafting agent ruled on every finding in `round-<n>/defence.md` and wrote the next version.
4. **Blind check** — a fresh judge compared D1 v1 and D1 v5, unlabeled and shuffled: [blind-check.md](blind-check.md).

## Round results

- Round 1 — 146 findings, 141 accepted, 5 rebutted (one more partial rebuttal was overturned by a judge: [round-1/judge-PA-03.md](round-1/judge-PA-03.md))
- Round 2 — 129 findings, 129 accepted, 0 rebutted (one partial rebuttal withdrawn after the reviewer's evidence)
- Round 3 — 97 findings, 96 accepted, 1 rebutted
- Round 4 — 91 findings, 90 accepted, 1 rebutted

| Round | Critical | Major | Minor | Taste | Reviews and rulings |
|---|---|---|---|---|---|
| 1 | 14 | 81 | 50 | 1 | [round-1/](round-1/) |
| 2 | 17 | 81 | 30 | 1 | [round-2/](round-2/) |
| 3 | 16 | 54 | 26 | 1 | [round-3/](round-3/) |
| 4 | 8 | 49 | 33 | 1 | [round-4/](round-4/) |
| **All** | **55** | **265** | **139** | **4** | 463 findings |

**Stop condition: four rounds run.** Critical plus major findings per round were 95, 98, 70, and 57. They never reached zero, so the "two clean rounds" rule never fired first. v5 applies round 4's accepted fixes and was not reviewed again.

**Blind check:** the final D1 beat D1 v1, 23 to 17 of 30, a clear margin, and was kept. It lost on voice (1 against 3): four rounds of fixes made the verdict section dense.

**Length:** the rule that a round may lengthen a document only to answer an accepted finding was not met for D2 and D3, which overran their word targets. Every addition answers an accepted finding. D3 is about 24,500 words, and D4 lists that as a criticism.

**Earlier drafts** are kept for comparison: `v1-*.md` to `v4-*.md`.

## Summary

What the gauntlet changed: the kill test can now cancel CORE before any hook or script is written, against a fair rival (built-in memory kept in the repo plus the same instruction lines), and every rule treats "not measured" as "does not ship".
What it refused to change and why: skills are not gated per machine (that would leave cloud sessions with nothing), the record test runs six repetitions rather than ten (cost, and too few runs only makes CORE lose), and CORE does not keep a separate private memory folder (it would be a second store with its own rules).
What remains unverified: v5 itself was never reviewed, nothing was built or run, and Codex and Antigravity behaviour is taken from documentation, not tested.
