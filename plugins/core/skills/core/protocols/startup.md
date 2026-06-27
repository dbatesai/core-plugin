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

- Run `detect-harness()` (per `protocols/harness.md`) and read the matching `harnesses/<name>.md` adapter. Every adapter verb below — starting with `read-auto-memory` — resolves against this loaded adapter; don't use one before the adapter is loaded.
- Read `~/.core/dm-profile.md` in full. Cross-project personality and patterns; no project facts. You're now yourself — same agent as last session.
- Use the `read-auto-memory` adapter verb (resolved per `harnesses/<harness>.md`) to load any harness-local recall available. Treat as scratch cache; verify any project-specific reference against the unit store before acting on it. Claude Code surfaces this from `~/.claude/projects/*/memory/MEMORY.md`. Codex can inject memory-like context when `features.memories = true` (experimental); when present, treat it as harness-local recall and run a startup probe to confirm injection occurred before relying on it. See `harnesses/codex.md §read-auto-memory` for details.
- Read `~/.core/topics.md` so the controlled vocabulary is loaded for retrieval and observation auto-tagging.

## Workspace resolution and routing

Resolve deterministically when you can; ask the user only when it's genuinely ambiguous.

Look for `workspace.json` in the current working directory — that's the pointer file. If it's not there, check `~/.core/index.json` for workspaces whose `path` matches the current directory (prefix match). One match → use it. Multiple matches → sort by `last_active` descending and ask the user: *"Last time we worked, we were on [workspace name]. Continuing there, or switching to [other workspace]?"* If `index.json` has exactly one workspace, use it. No match anywhere → unregistered; the routing below will send you to the new-workspace branch (its procedure lives in `protocols/startup-conditional-loads.md`) unless the project has v1-era content that needs migrating.

**Resolve plugin root before any script call.** `${CLAUDE_PLUGIN_ROOT}` is NOT injected into agent Bash tool calls, and `installed_plugins.json` has no usable entry for a local/source/dev install (`core-dev`) — both are unreliable as the *primary* source. The one source always available is **this skill's base directory**: the harness shows it in the SKILL.md header as `<plugin-root>/skills/core`. Strip the trailing `/skills/core`, substitute the concrete path for `<PLUGIN_ROOT>` below, and let `resolve-plugin-root.mjs --print-root` do the verification — it realpaths from its own module location, walks up to the plugin manifest, and prints the root with forward slashes on every platform. The resolution itself is one `node` call, so it behaves identically under bash, zsh, Git-Bash, and PowerShell — no bash-only parameter expansion, no inline `node -e` payload. Resolve once and reuse for every `node …` invocation:

```bash
# Substitute <PLUGIN_ROOT> with this skill's base directory minus the trailing
# "/skills/core" (read it from the SKILL.md header). The script verifies and
# normalizes; the env var is a fallback for FINDING the script only.
CORE_ROOT="$(node "<PLUGIN_ROOT>/skills/core/scripts/resolve-plugin-root.mjs" --print-root 2>/dev/null ||
             node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/resolve-plugin-root.mjs" --print-root 2>/dev/null)"
if [ -d "$CORE_ROOT/skills/core/scripts" ]; then
  echo "CORE_ROOT=$CORE_ROOT"
else
  CORE_ROOT=""
  echo "CORE-ROOT-UNRESOLVED: startup scripts will be skipped this session. Surface this in the readiness receipt and advise the user to run 'claude plugins update core@core'."
fi
```

**On PowerShell/CMD (Windows Codex):** the same `node … --print-root` call is the whole resolution — run it and substitute its printed path as the literal `CORE_ROOT` value in every subsequent script call. Don't port the bash gate; the script's exit code (0 resolved, 2 unresolved) is the signal. If the call fails, treat the session as CORE-ROOT-UNRESOLVED and surface it the same way.

**Last-resort fallback (no shell tricks):** if both invocations fail and you're on Claude Code, read `~/.claude/plugins/installed_plugins.json` with the read tool, find the `core@…` entry's `installPath`, and re-run `--print-root` against `<installPath>/skills/core/scripts/resolve-plugin-root.mjs`. This replaces the old inline `node -e` payload — the read goes through the file tool, so there is no quoting footgun on any platform.

If the resolved install is stale (an older build missing a script a newer protocol references), the individual `node` call fails loudly with a module-not-found error instead of silently no-opping. Surface that in the readiness receipt the same way as an unresolved root, with the advice to run `claude plugins update core@core`. A fully missing scripts dir is still caught by the gate above: `CORE_ROOT` is blanked and the block prints `CORE-ROOT-UNRESOLVED`, so the fork-check and Step-8 commands skip via their own guards.

**Probe the hardware budget (cross-platform).** Run once, right after the root resolves — `protocols/execution.md §"Hardware budget"` reads this result when sizing multi-agent work, and `os.totalmem()` works identically on Mac, Linux, and Windows (no `sysctl`):

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/hardware-budget.mjs" || true
```

Note the printed profile for later; don't narrate it unless the session actually goes multi-agent.

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

- **Migration-in-progress flag present.** If `<project>/_memories/.migration-in-progress` exists, a prior session started cold-start migration and didn't finish (or migration is running in another session). Resume migration — do not route to the returning-workspace load regardless of what else is in `_memories/`. The flag is the authoritative signal, and its `step-N-complete` lines (see Step 2) tell you exactly where to re-enter: continue from the first step with no completion line.
- **Unit store populated.** `<project>/_memories/` exists AND contains at least one canonical unit. A canonical unit is any `*.md` file in `_memories/` (recursive) whose name does not start with `_` (e.g., `_validation/`) and does not start with `INDEX`. Existence alone isn't enough — populated is the precondition. If populated AND no unprefixed CORE folders, route to the returning-workspace load.
- **Unit store populated BUT unprefixed CORE folders exist.** Pre-DC-74 naming on `handoffs/`, `summaries/`, `sessions/`, or `outputs/`. Run the folder-rename-only path, then proceed to returning-workspace load.
- **Unit store empty-or-missing, v1 markers present.** A prior PROJECT.md, `_summaries/` (or legacy `_handoffs/`), `_sessions/`, `_outputs/` (or unprefixed equivalents), `plan.md`, `specs/`, `rebuild/`, or legacy workspace meta at `~/.core/workspaces/<id>/tracking/` or `~/.core/workspaces/<id>/handoffs/` — any of these counts. Cold-start migration before any other load.
- **Unit store empty-or-missing, no v1 markers.** Truly new workspace. Interview and scaffold.

Surface the routing decision to the user in plain voice before proceeding. *"This project has prior content but no v2 unit store yet, so I'm going to run the cold-start migration before doing anything else."* For the rename-only case: *"This project's CORE folders are on the pre-DC-74 names. I'm going to rename them to the underscore convention before loading."* For the resume case: *"A migration-in-progress flag is present from a prior session. Resuming the cold-start migration before loading."*

Routing failure is itself a defect. If you find yourself trying to load the unit store on an empty/missing `_memories/` or with the migration flag present, stop and re-route.

**Conditional-load branches — read the sub-file when routing selects one.** When routing lands on **new-workspace** or **folder-rename**, **STOP and read `protocols/startup-conditional-loads.md` now**, then execute the matching section there and re-enter the returning-workspace load below. Those two branches don't fire on an established workspace, so their procedures live in that sub-file rather than loading every session. Do not run them from memory. The **cold-start migration** branch (and its migration-in-progress resume case) stays inline below — it's the one irreversible branch, its plan/flag backstops must always be in context, so it is *not* extracted. The **returning-workspace load** below is the common path; read it directly.

## Load — returning workspace

**Precondition:** `<project>/_memories/` exists, contains at least one canonical unit, and no migration-in-progress flag.

**Integrity probe before loading.** "Populated" is not "healthy" — a crashed migration or a half-synced store can leave partial units that this routing would otherwise load silently as a returning workspace. Before the tiered load, run the same integrity check cold-start Step 8b uses (guarded like every script call):

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/check-units.mjs" --store <project> --integrity \
  || echo "CORE-INTEGRITY-DEGRADED: store failed the integrity probe (or CORE_ROOT unresolved — probe skipped)"
```

Exit 0 → proceed normally. Anything else → degraded path: still load PROJECT.md and whatever units parse (the user needs to work), but lead the readiness summary with the failure and the probe's output, hold anti-resurrection and autonomous renders until the store is reconciled (you can't trust edit-detection against a broken store), and propose the fix — `/process-memory`, or resuming the migration if the damage traces to one. Never load a failing store silently as if it were healthy.

The v2 load uses the retrieval ladder, not a cover-to-cover read. The goal is to know enough to answer the user's next question, not to load every file.

- Read `<project>/workspace.json` to get the workspace id and data path.
- **Tier 0 (in-context):** the session-intent topics are whatever the user just said or typed. Pull those into mind, and read `<project>/PROJECT.md` **in full** to anchor the six-section view — `references/retrieval.md` counts that read as Tier 0, the already-loaded surface. Read the whole file, not a head slice — §Decisions & Risks and §Moves live well past the first screen, and a partial read silently drops them. If PROJECT.md is large enough to exceed one Read call, page through it (hot section first, then §Decisions & Risks, then the remainder within budget) and **keep track of how many lines you actually read** — that read-extent feeds the context-integrity check below (DC-94a), which surfaces any shortfall instead of letting it pass unnoticed. If the conversation is empty (cold start, no user message yet), the session-intent topics default to the bootstrap set — `orient`, `memory`, `state` — and that's what the first Tier 1 grep runs on; they resolve to the user's actual words after the first turn.
- **Tier 1 (lexical retrieval):** Grep `<project>/_memories/` for session-intent topic terms to surface relevant active units. Load whatever the grep returns above the priority threshold.
- **Tier 2 (graph walk):** for each loaded unit, walk its `supersedes` and `depends-on` edges one hop to pick up the related context. Stop when the candidate set is good enough.
- **Tier 3 (semantic):** only escalate if Tier 0–2 leave the user's actual question unanswered. The `Explore` subagent reasons over the vault for semantic queries.
- Read `<project>/inbox.md` if it exists. Raw pending items — promote worthwhile facts into the right units on the user's next review. When entries carry `mode: B` or `mode: C` frontmatter, they're pending review per the source-registration framework; count them for the readiness summary.
- Read `<project>/_sources/*.yaml` if the directory exists — the registered external sources for this project. Note the names and count for the readiness summary.
- Read `~/.core/workspaces/<id>/workspace.json` for cross-session metadata only (last-session date, timestamps). Don't read project facts from here — there aren't any.

After any Tier 1+ retrieval during startup, write one retrieval-shaped row with the exact producer schema. Do not invent aliases such as `session_intent_topics`, `highest_tier_reached`, or `selected_units`; the helper rejects them. The example below shows the schema only — fill every value from what actually happened this bootstrap: `units_retrieved` lists the units your grep or walk actually selected (real ids from THIS project), `intent_topics` the actual session-intent topics, the counts the real counts. Logging the placeholder values records a retrieval that never happened.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/record-retrieval-event.mjs" <project> --event-json '{"trigger":"session-start","intent_topics":["<actual-topic-1>","<actual-topic-2>"],"tier_reached":1,"escalation_path":[1],"units_retrieved":[{"id":"<unit-id-actually-retrieved>","tier":1}],"dip_back_count":0,"candidate_count":8,"selected_count":1,"edge_count":0,"retired_suppressed_count":0,"stale_suppressed_count":0,"native_memory_suppressed_count":0,"context_pack_token_estimate":1200,"usefulness_outcome":"useful"}'
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

## Load — cold-start migration

The project has substantive prior content but no v2 unit store. Run the nine steps below in order. Each step is load-bearing; don't demote any into "I'll handle that later in §Moves."

**Verify the model is appropriate.** Cold-start migration on a large project warrants Opus + ultrathink-level reasoning. Surface the recommendation if the session is on a smaller model before proceeding.

**Step 1 — Draft the migration plan with unit inventory enumerated.** Before writing the migration-in-progress flag, before any destructive action, draft `~/.core/workspaces/<id>/migration-plan.md`. The plan must enumerate the unit inventory unit-by-unit (people, decisions, risks, observations, open questions) — not "I'll discover units as I go." Naming conventions, edge structure, phase ordering, stop conditions, and any environment-specific concerns (OneDrive `cp -r` + `rm -rf` instead of `mv`; anti-resurrection traps specific to this corpus) get named in the plan. Surface the plan to the user for review and get the go-ahead before executing. If `~/.core/workspaces/<id>/migration-plan.md` already exists from a prior planning session, read it and execute from that — don't re-design.

This step is load-bearing. The advisor-caught addition — enumerate the inventory before any destructive action so you're not discovering mid-flight — is what makes the rest mechanical. Promoted from advisor-caught to protocol-required 2026-05-20 after a downstream-wrapper migration validated the pattern on a real non-CORE workspace.

**Step 2 — Write the migration-in-progress flag.** Create `<project>/_memories/.migration-in-progress`. First line: the session timestamp and a brief reason (`2026-05-20T11:23:00Z — cold-start migration begun`). The file is also the step-progress ledger: after each of Steps 3–7 completes, append one line in the form `step-N-complete 2026-05-20T11:41:00Z` (N = the step number, timestamp ISO). This flag guards against re-invocation mid-migration silently routing to the returning-workspace load on a partial store, and the step lines make a crash recoverable — a resume continues from the first step with no `step-N-complete` line instead of re-entering from the top and duplicating work. If the flag is already present from a prior interrupted session, read its step lines, resume from the first incomplete step (each step below carries its own "on re-entry" rule), and append a fresh resume line (`2026-05-21T09:00:00Z — resumed`) so the audit trail shows the gap. The flag is removed at the end as the explicit signal that migration completed cleanly — the step lines go with it.

**Step 3 — Write the early summary stub.** Migration is the canonical long/autonomous/complex session that warrants the early summary (see "Long sessions" below). Append `step-3-complete <ISO>` to the flag when done. On failure (the stub won't write — permissions, disk): non-fatal — note the gap in the migration plan and continue; the stub is insurance, not a dependency. On re-entry: if today's stub already exists, append to it rather than recreating it.

**Step 4 — Folder rename (DC-74 + summary rename).** If the project has unprefixed CORE folders (`handoffs/`, `summaries/`, `sessions/`, `outputs/`), rename them to the current underscore convention. For each folder being renamed, check `git ls-files <folder>` first — if any files are tracked, use `git mv` so history follows; otherwise plain `mv`. A project can live inside a git tree (a home-directory git repo is a common case) without its project subfolders being tracked, in which case `git mv` fails with a misleading "source directory is empty" error. The per-folder tracked check avoids that. On cloud-sync-virtualized paths (OneDrive, Dropbox, iCloud Drive), `mv` can corrupt the sync state — use `cp -r <src> <dst>` then `rm -rf <src>` after verifying counts match. Both `handoffs/` (pre-rename) and `summaries/` map to `_summaries/`; `sessions/` → `_sessions/`; `outputs/` → `_outputs/`. Run a path-citation sweep in `_memories/*.md` after the renames so frontmatter `sources:` pointers stay valid. Narrate the renames in plain voice as they happen. Append `step-4-complete <ISO>` to the flag when every folder is done. Failure handling, per folder: on the copy-then-delete path, verify file counts match (`find <src> -type f | wc -l` vs the same on `<dst>`) BEFORE the `rm -rf` — on mismatch, stop, keep the source, and surface; never delete a source you haven't verified. On re-entry: a folder whose underscore target already exists and whose source is gone is done — skip it; if BOTH source and target exist (crash between copy and delete), compare counts — equal means finish the delete, unequal means surface to the user rather than guess.

**Step 5 — Read substrate.** On Claude Code, check `~/.claude/projects/<cwd-mapped>/` for prior session transcripts — substrate worth reading alongside session summaries, plans, and specs. On Codex there is no equivalent transcript surface; rely on `<project>/_summaries/` and any project-local plans or specs instead. Either way, anti-resurrection is strict: if a prior PROJECT.md exists, it's the user's curation surface — promote backing units for facts it endorses; capture substrate-only facts as observations but do not auto-promote them. Surface ambiguous cases. Preserve disagreement: multi-agent perspective outputs and rejected alternatives are gold for the "how we got here" reasoning; don't flatten them when graduating. Append `step-5-complete <ISO>` to the flag when the read is done. This step is read-only, so re-entry is naturally safe — re-read what you need. On failure (transcript surface unreadable or absent): proceed on `<project>/_summaries/` and project-local plans alone, and record in the migration plan which substrate was skipped so the gap is visible later.

**Step 6 — Execute graduation per the plan from Step 1.** Walk the enumerated inventory and graduate units in the order the plan specifies (typically: people first, foundational decisions second, remaining decisions, risks, open-questions, observations last). Cite the plan as you go. Graduation must be idempotent: before writing any unit, check whether its id already exists in `_memories/` (`ls <project>/_memories/<id>.md`) — if it does, skip it; a crash mid-step means re-entry walks the same inventory and the existence checks turn already-written units into no-ops instead of duplicates. Don't "improve" an existing unit on resume — finish the inventory first, reconcile after. Append `step-6-complete <ISO>` to the flag only after the LAST inventory item is written. On failure mid-inventory (a write errors): note the failing unit in the migration plan, continue with the rest of the inventory, and retry the failures before declaring the step complete — one bad unit shouldn't strand the whole store.

**Step 7 — Re-render PROJECT.md and update workspace meta.** Compose the six-section view (What & Why / State / People / Moves / Decisions & Risks / Notes) from the freshly-graduated units. Update `~/.core/index.json` with `schema_version: v2` and `migrated_at`. Update `~/.core/workspaces/<id>/workspace.json` to v2 schema, preserving prior milestones and adding the migration milestone. Create `~/.core/workspaces/<id>/swarm-narrative.md` (empty) for future swarm runs. Every write in this step is a full-content rewrite or an additive field update, so re-entry just redoes it — re-rendering PROJECT.md from the same units and re-stamping the same index fields are no-ops in effect. On partial failure (say PROJECT.md landed but the index update errored): redo only the failed writes; verify each of the four surfaces (PROJECT.md, index.json, workspace.json, swarm-narrative.md) exists and carries the expected change before appending `step-7-complete <ISO>` to the flag.

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

## Session agenda

The agenda is `PROJECT.md §Moves`. No separate next-session file — that died with the 2026-04-21 restructure.

At session start, read §Moves, present the top 3–5 active priorities as the agenda, surface any high-priority items before implementation work begins. During the session, when new risks, decisions, open questions, or commitments emerge, update the relevant unit and re-render the affected PROJECT.md section in real time. At session end, make sure §Moves reflects next-session priorities — that's what gets picked up on the next bootstrap.

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
- **Open-question deferred twice or more.** While walking the same active open-question units, surface any with `deferrals: 2` or more in the readiness summary with the escalation framing — why the question matters and what goes wrong if it stays unanswered. At `deferrals: 3`, propose recording it as an accepted risk with the user's explicit acknowledgment, per SKILL.md §"Persist on hard questions". This sweep is what makes the deferral ladder real across sessions — the count lives in the unit, not in your memory of the conversation.

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

Read the candidate list, then compose 5–7 lines of plain prose blending two inputs: the priority candidates (stable structural heft) and your session-level awareness (current work, recent reconciliations, forward moves). Usually 1–3 items, no bold lead-in paragraphs unless the items genuinely need scannable headers. Write the composed prose to a draft file with your file-write tool — `~/.core/workspaces/<id>/hot-section-draft.md` — then land it by path. Never interpolate the prose into the shell as a `--text` argument: it's composed from unit bodies, which can carry quotes, backticks, and `$` that the shell will mangle or execute.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/hot-section.mjs" apply <project> --file ~/.core/workspaces/<id>/hot-section-draft.md
```

(`apply` also reads stdin when neither `--text` nor `--file` is given. `--text` stays available for short hand-typed strings that contain no unit-derived content.)

`hot-section.mjs apply` writes PROJECT.md and stamps `last_written_by: hot-section` into `~/.core/state-cache.json` itself, so next session's edit-detection (§"Load — returning workspace") recognizes the change as CORE's synthesis, not a user edit — no manual reconciliation, and `/finalize`'s close-of-session hot-section write is covered the same way (both go through `applyHotSection`).

Narrate the refresh in one sentence as part of readiness — *"Refreshed the hot section: Phase 1a is mid-flight and DC-88 just reconciled."* The agent self-disciplines on length (the 500-token enforcement is Phase 1b).

## Compose the readiness summary

**Before composing — run capability probe (fail-open).** If `$CORE_ROOT` was resolved, run:

```bash
node "${CORE_ROOT}/skills/core/scripts/capability-probe.mjs" --startup --json 2>/dev/null \
  > ~/.core/workspaces/<id>/capability-state.json || true
```

Then append this session's snapshot to the capability history — the per-session record that drift and regression analysis read at `/finalize` and `/process-memory`: Fail-open but not silent: if both the home store and the project fallback fail, the script prints a one-line error to stderr — leave that visible rather than discarding it, so a dead snapshot path surfaces instead of failing invisibly for months.

```bash
node "${CORE_ROOT}/skills/core/scripts/record-capability-snapshot.mjs" --workspace-id <id> || true
```

**Scaffold the metrics store (fail-open).** Once the workspace id is resolved, scaffold `_metrics/` so the observability substrate has somewhere to write — `log-event.mjs`'s OTel dual-write resolves its storage path from the pin file this writes, and on Windows+OneDrive this is what redirects payloads off the synced path. Idempotent and never fatal; a scaffold failure degrades metrics capture but never blocks the session.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/metrics-init.mjs" <project> <workspace-id> >/dev/null 2>&1 || true
```

**Before composing — check context integrity (DC-94a).** You can answer from partial context without noticing it: MEMORY.md gets truncated at the injection cap, and a large PROJECT.md can exceed a single read. Run `check-context-integrity.mjs` with the lines you actually read from PROJECT.md this bootstrap (the returning-workspace Tier-1 load reads it in full or paged — pass that read-extent). If the marker comes back `CONTEXT-PARTIAL`, say what's missing in plain voice **before** your first substantive answer — *"Heads up: MEMORY.md is over the injection cap, so I'm missing roughly 12 of its entries this session, and I only loaded 80 of PROJECT.md's 2200 lines. I'll read the rest before I lean on anything from there."* A `CONTEXT-COMPLETE` marker needs no narration.

```bash
[ -n "$CORE_ROOT" ] && [ -d "$CORE_ROOT/skills/core/scripts" ] && \
node "${CORE_ROOT}/skills/core/scripts/check-context-integrity.mjs" \
  --memory ~/.claude/projects/<cwd-mapped>/memory/MEMORY.md \
  --project <project>/PROJECT.md --project-read-lines <lines-read> || true
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
- Units retired by the anti-resurrection rule since the last readiness (the ids, with the one-line un-retire recovery phrase per `protocols/data-storage.md` §"The anti-resurrection rule"). Skip silently when none were retired.
- Source-registration signals when they're worth mentioning: pending Mode B/C blocks in `<project>/inbox.md` (count plus a one-line nudge — *"three pending observations in the inbox waiting on review"*), or observations citing a `source:` not in `<project>/_sources/` (drift signal — name the source). Skip silently when the inbox is empty and no drift surfaced.
- The top 3 §Moves priorities as the agenda.
- Anything auto-compacted during first-time setup, named explicitly (entries, not counts).
- The recognition signal, when present and worth flagging: read the one-line `~/.core/workspaces/<id>/metrics/orient-signal.txt` (pre-computed by `metrics-rollup.mjs` the last time `/finalize` or `/process-memory` ran — that script is the mechanism's source of truth, and there is NO automatic hook: the signal refreshes only on those user-invoked passes, so a session that ends without them leaves the file stale, not wrong). Surface it ONLY when the headline `rec-fail-tier-0` rate is trending up (the `↑` marker) — "the agent's own measurement says recognition is slipping." Read it as "as of the last finalize", never as continuous trending. It is **PROVISIONAL** (the classifier isn't calibrated yet); frame it as a self-audit signal, never a graded metric. Absent file or a flat/down trend → say nothing (per `feedback_readiness_only_escalations`).
- Plugin version + build: read both `version` and `build` from `../../.claude-plugin/plugin.json` relative to the skill base directory (which resolves to the plugin root's `plugin.json`) — that manifest is the single source of truth for both. Echo as "Plugin v<version> build <build>". If `plugin.json` is unreadable, omit the line; if it's readable but has no `build`, echo just "Plugin v<version>".

Target voice:

> *"Picking up on the [project name]. Last session closed Wednesday with the routing rework merged. PROJECT.md says we're mid-migration: Phase 1 done, Phase 2 in progress. Top of §Moves is the auth-rewrite review. One stale risk worth flagging: R-3 last reviewed three weeks ago. Ready."*

What to skip: session summary content (not part of the bootstrap read); auto-memory cited as authoritative (it's scratch cache); session log recaps (per-session artifacts, not state); a full section-by-section recital (the user sees PROJECT.md when they want the full view).

**Record the bootstrap.** After readiness lands, write `~/.core/workspaces/<id>/last-bootstrap.json` with two fields: `session_started_at` (the timestamp of the first user message this session — the one session-start marker you can actually observe; see §"Bootstrap dedup") and `bootstrap_completed_at` (now). This is the durable signal `skills/core/SKILL.md §"Before the task — startup"` reads to decide whether bootstrap already ran this session.

After readiness lands, only ask what you still don't know — genuine gaps that no durable artifact resolved, with a hypothesis when you have one. Don't ask "what were we working on?" (you just read it), "what would you like to do today?" (the agenda tells you), or "can you catch me up?" (that's exactly what bootstrap prevents). Do ask deferred-decision questions ("PROJECT.md flags the X decision as deferred pending your call — have you decided?"), agenda-fork questions ("continue the v2 build or pivot to the stale R-5 risk first?"), and missing-unit questions ("the session-intent topic 'auto-creation rules' didn't surface a unit at Tier 1 or 2 — written yet, or still pending?"). Then wait for the user's next move; the agenda topics get resolved or explicitly deferred before implementation work begins.

## Bootstrap dedup

This is the authoritative definition of the already-bootstrapped check that `SKILL.md §"Before the task — startup"` summarizes.

The marker is the first-user-message timestamp. `last-bootstrap.json`'s `session_started_at` holds the timestamp of the first user message of the session in which bootstrap ran — that's what "Record the bootstrap" above writes. It's a proxy: you have no access to the harness's session clock, but you can usually see when the conversation started.

The check, in order:

1. **New workspace — no dedup.** No `workspace.json` in the cwd and no matching `~/.core/index.json` entry means startup has never run here; it's startup that creates those files. Skip the dedup check and run the protocol. The check applies to returning sessions only.
2. **Resolve and compare.** Resolve the workspace id, read `~/.core/workspaces/<id>/last-bootstrap.json`, and compare its `session_started_at` to the timestamp of the current session's first user message. Same first message (allow a few minutes of tolerance for format and timezone jitter — the question is "same session?", not "same second?") → bootstrap already ran; skip the protocol read.
3. **Can't determine → run.** If you can't see the first user message's timestamp, or the file is absent or unparseable, treat bootstrap as not-yet-run and run the protocol. The failure direction is chosen deliberately: re-running bootstrap wastes a little time; wrongly skipping it means operating without routing, edit-detection, or the readiness contract.

Known limitation, named: on a harness that exposes no message timestamps, this gate can't distinguish sessions and effectively always re-runs bootstrap. That is the designed degradation — double-bootstrap, never silent-skip.

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
