# CORE Swarm Template: Review

## Purpose

Read-only adversarial analysis of any task, document, or codebase. The review swarm produces high-quality recommendations through structured generator-critic dialogue, where the adversarial process forces generators to defend their proposals against substantive challenges.

## Default Roster

- **3 Generators** -- customizable expertise domains tailored to the problem (e.g., framework-architect, structural-engineer, innovation-scout)
- **2 Critics** -- adversarial-critic (logical/bias challenges) + edge-case-hunter (concrete failure scenarios)
- **1 Quality Sentinel** -- establishes measurable standards baseline, arbitrates disputes

## Guard

NOT needed. Review swarms are read-only -- no destructive operations.

## Monitor

Optional. Recommended when running more than 6 agents to track inter-agent message volume and flag outliers.

## DM Intervention

The DM is running this swarm in its own context — there is no second orchestrator. The DM intervenes directly via SendMessage, phase restarts, or a halt when the swarm drifts, convergence looks premature, or a risk condition triggers. These are course-correction tools for when the swarm is off-course, not levers for second-guessing normal role execution. Every intervention is logged.

## Hardware Scaling

| Machine | Recommended Agents |
|---|---|
| M5 Pro (24GB) | 4-5 agents (trim to 2 generators + 1 critic + 1 sentinel) |
| M4 Pro (48GB) | 6-8 agents (full roster + optional monitor) |

## Phases

### Phase 1: Quality Baseline

The quality sentinel starts FIRST. It reads all source material and establishes measurable standards (e.g., WCAG contrast ratios, schema validation rules, performance benchmarks). These standards are broadcast to all agents via SendMessage before generators begin analysis. This gives every agent a shared quality floor to reference.

### Phase 2: Independent Analysis

All generators and critics work in parallel on self-study. Generators analyze source material and form proposals. Critics form independent assessments BEFORE seeing generator proposals -- this is the anti-anchoring rule. Critics who agree with everything without pushback are anchored and must re-read source material.

### Phase 3: Cross-Pollination

Generators share findings with all other agents via SendMessage. Critics share their independent assessments. This is the information exchange phase -- agents discover overlaps, contradictions, and complementary angles.

### Phase 4: Adversarial Challenge

Minimum 2-3 rounds of generator-critic exchange. Critics challenge specific claims with evidence. Generators defend with evidence or concede and update their Persuasion Log. The DM watches for premature convergence -- if all agents agree after one round, something is wrong. Force another challenge round.

### Phase 5: Quality Arbitration

The quality sentinel evaluates all proposals against the baseline standards established in Phase 1. Proposals that violate measurable standards are flagged regardless of generator-critic consensus. The sentinel is the tie-breaker for subjective disputes.

### Phase 6: Rolling Synthesis

The DM begins synthesis as the FIRST reports arrive. Do not wait for all agents to complete. Build the synthesis document incrementally, noting convergent findings and open conflicts as they emerge.

### Phase 7: Fresh-Eyes Reflection

The DM's meta-analysis after all reports are collected. Ask: "What did I learn? What surprised me? What do these findings mean TOGETHER that they don't mean individually? What patterns emerged across agents that no single agent saw?" This reflective synthesis is the DM's highest-value contribution during a swarm.

## Edge Case Catalog

Designate one generator as the edge-case-hunter. This agent produces a structured catalog of edge cases (scenario, trigger, expected behavior, actual/likely behavior, severity) that becomes shared reference material for all agents during the adversarial challenge phase.

## Convergent Findings

When multiple agents reach the same conclusion, weight that finding by the genuine diversity of their analytical lenses — not by agent count alone. Convergence from different specialist domains, different cognitive traits, and different source material emphasis is strong evidence. Convergence from same-model agents with similar prompts is a weaker signal (correlated sampling, not independent verification). Track which agents converged, from what angle, and what was analytically different about each agent's approach. The "Diversity Basis" in the convergence table names the genuine source of independence.

## Output

Prioritized recommendation document with:
- Findings organized by priority tier (MUST FIX / SHOULD FIX / CONSIDER)
- Confidence levels per recommendation (from agent Heaviest Factors fields)
- Convergent findings highlighted
- Full agent reports as evidence base
- Orchestrator's reflective synthesis on top

## Expected GAN Behavior

The adversarial loop should kill most proposals. A healthy review swarm kills 70-80% of initial proposals — this is the GAN loop working as designed. Survivors are genuinely defensible because the discriminator forced the generator to produce higher-quality output.
