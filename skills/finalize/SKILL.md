---
name: finalize
description: Session closing skill — reconcile state, write the session summary, render PROJECT.md from units, run memory hygiene
user-invocable: true
---

# `/finalize`

You're closing the session. Project state has been updating continuously — observations get written as the user talks, units get graduated as patterns emerge, PROJECT.md sections re-render when something meaningful changes. Finalize is where you verify everything's coherent, run the hygiene pass, write the human-readable summary, and leave a clean state for the next bootstrap.

Execute every step in order. Don't skip.

**Script path resolution.** This file references scripts via `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs`. That env var is set on Claude Code marketplace installs but not on Codex. On Codex, derive the path mechanically: take the absolute path you loaded this `SKILL.md` from, replace `/skills/finalize/SKILL.md` with `/skills/core/scripts/<script>.mjs`. Concretely: `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/finalize/SKILL.md` → `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/core/scripts/<script>.mjs`. Do not construct paths against a guessed plugin base; the loaded path carries the resolution.

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

6. **Refresh the hot section (DC-85 Phase 1a).** After the accepted PROJECT.md lands, refresh the hot tier atop it. This captures the new state the user just left — the session's actual outcome, not the state at session start. Steps:
   - Call `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/hot-section.mjs candidates <project> --top 12 --session-topic <topic1> --session-topic <topic2>...` with the session-intent topics from this session.
   - Compose 5-7 lines of plain prose blending priority candidates (stable structural heft) and session-level awareness (what closed, what's still open, what's next). Usually 1-3 items per spec §1.1; no bold-lead-in paragraphs unless they earn their weight.
   - Call `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/hot-section.mjs apply <project> --text "<composed prose>"` to land it.
   - Narrate the refresh in one sentence as part of the closing.
   - Skip when the session was trivial (no substantive work, no state changes) and the existing hot section still describes current truth. Don't refresh just to refresh.
   - Phase 1b enforces the 500-token cap programmatically; for Phase 1a, the agent self-disciplines on length.

---

## Step 3 — Memory hygiene pass

Walk the unit store and run the hygiene operations from `protocols/hygiene.md`:

- **Demote closed §Moves bullets (DC-85 Phase 1b).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/demote-moves.mjs <project>` before `compact-project.mjs`. Auto-applies — closed `[x]` bullets whose most-recent backing-unit `updated:` date is >30 days old AND all cited units are in terminal status get moved to `PROJECT-ARCHIVE.md §Moves` under a date-stamped subsection, with a one-line stub pointer left behind. Conservative defaults: bullets with no backing-unit citation never demote; bullets with any missing or still-active cited unit never demote. Event emission to `_sessions/<date>/hygiene-log.jsonl` (`kind: demote-moves`); large batches (>20 candidates) emit `demote-moves-large-batch` and a stderr warning. Narrate "demoted N items" only if N > 0.
- **Tighten PROJECT.md to hard cap (DC-85 Phase 1b).** After demote-moves, run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs <project>` to compact §Decisions stubs. Emits `compact-project` event with section-size breakdown; if still over the 70KB hard cap, emits `project-md-over-cap` and a stderr warning. The agent narrates the warning in plain voice; §State narrative compaction (Phase 1c) handles what compact-project + demote-moves leave behind.
- **Cloud-sync ghost cleanup** — macOS sync engines (iCloud, OneDrive, Dropbox) leave `<filename> 2.md` duplicates when they detect concurrent-write conflicts. Most settle as exact duplicates with identical content but pollute validator output. Walk `<project>/_memories/` for any `* 2.md` file, verify it's identical to its un-suffixed original via `diff -q`, and delete the ghost if so. Surface to the user if any ghost differs from its original (rare; means a real divergence the sync engine preserved). Narrate "Cleaned N ghost duplicates" only if N > 0.
- **Archive proposals** — surface low-priority candidates (R·S < 0.05, no recent reference) for `y / N / per-unit` approval. User-authored units always gate here.
- **Retire confirmations** — any unit whose claim disappeared from PROJECT.md this session gets `status: retired`.
- **Cold-store proposals** — surface any archived-and-retired-and-365d+ units.
- **Index regeneration** — re-run if you see drift from Step 2; also run for any unit types changed this session.
- **File-cap check** — if any synthesis file is over the Read-tool threshold, follow the graduation pattern in `protocols/hygiene.md`.
- **Continuous self-evaluation** — review session-level signals (under-recall, over-recall, voice drift, smuggled architecture); write the retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`.
- **Retrieval-quality surfacing** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project>` and narrate top anomalies in plain voice. Same shape `/process-memory` uses. If the project has no `_sessions/*/retrieval-log.jsonl` yet, say so in one sentence; don't pretend the corpus exists.
- **Source-pull monitoring** — when `<project>/_sources/` exists, run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-source-pull-log.mjs --workspace <id>` against the workspace id from `workspace.json` (not the project path). The analyzer reads `~/.core/workspaces/<id>/source-pull-log.jsonl` and aggregates the last 14 days. Surface only the signals worth acting on, in plain voice: a registered source with no pulls in window (the orchestration skill stopped firing for it), a source whose error count climbed this session, or a source showing Mode-C distribution above ~30% (the extractor is producing more judgment-needed observations than usual). If the log file doesn't exist yet ("No source-pull events in window"), say so in one sentence — common on a fresh workspace before the installation's orchestration skill has run. Skip the whole bullet when `<project>/_sources/` is absent.

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

## Step 5 — Refresh harness-local recall

Use the `detect-harness` adapter verb to branch by harness. The verb is defined in the sibling core skill's harness protocol — take the absolute path you loaded this `SKILL.md` from, replace `/skills/finalize/SKILL.md` with `/skills/core/protocols/harness.md`, and read that. (Claude Code: `${CLAUDE_PLUGIN_ROOT}/skills/core/protocols/harness.md`. Codex: `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/core/protocols/harness.md`.) Authority ordering puts harness-local recall at the bottom of the stack — see DC-86 for the principle.

### If harness is Claude Code

Claude Code automatically loads the per-project MEMORY.md at the start of every session (the first 200 lines, before any tool call). CORE writes into that folder so the next session's bootstrap starts warm. Authoritative project facts live in PROJECT.md and `_memories/` — auto-memory just carries pointers, session-level feedback, and summaries that help the next session orient fast.

The file naming is a CORE convention layered on top of the harness folder:

- User preferences and feedback → `feedback_*.md`
- Project context summaries → `project_*.md`
- User-profile updates → `user_profile.md`
- Pointers to external systems → `reference_*.md`

Update the `MEMORY.md` index in the same operation. Don't write project-specific facts as authoritative here — those live in PROJECT.md or `_memories/`. Auto-memory carries pointers and summaries.

Apply the memory hygiene rules: update stale memories rather than adding duplicates; remove memories that were proven wrong; keep `MEMORY.md` current.

Then refresh the auto-memory index. Two parts:

**Priority block (mechanical).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-memory-index.mjs <project>/_memories --memory-md ~/.claude/projects/<mapped-cwd>/memory/MEMORY.md --top 30`. The script regenerates only the "## Top project units" section in place: it preserves existing one-line descriptions for units that remain in top-N (so prior curation isn't lost), falls back to the unit's H1 for newly-promoted units, and removes entries for units that dropped out of top-N. Idempotent — re-runs with no underlying change are no-ops.

**Curation pass (inline, judgment).** Update the "Recent activity" section with this session's one-line entry. Sweep the "Feedback + project pointers" section: drop pointers to retired memories; add pointers for any `feedback_*.md` / `project_*.md` / `reference_*.md` you wrote this session. For any unit the script flagged with an H1-fallback description, refine if the H1 reads thin. Keep `MEMORY.md` under 200 lines.

Do this inline in the main agent — don't dispatch a subagent. The previous Haiku-subagent design required `git worktree`, which fails on non-git workspaces (any cloud-sync-backed project, any non-versioned project directory) with *"Cannot create agent worktree: not in a git repository."* Per CORE's harness-agnostic design intent, git is not a precondition for project intelligence. Project intelligence workspaces hold data, not code — versioning isn't the right tool here. The script does the heavy lifting; the curation pass stays in the main agent.

Narrate the refresh plainly: *"Refreshing MEMORY.md priority block from the top 30 units now."*

### If harness is Codex

Do not auto-write to `~/.codex/memories/`. Codex memory is explicit-save only — see `harnesses/codex.md §read-auto-memory` for the rule and `harnesses/codex.md §save-recall-note` for the mechanics of explicit recall writes. Trigger phrases (when a user request counts as "save this") live in the user's install-level config, not in CORE.

Confirm project facts are captured in `<project>/_memories/` and the session summary written in Step 4. If harness-level observations surfaced during the session (workflow lessons, tooling collisions, Codex-specific patterns), include them in the session summary so the next session reads about them.

If the user explicitly asked to save observations earlier in the session via `save-recall-note`, that ran at the trigger moment — don't duplicate-write here.

Narrate plainly: *"On Codex — project facts already captured in `_memories/`. No harness-memory writes."*

---

## Step 6 — Closing declaration

After all steps complete, declare in plain voice. Concrete shape:

> *"Session closed. Summary at `_summaries/summary-<date>.md`. PROJECT.md rendered from current units. Hygiene pass complete — N archives, M retires, no cold-stores this pass."*

If anything couldn't be completed, name it explicitly. Don't silently skip a step. Surface the blocker plainly and recommend a next move.
