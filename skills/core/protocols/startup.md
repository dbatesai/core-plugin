# Startup

## Voice

Plain person voice — same standard as SKILL.md §Voice. Specific note for this file: the readiness confirmation is the user's first impression each session. Don't recite. Talk.

---

Read this at the start of every session before accepting any task.

## Phase 0 — First-time initialization

Check these on every startup. Skip the creation step if the artifact already exists.

1. Check that `~/.core/` exists. If not, create it.
2. Check that `~/.core/index.json` exists. If not, create with empty array `[]`.
3. Check that `~/.core/dm-profile.md` exists. If not, create with skeleton sections and pick yourself a name — evocative, meaningful, not generic. The profile holds cross-project patterns only; no project-specific facts.
4. If `dm-profile.md` exists but has no name field, pick one and persist it.
5. Check that `~/.core/topics.md` exists. If not, create it with a starter vocabulary plus a changelog at the top.

## Phase 0.5 — Backup hygiene check

Before reading PROJECT.md or any synthesis file, check for size overflows. If `<project>/PROJECT.md` or `<project>/IMPROVEMENT_LOG.md` is over the Read tool cap, the hygiene mechanism should have compacted them last `/finalize`. This phase is the failsafe.

For each in-scope file (`<project>/PROJECT.md`, `<project>/IMPROVEMENT_LOG.md`, any other synthesis file flagged in the project):

1. Compute `estimated_tokens = wc -c <file> × per_file_ratio` (default ratio 0.30, per-file measured ratio overrides).
2. If `estimated_tokens > 0.8 × CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` (default cap 25000), trigger memory hygiene on the file. See `protocols/hygiene.md` for the compaction strategy per file shape.
3. If `file_size_chars > 4× cap` or slice-read errors out, surface a one-line warning at Phase 6 readiness; don't auto-compact a file you can't safely classify.

The primary trigger for compaction lives in `/finalize`'s hygiene pass. Phase 0.5 is the second line of defense — if last session missed it, this catches it.

## Phase 1 — Load identity and project context

1. Read `~/.core/dm-profile.md` in full. Cross-project personality and patterns; no project-specific facts. You're now yourself — same agent as last session.
2. Read auto-memory at `~/.claude/projects/*/memory/MEMORY.md`. Treat it as scratch cache; verify any project-specific reference against the unit store before acting on it.
3. Read `~/.core/topics.md` so the controlled vocabulary is loaded for retrieval and observation auto-tagging.

## Phase 2 — Resolve the workspace

Resolve deterministically when you can; ask the user only when it's genuinely ambiguous.

1. Look for `workspace.json` in the current working directory. If found, use it.
2. Otherwise, check `~/.core/index.json` for workspaces whose `path` matches the current directory (prefix match). One match → use it. Multiple matches → step 4.
3. If `index.json` has exactly one workspace, use it.
4. Multiple plausible workspaces. Sort by `last_active` descending. Ask the user: *"Last time we worked, we were on [workspace name]. Continuing there, or switching to [other workspace]?"* Use the answer.
5. No match anywhere → flag the workspace as unregistered and proceed to Phase 2.5. Phase 2.5 may route to Phase 3B if the project is truly new, or to Phase 3M if the project has v1-era content that needs migrating.

After resolution, update `last_active` in `~/.core/index.json` (Write/Edit, direct — Cowork capability routing is not a v2 concern).

**Layer separation reminder.** The project synthesis lives in `<project>/PROJECT.md` and the unit store lives in `<project>/_memories/`. Workspace operational meta lives at `~/.core/workspaces/<id>/`. The `workspace.json` in the project folder is just a pointer; the full manifest lives in `~/.core/workspaces/<id>/workspace.json`.

## Phase 2.5 — Architecture routing

Pick the right load branch by inspecting the project's architecture state. Phase 3A's retrieval ladder load has an implicit precondition that the unit store exists *and is populated*; without that, the load is a silent no-op. This phase makes the routing explicit.

1. **Check for a migration-in-progress flag.** If `<project>/_memories/.migration-in-progress` exists, a prior session started cold-start migration and didn't finish (or migration is running in another session). Route to Phase 3M to resume — do not route to Phase 3A regardless of what else is in `_memories/`. The flag is written at Phase 3M start and removed only on successful completion; its presence is authoritative.
2. **Check whether `<project>/_memories/` exists AND contains at least one canonical unit.** A canonical unit is any `*.md` file in `_memories/` (recursive) whose name does not start with `_` (e.g., `_lib/`, `_validation/`) and does not start with `INDEX`. An empty `_memories/`, or one containing only `_lib/`, `_validation/`, or index files, counts as **not populated** and routes the same as "missing." Existence alone is not enough — populated is the load precondition for Phase 3A.
3. Check for v1-era artifact markers. Any of these counts:
   - `<project>/PROJECT.md` exists
   - `<project>/_handoffs/` or unprefixed `<project>/handoffs/` exists
   - `<project>/_sessions/`, `<project>/_outputs/`, or unprefixed `<project>/sessions/`, `<project>/outputs/` exists
   - `<project>/plan.md`, `<project>/specs/`, `<project>/rebuild/`, or other substantive v1 project artifacts
   - `~/.core/workspaces/<id>/tracking/` exists (legacy planning records in workspace meta, pre-2026-04-21 structure)
   - `~/.core/workspaces/<id>/handoffs/` exists with prior sessions
4. Check for unprefixed CORE folders (legacy pre-DC-74 naming). If any of `<project>/handoffs/`, `<project>/sessions/`, or `<project>/outputs/` exist without the underscore prefix, note that the folder-rename step in Phase 3M must run before retrieval — even if the unit store is otherwise populated.
5. Route:
   - `.migration-in-progress` flag present → Phase 3M (resume migration; see Phase 3M Step 0).
   - `_memories/` populated AND no unprefixed CORE folders → Phase 3A (v2 returning workspace, the retrieval ladder load).
   - `_memories/` populated BUT unprefixed CORE folders exist → Phase 3M-lite (folder-rename only per DC-74; skip the full cold-start migration).
   - `_memories/` empty-or-missing, v1 markers present → Phase 3M (cold-start migration per spec §9; folder-rename is one step within it).
   - `_memories/` empty-or-missing, no v1 markers → Phase 3B (new workspace interview + scaffold).
6. Surface the routing decision to the user in plain voice before proceeding. Example: *"This project has prior content but no v2 unit store yet, so I'm going to run the cold-start migration before doing anything else."* For the rename-only case: *"This project's CORE folders are on the pre-DC-74 names. I'm going to rename them to the underscore convention before loading."* For the resume case: *"A migration-in-progress flag is present from a prior session. Resuming the cold-start migration before loading."*

Routing failure is itself a defect. If you find yourself in Phase 3A with an empty/missing `_memories/` or with the migration flag present, stop and re-run Phase 2.5; do not attempt the retrieval ladder load on an unpopulated or mid-migration store.

## Phase 3A — Returning workspace

**Precondition:** `<project>/_memories/` exists AND contains at least one canonical unit, AND `<project>/_memories/.migration-in-progress` is NOT present. Phase 2.5 should have routed here. If you reach Phase 3A with an empty/missing unit store or with the migration flag present, that's a routing bug; surface it and drop back into Phase 2.5 (which will re-route to 3M).

The v2 load uses the retrieval ladder, not a cover-to-cover read. The goal is to know enough to answer the user's next question, not to load every file.

1. Read `<project>/workspace.json` to get the workspace id and data path.
2. **Tier 0 (in-context):** the session-intent topics are whatever the user just said or typed. Pull those into mind. If the conversation is empty (cold start), the session-intent is "orient and present the state."
3. **Tier 1 (lexical retrieval):** `Read <project>/PROJECT.md` to anchor the six-section view. Grep `<project>/_memories/` for session-intent topic terms to surface relevant active units. Load whatever the grep returns above the priority threshold.
4. **Tier 2 (graph walk):** for each loaded unit, walk its `supersedes` and `depends-on` edges one hop to pick up the related context. Stop when the candidate set is good enough (score-gated termination).
5. **Tier 3 (semantic):** only escalate if Tier 0–2 leave the user's actual question unanswered. The `Explore` subagent reasons over the vault for semantic queries.
6. Read `<project>/inbox.md` if it exists. Raw pending items — promote worthwhile facts into the right units on the user's next review.
7. Read `~/.core/workspaces/<id>/workspace.json` for cross-session metadata only (last-session date, timestamps). Don't read project facts from here — there aren't any.
8. **Skip these surfaces at bootstrap:**
   - Handoffs in `<project>/_handoffs/`. They're narrative for the human reader. Facts worth keeping were already in PROJECT.md or the units at session close. Re-reading handoffs re-anchors you on narrative framing and can resurrect user-deleted facts.
   - `<project>/PROJECT-ARCHIVE.md`, `<project>/IMPROVEMENT_LOG-ARCHIVE.md`. Single-write archive surfaces. Never read at bootstrap.
   - Legacy workspace files (`raid-log.md`, `decision-log.md`, `next-session.md`, `handoffs/`) under `~/.core/workspaces/<id>/`. Pre-2026-04-21 structure. If you see them and `PROJECT.md` exists, ignore them. If you see them and `PROJECT.md` doesn't exist, surface the mismatch and offer to migrate before proceeding.
9. Run edit-detection on the files you read this turn against `~/.core/state-cache.json`. If hashes don't match, the user edited something between sessions — propagate the edits back to the source-of-truth units before composing the readiness summary.

## Phase 3B — New workspace

1. **Interview the user.** Don't skip this.
   - What's the problem or task? Scope? Timeline? What does success look like?
   - Constraints? Stakeholders? What's already been tried?
2. **Scaffold the synthesis.** Create `<project>/PROJECT.md` with the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes) populated from the interview. Solo projects can declare "solo project, no §People" inline rather than leaving the section blank.
3. **Create the unit store.** `mkdir -p <project>/_memories/observations/<YYYY-MM>/` and `<project>/_memories/_lib/`. Copy `priority.py` into `_lib/` if it isn't there (it may already be at the canonical path; sym-link or copy as appropriate to the harness).
4. **Optional staging.** Create `<project>/inbox.md` if external pulls are expected.
5. **Create the project-folder pointer.** `<project>/workspace.json` with `workspace_id`, `name`, `created`, `data_path`.
6. **Create the workspace meta.** `~/.core/workspaces/<workspace-id>/workspace.json` per the workspace schema; `~/.core/workspaces/<id>/swarm-narrative.md` empty for now.
7. **Register the workspace.** Append the entry to `~/.core/index.json`.
8. **Cold-start migration fallback.** If the project folder turns out to have pre-existing content that wasn't visible at Phase 2.5 (handoffs in unusual locations, prior PROJECT.md, session logs surfaced during interview), drop into Phase 3M for comprehensive migration per spec §9. Phase 3B's scaffold is for truly empty projects; substantial prior content always routes through 3M.

## Phase 3M — Cold-start migration

The project has substantive prior content but no v2 unit store. Run comprehensive cold-start migration per `core-skill-v2-spec.md` §9 before proceeding to Phases 3C–7.

The migration discipline lives in the spec — survey the project folder comprehensively, capture-everything at observation tier, graduate substantive content into canonical units, apply hygiene during migration with anti-resurrection enforced, narrate in real time, take the time needed. Do not duplicate the spec content here.

**Practical guidance for executing this phase:**

0. **Write the migration-in-progress flag first.** Before any other migration action, create `<project>/_memories/.migration-in-progress` (touch the file; a single line with this session's timestamp and a brief reason — e.g., `2026-05-18T11:23:00Z — cold-start migration begun` — is enough). This flag is the guard against re-invocation mid-migration silently routing to Phase 3A on a partial store. If the flag is already present from a prior interrupted session, read it to understand what was running, then decide whether to resume from the partial state or restart; either way, rewrite the flag with this session's timestamp before continuing. The flag is removed in the final step (8) as the explicit signal that migration completed cleanly.

1. **Write the Phase 7 early-handoff stub before starting.** Migration is the canonical long/autonomous/complex session per Phase 7 criteria.
2. **Check for an existing migration plan.** Look at `~/.core/workspaces/<id>/migration-plan.md`. If present, read it first — that's the durable plan from a prior planning session, and the current session should execute from it rather than re-design. If absent, write one to that location before executing the migration body.
3. **Verify the user is on the right model for the work.** Cold-start migration on a large project warrants Opus + ultrathink-level reasoning. Surface the recommendation if the session is on a smaller model.
4. **Check for prior conversation transcripts.** `~/.claude/projects/<cwd-mapped>/` may contain prior session transcripts; if present, they're substrate worth reading alongside handoffs, plans, and specs.
5. **Anti-resurrection is strict.** If a prior PROJECT.md exists, it is the user's curation surface — promote backing units for facts it endorses; capture substrate-only facts as observations but do not auto-promote them. Surface ambiguous cases.
6. **Preserve disagreement.** Multi-agent perspective outputs and rejected alternatives are gold for the "how we got here" reasoning; do not flatten them when graduating to units.
7. **Folder-rename step (DC-74).** If the project has unprefixed CORE folders (`handoffs/`, `sessions/`, `outputs/`), rename them to the underscore convention as the first concrete action after the early-handoff stub. Use `git mv` when the project is under git so history follows the rename; plain `mv` otherwise. Run a path-citation sweep in `_memories/*.md` after the renames so frontmatter `sources:` pointers stay valid — bare path-strings `handoffs/`, `sessions/`, `outputs/` become `_handoffs/`, `_sessions/`, `_outputs/`. Narrate the renames in plain voice as they happen.

8. **Remove the migration-in-progress flag and re-enter Phase 3A.** Once the unit store is populated and verified, delete `<project>/_memories/.migration-in-progress` as the explicit signal that migration completed cleanly. Then re-enter Phase 3A and run the retrieval ladder against the now-populated store. The migration agent's side-effect knowledge of what it wrote during migration is NOT a substitute for a deliberate load — Phase 3A is what actually puts unit content into working memory via lexical retrieval and typed-edge walks. Without this explicit re-entry, subsequent turns degrade rapidly as working-memory awareness of the project decays.

The migration is the entire load. Phases 3C–7 (session agenda, reconciliation, elapsed-time signals, readiness, early handoff) apply normally once Phase 3A has run on the populated store.

## Phase 3M-lite — Folder-rename only (DC-74 compliance)

The project is already on v2 (`_memories/` present) but has unprefixed CORE folders. Run only the folder-rename step, then proceed to Phase 3A.

1. Announce the rename in plain voice: *"This project has the pre-DC-74 folder names. Renaming `handoffs/` → `_handoffs/`, `sessions/` → `_sessions/`, `outputs/` → `_outputs/` before loading."*
2. For each unprefixed folder that exists: `git mv handoffs _handoffs` (or plain `mv` if not in a git tree). Skip any that don't exist.
3. Sweep `<project>/_memories/*.md` and update path-citations in frontmatter `sources:` and inline body text. The change is `handoffs/` → `_handoffs/`, `sessions/` → `_sessions/`, `outputs/` → `_outputs/`. Don't touch paths inside historical text that explicitly described prior state (e.g., changelog entries describing "before" states).
4. Sweep `<project>/PROJECT.md` for forward-looking path references to the same three folders; update those too.
5. Append a one-line entry to `<project>/IMPROVEMENT_LOG.md` recording the DC-74 rename if a project IMPROVEMENT_LOG exists.
6. Proceed to Phase 3A.

This is a routine, idempotent operation. Don't escalate to multi-agent. Don't pause for user approval — the convention is already locked at DC-74; the rename is a mechanical compliance step.

## Phase 3C — Session agenda

The agenda is `PROJECT.md §Moves`. No separate next-session file — that died with the 2026-04-21 restructure.

- At session start: read §Moves, present the top 3–5 active priorities as the agenda, surface any high-priority items before implementation work.
- During session: when new risks, decisions, open questions, or commitments emerge, update the relevant unit and re-render the affected PROJECT.md section. The session updates synthesis in real time, not just at /finalize.
- At session end: make sure §Moves reflects next-session priorities — that's what you pick up from on the next bootstrap.

If MCP calendar access is available, suggest scheduling regular sessions when the rhythm warrants it. Propose; let the user approve.

## Phase 4 — Reconcile between-session activity

| Source | Check |
|---|---|
| Notification responses | Has the user responded to anything you pinged between sessions? |
| External sources via MCP | Pull workspace-relevant updates; stage raw content in `<project>/inbox.md` for the user's review |
| Elapsed-time signals | Compute and apply the time-based signals in Phase 5 |

## Phase 5 — Apply elapsed-time signals

Read `last-reviewed` dates from `_memories/risk-*.md` and `_memories/dc-*.md` units. Read session timestamps from `~/.core/workspaces/<id>/workspace.json`. Reason about staleness.

| Signal | Calculation | Effect |
|---|---|---|
| Time since last session | `now − last_session_end` | >7 days: re-confirm priorities. >30 days: treat as near-new; re-interview. |
| Time until next deadline | `next_deadline − now` | Under two sessions of runway: escalate urgency. Past deadline: surface immediately, don't bury. |
| Time since risk last reviewed | `now − risk.last_reviewed` | >3 sessions or >14 days: flag as stale, force re-evaluation before proceeding. |
| Time since assumption validated | `now − assumption.last_validated` | >5 sessions or >14 days: confidence decays. Surface for revalidation. |
| External-source claim age | `now − source.fetched_at` | Task tracker / chat: >24h, disclose and consider re-fetch. Document store: >14d, disclose. |

Apply these signals before composing readiness. If any of them escalate, lead with the escalation.

## Phase 6 — Confirm readiness

Make workspace identity obvious. Talk like a person.

What to include:

- The workspace name in plain language.
- What `PROJECT.md` currently says in §State — one or two sentences, not a recap of every section.
- Active risks worth surfacing now (count plus the top one or two by impact).
- Any elapsed-time signals that escalated (Phase 5).
- The top 3 §Moves priorities as the agenda.
- Anything Phase 0.5 auto-compacted at startup, named explicitly (entries, not counts).

Target voice:

> *"Picking up on CORE. Last session closed on Wednesday with the v2 plan locked. PROJECT.md says we're at: v2 execution plan ready, memory v2 Steps 1–9 implemented, DECISIONS.md graduation queued. Top of §Moves is the autonomous v2 build per docs/plans/2026-05-17-v2-execution-plan.md. One stale risk worth flagging: R-DM-SMUGGLING last reviewed 2026-05-14. Ready."*

What NOT to do:

- Don't recite handoff content. Handoffs aren't part of the bootstrap read.
- Don't reference auto-memory as authoritative. It's scratch cache.
- Don't read and summarize session logs. They're per-session artifacts, not state.
- Don't list every section. The user sees PROJECT.md when they want the full view.

After readiness lands, wait for the user's next move. The agenda topics get resolved or explicitly deferred before implementation work begins.

## Phase 7 — Early handoff (long / autonomous / complex sessions)

Write a handoff stub immediately after orientation — before any substantive work — when:

- The session is explicitly autonomous (user unavailable for questions).
- The session will process multiple large files or spawn complex swarms.
- The session has many sequential tasks where auto-compaction could interrupt mid-flow.
- The user explicitly asks for an early handoff.

When to write it: after Phase 6, before the first Write/Edit/Task that produces a durable artifact.

What the stub needs:

```
# Session Handoff — [date] ([letter])

> Status: Early handoff stub — written before auto-compact, will be updated at session close.

## What Was Done (at time of writing)
[Orientation findings, key decisions read, probe results.]

## Key Findings / State
[The highest-value context that would be hard to reconstruct after compaction.]

## In Progress
[What's being worked on right now.]

## Open Questions
[Empirical unknowns, deferred decisions, items needing user input.]

## Next Steps
[If the session gets interrupted here, what should happen first next time.]
```

Naming: `_handoffs/handoff-<YYYY-MM-DD><letter>.md` — use the next available letter suffix.

Append findings as they emerge. The stub is a living document until `/finalize` upgrades it into the session-close handoff.
