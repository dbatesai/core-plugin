# Refinement Strategies

A catalog of dispositions for multi-agent work. Use them as composable shapes the lead agent reaches for as the task warrants — not as menu items to look up by problem type. The selection call is judgment; the catalog gives the agent a vocabulary for that judgment.

## Single-agent first

Not every task warrants multi-agent execution. Before reaching into this catalog, evaluate whether a well-prompted single agent would reach the same quality ceiling. Multi-agent costs real coordination overhead and risks convergence-as-false-consensus; it earns its place only when the task has the shape that benefits from adversarial challenge or perspective diversity.

A single agent is enough when the task has a single verifiable correct answer, requires no tension between competing values, involves fewer than three analytical dimensions, or the quality ceiling is reachable without challenge (mechanical fixes, template application, straightforward implementation).

Multi-agent earns its place when the task involves judgment calls with multiple valid approaches, competing stakeholder interests, risk assessment where blind spots matter, or architectural decisions where diverse lenses surface different concerns. When in doubt, choose multi-agent — but be honest about tasks that seem simple and carry hidden complexity, and tasks that seem complex and just need careful single-agent work.

## The dispositions

### GAN — adversarial harden

A Generator proposes, a Critic challenges, they iterate until the Critic approves or convergence stalls. The point is to surface the weak claim, the unjustified leap, the hidden assumption — to kill bad proposals and harden good ones. The cost is narrowness: GAN kills exploration alongside weak ideas. The discipline is anti-anchoring — the Critic forms an assessment independently before seeing the Generator's framing; without it, the loop is theater. Quick Critic approval is a signal of insufficient scrutiny, not quality — force a deep audit when it happens. The blind spot is what neither agent thought of, and convergence between two agents is not strong evidence (the sycophancy data shows 84.5% flip under social pressure). A healthy loop kills 70-80% of proposals; survivors are defensible.

### CAI — principle gate

Define concrete principles up front, evaluate the output against each independently, refine for violations, re-check the full list (fixing one violation can introduce another). The point is to ensure the output meets a known bar — compliance, style, safety, accessibility — and to make standards checkable. Vague principles produce vague evaluations; a strong showing on one doesn't compensate for failure on another. The blind spot is what's outside the principle list. CAI can't catch what the output reveals beyond what the standards anticipated.

### MAD — perspective debate

Multiple agents argue distinct positions from genuinely different cognitive frames. A moderator tracks who said what and what changed minds. The point is to surface trade-offs no single perspective sees alone, and to make competing valid approaches visible. Persona diversity must be real, not surface-deep — different names with the same thinking produces useless debate. Sustained disagreement is valuable signal; document it as unresolved tension, not failure. Agreement is the danger. When agents converge from anchoring rather than independent reasoning, it looks like consensus but is contamination — the persuasion log (who changed whose mind, with what argument) is the diagnostic; empty fields after adversarial phases mean the process didn't work.

### Karpathy Loop — self-critique iteration

An agent generates, critiques its own output, revises, repeats until improvement diminishes. The point is polish — getting good work to better. Define what "good" looks like before the first round; without that, self-critique drifts. Track improvement magnitude per iteration and stop when returns diminish. Iteration creates tunnel vision, so do a fresh-eyes read at the end. The ceiling is the agent's own blind spots — they're also the self-critic's blind spots, and only external perspective can break through them.

### Research Synthesis — parallel investigation

Multiple researchers investigate from different angles independently. A fact-checker validates findings before they enter the synthesis. A synthesizer integrates them into a coherent whole. The point is comprehensive ground-truth from multiple sources, and distinguishing what's known from what's plausibly assumed. Source independence is the whole point — researchers sharing early contaminates discovery. The fact-checker discipline matters; without it, uncalibrated confidence rolls into the synthesis as falsely-firm claims. Contradictions between researchers need explicit resolution or documentation, not flattening. The blind spot is gaps — you don't know what you didn't research. Make missing questions explicit at synthesis time.

## When each fits

GAN tends to fit when the task is to harden a claim against challenge — code review, architectural validation, audit work. CAI tends to fit when the output must satisfy a known standard — compliance, accessibility, style consistency. MAD tends to fit when the task involves legitimate competing perspectives with no single right answer — strategic planning, risk assessment, architecture choice. The Karpathy loop tends to fit when the task is iterative refinement against a defined target — writing, code generation, polishing. Research Synthesis tends to fit when the task requires gathering and integrating information from multiple sources — literature review, competitive analysis, bug investigation needing root-cause discovery.

These are tendencies, not assignments. The same task can warrant different dispositions at different phases, and a single phase can blend dispositions. Composition is the primary practice; the catalog is starting material, not a menu the lead agent reads off.

## Composition

Strategies combine. Two recognizable patterns:

**Chaining** runs sequential phases each using a different disposition, where the output of one feeds the next. Architecture design might run Research Synthesis to gather constraints and prior art, then MAD to debate approaches using those findings, then GAN to stress-test the chosen approach, then a Karpathy loop to polish the resulting document. Each phase produces a tagged output — quality assessment plus confidence — that the next phase consumes.

**Blending** runs two dispositions together within a single phase. A requirements analysis might run GAN (Generator proposes, Critic challenges) with CAI principles checked alongside every iteration ("every requirement must be testable", "no requirement contradicts an existing one"). One disposition is primary — it drives the interaction pattern — and the other adds constraints or checks. Two strategies is the practical ceiling on blending; more than that overwhelms.

**Full compositional freedom.** Chaining and blending are recognizable patterns, not constraints. The lead agent composes whatever the task demands. Novel compositions are encouraged when justified, and surprise-persona composition is a recommended default for high-stakes work — pulling in a lens the catalog doesn't anticipate often surfaces the issue the standard roster would miss. Record the composition reasoning so future sessions can see what worked.

When the catalog doesn't fit a task at all, design a new disposition. Name it with the same disposition / wants / costs / blind spot framing so it can compose with the rest, record the first execution's outcome, and add it to the catalog. The dispositions in this file are seed material, not a closed set.

## When to switch

Watch for signals that the current strategy isn't earning its keep:

- Convergence stall — agents repeat positions across 2+ iterations without progress
- Quality plateau — improvement per iteration drops below meaningful change
- Quality decline — later iterations score worse than earlier ones; switch immediately and preserve the best prior output
- Agent disengagement — repetitive responses, shallow critiques, agreement without substance
- Effort-to-improvement ratio — high iteration count with small cumulative improvement (3x effort for 1x improvement is the rough trip-wire)

Natural convergence looks like stalling. GAN loops where the Critic has fewer findings each round are converging, not failing — check whether remaining findings are substantive before switching. Some dispositions have slow starts; MAD typically needs a few rounds before meaningful convergence appears, and switching too early throws away the work that earns the next round.

When switching, preserve all prior work — nothing is discarded. Tag the prior output with a quality assessment, a confidence level, and notes on what the prior disposition accomplished and where it stalled. Document the switch reasoning. Brief the new disposition with the tagged prior output; the new disposition decides how much weight to give prior work. Don't restart from zero unless prior work is actively misleading.

## Effectiveness over time

Record outcomes by problem type — what was tried, how it landed, what was learned. Index globally, not per workspace. A GAN approach that worked for code review should be findable regardless of which workspace it was used in. Use the record to bias future selection without locking in: when trying a different disposition for a known problem type, document why you're diverging from the proven approach, so the record stays a tool for judgment rather than a rule the lead agent follows by default.
