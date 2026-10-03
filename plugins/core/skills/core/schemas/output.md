# CORE Output Schema

The output structure every adversarial and generative agent returns, regardless of task type, team composition, or phase. No fields may be omitted — even when a field has nothing to report, the agent must explicitly state that (e.g., "No position changes during this execution"). The Quality Sentinel measures against standards rather than argues, so it returns the specialized variant at the bottom of this file instead.

Every field describes citable source evidence and results: concise justification, material alternatives, observable checks, uncertainty, and decision changes supported by evidence. Do not request or reproduce hidden internal reasoning traces or private deliberation.

The lead agent must process all eight fields when synthesizing results. Ignoring fields — particularly Persuasion Log, Mind Changes, Lingering Concerns, or Minority Views — defeats the adversarial quality signal CORE is designed to produce.

---

## The Eight Fields — standard output (adversarial and generative agents)

| # | Field | Type | Description |
|---|---|---|---|
| 1 | **Result** | string | The deliverable, finding, or answer. The agent's primary output — should stand on its own. For synthesis outputs, annotate significant findings with confidence level (High/Medium/Low) derived from the Convergence Tracking table's Diversity Basis column. A finding supported by agents from different specialist domains and cognitive traits is stronger than one where agents shared a single analytical lens. |
| 2 | **Reasoning** | string | Concise justification grounded in cited evidence, alternatives materially considered, and observable checks with their results. Explain why the evidence supports the conclusion; do not disclose an internal reasoning trace. |
| 3 | **Heaviest Factors** | array (3–5 items) | The factors that most influenced the result. Each entry: factor name + why it was decisive. Constrained to 3–5. Fewer than 3 means the analysis is too shallow; more than 5 means the agent hasn't prioritized. |
| 4 | **Persuasion Log** | array | Record of position changes caused by other agents. Each entry: who persuaded, what claim they made, how the position shifted, from-to summary. If no changes: "No position changes during this execution" — explicit statement required, empty array is not acceptable. |
| 5 | **Mind Changes** | array | Evidence-backed decision changes independent of another agent's argument. Each entry: prior stated conclusion, new evidence or check result, revised conclusion, optional confidence delta. Report observable decision changes, not a reconstruction of private deliberation. |
| 6 | **Unanswered Questions** | array | Questions the agent couldn't resolve. For each: the question, what data/access would answer it, how the answer might change the result. |
| 7 | **Lingering Concerns** | array | The lead agent's own reservations about the result — positions the lead agent holds even after the swarm has reached consensus. The lead agent must not discard these — they travel with the output and inform future work. |
| 8 | **Minority Views** | array | Named, attributed positions from specific agents that were heard, understood, and not incorporated into the consensus result. Each entry: agent name, the position held, and why it wasn't adopted. Distinct from Lingering Concerns (which are the lead agent's reservations). Do not conflate. If no minority positions exist: "No minority views during this execution" — explicit statement required, empty array is not acceptable. |

---

## Why Fields 4–8 Matter

Field 1 is what single-pass analysis produces. Fields 4–8 are where CORE's adversarial value concentrates:

- **Persuasion Log** — Concise record of which attributed claim and evidence changed a stated conclusion across agents; no internal deliberation trace.
- **Mind Changes** — Records revised conclusions and the new evidence or checks that support them. Persuasion Log attributes another agent's contribution; Mind Changes records independently evidenced revisions.
- **Unanswered Questions** — A gift to future sessions. Tells the next agent exactly where to dig.
- **Lingering Concerns** — The lead agent's intellectual honesty. These are the lead agent's own reservations held even after full swarm analysis — not agent positions, not unresolved questions, but the lead agent's personal dissent or caution that stays on record.
- **Minority Views** — Agent intellectual honesty. The named, attributed positions that lost the consensus vote but were substantive enough to record. The raw data already exists in session logs — this field surfaces it explicitly. Example: "Minority View (Sentinel): The migration approach is sound under current load but carries brittleness risk at 10× scale. Heard; not adopted because near-term timelines don't require it."

---

## Enforcement

- No fields may be omitted from any standard agent output. The Quality Sentinel's measurement variant below defines its own required sections.
- The lead agent must process all eight fields during synthesis: reading, weighing, and incorporating into the synthesized result or explicitly noting why a concern was set aside.
- Lead-agent synthesis warrants extended thinking — see the gate table in `agents/base-protocol.md` §"Extended thinking — when to use it".
- Fields 7 and 8 are distinct and must not be conflated: Lingering Concerns are lead-agent reservations; Minority Views are agent positions. Both travel with the output.

---

## Example

```
Result: [The agent's primary deliverable — complete, stands on its own]

Reasoning: [Concise evidence-based justification, material alternatives, and observable checks with results; no internal reasoning trace]

Heaviest Factors:
1. [Factor] — [Why it was decisive]
2. [Factor] — [Why it was decisive]
3. [Factor] — [Why it was decisive]

Persuasion Log:
- Persuaded by [Agent] on [claim]. Changed position from [X] to [Y] because [cited evidence or check result].
- No other position changes during this execution.

Mind Changes:
- Prior stated conclusion: [X]. New evidence or check: [Y]. Revised conclusion: [Z]. Confidence [increased/decreased] because [specific evidence].

Unanswered Questions:
- [Question]. Would need [data/access] to resolve. Could change [aspect of result].

Lingering Concerns:
- [lead-agent reservation that survives the process — the lead agent's own dissent or caution]

Minority Views:
- [Agent name]: [Position held]. [Why it wasn't adopted into consensus].
```

---

## Quality Sentinel Output (measurement variant)

The Quality Sentinel uses a specialized schema because it measures against standards rather than performs adversarial analysis. Fields like Persuasion Log don't apply to standards measurement.

```
Standards Catalog:
- [Standard name]: [Specific threshold or requirement]

Violations Found:
- [Standard]: required [X], measured [Y] — [file/location]

Measurements Taken:
- [What was measured]: [Result] — [PASS/FAIL]

Final Quality Verdict: [PASS / CONDITIONAL PASS / FAIL]
[Brief rationale — especially for CONDITIONAL PASS or FAIL]
```
