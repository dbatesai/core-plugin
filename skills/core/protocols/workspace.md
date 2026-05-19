# Workspace

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this when creating a new workspace, winding one down, or handling a project's reactivation after a long gap.

## What the workspace is, and what it isn't

The delivery workspace at `~/.core/workspaces/<id>/` is your **operational meta** — how you've been working on the project. It holds the manifest, cross-session observations, pointers to session logs, the swarm-narrative log.

**Project facts don't live here.** They live in `<project>/PROJECT.md` (rendered six-section view) and `<project>/_memories/` (canonical units). PROJECT.md is the user's editable surface; the workspace folder is operational only. When the two disagree, PROJECT.md wins because the user controls it.

You read PROJECT.md and the relevant units at every session start. The workspace is supplemental.

## Always-live principle

Workspaces are always live. There are no "paused," "inactive," or "archived-in-place" state labels. Don't set workspace state.

Infer activity from signals instead:

- Recency of engagement (`last_active` on the manifest; the latest dated entry in PROJECT.md §State).
- Frequency of sessions.
- Delivery pressure — read from §Moves and §Decisions & Risks, not from the workspace.
- Open items — also from §Moves and §Decisions & Risks.
- User engagement patterns observed across sessions.

If you want to mark a workspace "inactive," instead update PROJECT.md §State with a dated note describing the signals: *"2026-04-21 — no engagement in 3 weeks; no open deadlines; 2 low-priority moves still open."*

## Progressive wind-down

As engagement signals decrease, progressively reduce proactive activity:

- High engagement → full proactivity: updates, suggestions, risk alerts.
- Declining → reduce frequency, focus on critical items only.
- Low engagement → minimal: only surface urgent risks or deadline warnings.
- No engagement → silent: stop proactive activity entirely.

Wind-down is continuous, not stepped. When approaching silence, use judgment on whether to send a final check-in based on delivery risk, open moves, and the user's engagement pattern.

## Reactivation

When the user returns after a gap:

1. Read PROJECT.md fresh and run the retrieval ladder over `_memories/` for the session-intent topics. Don't resume from memory of the prior session alone.
2. Surface what's become stale: aging decisions, risks past their `last_reviewed` threshold, moves whose target dates have passed.
3. Apply elapsed-time signals per `protocols/startup.md` (Elapsed-time signals section).
4. Recalibrate proactivity to the current engagement level.

Don't re-read handoff bodies at reactivation. Handoffs are narrative for the human reader; facts worth keeping were already promoted into PROJECT.md or units at the prior session's close. Re-reading handoffs can resurrect user-deleted facts.

## Cross-workspace awareness

You have access to every workspace in `~/.core/index.json`, but context boundaries are a discipline, not a data boundary. Anchor to the workspace resolved at bootstrap — usually inferred from CWD (see `protocols/startup.md`). Cross-workspace reference is your call when it clearly adds value (a similar risk in another project, a reusable pattern). Never user-prompted, never assumed.

When you do reach across workspaces, name the move: *"Same pattern I hit in the auth-rewrite project last month — flagging in case it applies."*

## Completion and retrospective

A workspace is never truly closed — if the project resurfaces, continue in the same workspace with full history. **Optional archiving** is user-initiated housekeeping that removes the workspace from active view while preserving all history. The user can unarchive any time.

When the user indicates completion:

1. Present objective status from PROJECT.md — deliverables done/outstanding, open moves, remaining risks, quality assessment.
2. Run a retrospective scaled to project complexity.
3. Promote generalizable learnings — patterns that apply across projects — to `~/.core/dm-profile.md §Cross-Project Learnings`. Never promote project-specific facts to the profile; those stay in PROJECT.md.
4. PROJECT.md is the durable record of what happened on this project. The workspace's manifest + swarm-narrative can carry operational observations about how the work was run, but the project's story lives in PROJECT.md.
