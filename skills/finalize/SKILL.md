---
name: finalize
description: Session closing skill — reconcile state, write the session summary, render PROJECT.md from units, run memory hygiene
user-invocable: true
---

# `/finalize`

You're closing the session. Project state has been updating continuously — observations get written as the user talks, units get graduated as patterns emerge, PROJECT.md sections re-render when something meaningful changes. Finalize is where you verify everything's coherent, run the hygiene pass, write the human-readable summary, and leave a clean state for the next bootstrap.

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

Write a one-paragraph honest assessment. It goes into the summary.

---

## Step 2 — Reconcile units, render PROJECT.md

Project state has been updating continuously. Finalize is when you verify the render is current and the units that drive it are complete.

1. **Reconcile open observations.** Any unprocessed observation that's been referenced more than twice this session, or that captures a substantive cross-session-relevant claim, gets graduated to a unit per `protocols/hygiene.md` §Graduation. Anti-miss bias: when in doubt, write the unit.

2. **Update touched units.** For every unit you wrote to during the session, verify frontmatter — `updated:` timestamp, `last_accessed:`, `access_count:`, edges. Make sure inverse edges are set on `supersedes` / `depends-on` / `conflicts-with`.

3. **Regenerate indexes.** Run the index generators for any unit types that changed this session — typically `_memories/INDEX-decisions.md` via `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs <project>/_memories/` (ships with the plugin per DC-77). The scripts auto-detect — if you pass a project root with a `_memories/` subdir, they write inside it; otherwise they write to whatever path you passed.

4. **Render PROJECT.md from units.** Walk canonical units, compose the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes), and show the user the draft. **Skip re-render when the user's PROJECT.md is curated and the new units are sparse backing-only.** Anti-resurrection cuts both ways — don't strip the user's curation just because the unit store is thin. If the existing PROJECT.md already reflects current truth and the new units add traceability without changing what the user sees, present the existing PROJECT.md for re-acceptance and note the choice; don't re-render from a sparse unit set.

5. **Render-and-accept.** Present the draft (or the preserved-existing PROJECT.md per the skip rule above). User accepts (Mode A continues) or edits (Mode B-ish — edits become ground truth, propagate back to units, anti-resurrection fires for removals). Commit the accepted version.

---

## Step 3 — Memory hygiene pass

Walk the unit store and run the hygiene operations from `protocols/hygiene.md`:

- **Archive proposals** — surface low-priority candidates (R·S < 0.05, no recent reference) for `y / N / per-unit` approval. User-authored units always gate here.
- **Retire confirmations** — any unit whose claim disappeared from PROJECT.md this session gets `status: retired`.
- **Cold-store proposals** — surface any archived-and-retired-and-365d+ units.
- **Index regeneration** — re-run if you see drift from Step 2; also run for any unit types changed this session.
- **File-cap check** — if any synthesis file is over the Read-tool threshold, follow the graduation pattern in `protocols/hygiene.md`.
- **Continuous self-evaluation** — review session-level signals (under-recall, over-recall, voice drift, smuggled architecture); write the retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`.
- **Retrieval-quality surfacing** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project>` and narrate top anomalies in plain voice. Same shape `/process-memory` uses. If the project has no `_sessions/*/retrieval-log.jsonl` yet, say so in one sentence; don't pretend the corpus exists.

The deeper sub-protocols (edge-integrity sweep, session-log auto-prune) live in `references/hygiene-strategies.md`.

---

## Step 4 — Write the session summary

`<project>/_summaries/summary-<YYYY-MM-DD>.md` (with letter suffix if today already has one).

The summary is a human-readable narrative of the session for the user to review later — what got done, what got decided, what's open. It's not part of how the next session orients itself. Project facts worth keeping across sessions were already promoted into PROJECT.md and `_memories/` during the session; the next bootstrap reads those, not the summary. The summary is a safety net (if the unit store ever gets corrupted, you could reconstruct from summaries) and a record for the user.

```markdown
# Session Summary — <YYYY-MM-DD>

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

Summaries are write-only from your perspective — you don't re-read them at bootstrap. The anti-resurrection rule applies: re-reading a summary could resurrect facts the user removed from PROJECT.md after it was written. Future bootstraps load from PROJECT.md and `_memories/`; the summary stays as a human record.

---

## Step 5 — Update Claude Code's auto-memory cache

Claude Code automatically loads the per-project MEMORY.md at the start of every session (the first 200 lines, before any tool call). CORE writes into that folder so the next session's bootstrap starts warm. Authoritative project facts live in PROJECT.md and `_memories/` — auto-memory just carries pointers, session-level feedback, and summaries that help the next session orient fast.

The file naming is a CORE convention layered on top of the harness folder:

- User preferences and feedback → `feedback_*.md`
- Project context summaries → `project_*.md`
- User-profile updates → `user_profile.md`
- Pointers to external systems → `reference_*.md`

Update the `MEMORY.md` index in the same operation. Don't write project-specific facts as authoritative here — those live in PROJECT.md or `_memories/`. Auto-memory carries pointers and summaries.

Apply the memory hygiene rules: update stale memories rather than adding duplicates; remove memories that were proven wrong; keep `MEMORY.md` current.

### Refresh the auto-memory index

After capturing session-specific memories, refresh `MEMORY.md` from the top-priority canonical units. This is a mechanical formatting operation.

Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs <project>/_memories --top 30` and read the current `~/.claude/projects/<mapped-cwd>/memory/MEMORY.md`. Then rewrite `MEMORY.md` so each top unit is a one-line markdown bullet linking to its unit file, followed by an em-dash and a one-line hook (match the existing entries' shape). Preserve user-added entries that are still relevant, drop entries pointing to retired units, keep the file under 200 lines.

Do this inline in the main agent — don't dispatch a subagent. The previous Haiku-subagent design required `git worktree`, which fails on non-git workspaces (any cloud-sync-backed project, any non-versioned project directory) with *"Cannot create agent worktree: not in a git repository."* Per CORE's harness-agnostic design intent, git is not a precondition for project intelligence. Project intelligence workspaces hold data, not code — versioning isn't the right tool here. The refresh is fast enough inline that blocking on it isn't a real cost.

Narrate the refresh plainly: *"Refreshing MEMORY.md from the top 30 units now."* Then proceed to the closing declaration.

---

## Step 6 — Closing declaration

After all steps complete, declare in plain voice. Concrete shape:

> *"Session closed. Summary at `_summaries/summary-<date>.md`. PROJECT.md rendered from current units. Hygiene pass complete — N archives, M retires, no cold-stores this pass."*

If anything couldn't be completed, name it explicitly. Don't silently skip a step. Surface the blocker plainly and recommend a next move.
