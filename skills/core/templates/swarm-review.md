# Swarm Template — Review

Read-only adversarial analysis of a task, document, or codebase. Use this shape when the work is to harden a claim or proposal through structured generator-critic dialogue.

## Roster

- 3 Generators with task-tailored expertise (e.g., framework-architect, structural-engineer, innovation-scout)
- 2 Critics — adversarial-critic (logical and bias challenges) + edge-case-hunter (concrete failure scenarios)
- 1 Quality Sentinel — establishes the measurable standards baseline and arbitrates disputes
- No Guard needed (read-only swarm)
- Monitor optional, recommended when running more than 6 agents

Hardware budget caps the upper end — see `protocols/execution.md`. Default at constrained budget: 2 generators + 1 critic + 1 sentinel.

## Phasing

The phase sequence is the standard adversarial flow in `protocols/analysis.md` §4. Two pieces specific to review work warrant attention.

The **Quality Sentinel starts first** — it reads source material and broadcasts measurable standards (WCAG ratios, schema validation rules, performance benchmarks, whatever the task makes checkable) before generators begin. Every agent gets a shared quality floor to reference.

The **edge-case-hunter** produces a structured catalog (scenario, trigger, expected behavior, likely behavior, severity) during independent analysis. The catalog becomes shared reference material during the adversarial challenge phase.

## Convergent Findings — diversity basis

When multiple agents reach the same conclusion, weight the convergence by the genuine diversity of their analytical lenses, not by agent count. Convergence from different specialist domains, different cognitive traits, and different source-material emphasis is strong evidence. Convergence from same-model agents with similar prompts is correlated sampling, not independent verification. In the convergence table, the "Diversity Basis" field names the genuine source of independence — track it explicitly.

This is the load-bearing piece of the review template. The 84.5% sycophancy flip rate means agreement among agents is not evidence of correctness; the diversity-basis field is how the synthesis distinguishes signal from anchoring.

## Expected behavior

A healthy review swarm kills 70-80% of initial proposals — the adversarial loop working as designed. Survivors are genuinely defensible because the discriminator forced the generator to produce higher-quality output. If the kill rate drops well below this, suspect insufficient adversarial pressure (Critic anchoring, missing edge cases, premature convergence).

## Output

Per `schemas/output.md` — prioritized findings (MUST FIX / SHOULD FIX / CONSIDER) with confidence levels from each agent's Heaviest Factors, convergent findings highlighted with their diversity basis, full agent reports as evidence, the DM's reflective synthesis on top.
