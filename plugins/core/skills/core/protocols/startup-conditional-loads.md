# Startup — conditional load branches

## Voice

Plain person voice — same standard as `startup.md` §Voice. These branches run rarely; when they do, narrate the routing decision and the work in plain voice.

---

Read this file **only when** `protocols/startup.md` §"Workspace resolution and routing" lands on one of two branches: **new-workspace** (truly empty project) or **folder-rename** (a returning v2 project on legacy folder names). Both are conditional loads that don't fire on an established returning workspace, so they live here instead of loading into every session.

The **cold-start migration** branch is *not* here — it stays inline in `startup.md` by design (it's the one irreversible branch, and its plan/flag backstops must always be in context). If routing selected migration, execute it from `startup.md`, not this file.

After either branch below completes, re-enter `protocols/startup.md` §"Load — returning workspace" and continue from there (elapsed-time signals → hot-section → readiness).

## Load — new workspace

Interview first. Don't skip this.

- What's the problem or task? Scope? Timeline? What does success look like?
- Constraints? Stakeholders? What's already been tried?

Then scaffold the synthesis: create `<project>/PROJECT.md` with the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes) populated from the interview. Solo projects can declare "solo project, no §People" inline rather than leaving the section blank.

Create the unit store: `mkdir -p <project>/_memories/observations/<YYYY-MM>/`. Project folders hold only data; the priority function and other executable units ship with the plugin by design.

Create `<project>/inbox.md` if external pulls are expected. Create the project-folder pointer at `<project>/workspace.json` with `schema_version: v2`, `workspace_id`, `name`, `created`, `data_path`. Create the workspace meta at `~/.core/workspaces/<workspace-id>/workspace.json` with `schema_version: v2` plus the workspace schema fields, and `~/.core/workspaces/<id>/swarm-narrative.md` empty for now. Register the workspace via the scripted writer — never by hand-editing `~/.core/index.json` (freehand registry writes race concurrent sessions; `protocols/data-storage.md §Shared-write concurrency`):

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/index-registry.mjs" add --json '{"workspace_id":"<id>","name":"<name>","path":"<abs-project-path>"}'
```

If `CORE_ROOT` is unresolved this session, defer the registration and surface it in the readiness receipt (the workspace still works locally via its pointer; registration lands on the next healthy startup).

**First-run metrics disclosure — structural, not a reminder to remember.** Metrics capture is default-on by design from this workspace's first turn onward: every turn gets locally classified, including a `user_text` field with real excerpts of what the user typed, written to `_metrics`/workspace metrics dirs. Nothing transmits over a network, but the user has had no way of knowing this happens at all — so the very first readiness summary this workspace ever gets must disclose it. This is scripted the same way the fork-check is (`protocols/startup.md` §"Auto-fork copied workspaces") so it can't be silently skipped: run the check immediately after the workspace meta write above (it needs the manifest to already exist so it can add its flag rather than race the creation):

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/metrics-disclosure.mjs" check <workspace-id>
```

The flag it checks (`metrics_disclosure_shown` in the workspace manifest) lives with the workspace, not the session, so this is safe to run every time a workspace scaffolds — it fires exactly once, ever, per workspace id. If it prints notice text, that text goes into this session's first readiness summary **verbatim, word for word** — it names what CORE logs locally, why (self-improvement, nothing else), that nothing transmits anywhere, and both opt-out mechanisms (`CORE_METRICS_ENABLED=0`, or `metrics_enabled: false` in this project's `workspace.json`). You may add a plain-voice sentence around it, same as the fork-check echo, but never paraphrase the notice itself out of existence. If it prints `ALREADY-SHOWN`, or `CORE_ROOT` didn't resolve so the check was skipped, say nothing about metrics — this notice runs once, not every session.

Then ask about external sources. *"Are there external data sources that should feed this project's memory? We can register them now, or add them later via `/register-sources`."* If the user names sources, walk through registration per `references/external-sources/source-registration-framework.md §3`. For each source: capture the authority statement (the prose answer becomes both the registration's `authority` field and a `source-of-authority` unit), surface the installation's suggested defaults for `confidence-default` / `relevance-contract` / `cadence` / `kind` (or ask the user directly if there's no installation orchestration layer), then write `<project>/_sources/<source-name>.yaml` and the corresponding `<project>/_memories/source-of-authority-<source-name>.md` unit. Set `authority-unit-id` on the registration after the unit lands. Create `<project>/_sources/` only when at least one source is being registered. If the user defers, skip — `/register-sources` handles the same intake protocol on a returning workspace.

**Then ask about governance-document hierarchy**. Distinct from the per-external-source authority captured above — this one captures the ordering of the project's own artifacts when they disagree. Ask: *"When the project's documents disagree about a fact — say a PRD and a chat log, or a design spec and a status update — which one wins? Some projects have a clear hierarchy (PRD > HLSD > RTM > chat); others are single-source and this is trivial. Worth a sentence either way."*

Single-source or trivially-ordered projects: skip; no decision unit needed. Multi-document projects with a real hierarchy: write the answer as a decision unit named `dc-NN-source-authority-hierarchy.md` (per project; only one) with the ordered list and one-line rationale per ranked source. The unit gets `type: decision` and `topics: [source-authority, governance]`. Synthesis-pass behavior #5 (spec §5) consults this unit when contradictions are found across sources, so it's the load-bearing target for adversarial reasoning over multi-source projects. When governance changes later, supersede with a new unit and the `supersedes` edge handles the revision — synthesis-pass behavior #5 always reads the current authoritative version.

The naming `dc-NN-source-authority-hierarchy.md` (singular, per-project) intentionally differs from the per-source units `source-of-authority-<source-name>.md` (one per external source). Both are valid surfaces; they answer different questions. The per-source units say *"this source's authority claim is X."* The project-hierarchy unit says *"across these sources, here's who wins on contradictions."*

If the project folder turns out to have pre-existing content that wasn't visible during routing (session summaries or legacy handoffs in unusual locations, prior PROJECT.md, session logs surfaced during interview), drop into cold-start migration instead — that branch lives inline in `protocols/startup.md` §"Load — cold-start migration". The new-workspace scaffold is for truly empty projects; substantial prior content always routes through migration.

## Load — folder rename only

The project is already on v2 but has unprefixed CORE folders, or it's on the legacy `_handoffs/` layout and needs the summary rename. Run only the rename step, then proceed to the returning-workspace load (in `protocols/startup.md`).

Announce the rename in plain voice. Example: *"This project has the legacy folder names. Renaming `handoffs/` → `_summaries/`, `sessions/` → `_sessions/`, `outputs/` → `_outputs/` before loading."* Or, for the `_handoffs/`-to-summary case: *"This project still has the legacy `_handoffs/` folder. Renaming to `_summaries/` before loading."*

For each folder that exists, use `git mv` (or plain `mv` if not in a git tree). On cloud-sync-virtualized paths (OneDrive, Dropbox, iCloud Drive), `mv` can corrupt the sync state — use `cp -r <src> <dst>` then `rm -rf <src>` after verifying file counts match, same as `protocols/startup.md` Step 4:
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
