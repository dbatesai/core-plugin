# Startup — conditional load branches

## Voice

Plain person voice — same standard as `startup.md` §Voice. These branches run rarely; when they do, narrate the routing decision and the work in plain voice.

---

Read this file **only when** `protocols/startup.md` §"Workspace resolution and routing" lands on one of two branches: **new-workspace** (truly empty project) or **folder-rename** (a returning v2 project on pre-DC-74 folder names). Both are conditional loads that don't fire on an established returning workspace, so they live here instead of loading into every session.

The **cold-start migration** branch is *not* here — it stays inline in `startup.md` by design (it's the one irreversible branch, and its plan/flag backstops must always be in context). If routing selected migration, execute it from `startup.md`, not this file.

After either branch below completes, re-enter `protocols/startup.md` §"Load — returning workspace" and continue from there (elapsed-time signals → hot-section → readiness).

## Load — new workspace

Interview first. Don't skip this.

- What's the problem or task? Scope? Timeline? What does success look like?
- Constraints? Stakeholders? What's already been tried?

Then scaffold the synthesis: create `<project>/PROJECT.md` with the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes) populated from the interview. Solo projects can declare "solo project, no §People" inline rather than leaving the section blank.

Create the unit store: `mkdir -p <project>/_memories/observations/<YYYY-MM>/`. Project folders hold only data; the priority function and other executable units ship with the plugin (see DC-77).

Create `<project>/inbox.md` if external pulls are expected. Create the project-folder pointer at `<project>/workspace.json` with `schema_version: v2`, `workspace_id`, `name`, `created`, `data_path`. Create the workspace meta at `~/.core/workspaces/<workspace-id>/workspace.json` with `schema_version: v2` plus the workspace schema fields, and `~/.core/workspaces/<id>/swarm-narrative.md` empty for now. Register the workspace by appending its entry to `~/.core/index.json` (with `schema_version: v2` if not already set at the index level).

Then ask about external sources. *"Are there external data sources that should feed this project's memory? We can register them now, or add them later via `/register-sources`."* If the user names sources, walk through registration per `references/external-sources/source-registration-framework.md §3`. For each source: capture the authority statement (the prose answer becomes both the registration's `authority` field and a `source-of-authority` unit per DC-85), surface the installation's suggested defaults for `confidence-default` / `relevance-contract` / `cadence` / `kind` (or ask the user directly if there's no installation orchestration layer), then write `<project>/_sources/<source-name>.yaml` and the corresponding `<project>/_memories/source-of-authority-<source-name>.md` unit. Set `authority-unit-id` on the registration after the unit lands. Create `<project>/_sources/` only when at least one source is being registered. If the user defers, skip — `/register-sources` handles the same intake protocol on a returning workspace.

**Then ask about governance-document hierarchy** (DC-85 §8). Distinct from the per-external-source authority captured above — this one captures the ordering of the project's own artifacts when they disagree. Ask: *"When the project's documents disagree about a fact — say a PRD and a chat log, or a design spec and a status update — which one wins? Some projects have a clear hierarchy (PRD > HLSD > RTM > chat); others are single-source and this is trivial. Worth a sentence either way."*

Single-source or trivially-ordered projects: skip; no decision unit needed. Multi-document projects with a real hierarchy: write the answer as a decision unit named `dc-NN-source-authority-hierarchy.md` (per project; only one) with the ordered list and one-line rationale per ranked source. The unit gets `type: decision` and `topics: [source-authority, governance]`. Synthesis-pass behavior #5 (spec §5) consults this unit when contradictions are found across sources, so it's the load-bearing target for adversarial reasoning over multi-source projects. When governance changes later, supersede with a new unit and the `supersedes` edge handles the revision — synthesis-pass behavior #5 always reads the current authoritative version.

The naming `dc-NN-source-authority-hierarchy.md` (singular, per-project) intentionally differs from the per-source DC-87 units `source-of-authority-<source-name>.md` (one per external source). Both are valid surfaces; they answer different questions. The DC-87 units say *"this source's authority claim is X."* The DC-85 §8 unit says *"across these sources, here's who wins on contradictions."*

If the project folder turns out to have pre-existing content that wasn't visible during routing (session summaries or legacy handoffs in unusual locations, prior PROJECT.md, session logs surfaced during interview), drop into cold-start migration instead — that branch lives inline in `protocols/startup.md` §"Load — cold-start migration". The new-workspace scaffold is for truly empty projects; substantial prior content always routes through migration.

## Load — folder rename only

The project is already on v2 but has unprefixed CORE folders, or it's on DC-74-era `_handoffs/` and needs the summary rename. Run only the rename step, then proceed to the returning-workspace load (in `protocols/startup.md`).

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

This is routine and idempotent — don't escalate to multi-agent, don't pause for approval. When done, re-enter `protocols/startup.md` §"Load — returning workspace".
