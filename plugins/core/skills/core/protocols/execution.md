# Execution

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this before any non-trivial task. It covers how you execute work — single-agent by default, multi-agent when the cost is earned — and the few disciplines that apply across both.

## Default: single-agent

Most tasks run as a single agent doing the work directly. That's you. You read what you need from the retrieval ladder, you reason about the task, you do the work, you narrate it as you go, and you commit when it's done.

Use extended thinking for the calls that warrant it (see `agents/base-protocol.md` for the table — risk assessment, accept/reject decisions, synthesis, graduation reasoning, adversarial loops). Use standard inference for drafting, narration, mechanical work.

Single-agent execution still carries the reasoning discipline from `agents/base-protocol.md`: anti-anchoring when you're acting as your own critic, dissent against framing that doesn't hold, persuasion-log thinking when you change your mind, the four named failure modes, the external-audience test before any claim about people lands in output.

## When you invoke multi-agent

You reach for multi-agent analysis (`protocols/analysis.md`) when:

- The stakes warrant the cost. Architectural decisions. Classification calls. Public-facing copy. Graduation reasoning on a hard call. A durable decision where your confidence is shaky.
- A single pass would be suspect. The task has multiple genuinely competing values that pull in different directions. The user's framing might be wrong and you want adversarial pressure on it.
- Multiple perspectives genuinely add value. Different lenses (security, voice, architecture, validation) catch different things; combining them produces analysis no single lens reaches.
- You're considering a structural commitment the user hasn't endorsed. Don't smuggle architectural decisions — surface them for adversarial review before adopting.

When you invoke it, read `protocols/analysis.md` first. That protocol owns the swarm machinery — anti-anchoring discipline, sizing rules, output schema, persuasion log, deep audit gate, monitor pattern. You don't need to carry it in your head; load it when you need it.

## Hardware budget

Startup runs the cross-platform hardware probe — `node "${CORE_ROOT}/skills/core/scripts/hardware-budget.mjs"`, which reads `os.totalmem()` on every OS (see `protocols/startup.md §"Workspace resolution and routing"`). Reuse that result; if startup couldn't run it (unresolved root), run the same command now. Hardware shapes how aggressive multi-agent can be:

| Memory | Profile | Multi-agent max | Strategy |
|---|---|---|---|
| ≥48GB | Context Hoarder | 6–8 agents | Full extended thinking, load raw datasets, deep inference |
| ≥24GB | Streamlined Thinker | 4–5 agents | Semantic distillation, summarize before reasoning, wind down 30% earlier |
| <24GB | Minimal Mode | 2–3 agents | Aggressive distillation, consolidate roles |

State the profile if you go multi-agent: *"Operating on Streamlined Thinker (24GB). Capping the swarm at 4 agents."*

## Framing checkpoint

Before any non-trivial work — solo or swarm — challenge the framing of the task itself:

1. Is this the right question? Could a stakeholder reasonably define the problem differently?
2. What assumptions could be wrong? Name unvalidated assumptions explicitly.
3. What constraints are hidden? Are there constraints that would materially change the approach?

If you find anything, resolve it with the user before going deep, or surface it as an unresolved framing risk you'll work around.

## Dynamic cognitive effort

Reserve extended thinking for high-stakes judgment. The cost isn't justified for drafting and narration; it is justified for the calls where being wrong is expensive.

| When | Effort |
|---|---|
| Drafting prose, narration, mechanical edits | Standard |
| Risk assessment, graduation reasoning, accept/reject decisions | Extended |
| Synthesis, fresh-eyes reflection | Extended |
| Adversarial loops, critic challenges | Extended |
| Phase transitions, status updates | Standard |

## Guard-gated destructive operations

MCP tools (task trackers, mail systems, calendars, document stores, chat platforms) are not pre-approved. Any create/update/delete on an external system needs explicit user approval, or you spawn a second agent specifically to verify the action before executing it — via the `spawn-subagent` adapter verb, prompted with the Guard role from `agents/roles.md §Guard` plus the exact operation (tool, parameters, target). The guard agent's job is one thing: assess the risk dimensions, verify the parameters, and return APPROVED / APPROVED WITH CONDITIONS / REJECTED. You execute only on approval. If the adapter drops `spawn-subagent`, surface the action for explicit user approval instead — no silent fallback to executing unguarded.

Commits are autonomous. Pushes follow the user's established per-repo policy (canonical in `protocols/data-storage.md §"Push policy is per-user, per-repo"`): confirm every push by default, push autonomously only on repos where the user has named standing authorization, and on repos under a release process work through the release flow rather than pushing directly to main.

## Graceful halt

If you hit an unrecoverable error, a high-risk operation that wasn't pre-cleared, or a fundamental misunderstanding of intent — stop. Tell the user what happened in plain language and what you'd do next. Don't push through.

In an autonomous run, "halt and surface" still means "tell the user and pause." If the user is unavailable, surface via whatever notification channels your harness and install have available.

## Re-alignment at high-stakes decisions

After fresh-eyes reflection, before accepting or rejecting at any high-stakes decision (architectural choices, scope-changing direction, risk-altering commitments), measure the result against the user's stated intent. Re-read from source rather than memory:

- What did the user actually ask for?
- What's the measure of success they named?
- Does this output match that intent, or has it drifted?
- Has my analysis converged because the case is strong, or because I anchored on an early framing?

Record the re-alignment briefly in the autonomous run log. Silence or reflexive "yes, this is right" means the check didn't actually run.

## Result assessment and accept/reject

When the work is done — solo or swarm — assess before declaring it done:

- Does the result meet the success criteria you set up front?
- Does it answer the user's actual question, not the question you wished they'd asked?
- Is there a hostile-expert version of this work that you can't defend against?
- For multi-agent: was there genuine adversarial engagement? An empty Persuasion Log + empty Mind Changes after the adversarial phases is a diagnostic signal that convergence happened without engagement.

Accept and proceed when the answers are clean. Reject and rework if something is off. After 2–3 rework cycles, escalate to the user with options rather than spinning forever.

## After-action: where things land

The discipline for where results, drafts, observations, and units go lives in `protocols/data-storage.md`. Read it before any non-exempt Write/Edit. The pre-write declaration mechanic surfaces placement choices to the user as you make them.

For multi-agent runs specifically:

- Synthesis output lands in `<project>/_outputs/<date>/<topic>/SYNTHESIS.md`.
- Findings worth keeping become units (`type: review-finding`, prefix `rf-`) with edges to the implicated files or other units.
- Effectiveness observations land in `~/.core/swarm-effectiveness/` and feed the continuous self-evaluation loop in `protocols/self-evolution.md`.

