# Refinement Strategy Catalog


This catalog defines the refinement strategies available to the DM when running a swarm. Use the selection framework to choose strategies, the composition rules to combine them, and the effectiveness tracking to improve selections over time.

---

## Option 0: Single-Agent Chain-of-Thought

**The DM evaluates this option BEFORE selecting any multi-agent strategy.** Not every task benefits from adversarial challenge. Option 0 is the quality-maximizing choice when multi-agent execution would add overhead without surfacing insights a single well-prompted agent would miss.

**Use Option 0 when:** The task has a single verifiable correct answer; requires no tension between competing values or trade-offs; involves fewer than 3 analytical dimensions; or when quality ceiling is reachable without adversarial challenge (e.g., mechanical fixes, template application, straightforward implementation).

**Use multi-agent when:** The task involves judgment calls with multiple valid approaches; competing stakeholder interests; risk assessment where blind spots matter; or architectural decisions where diverse lenses surface different concerns.

**When to avoid Option 0:** Tasks that SEEM simple but carry hidden complexity — architecture changes, requirements with unstated assumptions, decisions that affect multiple stakeholders. When in doubt, choose multi-agent.

---

## Core Strategies

### GAN (Generator-Critic Adversarial Loop)

**How it works:** Generator proposes, Critic challenges. Iterate until the Critic approves or convergence criteria are met.

**Best for:** Reviews, audits, analysis — any task where adversarial challenge improves quality.

**Key mechanics:**
1. **Anti-anchoring:** Critic forms an independent assessment BEFORE seeing the Generator's proposal. This prevents the Critic from anchoring to the Generator's framing.
2. **Severity tiering:** Critic categorizes findings by severity (critical, major, minor, nitpick). Critical and major findings must be resolved before approval.
3. **Forced Deep Audit:** If the Critic approves too quickly (first pass, minimal findings), force a deeper review round. Easy approval is a signal of insufficient scrutiny, not high quality.
4. **Iteration protocol:** Generator addresses Critic's findings, Critic re-evaluates. Continue until Critic approves with documented reasoning or a maximum iteration count is reached.

**Expected behavior:** The pattern reliably kills weak ideas and strengthens good ones. A healthy GAN loop kills 70-80% of proposals — survivors are genuinely defensible.

**When to avoid:** Tasks requiring broad exploration before convergence. GAN narrows too quickly for open-ended brainstorming.

---

### CAI (Constitutional AI / Principle-Based Refinement)

**How it works:** Define a set of principles upfront. Evaluate output against each principle. Trigger refinement passes for violations.

**Best for:** Ensuring outputs meet specific standards — compliance, style consistency, safety, accessibility.

**Key mechanics:**
1. **Principle definition:** List concrete, evaluable principles before execution begins. Vague principles produce vague evaluations.
2. **Systematic evaluation:** Check each principle independently. Don't let a strong showing on one principle compensate for failure on another.
3. **Iterative refinement:** For each violation, refine the output, then re-evaluate all principles (fixing one violation can introduce another).
4. **Completion criterion:** All principles satisfied, or explicit documentation of why a principle was deliberately violated.

**When to avoid:** Tasks where the "right answer" isn't well-defined by principles. CAI works poorly for creative or exploratory work.

---

### MAD (Multi-Agent Debate)

**How it works:** Multiple agents argue positions from different perspectives. A moderator tracks the debate and synthesizes convergent findings.

**Best for:** Strategic decisions, risk assessment, complex trade-offs — tasks with multiple valid approaches and no single correct answer.

**Key mechanics:**
1. **Perspective diversity:** Each debater must have genuinely different cognitive traits and specialists. Surface diversity (different names, same thinking) produces useless debate.
2. **Position tracking:** Moderator records each agent's initial position, tracks changes, and documents what arguments caused shifts.
3. **Convergence detection:** When agents converge on a point from different starting positions, that's a high-confidence finding.
4. **Persistent disagreement:** Disagreements that survive debate are valuable signals — document them as unresolved tensions, not failures.

**When to avoid:** Tasks with clear right answers (bug fixes, syntax corrections). Debate adds overhead without value when the answer is deterministic.

---

### Karpathy Loop (Self-Critique Iteration)

**How it works:** Agent generates output, critiques its own output, revises. Repeat until self-assessment meets threshold or returns diminish.

**Best for:** Writing, code generation, polishing — tasks where iterative self-improvement works.

**Key mechanics:**
1. **Self-assessment criteria:** Define what "good" looks like before the first iteration. Without criteria, self-critique drifts.
2. **Diminishing returns detection:** Track improvement magnitude per iteration. Stop when improvement drops below threshold.
3. **Fresh-eyes pass:** After iterations, do one final read as if seeing the output for the first time. Iteration can create tunnel vision.

**When to avoid:** Tasks requiring external perspective. Self-critique has a ceiling — the agent can't challenge its own blindspots.

---

### Research Synthesis

**How it works:** Multiple researchers investigate in parallel from different angles. A fact-checker validates findings. A synthesizer integrates into a coherent whole.

**Best for:** Multi-source investigation, literature review, competitive analysis, any task requiring information gathering and integration.

**Key mechanics:**
1. **Source independence:** Researchers must investigate independently before sharing. Early sharing contaminates independent discovery.
2. **Contradiction register:** Maintain an explicit list of contradictions between researchers' findings. Contradictions require resolution or documentation.
3. **Confidence calibration:** Each finding tagged with confidence level and supporting evidence. Synthesizer weights accordingly.
4. **Gap identification:** After synthesis, explicitly identify what's missing — what questions weren't answered, what sources weren't consulted.

**When to avoid:** Tasks where the information is already known and the challenge is analysis or decision-making, not discovery.

---

## Strategy Selection Framework

Use this table as a starting point. Adjust based on task-specific characteristics and historical effectiveness data.

| Problem Type | Primary Strategy | Secondary | Notes |
|-------------|-----------------|-----------|-------|
| Code review / audit | GAN | CAI for standards compliance | Anti-anchoring critical. |
| Architecture design | MAD | GAN for validating chosen approach | Multiple valid approaches need debate first. |
| Bug investigation | Research Synthesis | Karpathy for developing the fix | Parallel investigation finds root cause faster. |
| Documentation writing | Karpathy | CAI for style/completeness standards | Self-critique works well; CAI catches standard violations. |
| Requirements analysis | GAN + MAD blend | — | Adversarial challenge + multi-perspective. Blend, don't chain. |
| Risk assessment | MAD | GAN for stress-testing worst cases | Diverse risk perspectives essential. |
| Implementation (code) | Karpathy | GAN for post-implementation review | Generate-refine loop, then adversarial review of result. |
| Strategic planning | MAD | Research Synthesis for inputs | Debate needs grounded inputs; research feeds debate. |
| Compliance / standards | CAI | GAN for edge cases | Principle-based is the natural fit. |
| Exploratory research | Research Synthesis | MAD for interpreting findings | Discover first, then debate meaning. |

### Selection Decision Process

1. **Classify the problem type** from the table above. If it doesn't fit, identify the closest match and note the differences.
2. **Check effectiveness history** for this problem type. Indexed globally, not per workspace.
3. **Consider task-specific factors:**
   - High stakes → prefer adversarial strategies (GAN, MAD)
   - Time-constrained → prefer focused strategies (Karpathy, single-pass GAN)
   - Ambiguous requirements → prefer exploratory strategies (MAD, Research Synthesis)
   - Clear standards exist → include CAI
4. **Select primary strategy.** Optionally select a secondary for chaining or blending.
5. **Document reasoning**: problem classification, data consulted, strategy chosen, rationale.

---

## Strategy Composition

Strategies can be combined. Two composition modes:

### Chaining (sequential across phases)

Each phase uses a different strategy. Output of one phase feeds the next.

**Example: Architecture design**
```
Phase 1: Research Synthesis
  → Gather information about constraints, prior art, available technologies
  → Output: research findings with confidence levels

Phase 2: MAD
  → Debate architectural approaches using research findings as input
  → Output: ranked approaches with trade-off analysis

Phase 3: GAN
  → Generator details the top approach; Critic stress-tests it
  → Output: validated architecture with identified risks

Phase 4: Karpathy
  → Polish the architecture document through self-critique iteration
  → Output: final architecture document
```

**Rules for chaining:**
- Each phase must have a clear handoff — what output it produces and what the next phase needs
- Tag phase outputs with quality and confidence assessments
- Later phases can reference earlier phase outputs

### Blending (simultaneous within a phase)

Two strategies operate together within a single phase.

**Example: Requirements analysis (GAN + CAI blend)**
```
Generator proposes requirements
Critic challenges requirements (GAN)
  AND each iteration checked against constitutional principles:
    - "Every requirement must be testable"
    - "No requirement contradicts an existing one"
    - "Each requirement traces to a user need"
(CAI principles checked alongside adversarial challenge)
```

**Rules for blending:**
- One strategy is primary (drives the interaction pattern), the other is supplementary (adds constraints or checks)
- Don't blend more than two strategies — complexity overwhelms value
- Document which strategy is primary and which is supplementary

### Full Compositional Freedom

The DM has full freedom to compose strategies as the task demands. The modes above are patterns, not constraints. Novel compositions are encouraged when justified — document the reasoning and record effectiveness for future reference.

---

## Adaptive Switching

### Monitoring Signals

During execution, continuously monitor:

| Signal | How to Detect | Threshold |
|--------|--------------|-----------|
| **Convergence stall** | Agents repeat positions without progress across 2+ iterations | Switch after 3 stalled iterations |
| **Quality plateau** | Improvement per iteration drops below meaningful change | Evaluate whether this is natural convergence or wrong strategy |
| **Quality decline** | Later iterations score worse than earlier ones | Switch immediately; preserve best prior output |
| **Agent disengagement** | Repetitive responses, shallow critiques, agreement without substance | Persona refresh first; switch if refresh doesn't help |
| **Effort-to-improvement ratio** | High iteration count with small cumulative improvement | Switch when ratio exceeds 3:1 (3x effort for 1x improvement) |

### Switch Protocol

When switching strategies mid-execution:

1. **Preserve all prior work.** Nothing is discarded.
2. **Tag prior output** with:
   - Quality assessment (how good is it?)
   - Confidence level (how confident are you in the assessment?)
   - What the prior strategy accomplished and where it stalled
3. **Document the switch** — why the current strategy isn't working, what you expect the new strategy to do better
4. **Brief the new strategy** with tagged prior output. The new strategy decides how much weight to give prior work based on the trust level.
5. **Don't restart from zero** unless prior work is actively misleading.

### When NOT to Switch

- **Natural convergence looks like stalling.** GAN loops where the Critic has fewer findings each round are converging, not stalling. Check whether the remaining findings are substantive.
- **Some strategies have slow starts.** MAD debate needs a few rounds before meaningful convergence appears. Don't switch after round 1.
- **Sunk cost is not a reason to stay**, but neither is impatience a reason to switch.

---

## Strategy Research

### Just-in-Time Research

When no existing strategy is a good match for the current task:

1. Identify what makes this task different from known problem types
2. Research approaches — check academic literature, industry practices, prior CORE session logs
3. Design a strategy tailored to this problem type
4. Document the new strategy with: name, mechanics, best-for, when-to-avoid
5. Execute it and record effectiveness

### Proactive Research

The DM may schedule strategy research during low-activity periods:

- Investigate strategies for anticipated future task types
- Deepen understanding of underperforming strategies
- Study composition patterns that haven't been tried

### Catalog Updates

New strategies are added to this catalog with:

- Name and description
- Detailed mechanics (how to execute it step by step)
- Problem-type applicability (what it's best for, when to avoid)
- Initial effectiveness assessment (from the first execution)
- Composition notes (how it chains/blends with other strategies)

---

## Effectiveness Tracking

### What to Track

After every execution, record:

| Field | Description |
|-------|-------------|
| **Problem type** | Classification of the task |
| **Strategy used** | Primary and secondary strategies |
| **Composition mode** | Chain, blend, single, or novel |
| **Outcome quality** | Assessment of result quality |
| **Convergence speed** | How many iterations to reach acceptable quality |
| **Strategy switches** | Whether a switch was needed and why |
| **Team composition** | What agents were used (traits + specialists + roles) |
| **Key learnings** | What worked, what didn't, what to do differently |

### How to Index

Effectiveness data is indexed **globally by problem type**, not per workspace. A GAN strategy that works well for code review should be findable regardless of which workspace it was used in.

### How to Use

When selecting strategies for a new task:

1. Look up the problem type in effectiveness records
2. Check which strategies have been tried and their outcomes
3. Prefer strategies with proven track records for this problem type
4. When trying a new strategy for a known problem type, document why you're diverging from the proven approach
