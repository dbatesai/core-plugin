# Self-Evolution

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this at session end, when memory hygiene runs a comprehensive pass, and when writing an analysis-protocol effectiveness report.

## Universal self-improvement (architectural invariant)

Universal self-improvement isn't a feature; it's an architectural invariant. Every protocol, process, and component must carry a self-improvement mechanism. If a component doesn't, it's incomplete.

This includes the self-evolution mechanism itself — it must evaluate its own effectiveness across sessions and surface improvements.

## Continuous self-evaluation (spec §2.3)

Storage and retrieval are not frozen. You watch your own performance and adjust:

- **Under-recall** — query ran, relevant unit didn't surface. Why? Wrong tier? Topics mis-tagged? Edge missing? Fix by adding the edge or restructuring the unit. Adjust priority weights if a class of queries keeps under-recalling.
- **Over-recall** — Tier 1 returned 14 units when 3 was the scope. Priority function under-weighting alignment? Query under-specified? Tune.
- **Stale-surfacing** — units that should have archived keep coming back. Anti-resurrection failure or recency under-weighting.
- **Voice drift** — re-read your own recent narration. Does any of it sound like a coding assistant wrote it? Course-correct in-flow.
- **Smuggled architecture** — did you make a structural commitment the user didn't authorize? Surface it as a fix, name it as a smuggle, propose alternatives.

The structural adjustment options, in order of cost:

1. **Add an edge.** A single missing `cites` or `references-topic` often fixes retrieval. Free.
2. **Restructure a unit.** Split into two, merge two into one, change the prefix. Cheap but breaks existing cites — handle inverse-edge updates.
3. **Re-tune priority weights** in the plugin's `scripts/priority.mjs` (DC-77 — weights live in the plugin and propagate via plugin update, not per-project copies). Document the change in the hygiene retrospective.
4. **Evolve query shape** — change how you phrase retrieval prompts internally.
5. **Escalate infrastructure** — vector store, graph DB, or other. Earned only after repeated trip-wire firings per DC-67. Two consecutive Explore-miss cycles pointing at the same gap means it's time for a new DC.

## Trip-wire escalation for infrastructure

DC-67 named four trip-wires for when CORE's native-tools-first stance gets reconsidered:

1. Corpus grows past ~50K files AND measured Grep latency > 500ms on common queries repeatedly → revisit lexical infrastructure (likely a ripgrep daemon behind MCP, not a different substrate).
2. Multi-hop graph walks become frequent AND walk latency > 2s on real measurements → generate `adjacency.json` at hygiene time first; only if that's still slow does a graph engine earn its place.
3. Documented repeated Explore-miss pattern where lexical+graph also fail across multiple sessions on different queries → vector store behind MCP earns its place.
4. A second writer enters the system AND demonstrably conflicts AND direct-write + file-locking proves insufficient → event-log + materializer earns its place.

One cycle of a trip-wire firing is a signal. Two consecutive cycles = propose a DC committing to the next-step infrastructure. Don't escalate on the first signal — the cost of premature infrastructure is the v1 dream we just simplified away from.

## Auto-memory (every session)

Auto-memory at `~/.claude/projects/<hash>/memory/` is scratch cache, not authoritative state. The harness writes it. You treat it as a fast-access summary of what was learned, but on every bootstrap, auto-memory is re-verified against PROJECT.md (for project facts) and `dm-profile.md` (for cross-project patterns). If auto-memory disagrees with synthesis, synthesis wins and auto-memory gets updated.

Why scratch cache: the user's control over project knowledge runs through PROJECT.md. If auto-memory were authoritative, the user could delete a fact from synthesis and you'd still "remember" it — breaking the user-control invariant. Auto-memory's role is acceleration, not persistence.

**Capture automatically after every session:**

1. Save key cross-session insights to auto-memory (user, feedback, reference, project types). Don't save project-specific facts as authoritative — those go to PROJECT.md or `_memories/`.
2. Save effective agent configurations from multi-agent runs to `~/.core/agents/<name>.md` for future reuse.
3. Save effective analysis-protocol configurations by task type to `~/.core/task-configs/<type>.md`. Check this folder before composing a new swarm.
4. Record strategy effectiveness per problem type.
5. Sync cross-project learnings to `dm-profile.md` — user preferences, personality refinements, portfolio patterns. Never project-specific facts.
6. Update PROJECT.md §Decisions & Risks, §Moves, §Notes, §People as the session-close step. The corresponding units get the matching frontmatter updates.

**Bootstrap invariant:** on the next session start, if auto-memory carries a project-specific fact not present in PROJECT.md or `_memories/`, you treat the fact as deleted-by-user and rebuild auto-memory from current synthesis. That's the structural enforcement of the user-control invariant.

## Session-end self-evolution

1. Evaluate the session — what produced good work, what produced friction.
2. Make concrete self-improvement recommendations. "Try X next session" beats "do better at Y."
3. Write the improvement summary to the screen for the user at session close.

## Analysis-protocol efficacy narrative

After running a multi-agent analysis via `protocols/analysis.md`, append to the workspace narrative at `~/.core/workspaces/<id>/swarm-narrative.md`. Not a mechanical record — a reflective account written for your own future swarm runs in this workspace.

Each entry captures: what this swarm revealed about agent effectiveness, what you chose to eliminate and why, what you preserved and why, and what questions remain open. Workspace-scoped — stays distinct from cross-workspace learnings in `dm-profile.md`.

## Analysis-protocol effectiveness report

After every substantial multi-agent run, write a structured effectiveness report to `~/.core/swarm-effectiveness/<workspace-id>-<YYYY-MM-DD>.md`.

| Section | What to cover |
|---|---|
| Strategy choice | Which strategy was selected, why, how it performed against alternatives |
| Team composition | Who was on the team, what value each member delivered, which assignments were well-matched |
| Failure mode audit | Explicit assessment against all four named failure modes (see below) |
| Process signals | Measurable signals where available — confidence deltas, estimate drift, phase quality scores |
| What worked | Specific, not generic. What techniques produced signal this run. |
| What failed | What was tried, what didn't hold up, why |
| Wish I had | Concrete experiments for the next run |
| Improvement tracking | Status of prior "Wish I Had" items tested this run: tested / improved outcome / no difference / made things worse |

The four named failure modes (premature convergence, collapsing consensus, superficial confidence, agreement quality) live in `protocols/analysis.md` under the deep-audit-gate section. Assess each explicitly in the effectiveness report — the same four names — and call out which one drove the strongest signal this run. Historical pattern: superficial confidence has been the recurring #1.

You read recent effectiveness reports before composing a new analysis-protocol invocation. Prior reports are direct calibration input.

## Self-improvement risk tiers

| Risk Level | Examples | Approval Path |
|---|---|---|
| **Low** | Effectiveness score updates, strategy ranking adjustments, memory additions, minor optimizations | Apply autonomously. Report to user at session end. |
| **Medium** | Composition rule changes, phase sequencing modifications, strategy ranking changes | Present to user with rationale and risks before applying. User approves, modifies, or rejects. |
| **High** | Protocol modifications, behavioral shifts, execution flow changes, architectural decisions | Present to user with full risk analysis before applying. User approves, modifies, or rejects. |

When in doubt, escalate. Changes that affect how CORE processes all future tasks — or changes to the self-improvement mechanism itself — are High risk by default.

## Memory hygiene (was: memory hygiene)

Every meaningful change, every `/finalize`, and on-demand: memory hygiene runs. Read `protocols/hygiene.md` for the canonical mechanism. The deeper sub-protocols (edge-integrity sweep, session-log auto-prune, etc.) live in `references/hygiene-strategies.md`.

There's no separate "memory hygiene" ritual anymore — the operations got named for what they actually do, and they fire on the natural triggers (size, signals, edits) rather than on a fixed cadence.

## Context window check

If under 30% context remaining: write or update a handoff stub at `<project>/_handoffs/handoff-<YYYY-MM-DD><letter>.md` before substantial work continues. The early-handoff discipline in `protocols/startup.md` (Long sessions — write the early handoff stub) covers the format.
