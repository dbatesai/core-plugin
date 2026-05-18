# Multi-Agent Analysis

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this when you've decided to invoke multi-agent analysis. This protocol owns the swarm machinery: anti-anchoring discipline, sizing, phases, output shape, the persuasion-log requirement, the deep audit gate, the monitor pattern, the external-audience test. It also covers research mode — investigator swarms when the task is research-primary.

You read `protocols/execution.md` first to confirm multi-agent is warranted; you read this when the decision is made and you're composing the swarm.

## § 1 — When to invoke

Multi-agent earns its cost on tasks where a single pass would be suspect. The criteria from `protocols/execution.md`:

- Stakes warrant the cost — architectural decisions, classification calls, public-facing copy, graduation reasoning on a hard call, durable decisions where confidence is shaky.
- A single pass would converge sycophantically — there are genuinely competing values, multiple reasonable framings, or strong priors that need adversarial pressure.
- Multiple perspectives add value — different lenses (security, voice, architecture, domain expertise) catch different things.
- Structural commitment the user hasn't endorsed — don't smuggle architectural moves; surface them for adversarial review.

If the task doesn't meet at least one of these criteria, you're paying the multi-agent cost for a task a single agent would have done well. Reconsider before composing.

## § 2 — Swarm sizing

| Scope | Roster | When |
|---|---|---|
| Focused check | 3 agents | Targeted spec compliance, voice audit, single-domain review |
| Comprehensive review | 4–5 agents | Architectural review, multi-lens analysis, classification work |
| Research investigation | 3–5 agents (researchers + critic) | Topic decomposition, source-finding, evidence-weighing, synthesis |

Critic is always present. Anti-anchoring discipline is non-negotiable regardless of roster size.

Hardware budget caps the upper end. From `protocols/execution.md`: ≥48GB → up to 6–8; ≥24GB → 4–5; <24GB → 2–3.

## § 3 — Anti-anchoring enforcement

The Critic frames their independent position BEFORE seeing the Generator's output. This is the single most important piece of multi-agent discipline — it's what fights the empirically observed 84.5% sycophancy flip rate in LLM critics.

Operational pattern:

1. The Critic writes their top N predicted failure modes for the task, in isolation, before reading anything the Generators produced.
2. Then the Critic reads the Generators' output.
3. Then the Critic tests each prediction against what was actually produced (CONFIRMED / NOT CONFIRMED / PARTIAL).
4. Findings beyond the predictions are noted as "additional issues."

When you spawn the Critic agent, its prompt must include this discipline explicitly. Don't trust the model to do it on its own — the sycophancy pull is strong.

## § 4 — Execution phases

Five phases. Each has a clear transition criterion. Don't advance unless the criterion is met.

| Phase | What happens | Transition criterion |
|---|---|---|
| **0 Setup** | Compose briefing, name the team, spawn agents, share briefing | All agents acknowledged briefing |
| **1 Independent framing** | Each agent frames the task in isolation; Critic writes predictions before reading anyone else | ≥80% of agents have broadcast their independent position |
| **2 Cross-pollination** | Agents share findings; Critic reads Generators; surprise lenses surface | All agents have read and acknowledged others' findings |
| **3 Adversarial pressure** | Critic challenges Generators with evidence; Generators defend or update; persuasion-log entries land | Diminishing returns for 2+ exchanges, OR convergence-watch trips |
| **4 Synthesis + deep audit** | DM composes synthesis; deep audit gate runs (see §8); accept or reject | Deep audit passes the four named failure modes |

Phase transitions are decisions, not timers. If Phase 3 produces flat agreement after one round, that's a convergence-watch trip — see §7.

## § 5 — Output shape

Multi-agent runs land structured output in two places:

- **Synthesis** at `<project>/_outputs/<YYYY-MM-DD>/<topic>/SYNTHESIS.md`. Contains the eight-section CORE output (per `agents/base-protocol.md`), the briefing it ran against, and the team composition.
- **Review-finding unit** at `<project>/_memories/rf-<topic>-<YYYY-MM-DD>.md` (or `rf-<topic>.md` if it's an ongoing finding). Frontmatter includes `type: review-finding`, edges (`cites`) to every file or unit implicated by the findings, and an edge back to the SYNTHESIS doc.

Why both: the SYNTHESIS holds the full narrative for the human reader; the unit holds the durable, retrievable record that surfaces in future retrieval-ladder queries.

Effectiveness observations land in `~/.core/swarm-effectiveness/<workspace-id>-<YYYY-MM-DD>.md` per `protocols/self-evolution.md`.

## § 6 — Persuasion log + mind changes

Both fields are mandatory in every agent's output, and in the synthesis.

**Persuasion log.** What other agents said that changed your mind, and why. Who persuaded you, the specific argument, what position you held before. An empty persuasion log after the adversarial phases is a diagnostic signal — it usually means convergence happened without genuine engagement, which is worse than disagreement.

**Mind changes.** Positions you revised on your own (not due to inter-agent persuasion) as you deepened your analysis. Distinct from the persuasion log.

If the synthesis carries empty Persuasion Log + empty Mind Changes, that's a deep-audit failure. Reject; re-run Phase 3 with more pressure.

## § 7 — Monitor pattern

A Monitor agent is part of the swarm whenever the stakes are high. Its job is to catch patterns the working agents can't see in themselves — sycophancy, premature convergence, collapsing consensus, scope drift.

Monitor's escalation ladder:

| Level | Trigger | Action | Required response |
|---|---|---|---|
| First warning | Monitor flags a concern | Warning broadcast to team | Agents acknowledge; decide whether to change course |
| Second flag | Same concern persists | Monitor escalates to DM | DM evaluates; the call is final |

Monitor is a peer in the communication mesh, not a passive observer. It can challenge, request evidence, and demand recalibration.

## § 8 — Deep audit gate

Before accepting any convergence claim, run the deep audit. Four named failure modes — assess each explicitly:

1. **Premature convergence** — agreement arrived before real adversarial pressure was applied.
2. **Collapsing consensus** — positions narrowed because of social dynamics, not evidence.
3. **Superficial confidence** — high-confidence claims without proportionate justification.
4. **Agreement quality** — was the agreement on what claims actually mean, or just on the same words?

Each failure mode gets a named call: "Premature convergence: not detected — the Critic ran predictions in Phase 1 and held a contradicting position through Phase 2." Empty assessment is not allowed.

If any failure mode is detected, the result is rejected and the corresponding phase reruns with corrective pressure.

## § 9 — External-audience test

Before any claim about a person or group enters the synthesis output, ask: would a reasonable stakeholder — who lacks the original informal context — find this characterization appropriate if they read it in a status report? If not, redact the individual attribution, describe the structural concern without it, or surface as an Unanswered Question.

This is the same test in `agents/base-protocol.md` — restated here because it's the gate between the swarm's internal reasoning and the user-facing output.

## § 10 — Research mode

When the task is research-primary (investigation, document synthesis, comparative analysis), the swarm composition shifts toward researchers + a critic, and you adopt the research-document discipline.

**Two modes within research:**

- **Synthesis mode** — the user provides source documents. The swarm classifies them by source quality, cross-references claims, and synthesizes convergence-mapped findings.
- **Investigation mode** — the user provides a topic or question. The swarm decomposes it into research questions, finds sources (typically via WebSearch / WebFetch / Firecrawl), verifies findings, and synthesizes.

**Source quality classification.** Every cited claim carries the credibility of its source. The formality spectrum (per `agents/base-protocol.md`): formal (RFCs, design specs, approved comms) > semi-formal (tracked issues, recorded minutes) > informal (chat, 1:1s, unrecorded). Informal signal can direct attention; it cannot anchor claims about people in formal output.

**Research library.** Outputs from investigation runs land in `~/.core/research/<topic>-<YYYY-MM-DD>.md` when they're generalizable across projects, or in `<project>/_outputs/` when they're project-specific. The split is one question: would this finding be useful on a different project? If yes, generalize and put it in `~/.core/research/`.

**Provenance discipline.** Every research document carries `sources:`, `sensitivity:` (public/internal/restricted), and `derived-from-restricted:` (true/false) in frontmatter. Sensitivity inherits from source material. If a finding is supported only by informal sources, name it as such — don't fill the gap with an informal attribution.

**Quality scoring.** Research documents carry evidence_quality (1–5), confidence (0.0–1.0), and a brief justification for both. Score caps when methodology is degraded (e.g., no parent agent definitions for swarm spawn): evidence_quality ≤ 3, document marked `degraded_mode: true`.

**The library is self-improving.** When new research supersedes old, write a `supersedes` edge in the new doc's frontmatter and `superseded_by` in the old one's. Nothing is deleted; supersession is the audit trail.

## § 11 — When NOT to invoke

Don't reach for multi-agent when:

- The task is mechanical (find/replace, rename, format-only edit).
- The task has one obvious correct answer and a single agent will produce it.
- The cost — token spend + wall time — exceeds the value of the marginal quality improvement.
- A single agent with extended thinking would converge to the same answer faster.
- The user has explicitly asked for a quick answer and the stakes don't override that.

Multi-agent is one tool, not the product. If single-pass works, use single-pass.

## § 12 — Briefing structure

The briefing is what gets injected into each agent's prompt at spawn time. It's the durable artifact the team reads at start and the DM re-reads during monitoring.

Minimum viable briefing — every swarm:

1. **What to do** — task description.
2. **Why it matters in project context** — project state summary.
3. **How to know it's done** — success criteria, what matters.
4. **Active risks** — never omitted. What could go wrong, likelihood, impact, mitigation.

Structured packet for moderate/complex tasks — add:

| Field | Description |
|---|---|
| `dependencies` | What this task depends on |
| `stakeholder_context` | Who cares about this task and why |
| `constraints` | Boundaries the swarm must respect |
| `dm_perspective` | Nuance, judgment calls, contextual concerns |
| `what_matters_most` | The single most important thing to get right |
| `what_could_go_wrong` | Likeliest failure mode |

If the task is complex enough that the user might frame the problem wrong, run the framing checkpoint from `protocols/execution.md` before composing — three questions about whether you have the right question, what assumptions could be wrong, and what constraints are hidden.

## § 13 — Re-alignment before accepting

After the swarm produces its synthesis and you've completed the deep audit, run a final re-alignment check before accepting:

- What did the user actually ask for?
- What's the measure of success they named?
- Does this output match that intent, or has the swarm drifted into adjacent territory?
- Has the synthesis converged because the case is strong, or because the agents anchored on an early framing?

Record the re-alignment briefly in the autonomous run log. Silence here means the check didn't actually run.

If the synthesis drifts from the user's intent, the answer isn't to ship it anyway — it's to reject and re-spec the swarm with the corrected framing.

## § 14 — After-action

Once accepted:

1. Save the synthesis to `<project>/_outputs/<date>/<topic>/SYNTHESIS.md` BEFORE TeamDelete.
2. Write the review-finding unit at `<project>/_memories/rf-<topic>-<YYYY-MM-DD>.md` with edges to implicated files.
3. Append the effectiveness narrative to `~/.core/workspaces/<id>/swarm-narrative.md`.
4. Write the effectiveness report at `~/.core/swarm-effectiveness/<workspace-id>-<YYYY-MM-DD>.md` per `protocols/self-evolution.md`.
5. Promote generalizable insights to `~/.core/research/` (research mode) or `~/.core/agents/` + `~/.core/task-configs/` (compositional patterns).
6. Update `PROJECT.md` if the synthesis produced new decisions, risks, or moves.
7. TeamDelete to free the context.

Output saved before TeamDelete. Always. A failed TeamDelete with unsaved outputs is the worst failure mode in multi-agent execution.
