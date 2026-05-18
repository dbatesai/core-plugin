---
name: finalize
description: Session closing skill — reconcile state, write handoff, render PROJECT.md from units, run memory hygiene, sync skill changes if any landed this session
user-invocable: true
---

# `/finalize`

You're closing the session. This is a **reconciliation point**, not the primary state-capture event. Project state has been updating continuously through the session — observations get written as the user talks, units get graduated as patterns emerge, PROJECT.md sections re-render when something meaningful changes. Finalize verifies that everything's coherent, writes the human-readable handoff, runs memory hygiene, and ensures the next bootstrap finds a clean state.

Execute every step in order. Don't skip.

---

## Step 1 — Fresh-eyes review

Before writing anything, re-read the session from the top with fresh eyes. Reason against the user's stated intent, goal, and measure of success. Ask:

- What did we actually accomplish vs. what we set out to do?
- What decisions were made? Are they captured as units?
- Did changes in direction during the session cause anything important to slip?
- What was left incomplete? Is it tracked as a unit or in §Moves?
- What surprised us? What did we learn that wasn't expected?
- Did anything break or degrade that we didn't fix?
- Is the project better than we found it?

Write a one-paragraph honest assessment. It goes into the handoff.

---

## Step 2 — Reconcile units, render PROJECT.md

Project state has been updating continuously. Finalize is when you verify the render is current and the units that drive it are complete.

1. **Reconcile open observations.** Any unprocessed observation that's been referenced more than twice this session, or that captures a substantive cross-session-relevant claim, gets graduated to a unit per `protocols/hygiene.md` §Graduation. Anti-miss bias: when in doubt, write the unit.

2. **Update touched units.** For every unit you wrote to during the session, verify frontmatter — `updated:` timestamp, `last_accessed:`, `access_count:`, edges. Make sure inverse edges are set on `supersedes` / `depends-on` / `conflicts-with`.

3. **Regenerate indexes.** Run the index generators for any unit types that changed this session — typically `_memories/INDEX-decisions.md` via `<project>/.claude/scripts/generate-decisions-index.py`.

4. **Render PROJECT.md from units.** Walk canonical units, compose the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes), and show the user the draft.

5. **Render-and-accept.** Present the draft. User accepts (Mode A continues) or edits (Mode B-ish — edits become ground truth, propagate back to units, anti-resurrection fires for removals). Commit the accepted version.

---

## Step 3 — Memory hygiene comprehensive pass

Invoke `protocols/hygiene.md` for a comprehensive pass. This is the canonical place hygiene fires at full strength:

- Archive proposals — present low-priority candidates (R·S < 0.05, no recent reference) to the user for `y / N / per-unit` approval.
- Retire confirmations — any unit whose claim disappeared from PROJECT.md this session gets `status: retired`.
- Cold-store proposals — surface any archived-and-retired-and-365d+ units.
- Index regeneration — see Step 2.
- File-cap monitoring — check PROJECT.md and any other synthesis file against the Read tool threshold; if any are over, follow the graduation pattern documented in `protocols/hygiene.md`.
- Continuous self-evaluation — review session-level signals (under-recall, over-recall, voice drift, smuggled architecture); write the retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`.

The deeper sub-protocols (edge-integrity sweep, session-log auto-prune) live in `references/hygiene-strategies.md` and run as part of this comprehensive pass.

---

## Step 4 — Write the handoff

`<project>/_handoffs/handoff-<YYYY-MM-DD>.md` (with letter suffix if today already has one).

```markdown
# Session Handoff — <YYYY-MM-DD>

## Fresh-eyes assessment
[Your one-paragraph honest read from Step 1.]

## What was done
[Bullet list of completed work — specific, not vague.]

## Current state
[Where the project stands right now. Mirrors PROJECT.md §State but written for a human reader.]

## Decisions made
[Any architectural, design, or priority decisions — with rationale. Should align with units written this session.]

## Open work
[Incomplete items. Specific about what's left.]

## Open questions
[Unresolved questions with any partial context already gathered.]

## Active risks
[New or escalated risks this session.]

## Next session: read first
[The 3-5 most important things the next session needs before touching anything.]

## Next session: recommended start
[Specific recommended first action.]
```

Handoffs are write-only from your perspective — facts worth keeping are already in PROJECT.md or `_memories/`. The handoff is for the human reader (project review, reconstructed context after a catastrophic loss).

---

## Step 5 — Update auto-memory

Auto-memory is scratch cache; the bootstrap rebuilds it from current synthesis. Still, capture session-level insights that should accelerate the next session's load:

- New user preferences or feedback → `feedback_*.md`.
- New project context → `project_*.md`.
- Changed understanding of the user → `user_profile.md`.

Update the `MEMORY.md` index in the same operation. Don't write project-specific facts as authoritative here — those live in PROJECT.md or `_memories/`. Auto-memory carries pointers and summaries.

Apply the memory hygiene rules: update stale memories rather than adding duplicates; remove memories that were proven wrong; keep `MEMORY.md` current.

---

## Step 6 — Closing declaration

After all steps complete, declare in plain voice. Concrete shape:

> *"Session closed. Handoff at `_handoffs/handoff-<date>.md`. PROJECT.md rendered from current units. Hygiene pass complete — N archives, M retires, no cold-stores this pass."*

If anything couldn't be completed, name it explicitly. Don't silently skip a step. Surface the blocker plainly and recommend a next move.
