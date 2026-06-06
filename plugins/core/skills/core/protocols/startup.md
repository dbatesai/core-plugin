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
- Use the `read-auto-memory` adapter verb (resolved per `harnesses/<harness>.md`) to load any harness-local recall available. Treat as scratch cache; verify any project-specific reference against the unit store before acting on it. Claude Code surfaces this from `~/.claude/projects/*/memory/MEMORY.md`. Codex can inject memory-like context when `features.memories = true` (experimental); when present, treat it as harness-local recall and run a startup probe to confirm injection occurred before relying on it. See `harnesses/codex.md §read-auto-memory` for details.
- Read `~/.core/topics.md` so the controlled vocabulary is loaded for retrieval and observation auto-tagging.

## Workspace resolution and routing

Resolve deterministically when you can; ask the user only when it's genuinely ambiguous.

Look for `workspace.json` in the current working directory — that's the pointer file. If it's not there, check `~/.core/index.json` for workspaces whose `path` matches the current directory (prefix match). One match → use it. Multiple matches → sort by `last_active` descending and ask the user: *"Last time we worked, we were on [workspace name]. Continuing there, or switching to [other workspace]?"* If `index.json` has exactly one workspace, use it. No match anywhere → unregistered; you'll route to new-workspace setup below unless the project has v1-era content that needs migrating.

**Resolve plugin root before any script call.** `${CLAUDE_PLUGIN_ROOT}` is NOT injected into agent Bash tool calls, and `installed_plugins.json` has no usable entry for a local/source/dev install (`core-dev`) — both are unreliable as the *primary* source, and relying on them is what produced the field failure where CORE_ROOT resolved empty and every script was skipped. The one source always available is **this skill's base directory**: the harness shows it in the SKILL.md header as `<plugin-root>/skills/core`. Make that primary — strip the trailing `/skills/core` and substitute the concrete path for `<PLUGIN_ROOT>` below. The env var and `installed_plugins.json` are fallbacks only. Resolve once and reuse for every `node …` invocation:

```bash
# Preference order: skill base directory (always injected) → CLAUDE_PLUGIN_ROOT env →
# installed_plugins.json. Substitute <PLUGIN_ROOT> with this skill's base directory minus
# the trailing "/skills/core" (read it from the SKILL.md header). If you cannot substitute
# it, the line no-ops and the fallbacks run — never worse than the old behavior.
CORE_ROOT="<PLUGIN_ROOT>"
if [ -z "$CORE_ROOT" ] || [ ! -f "$CORE_ROOT/skills/core/scripts/workspace-fork-check.mjs" ]; then
  CORE_ROOT="${CLAUDE_PLUGIN_ROOT}"
fi
if [ -z "$CORE_ROOT" ] || [ ! -f "$CORE_ROOT/skills/core/scripts/workspace-fork-check.mjs" ]; then
  # Last resort: read the install path from installed_plugins.json. The node
  # payload prints installPath RAW — no regex, no backslash literal — because a
  # backslash inside a double-quoted `node -e` collapses in the shell (\\ becomes
  # \) and yields a compile-time SyntaxError that try/catch cannot catch. That was
  # the silent failure: empty CORE_ROOT then resolved `node "/skills/..."` against
  # the Git-Bash MSYS root on Windows. Separator normalization happens in bash
  # below, where no backslash has to survive node's parser.
  CORE_ROOT=$(node -e "
    try {
      const fs = require('fs'), os = require('os');
      const d = JSON.parse(fs.readFileSync(os.homedir() + '/.claude/plugins/installed_plugins.json', 'utf8'));
      const plugins = d.plugins || {};
      // core@core first, then any 'core@<marketplace>' key — the marketplace name may differ.
      let entries = plugins['core@core'];
      if (!entries) { const k = Object.keys(plugins).find(k => /^core@/.test(k)); entries = k ? plugins[k] : []; }
      entries = entries || [];
      const entry = entries.find(e => e.scope === 'user') || entries[0];
      process.stdout.write(entry?.installPath || '');
    } catch (e) {}
  ")
  # Normalize Windows backslashes to forward slashes in the shell (no-op on POSIX paths).
  CORE_ROOT="${CORE_ROOT//\\//}"
fi
# Resolve to a definite state. On success, echo the root so it carries forward;
# on failure, BLANK it and emit a structured marker. Every downstream `node` call
# is guarded on the scripts dir, so a blank root skips-and-surfaces instead of
# running against the wrong drive (the Windows MSYS-root failure Meridian hit).
if [ -d "$CORE_ROOT/skills/core/scripts" ]; then
  echo "CORE_ROOT=$CORE_ROOT"
else
  CORE_ROOT=""
  echo "CORE-ROOT-UNRESOLVED: startup scripts will be skipped this session. Surface this in the readiness receipt and advise the user to run 'claude plugins update core@core'."
fi
```

If the resolved install is stale (an older build that predates `workspace-fork-check.mjs`), the missing-scripts directory check above catches it: `CORE_ROOT` is blanked and the block prints `CORE-ROOT-UNRESOLVED`. In that case the fork-check and Step-8 commands skip via their own guards, and the readiness receipt surfaces the skip (see "Compose the readiness summary") with the advice to run `claude plugins update core@core`.

**Auto-fork copied workspaces.** Run the fork-check script as the first action of workspace resolution. The guard is mechanical, not advisory — if `CORE_ROOT` is blank or its scripts dir is absent, the call skips with a marker instead of running `node` against an empty/wrong path:

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] \
  && node "${CORE_ROOT}/skills/core/scripts/workspace-fork-check.mjs" \
  || echo "CORE-ROOT-UNRESOLVED: skipping workspace-fork-check"
```

The script reads `<cwd>/workspace.json` and `~/.core/index.json`, detects whether the local pointer was copied from another project (its `workspace_id` resolves to an index entry whose registered `path` is somewhere else), and if so performs the fork: slugifies the cwd basename into a new id (collision-resolved with `-2`, `-3`, etc.), then writes the three surfaces in a crash-recoverable order — the meta dir + fresh manifest at `~/.core/workspaces/<new-id>/workspace.json` first, then the `index.json` entry, then the local pointer last — every write atomic (temp-file + rename). The order makes an index entry always imply its meta dir exists, so a crash mid-fork re-forks cleanly next session rather than orphaning the workspace. If there's nothing to do — no pointer, no index, path already registered, or `workspace_id` not in index — it prints `(no fork needed)` and exits 0. The check is idempotent: re-running after a fork finds the id already matches the cwd and is a no-op.

Echo the script's stdout verbatim into the readiness summary as a quoted line — exact characters, no paraphrase, no rewording. If it printed `forked <original-id> -> <new-id>; registered at ~/.core/workspaces/<new-id>/`, the readiness must contain that exact string with the actual id values from stdout. After the verbatim echo, you may add a plain-voice gloss in a separate sentence (e.g., *"That means this `workspace.json` was copied from `<original-id>`; we're treating it as a new workspace."*) — but the gloss is supplemental, never a replacement. If the script printed `(no fork needed)`, no narration required.

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
- Read `<project>/inbox.md` if it exists. Raw pending items — promote worthwhile facts into the right units on the user's next review. When entries carry `mode: B` or `mode: C` frontmatter, they're pending review per the source-registration framework; count them for the readiness summary.
- Read `<project>/_sources/*.yaml` if the directory exists — the registered external sources for this project. Note the names and count for the readiness summary.
- Read `~/.core/workspaces/<id>/workspace.json` for cross-session metadata only (last-session date, timestamps). Don't read project facts from here — there aren't any.

After any Tier 1+ retrieval during startup, write one retrieval-shaped row with the exact producer schema. Do not invent aliases such as `session_intent_topics`, `highest_tier_reached`, or `selected_units`; the helper rejects them.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/record-retrieval-event.mjs" <project> --event-json '{"trigger":"session-start","intent_topics":["orient","memory"],"tier_reached":1,"escalation_path":[1],"units_retrieved":[{"id":"dc-memory-index","tier":1}],"dip_back_count":0,"candidate_count":8,"selected_count":1,"edge_count":0,"retired_suppressed_count":0,"stale_suppressed_count":0,"native_memory_suppressed_count":0,"context_pack_token_estimate":1200,"usefulness_outcome":"useful"}'
```

Tier 0 in-context reuse does not need a retrieval row.

**Skip these surfaces at bootstrap:**
- Session summaries in `<project>/_summaries/` (or legacy `_handoffs/` if the rename hasn't happened yet). They're narrative for the human reader. Facts worth keeping were already in PROJECT.md or the units at session close. Re-reading summaries re-anchors you on narrative framing and can resurrect user-deleted facts.
- `<project>/PROJECT-ARCHIVE.md`, `<project>/IMPROVEMENT_LOG-ARCHIVE.md`. Single-write archive surfaces.
- Legacy workspace files (`raid-log.md`, `decision-log.md`, `next-session.md`, `handoffs/`) under `~/.core/workspaces/<id>/` — pre-2026-04-21 structure. If `PROJECT.md` exists, ignore them. If it doesn't, surface the mismatch and offer to migrate.

Run edit-detection on the files you read against `~/.core/state-cache.json`. If a file's hash doesn't match, something changed between sessions — but first rule out CORE's own renders, which are not user edits:

- **CORE-authored writes.** A PROJECT.md diff confined to the marker-delimited hot-section block (`<!-- HOT-SECTION:BEGIN -->`…`<!-- HOT-SECTION:END -->`), or a file whose state-cache `last_written_by` is a CORE writer (e.g. `hot-section`), is CORE's synthesis — `hot-section.mjs apply` stamps that authorship itself. Refresh the cache entry and move on; do NOT propagate or fire anti-resurrection.
- **Unit files:** a genuine user edit IS the new truth. Update the state cache, propagate any frontmatter implications, narrate what changed.
- **PROJECT.md (user edit):** a change OUTSIDE the hot block is the user's authorship asserting itself. Propagate back to the source units (frontmatter updates, `status: retired` for removed facts). Anti-resurrection fires for removals — a fact the user deleted stays deleted.

Surface any genuine user edit in the readiness summary before the agenda.

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

If the project folder turns out to have pre-existing content that wasn't visible during routing (session summaries or legacy handoffs in unusual locations, prior PROJECT.md, session logs surfaced during interview), drop into cold-start migration instead. The new-workspace scaffold is for truly empty projects; substantial prior content always routes through migration.

## Load — cold-start migration

The project has substantive prior content but no v2 unit store. Run the nine steps below in order. Each step is load-bearing; don't demote any into "I'll handle that later in §Moves."

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

**Gate first.** If `CORE_ROOT` did not resolve (blank, or no scripts dir — the resolver block printed `CORE-ROOT-UNRESOLVED`), skip this entire step and carry the unresolved state into the readiness receipt. Do not run a bare `node "${CORE_ROOT}/..."` — an empty root resolves against the wrong drive on Windows Git-Bash and dies silently. When `CORE_ROOT` is resolved, each command runs as-is; the `[ -d "$CORE_ROOT/skills/core/scripts" ] && node ... ` guard form is the mechanical version if you run them defensively in one block.

| # | Command | Pass criteria |
|---|---|---|
| a | `node "${CORE_ROOT}/skills/core/scripts/check-units.mjs" --store <project> --schema` | Exit 0 — no frontmatter mismatches, no invalid status/type enums, no dangling edges at the schema level |
| b | `node "${CORE_ROOT}/skills/core/scripts/check-units.mjs" --store <project> --integrity` | Exit 0 — no orphans (or expected-orphan pattern named in plan), no broken edge targets, no stale-flagged units |
| c | `node "${CORE_ROOT}/skills/core/scripts/generate-decisions-index.mjs" --store <project>` | Writes `INDEX-decisions.md` with the expected decision count |
| d | `node "${CORE_ROOT}/skills/core/scripts/generate-risks-index.mjs" --store <project>` | Writes `INDEX-risks.md` with the expected risk count |
| e | `node "${CORE_ROOT}/skills/core/scripts/priority.mjs" <project>/_memories --top 10` | Ranks successfully; foundational decisions and high-severity risks surface at top; topics field populated |
| f | `node "${CORE_ROOT}/skills/core/scripts/compact-project.mjs" --check <project>` | Reports PROJECT.md under cap |

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
- **Open-question past `by-when` (DC-85 §2).** Walk active open-question units in `<project>/_memories/`. For each unit with `type: open-question` AND `status: active` AND a `by-when` field whose ISO date is in the past, surface it in the readiness summary. Plain voice: *"One open question past its by-when: oq-michelle-design-review expected 5/22 — six days ago."* This is the absence-detection primitive; the architecture surfaces the lapse so the user doesn't have to remember it. The Michelle probe (spec §10) validates this mechanism.

- **Recent hygiene-log signals (DC-85 Phase 1b).** Read `<project>/_sessions/<most-recent-date>/hygiene-log.jsonl` if present. Surface what matters in plain voice — don't pile on: a `demote-moves-large-batch` from the last 1–2 sessions → *"last `demote-moves` ran on N candidates (threshold M); criteria may be tightening or loosening — worth a glance next `/process-memory`"*; `project-md-over-cap` events that persist across sessions → *"PROJECT.md is stuck over the ~70KB soft target; the compactor warns, doesn't block."* Skip when the log is absent (fresh workspace) or shows clean steady-state.

Apply these before composing readiness. If any of them escalate, lead with the escalation.

## Memory processing nudge

Read `<project>/_memories/_pm-state.json` if it exists. If `now - last_run > 24 hours` (or the file doesn't exist), include a one-line prompt in the readiness summary:

> *"Memory processing hasn't run in [X hours/days] — worth running `/process-memory` when you get a moment."*

Don't block on it. It's a nudge, not a gate.

## Hot-section synthesis pass

The hot section sits atop `<project>/PROJECT.md` — 5–7 lines naming what matters right now. Refresh it conditionally — only when candidate ranking has shifted meaningfully since the last synthesis, or when this session's intent diverges from what the existing hot section addresses. This runs after elapsed-time signals (an escalation can feed the refresh) and before the readiness summary (the refreshed section feeds the receipt).

**When to refresh** (any one suffices):

- The existing hot section is missing (project predates DC-85 Phase 1a, or it was cleared).
- The existing hot section is older than 24 hours (the candidates underneath have likely shifted).
- Session-intent topics don't overlap with the topics the existing hot section addresses (priority ranking will shift under the new intent).
- An elapsed-time signal (above) escalated something the existing hot section doesn't mention.

**When to skip:** the existing hot section is fresh, the session intent matches its framing, and nothing escalated. Skip silently — don't refresh just to refresh.

**How to refresh** (reuse the `CORE_ROOT` resolved in §"Workspace resolution and routing"; the guard skips cleanly if it's blank):

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/hot-section.mjs" candidates <project> --top 12 --session-topic <topic1> --session-topic <topic2>
```

Read the candidate list, then compose 5–7 lines of plain prose blending two inputs: the priority candidates (stable structural heft) and your session-level awareness (current work, recent reconciliations, forward moves). Usually 1–3 items, no bold lead-in paragraphs unless the items genuinely need scannable headers. Land it:

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/hot-section.mjs" apply <project> --text "<composed prose>"
```

`hot-section.mjs apply` writes PROJECT.md and stamps `last_written_by: hot-section` into `~/.core/state-cache.json` itself, so next session's edit-detection (§"Load — returning workspace") recognizes the change as CORE's synthesis, not a user edit — no manual reconciliation, and `/finalize`'s close-of-session hot-section write is covered the same way (both go through `applyHotSection`).

Narrate the refresh in one sentence as part of readiness — *"Refreshed the hot section: Phase 1a is mid-flight and DC-88 just reconciled."* The agent self-disciplines on length (the 500-token enforcement is Phase 1b).

## Compose the readiness summary

**Before composing — run capability probe (fail-open).** If `$CORE_ROOT` was resolved, run:

```bash
node "${CORE_ROOT}/skills/core/scripts/capability-probe.mjs" --startup --json 2>/dev/null \
  > ~/.core/workspaces/<id>/capability-state.json || true
```

Then append this session's snapshot to the capability history — the per-session record that drift and regression analysis read at `/finalize` and `/process-memory`:

```bash
node "${CORE_ROOT}/skills/core/scripts/record-capability-snapshot.mjs" --workspace-id <id> 2>/dev/null || true
```

**Scaffold the metrics store (fail-open).** Once the workspace id is resolved, scaffold `_metrics/` so the observability substrate has somewhere to write — `log-event.mjs`'s OTel dual-write resolves its storage path from the pin file this writes, and on Windows+OneDrive this is what redirects payloads off the synced path. Idempotent and never fatal; a scaffold failure degrades metrics capture but never blocks the session.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/metrics-init.mjs" <project> <workspace-id> >/dev/null 2>&1 || true
```

Read the output. When **any row is non-PASS**, narrate in plain voice:

> *"Continuing with degraded capability evidence. plugin-root-resolution: DEGRADED (harness split-brain). Identity is best-effort this session."*

Use **"continuing with degraded capability evidence"** verbatim per HC — not "ready," not "certified." When all rows PASS, do not surface capability state in readiness per `feedback_readiness_only_escalations`.

If `$CORE_ROOT` was not resolved (script unavailable), skip the capability probe silently — the probe itself is best-effort at startup, never a blocker.

**But surface the unresolved root itself — loudly, once.** An unresolved `CORE_ROOT` is not a silent best-effort skip: it means the fork-check and all six Step-8 readiness commands were skipped this session, so the workspace was loaded without index regeneration, priority ranking, or the compaction check. Include a visible line in the readiness receipt — *"Heads up: I couldn't resolve the CORE plugin root this session, so the startup scripts (fork-check, index regen, priority, compaction check) were skipped. Run `claude plugins update core@core` and I'll have them next session."* This turns the wrong-drive silent failure into a visible degraded state the user can act on.

**Before composing — view memory.** Re-check the auto-memory loaded in Identity load (the harness injects this into context, typically as `MEMORY.md`), especially the cross-project feedback memories. Recognition-failure looks like having memory loaded but not reaching for it; an explicit re-check at this point closes the gap. Mirrors Anthropic's memory-tool system prompt — *always view your memory directory before doing anything else.*

Make workspace identity obvious. Talk like a person.

What to include:
- A structured one-line routing-decision tag at the start or end of the summary, rendered as the literal characters `Routing: <branch-name>` — no backticks, no Markdown code formatting around the branch-name value. The exact rendered form is `Routing: new-workspace` (not `` `Routing: \`new-workspace\` ``). Branch-name is one of `returning-workspace`, `cold-start-migration`, `folder-rename`, `new-workspace`, `migration-resume`. This makes regression tests robust to prose drift while preserving the conversational readiness summary below.
- The workspace name in plain language.
- What `PROJECT.md` currently says in §State — one or two sentences, not a recap of every section.
- Active risks worth surfacing now (count plus the top one or two by impact).
- Any elapsed-time signals that escalated.
- Source-registration signals when they're worth mentioning: pending Mode B/C blocks in `<project>/inbox.md` (count plus a one-line nudge — *"three pending observations in the inbox waiting on review"*), or observations citing a `source:` not in `<project>/_sources/` (drift signal — name the source). Skip silently when the inbox is empty and no drift surfaced.
- The top 3 §Moves priorities as the agenda.
- Anything auto-compacted during first-time setup, named explicitly (entries, not counts).
- The recognition signal, when present and worth flagging: read the one-line `~/.core/workspaces/<id>/metrics/orient-signal.txt` (pre-computed by `metrics-rollup.mjs` at last session close — that script is the mechanism's source of truth). Surface it ONLY when the headline `rec-fail-tier-0` rate is trending up (the `↑` marker) — "the agent's own measurement says recognition is slipping." It is **PROVISIONAL** (the classifier isn't calibrated yet); frame it as a self-audit signal, never a graded metric. Absent file or a flat/down trend → say nothing (per `feedback_readiness_only_escalations`).
- Plugin version + build: read both `version` and `build` from `../../.claude-plugin/plugin.json` relative to the skill base directory (which resolves to the plugin root's `plugin.json`) — that manifest is the single source of truth for both. Echo as "Plugin v<version> build <build>". If `plugin.json` is unreadable, omit the line; if it's readable but has no `build`, echo just "Plugin v<version>".

Target voice:

> *"Picking up on the [project name]. Last session closed Wednesday with the routing rework merged. PROJECT.md says we're mid-migration: Phase 1 done, Phase 2 in progress. Top of §Moves is the auth-rewrite review. One stale risk worth flagging: R-3 last reviewed three weeks ago. Ready."*

What to skip: session summary content (not part of the bootstrap read); auto-memory cited as authoritative (it's scratch cache); session log recaps (per-session artifacts, not state); a full section-by-section recital (the user sees PROJECT.md when they want the full view).

**Record the bootstrap.** After readiness lands, write `~/.core/workspaces/<id>/last-bootstrap.json` with two fields: `session_started_at` (the Claude Code session-start timestamp — best available proxy is the timestamp of the first user message this session) and `bootstrap_completed_at` (now). This is the durable signal `skills/core/SKILL.md §"Before the task — startup"` reads to decide whether bootstrap already ran this session.

After readiness lands, only ask what you still don't know — genuine gaps that no durable artifact resolved, with a hypothesis when you have one. Don't ask "what were we working on?" (you just read it), "what would you like to do today?" (the agenda tells you), or "can you catch me up?" (that's exactly what bootstrap prevents). Do ask deferred-decision questions ("PROJECT.md flags the X decision as deferred pending your call — have you decided?"), agenda-fork questions ("continue the v2 build or pivot to the stale R-5 risk first?"), and missing-unit questions ("the session-intent topic 'auto-creation rules' didn't surface a unit at Tier 1 or 2 — written yet, or still pending?"). Then wait for the user's next move; the agenda topics get resolved or explicitly deferred before implementation work begins.

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
