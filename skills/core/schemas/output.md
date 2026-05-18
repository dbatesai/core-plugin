# CORE Output Schema

The mandatory output structure that ALL agents must return, regardless of task type, team composition, or phase. No fields may be omitted — even when a field has nothing to report, the agent must explicitly state that (e.g., "No position changes during this execution").

The DM must process all eight fields when synthesizing results. Ignoring fields — particularly Persuasion Log, Mind Changes, Lingering Concerns, or Minority Views — defeats the adversarial quality signal CORE is designed to produce.

---

## The Eight Fields

| # | Field | Type | Description |
|---|---|---|---|
| 1 | **Result** | string | The deliverable, finding, or answer. The agent's primary output — should stand on its own. For synthesis outputs, annotate significant findings with confidence level (High/Medium/Low) derived from the Convergence Tracking table's Diversity Basis column. A finding supported by agents from different specialist domains and cognitive traits is stronger than one where agents shared a single analytical lens. |
| 2 | **Reasoning** | string | How the agent arrived at the result. Show the work: evidence weighed, alternatives evaluated, analytical framework applied. NOT a restatement of the result. |
| 3 | **Heaviest Factors** | array (3–5 items) | The factors that most influenced the result. Each entry: factor name + why it was decisive. Constrained to 3–5. Fewer than 3 means the analysis is too shallow; more than 5 means the agent hasn't prioritized. |
| 4 | **Persuasion Log** | array | Record of position changes caused by other agents. Each entry: who persuaded, what claim they made, how the position shifted, from-to summary. If no changes: "No position changes during this execution" — explicit statement required, empty array is not acceptable. |
| 5 | **Mind Changes** | array | Intra-agent reconsiderations — moments where the agent changed its own mind during execution, independent of other agents. Each entry: initial position, trigger (what caused reconsideration), revised position, optional confidence delta. |
| 6 | **Unanswered Questions** | array | Questions the agent couldn't resolve. For each: the question, what data/access would answer it, how the answer might change the result. |
| 7 | **Lingering Concerns** | array | The DM's own reservations about the result — positions the DM holds even after the swarm has reached consensus. The DM must not discard these — they travel with the output and inform future work. |
| 8 | **Minority Views** | array | Named, attributed positions from specific agents that were heard, understood, and not incorporated into the consensus result. Each entry: agent name, the position held, and why it wasn't adopted. Distinct from Lingering Concerns (which are the DM's reservations). Do not conflate. If no minority positions exist: "No minority views during this execution" — explicit statement required, empty array is not acceptable. |

---

## Why Fields 4–8 Matter

Field 1 is what single-pass analysis produces. Fields 4–8 are where CORE's adversarial value concentrates:

- **Persuasion Log** — Traceable chain of reasoning changes across agents. Shows exactly which argument changed which agent's mind and why. The most distinctive CORE innovation.
- **Mind Changes** — Measures analytical depth. Persuasion Log tracks inter-agent influence; Mind Changes tracks intra-agent reasoning. Both are quality signals.
- **Unanswered Questions** — A gift to future sessions. Tells the next agent exactly where to dig.
- **Lingering Concerns** — The DM's intellectual honesty. These are the DM's own reservations held even after full swarm analysis — not agent positions, not unresolved questions, but the DM's personal dissent or caution that stays on record.
- **Minority Views** — Agent intellectual honesty. The named, attributed positions that lost the consensus vote but were substantive enough to record. The raw data already exists in session logs — this field surfaces it explicitly. Example: "Minority View (Sentinel): The migration approach is sound under current load but carries brittleness risk at 10× scale. Heard; not adopted because near-term timelines don't require it."

---

## Enforcement

- No fields may be omitted from any agent output.
- The DM must process all eight fields during synthesis: reading, weighing, and incorporating into the synthesized result or explicitly noting why a concern was set aside.
- Fields 7 and 8 are distinct and must not be conflated: Lingering Concerns are DM reservations; Minority Views are agent positions. Both travel with the output.

---

## Example

```
Result: [The agent's primary deliverable — complete, stands on its own]

Reasoning: [Analytical chain showing how the result was reached — evidence considered, alternatives evaluated, methodology applied]

Heaviest Factors:
1. [Factor] — [Why it was decisive]
2. [Factor] — [Why it was decisive]
3. [Factor] — [Why it was decisive]

Persuasion Log:
- Persuaded by [Agent] on [claim]. Changed position from [X] to [Y] because [specific reasoning].
- No other position changes during this execution.

Mind Changes:
- Initially assumed [X]. While analyzing [evidence], realized [Y]. Revised to [Z]. Confidence [increased/decreased] because [reasoning].

Unanswered Questions:
- [Question]. Would need [data/access] to resolve. Could change [aspect of result].

Lingering Concerns:
- [DM reservation that survives the process — the DM's own dissent or caution]

Minority Views:
- [Agent name]: [Position held]. [Why it wasn't adopted into consensus].
```

---

## Quality Sentinel Output (Specialized Schema)

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
