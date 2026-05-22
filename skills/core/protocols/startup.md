# Startup

## Voice

Plain person voice — same standard as SKILL.md §Voice. The readiness summary is the user's first impression each session. Don't recite. Talk.

---

Read this at the start of every session before accepting any task.

## First-time setup

Check infrastructure on every startup; skip creation steps for anything that already exists.

- `~/.core/` exists.
- `~/.core/index.json` exists (empty array `[]` is fine).
- `~/.core/dm-profile.md` exists with a name in the identity section. If the file exists but has no name, pick one — evocative, meaningful, not generic — and persist it. Cross-project patterns only; no project-specific facts.
- `~/.core/topics.md` exists with a starter controlled vocabulary plus a changelog at the top.

Then check the project's synthesis files for size overflow. `<project>/PROJECT.md` and `<project>/IMPROVEMENT_LOG.md` are the typical candidates; any synthesis file flagged in the project counts. Compute `estimated_tokens = wc -c × 0.30` as a default; if it crosses ~80% of the Read-tool cap (default ~25000 tokens), trigger memory hygiene on the file. If the file is too large to safely classify (over 4× the cap, or slice-read errors out), surface a one-line warning during the readiness summary rather than auto-compacting blind. The primary trigger for compaction lives in `/finalize` — this is the second line of defense for when last session missed it.

## Identity load

- Read `~/.core/dm-profile.md` in full. Cross-project personality and patterns; no project facts. You're now yourself — same agent as last session.
- Use the `read-auto-memory` adapter verb (resolved per `harnesses/<harness>.md`) to load any harness-local recall available. Treat as scratch cache; verify any project-specific reference against the unit store before acting on it. Claude Code surfaces this from `~/.claude/projects/*/memory/MEMORY.md`; Codex has no equivalent auto-memory and the verb is a no-op there (see `harnesses/codex.md §read-auto-memory`).
- Read `~/.core/topics.md` so the controlled vocabulary is loaded for retrieval and observation auto-tagging.

## Workspace resolution and routing

Resolve deterministically when you can; ask the user only when it's genuinely ambiguous.

Look for `workspace.json` in the current working directory — that's the pointer file. If it's not there, check `~/.core/index.json` for workspaces whose `path` matches the current directory (prefix match). One match → use it. Multiple matches → sort by `last_active` descending and ask the user: *"Last time we worked, we were on [workspace name]. Continuing there, or switching to [other workspace]?"* If `index.json` has exactly one workspace, use it. No match anywhere → unregistered; you'll route to new-workspace setup below unless the project has v1-era content that needs migrating.

**Auto-fork copied workspaces.** Run the fork-check script as the first action of workspace resolution:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/workspace-fork-check.mjs
```

The script reads `<cwd>/workspace.json` and `~/.core/index.json`, detects whether the local pointer was copied from another project (its `workspace_id` resolves to an index entry whose registered `path` is somewhere else), and if so performs the fork: slugifies the cwd basename into a new id (collision-resolved with `-2`, `-3`, etc.), rewrites the local pointer, appends an entry to `index.json`, and creates a fresh manifest at `~/.core/workspaces/<new-id>/workspace.json`. If there's nothing to do — no pointer, no index, path already registered, or `workspace_id` not in index — it prints `(no fork needed)` and exits 0. The check is idempotent: re-running after a fork finds the id already matches the cwd and is a no-op.

Echo the script's stdout to the readiness summary. If it printed `forked <original> -> <new>; registered at <path>`, name the fork in plain voice: *"Detected this `workspace.json` was copied from `<original>`; treating as a new workspace registered as `<new>`."* If it printed `(no fork needed)`, no narration required.

Why a script and not prose: per DC-77, workspace identity stability is a critical surface inference can't be trusted on. The Round-3 Codex re-probe (2026-05-21) showed the agent reading equivalent prose, narrating the mismatch, and still operating under the source identity. The fork is a multi-file mutation; inference reading the steps can fail at any one of them. Ship the deterministic script, drop the agent's job to "run script, echo output."

After the fork check returns, continue with normal resolution: the post-fork local pointer's `workspace_id` is now in `index.json`, so the standard lookup below will find it. The fork doesn't touch project data — `PROJECT.md`, `_memories/`, and the rest stay verbatim; only the registration changes.

After resolution (including any fork), update `last_active` in `~/.core/index.json` for the resolved workspace id.

**Layer separation reminder.** Project synthesis lives in `<project>/PROJECT.md`. The unit store lives in `<project>/_memories/`. Workspace operational meta lives at `~/.core/workspaces/<id>/`. The `workspace.json` in the project folder is just a pointer; the full manifest lives in `~/.core/workspaces/<id>/workspace.json`.

Now route by the project's architecture state. The retrieval-ladder load has an implicit precondition that the unit store exists and is populated — without that, the load is a silent no-op. Make the routing decision explicit:

- **Migration-in-progress flag present.** If `<project>/_memories/.migration-in-progress` exists, a prior session started cold-start migration and didn't finish (or migration is running in another session). Resume migration — do not route to the returning-workspace load regardless of what else is in `_memories/`. The flag is the authoritative signal.
- **Unit store populated.** `<project>/_memories/` exists AND contains at least one canonical unit. A canonical unit is any `*.md` file in `_memories/` (recursive) whose name does not start with `_` (e.g., `_validation/`) and does not start with `INDEX`. Existence alone isn't enough — populated is the precondition. If populated AND no unprefixed CORE folders, route to the returning-workspace load.
- **Unit store populated BUT unprefixed CORE folders exist.** Pre-DC-74 naming on `handoffs/`, `summaries/`, `sessions/`, or `outputs/`. Run the folder-rename-only path, then proceed to returning-workspace load.
- **Unit store empty-or-missing, v1 markers present.** A prior PROJECT.md, `_summaries/` (or legacy `_handoffs/`), `_sessions/`, `_outputs/` (or unprefixed equivalents), `plan.md`, `specs/`, `rebuild/`, or legacy workspace meta at `~/.core/workspaces/<id>/tracking/` or `~/.core/workspaces/<id>/handoffs/` — any of these counts. Cold-start migration before any other load.
- **Unit store empty-or-missing, no v1 markers.** Truly new workspace. Interview and scaffold.

Surface the routing decision to the user in plain voice before proceeding. *"This project has prior content but no v2 unit store yet, so I'm going to run the cold-start migration before doing anything else."* For the rename-only case: *"This project's CORE folders are on the pre-DC-74 names. I'm going to rename them to the underscore convention before loading."* For the resume case: *"A migration-in-progress flag is present from a prior session. Resuming the cold-start migration before loading."*

Routing failure is itself a defect. If you find yourself trying to load the unit store on an empty/missing `_memories/` or with the migration flag present, stop and re-route.

## Load — returning workspace

**Precondition:** `<project>/_memories/` exists, contains at least one canonical unit, and no migration-in-progress flag.

The v2 load uses the retrieval ladder, not a cover-to-cover read. The goal is to know enough to answer the user's next question, not to load every file.

- Read `<project>/workspace.json` to get the workspace id and data path.
- **Tier 0 (in-context):** the session-intent topics are whatever the user just said or typed. Pull those into mind. If the conversation is empty (cold start), the session-intent is "orient and present the state."
- **Tier 1 (lexical retrieval):** read `<project>/PROJECT.md` to anchor the six-section view. Grep `<project>/_memories/` for session-intent topic terms to surface relevant active units. Load whatever the grep returns above the priority threshold.
- **Tier 2 (graph walk):** for each loaded unit, walk its `supersedes` and `depends-on` edges one hop to pick up the related context. Stop when the candidate set is good enough.
- **Tier 3 (semantic):** only escalate if Tier 0–2 leave the user's actual question unanswered. The `Explore` subagent reasons over the vault for semantic queries.
- Read `<project>/inbox.md` if it exists. Raw pending items — promote worthwhile facts into the right units on the user's next review.
- Read `~/.core/workspaces/<id>/workspace.json` for cross-session metadata only (last-session date, timestamps). Don't read project facts from here — there aren't any.

**Skip these surfaces at bootstrap:**
- Session summaries in `<project>/_summaries/` (or legacy `_handoffs/` if the rename hasn't happened yet). They're narrative for the human reader. Facts worth keeping were already in PROJECT.md or the units at session close. Re-reading summaries re-anchors you on narrative framing and can resurrect user-deleted facts.
- `<project>/PROJECT-ARCHIVE.md`, `<project>/IMPROVEMENT_LOG-ARCHIVE.md`. Single-write archive surfaces.
- Legacy workspace files (`raid-log.md`, `decision-log.md`, `next-session.md`, `handoffs/`) under `~/.core/workspaces/<id>/` — pre-2026-04-21 structure. If `PROJECT.md` exists, ignore them. If it doesn't, surface the mismatch and offer to migrate.

Run edit-detection on the files you read against `~/.core/state-cache.json`. If hashes don't match, the user edited something between sessions — propagate the edits back to the source-of-truth units before composing the readiness summary.

## Load — new workspace

Interview first. Don't skip this.

- What's the problem or task? Scope? Timeline? What does success look like?
- Constraints? Stakeholders? What's already been tried?

Then scaffold the synthesis: create `<project>/PROJECT.md` with the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes) populated from the interview. Solo projects can declare "solo project, no §People" inline rather than leaving the section blank.

Create the unit store: `mkdir -p <project>/_memories/observations/<YYYY-MM>/`. Project folders hold only data; the priority function and other executable units ship with the plugin (see DC-77).

Create `<project>/inbox.md` if external pulls are expected. Create the project-folder pointer at `<project>/workspace.json` with `schema_version: v2`, `workspace_id`, `name`, `created`, `data_path`. Create the workspace meta at `~/.core/workspaces/<workspace-id>/workspace.json` with `schema_version: v2` plus the workspace schema fields, and `~/.core/workspaces/<id>/swarm-narrative.md` empty for now. Register the workspace by appending its entry to `~/.core/index.json` (with `schema_version: v2` if not already set at the index level).

If the project folder turns out to have pre-existing content that wasn't visible during routing (session summaries or legacy handoffs in unusual locations, prior PROJECT.md, session logs surfaced during interview), drop into cold-start migration instead. The new-workspace scaffold is for truly empty projects; substantial prior content always routes through migration.

## Load — cold-start migration

The project has substantive prior content but no v2 unit store. Run the eight steps below in order. Each step is load-bearing; don't demote any into "I'll handle that later in §Moves."

**Verify the model is appropriate.** Cold-start migration on a large project warrants Opus + ultrathink-level reasoning. Surface the recommendation if the session is on a smaller model before proceeding.

**Step 1 — Draft the migration plan with unit inventory enumerated.** Before writing the migration-in-progress flag, before any destructive action, draft `~/.core/workspaces/<id>/migration-plan.md`. The plan must enumerate the unit inventory unit-by-unit (people, decisions, risks, observations, open questions) — not "I'll discover units as I go." Naming conventions, edge structure, phase ordering, stop conditions, and any environment-specific concerns (OneDrive `cp -r` + `rm -rf` instead of `mv`; anti-resurrection traps specific to this corpus) get named in the plan. Surface the plan to the user for review and get the go-ahead before executing. If `~/.core/workspaces/<id>/migration-plan.md` already exists from a prior planning session, read it and execute from that — don't re-design.

This step is load-bearing. The advisor-caught addition — enumerate the inventory before any destructive action so you're not discovering mid-flight — is what makes the rest mechanical. Promoted from advisor-caught to protocol-required 2026-05-20 after a downstream-wrapper migration validated the pattern on a real non-CORE workspace.

**Step 2 — Write the migration-in-progress flag.** Create `<project>/_memories/.migration-in-progress` — a single line with the session timestamp and a brief reason (`2026-05-20T11:23:00Z — cold-start migration begun`). This flag guards against re-invocation mid-migration silently routing to the returning-workspace load on a partial store. If the flag is already present from a prior interrupted session, read it, decide whether to resume from partial state or restart, and rewrite the flag with this session's timestamp either way. The flag is removed at the end as the explicit signal that migration completed cleanly.

**Step 3 — Write the early summary stub.** Migration is the canonical long/autonomous/complex session that warrants the early summary (see "Long sessions" below).

**Step 4 — Folder rename (DC-74 + summary rename).** If the project has unprefixed CORE folders (`handoffs/`, `summaries/`, `sessions/`, `outputs/`), rename them to the current underscore convention. For each folder being renamed, check `git ls-files <folder>` first — if any files are tracked, use `git mv` so history follows; otherwise plain `mv`. A project can live inside a git tree (a home-directory git repo is a common case) without its project subfolders being tracked, in which case `git mv` fails with a misleading "source directory is empty" error. The per-folder tracked check avoids that. On cloud-sync-virtualized paths (OneDrive, Dropbox, iCloud Drive), `mv` can corrupt the sync state — use `cp -r <src> <dst>` then `rm -rf <src>` after verifying counts match. Both `handoffs/` (pre-rename) and `summaries/` map to `_summaries/`; `sessions/` → `_sessions/`; `outputs/` → `_outputs/`. Run a path-citation sweep in `_memories/*.md` after the renames so frontmatter `sources:` pointers stay valid. Narrate the renames in plain voice as they happen.

**Step 5 — Read substrate.** On Claude Code, check `~/.claude/projects/<cwd-mapped>/` for prior session transcripts — substrate worth reading alongside session summaries, plans, and specs. On Codex there is no equivalent transcript surface; rely on `<project>/_summaries/` and any project-local plans or specs instead. Either way, anti-resurrection is strict: if a prior PROJECT.md exists, it's the user's curation surface — promote backing units for facts it endorses; capture substrate-only facts as observations but do not auto-promote them. Surface ambiguous cases. Preserve disagreement: multi-agent perspective outputs and rejected alternatives are gold for the "how we got here" reasoning; don't flatten them when graduating.

**Step 6 — Execute graduation per the plan from Step 1.** Walk the enumerated inventory and graduate units in the order the plan specifies (typically: people first, foundational decisions second, remaining decisions, risks, open-questions, observations last). Cite the plan as you go.

**Step 7 — Re-render PROJECT.md and update workspace meta.** Compose the six-section view (What & Why / State / People / Moves / Decisions & Risks / Notes) from the freshly-graduated units. Update `~/.core/index.json` with `schema_version: v2` and `migrated_at`. Update `~/.core/workspaces/<id>/workspace.json` to v2 schema, preserving prior milestones and adding the migration milestone. Create `~/.core/workspaces/<id>/swarm-narrative.md` (empty) for future swarm runs.

**Step 8 — Six-command readiness check (numbered, not text).** Run these six commands explicitly. Do not demote this step into §Moves — a real-world migration retrospective surfaced exactly this trap: an agent silently moved "readiness check" into §Moves item #1 mid-migration, advisor caught the demotion, the check then revealed substantive issues that would have shipped uncaught. Naming it as a numbered step prevents the demotion.

| # | Command | Pass criteria |
|---|---|---|
| a | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs --store <project> --schema` | Exit 0 — no frontmatter mismatches, no invalid status/type enums, no dangling edges at the schema level |
| b | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs --store <project> --integrity` | Exit 0 — no orphans (or expected-orphan pattern named in plan), no broken edge targets, no stale-flagged units |
| c | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs --store <project>` | Writes `INDEX-decisions.md` with the expected decision count |
| d | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs --store <project>` | Writes `INDEX-risks.md` with the expected risk count |
| e | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs <project>/_memories --top 10` | Ranks successfully; foundational decisions and high-severity risks surface at top; topics field populated |
| f | `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs --check <project>` | Reports PROJECT.md under cap |

If any command silently no-ops with no stdout and no file written, set `CORE_DEBUG_CLI_ENTRY=1` and rerun — that surfaces the `process.argv[1]` vs `import.meta.url` mismatch the CLI entry guard depends on (path-normalization, symlinks, OneDrive virtualization on the invoking cwd).

**Step 9 — Remove the flag and re-enter the returning-workspace load.** Delete `<project>/_memories/.migration-in-progress` as the explicit signal migration completed cleanly. Then run the returning-workspace load against the now-populated store. The migration agent's side-effect knowledge of what it wrote is NOT a substitute for a deliberate load — the retrieval ladder is what actually puts unit content into working memory. Without this re-entry, subsequent turns degrade rapidly as working-memory awareness decays.

## Load — folder rename only

The project is already on v2 but has unprefixed CORE folders, or it's on DC-74-era `_handoffs/` and needs the summary rename. Run only the rename step, then proceed to the returning-workspace load.

Announce the rename in plain voice. Example: *"This project has the pre-DC-74 folder names. Renaming `handoffs/` → `_summaries/`, `sessions/` → `_sessions/`, `outputs/` → `_outputs/` before loading."* Or, for the DC-74-to-summary case: *"This project still has the legacy `_handoffs/` folder. Renaming to `_summaries/` before loading."*

For each folder that exists, use `git mv` (or plain `mv` if not in a git tree):
- `handoffs/` → `_summaries/`
- `summaries/` → `_summaries/`
- `_handoffs/` (legacy) → `_summaries/`
- `sessions/` → `_sessions/`
- `outputs/` → `_outputs/`

Skip any that don't exist.

Sweep `<project>/_memories/*.md` for path-citations in frontmatter `sources:` and inline body text — update the bare path-strings to the current `_summaries/`, `_sessions/`, `_outputs/`. Don't touch paths inside historical text that explicitly described prior state (changelog entries describing "before" states, for instance).

Sweep `<project>/PROJECT.md` for forward-looking path references to the same folders.

Append a one-line entry to `<project>/IMPROVEMENT_LOG.md` recording the rename, if a project IMPROVEMENT_LOG exists.

This is routine and idempotent — don't escalate to multi-agent, don't pause for approval.

## Session agenda

The agenda is `PROJECT.md §Moves`. No separate next-session file — that died with the 2026-04-21 restructure.

At session start, read §Moves, present the top 3–5 active priorities as the agenda, surface any high-priority items before implementation work begins. During the session, when new risks, decisions, open questions, or commitments emerge, update the relevant unit and re-render the affected PROJECT.md section in real time. At session end, make sure §Moves reflects next-session priorities — that's what gets picked up on the next bootstrap.

If MCP calendar access is available, suggest scheduling regular sessions when the rhythm warrants it. Propose; let the user approve.

## Reconcile between-session activity

- **Notification responses.** Has the user responded to anything you pinged between sessions?
- **External sources via MCP.** Pull workspace-relevant updates; stage raw content in `<project>/inbox.md` for the user's review.
- **Elapsed-time signals.** Compute and apply (see below).

## Elapsed-time signals

Read `last-reviewed` dates from `_memories/risk-*.md` and `_memories/dc-*.md` units. Read session timestamps from `~/.core/workspaces/<id>/workspace.json`. Reason about staleness.

Starting calibrations — tune based on observed behavior:

- **Time since last session.** >7 days: re-confirm priorities. >30 days: treat as near-new; re-interview.
- **Time until next deadline.** Under two sessions of runway: escalate urgency. Past deadline: surface immediately, don't bury.
- **Time since risk last reviewed.** >3 sessions or >14 days: flag as stale, force re-evaluation before proceeding.
- **Time since assumption validated.** >5 sessions or >14 days: confidence decays. Surface for revalidation.
- **External-source claim age.** Task tracker or chat older than 24h: disclose and consider re-fetch. Document store older than 14d: disclose.

Apply these before composing readiness. If any of them escalate, lead with the escalation.

## Memory processing nudge

Read `<project>/_memories/_pm-state.json` if it exists. If `now - last_run > 24 hours` (or the file doesn't exist), include a one-line prompt in the readiness summary:

> *"Memory processing hasn't run in [X hours/days] — worth running `/process-memory` when you get a moment."*

Don't block on it. It's a nudge, not a gate.

## Compose the readiness summary

Make workspace identity obvious. Talk like a person.

What to include:
- A structured one-line routing-decision tag at the start or end of the summary: `Routing: <branch-name>` where branch-name is one of `returning-workspace`, `cold-start-migration`, `folder-rename`, `new-workspace`, `migration-resume`. This makes regression tests robust to prose drift while preserving the conversational readiness summary below.
- The workspace name in plain language.
- What `PROJECT.md` currently says in §State — one or two sentences, not a recap of every section.
- Active risks worth surfacing now (count plus the top one or two by impact).
- Any elapsed-time signals that escalated.
- The top 3 §Moves priorities as the agenda.
- Anything auto-compacted during first-time setup, named explicitly (entries, not counts).
- Plugin version: read `VERSION` and `BUILD` from the skill base directory (the directory containing `protocols/`, `SKILL.md`, etc.). Echo as "Plugin v<VERSION> build <BUILD>". If either file is missing, echo whatever exists; if both missing, omit the line entirely.

Target voice:

> *"Picking up on the [project name]. Last session closed Wednesday with the routing rework merged. PROJECT.md says we're mid-migration: Phase 1 done, Phase 2 in progress. Top of §Moves is the auth-rewrite review. One stale risk worth flagging: R-3 last reviewed three weeks ago. Ready."*

What to skip: session summary content (not part of the bootstrap read); auto-memory cited as authoritative (it's scratch cache); session log recaps (per-session artifacts, not state); a full section-by-section recital (the user sees PROJECT.md when they want the full view).

**Record the bootstrap.** After readiness lands, write `~/.core/workspaces/<id>/last-bootstrap.json` with two fields: `session_started_at` (the Claude Code session-start timestamp — best available proxy is the timestamp of the first user message this session) and `bootstrap_completed_at` (now). This is the durable signal `skills/core/SKILL.md §"Before the task — startup"` reads to decide whether bootstrap already ran this session.

After readiness lands, wait for the user's next move. The agenda topics get resolved or explicitly deferred before implementation work begins.

## Long sessions — write the early summary stub

Write a summary stub immediately after readiness — before any substantive work — when:

- The session is explicitly autonomous (user unavailable for questions).
- The session will process multiple large files or spawn complex swarms.
- The session has many sequential tasks where auto-compaction could interrupt mid-flow.
- The user explicitly asks for an early summary.

Naming: `_summaries/summary-<YYYY-MM-DD><letter>.md` — use the next available letter suffix.

The stub structure:

```
# Session Summary — [date] ([letter])

> Status: Early summary stub — written before auto-compact, will be updated at session close.

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

Append findings as they emerge. The stub is a living document until `/finalize` upgrades it into the session-close summary.
