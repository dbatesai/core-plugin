---
name: organize-files
description: 'Reorganize files to clear two kinds of clutter: (1) version-qualifier chaos (multiple copies, -v1/-v2/-working/-draft/-FINAL suffixes, macOS " copy" duplicates) and (2) clean-named files in active paths whose content misstates current state (old architecture, rejected specs without supersession markers, descriptions of approaches the project retired). Reads the project''s authoritative state (PROJECT.md, current README, latest specs) to decide what is current; never asks the user to pick. Archives superseded files with date- or event-stamped names; preserves history. Invoke when the user says files are a mess, too many versions, they can''t find the latest, asks to clean up or archive old versions, OR asks whether files in active paths misstate current state or describe approaches the project has abandoned. Use proactively when version-qualifier files accumulate outside archive/ or clean-named files describe retired components.'
---

# /organize-files

## What This Skill Does

Two complementary sweeps that keep active paths trustworthy:

1. **Filename sweep** — Eliminate version-qualifier chaos (`-v1`, `-working`, ` copy`, `-FINAL`). Files at the clean unqualified path are canonical; the rest get archived.
2. **Content sweep** — Eliminate files whose *content* misstates current state, regardless of filename. A clean-named `architecture.md` that describes pre-supersession architecture is just as misleading as a `-old` suffix — sometimes worse, because nothing in the filename warns the reader.

Both sweeps feed the same archive structure with the same outcome: preserve history, clear active paths.

**Project scope.** This skill works on any project — software repo, research folder, design archive, anything with a filesystem. The two invariants are universal. The content-sweep examples in Step 1B use CORE-specific concepts (Task Manager, DC-21, etc.) only to illustrate what a redaction list looks like — the *technique* is to anchor on whatever the target project's current-truth sources are (its `README.md`, its main spec, its `CHANGELOG`, whatever it has). The "CORE Workspace Migration" section near the bottom is an optional bonus that triggers only if the target contains CORE legacy files; on every other project it stays dormant.

---

## The Two Core Invariants

1. **The file at the unqualified, clean path is the current version.**
   - `report.md` — open this one
   - `report-v2.md` — superseded, belongs in `archive/`
   - `deck-copy-EDITABLE.md` — superseded name, rename to `deck-copy.md` if canonical

2. **Files in active (non-archive) paths describe current state, not historical state.**
   - A file describing architecture that has been superseded belongs in `archive/`, even if its filename is clean
   - A "draft pending review" status on a spec that was reviewed and rejected misstates the project's stance — archive or update the marker

Both rules let directory scans be unambiguous without the user having to remember which files are stale.

---

## Step 1A: Filename Survey

Scan target directories and identify files that need attention. Flag:

**Version qualifiers:**
- `* copy*` or `* Copy*` (macOS duplicate)
- `-v[0-9]+` or `_v[0-9]+` (explicit version numbers)
- `-working`, `-WORKING`, `-editable`, `-EDITABLE`
- `-draft`, `-DRAFT`, `-WIP`
- `-FINAL`, `-final` (almost never actually final)
- `-old`, `-OLD`, `-backup`, `-bak`, `.bak`

**Also look for:**
- Multiple files at the same level with the same base name
- Files in subdirectories that appear to duplicate files in parent directories
- Near-identical file sizes suggesting copies

---

## Step 1B: Content Staleness Survey

The harder sweep. The goal is to find files that look fine by filename but misstate current state by content. Build this survey on top of authoritative reference points — don't try to guess from intuition alone.

**1. Identify the project's current-truth anchors first.** Before scanning content, name what "current" means. The right anchors vary by project — usually some combination of:
- A project synthesis or state document (`PROJECT.md`, `STATE.md`, the latest `README.md`, the most recent CHANGELOG / IMPROVEMENT_LOG)
- The authoritative architecture or spec doc — typically sits with the shipped product (under `src/`, the skill folder, the package), not under `docs/` or `proposals/`
- Recent decisions, ADRs, or commit history that name what changed and when

If the user has volunteered specific transitions ("we folded X into Y," "we replaced approach A with B," "spec C was rejected"), those go at the top of the watch list. The user knows what is currently active better than the filesystem does — asking *what changed recently* is more efficient than reading every doc.

**2. Build a redaction list — concepts, components, paths, or statuses that no longer represent current state.** From the anchors above, extract concrete patterns to search for:
- Components that no longer exist (e.g., a role that was folded into another, a tier of architecture that was collapsed)
- Approaches that were tried and rejected
- Concept names that have been renamed
- Directories or files that were removed (any active doc still pointing at them is stale)
- Status markers that no longer apply ("pending review" for items already reviewed and decided, "draft" for work that has been superseded)

Examples from a real CORE session (concrete to illustrate the shape):
- `Task Manager` — a role folded into the Delivery Manager in a prior decision
- `personas/`, `phases/`, `usecases/` — directory paths that were removed
- `next-session.md` — replaced by `PROJECT.md §Moves`
- "Draft — pending adversarial review" — a status header that outlived a spec which was actually reviewed and rejected

The redaction list is project-specific; the *technique* is universal.

**3. Scan active paths for redaction-list hits.** Exclude operational-history directories — `archive/`, `sessions/`, `summaries/`, `handoffs/` (legacy name), anything explicitly named as historical record. Those directories are *supposed* to preserve old state. The goal is to surface hits in *active* paths: top-level docs, current spec folders, presentation assets, root-level files.

The basic shape:
```bash
grep -r -l "<pattern>" <project-root> \
  --exclude-dir=archive --exclude-dir=sessions --exclude-dir=summaries --exclude-dir=handoffs
```

**4. Look for cross-path duplicates with overlapping scope.** A file at `docs/architecture.md` and one at `<product-folder>/ARCHITECTURE.md` covering the same conceptual ground is a red flag. The one not at the canonical product location is usually the older or speculative copy. Verify by content inspection (Step 2), then archive the loser.

Cross-path duplicates are a common pattern because docs get drafted in `docs/` and then "promoted" into the product folder — the draft often outlives its purpose.

**5. Surface stale status/decision markers.** Read the header/status block of any doc that looks like a spec, proposal, or plan. A spec whose header says "Draft — pending review" but which was reviewed and rejected misstates the project's stance — sometimes more dangerously than wrong content, because the status field is what readers anchor on.

Status-marker patterns worth grepping for in active paths:
- `Status: Draft`, `pending review`, `pending adversarial review`, `IN PROGRESS` — on documents that have actually been decided
- `Phase [1-9] of [2-9]` — when later phases have already landed
- `TODO`, `TBD`, `[ ]` checkbox items — in headers describing what should already be settled
- Dates in "Last reviewed" or "Updated" fields that predate a known major transition

When the marker contradicts what other anchors say happened, the marker is stale.

**Report findings before acting.** Group them: (a) clearly stale by content (filename or content evidence is decisive); (b) likely stale but worth a content-confirmation read; (c) ambiguous — these need a quick read or a user call. The user signs off on the action plan, not file-by-file.

---

## Step 2: Determine Canonical — Inspect, Don't Ask

For each file family (or each suspected stale file), determine which version is canonical. The user often doesn't know which is which — that's why they asked you. Work through signals in order: fast objective signals first, then inference.

**Signal 1 — Clean name (fastest)**
One file has the unqualified base name (`report.md`) and others have qualifiers → the clean name is canonical.

**Signal 2 — File system dates (fast, sets a hypothesis)**
Check modification time (`stat` or `ls -lt`). A file modified significantly more recently is probably the active one. State the dates aloud: *"report.md modified 2 hours ago, report-v1.md modified 3 weeks ago — report.md is probably current."*

Two known failure modes — both require content confirmation:
- `cp` on macOS preserves mtime, so a backup copy shows the same date as the original
- A file can be edited in one section today while other sections lag. The mtime reflects when the file was last *touched*, not whether all its content is more advanced. A typo fix in a header makes the whole file look current even when the analysis section is a week behind a "stale" file.

When dates are close, identical, or partial editing is plausible — move to content reasoning.

**Signal 3 — Content structure and completeness (robust inference)**
Read the files and reason from what's inside — not from labels, but from content:
- Which version is more complete? A longer, more developed version usually supersedes a stub.
- Which version reflects finished work? Downstream artifacts (decisions, conclusions, next steps) appear after the work is done. A file containing "Decision: increase budget 15%" postdates a file that just presents the data.
- Which version's facts are settled? Unresolved placeholders, question marks, and pending items are marks of an earlier state.
- Does any version contradict a related canonical artifact? If a `.md` doc and an `.html` page exist, which markdown matches the HTML's current content?

For content-staleness candidates (no clean-path sibling, just stale content vs current truth):
- Cross-check the file's claims against the project's current-truth anchors (Step 1B.1).
- A file describing a component, approach, or path that no longer exists is stale relative to current truth — even if it was correct on the day it was written.

Explicit markers like "IN PROGRESS" or "DO NOT DISTRIBUTE" may confirm an inference, but don't depend on them — reason from the content. A file can be the final version and still be labeled "draft," and a rejected spec can still say "pending review."

Always state the specific evidence: *"docs/architecture.md is stale — has explicit `### Task Manager` section describing two-tier DM/TM orchestration. PROJECT.md §Decisions records that TM was folded into DM on 2026-04-20 (DC-11..15). The canonical architecture lives at `core-plugin/ARCHITECTURE.md` (706 lines, DM-only). This file describes a superseded architectural state."*

---

## Step 3: Pick the Right Action

For each candidate from Step 1A or 1B, the right action depends on what the file actually is. There are four — naming them up front prevents the default of "archive everything," which sometimes creates duplicate bytes or sweeps up files that were correctly named in the first place.

### Action A — Archive (default for genuinely superseded files)

Move to `archive/` with a date- or event-stamped name. Use when:
- The file has a version qualifier and a canonical sibling exists at the clean path (or you can promote one to the clean path).
- The file's *content* is stale relative to current truth, and the file has no exact equivalent already living at a canonical path.

**Naming conventions:**
- Filename-qualifier supersessions: `{original-base}-pre-{YYYY-MM-DD}.{ext}` — today's date unless you have evidence the file was already stale earlier.
- Content-staleness supersessions: prefer **event names** over dates — `{original-base}-pre-{event}.{ext}`. Examples: `architecture-pre-tm-fold.md`, `cowork-plugin-spec-NOT-APPROVED.md`, `principles-pre-DC-21.md`. Event names tell future readers *why*; dates only say *when*. Fall back to dates only when the user can't name the event.
- If the original filename already carries a session date or version marker (e.g., `core-principles-draft-2026-04-21.md`), keep it as-is — the existing date is its own supersession marker.

**Archive tiers:**
- `archive/` — recently superseded; safe for an agent to read on request
- `archive/deep/` — clearly obsolete or older than ~30 days
- `archive/pre-claude-code-sessions/` — pre-tool-era context uploads, chat exports, etc. (human reading only)

When you create or add to an archive directory, write `archive/README.md` (or update it). One paragraph — name the kinds of files inside and the events/transitions that drove the archiving, so a future reader can decide whether anything in here is still useful.

### Action B — Delete (byte-identical duplicates only)

When a `-draft` or version-qualified file is **byte-identical** to a file already at a canonical path, the canonical preserves the content. Archiving makes a third copy of the same bytes — noise without information. Verify identity first:

```bash
diff <suspect-file> <canonical-file> && echo "IDENTICAL — safe to delete"
```

Only delete on exact match. Never delete on a near-match — content drift is exactly what archives are for. Common pattern: drafts written at a parent location and then "promoted" into a sub-structure (e.g., a flat `plugin-README-draft.md` next to a `scaffolds/plugin/README.md` containing identical bytes).

### Action C — Rename to clean path

If the canonical version itself has a qualifier in its name and the clean path is empty, rename:
- `copy-working.md` → `copy.md`
- `deck-copy-EDITABLE.md` → `deck-copy.md`
- `analysis-v3-FINAL.md` → `analysis.md`

If a file already exists at the clean path and is *not* the canonical, archive that one first (Action A), then move the canonical into place.

For pure content-staleness cases there's usually no clean-path sibling to promote — skip this action.

### Action D — Leave alone (legitimate patterns)

Some files match the version-qualifier regex but are correctly named for their context. Touching them is the failure mode this guard prevents:

- **Phase/iteration semantics inside a dated session container.** `outputs/swarm-2026-04-19/phase-5/options-v2.md` — phase 5 produced version 2 of options because phase 4 holds v1. The `-v2` describes phase content, not version chaos.
- **`-final` as part of a phase or iteration name.** `voice-loop-iter-06-final-synthesis.md` — `final-synthesis` is iter-06's name in a six-iteration loop, not a "FINAL" marker on a versioned doc.
- **Session deliverables with dates as their marker.** `outputs/skill-draft-2026-04-20.md` — the date already labels this as historical. No clean-path sibling exists to promote; the file is what it claims to be (a draft from that date).
- **Content matches current state AND filename is clean.** Even if the file's purpose feels redundant, aesthetics aren't a valid trigger.

When in doubt about whether a file is "legitimate pattern" vs. "version chaos," read its container directory. A `-v2` or `-final` inside a dated/phase-numbered parent usually inherits that container's semantics.

### Git-tracking — check before moving or deleting

Tracked files need different commands than untracked ones. Tracked moves done with `git mv` preserve rename history (`git blame` and `git log --follow` keep working); plain `mv` on a tracked file looks like delete + create to git, severing history.

```bash
git ls-files <files...>
```

- Output includes the file → tracked → use `git mv` / `git rm`.
- Output omits the file → untracked → use `mv` / `rm`.

Batching: group files by tracked vs untracked status so each move command stays clean.

---

## Step 4: Add Status Headers (Markdown files only)

Add a one-line status header at the very top of each canonical `.md` file:
```markdown
> **[CANONICAL]** Updated YYYY-MM-DD
```

Add a one-line redirect header to archived `.md` files:
```markdown
> **[ARCHIVED]** Superseded YYYY-MM-DD — canonical at [relative path]
```

For archived content-stale files where there is no canonical replacement at a single path, name the *current-truth anchor* instead:
```markdown
> **[ARCHIVED]** Superseded by [tm-fold decision, 2026-04-20] — current architecture in PROJECT.md §State + core-plugin/ARCHITECTURE.md
```

Skip HTML, binary, JSON, and other non-Markdown files — headers there are noise, and HTML in particular won't render the blockquote helpfully.

---

## Step 5: Verify (and consider a second opinion)

Verification is two complementary checks plus a quality gate. Skipping it is how stale grep hits and missed cross-path duplicates survive a "completed" sweep.

**Re-run both surveys:**
- Filename scan: no version qualifiers remain outside `archive/` (re-run the Step 1A find command).
- Redaction-list grep: no hits in active paths other than canonical anchors that legitimately reference historical state (e.g., a §Decisions log mentioning a superseded approach by name).

**Structural checks:**
- Each file family has exactly one canonical entry at the clean path.
- Archive directories that received files have a README.
- Tracked moves used `git mv` (verify with `git status` — renames show as `R` not delete+add).

**Second-opinion gate (call the advisor before declaring done when):**
- The action plan touches more than ~5 files
- Any action call was non-obvious — close mtimes, partial content overlap, cross-path duplicates where you had to read content to break the tie
- A content-staleness call rested on a single grep hit rather than a full content read

The advisor sees the full tool history and catches things like "you grepped for `Task Manager` but the match was on lowercase `task manager` — did you check that follow-up?" These are cheap to surface and decisive to fix before files move.

**Report:** N files renamed, N archived, N deleted, N left alone with reasoning, directories affected, plus a one-line note on which content-staleness patterns were cleared.

---

## CORE Workspace Migration (recognized pattern)

If the target includes `~/.core/workspaces/<id>/` directories and you find legacy files (`raid-log.md`, `next-session.md`, `decision-log.md`, `session-log.md`), these predate the DC-16..18 migration (2026-04-21) that moved project state into `PROJECT.md`.

**Migration steps:**
1. Read all legacy files to understand project state
2. Check if the workspace has a linked project folder (via `workspace.json` `path` field)
3. Create `PROJECT.md` at the project root (or workspace root if no separate folder) with 6 sections: §What & Why, §State, §People, §Moves, §Decisions & Risks, §Notes
4. Move legacy files to `archive/legacy-pre-dc16/`
5. Write `archive/legacy-pre-dc16/README.md` explaining the DC-16 migration context

Synthesize `§Moves` from the `next-session.md` agenda. Synthesize `§Decisions & Risks` from `raid-log.md`/`decision-log.md`. Promote session history from `session-log.md` into `§State`.

---

## Behavioral Notes

- **Batch the survey, then act.** Run both sweeps (1A filename + 1B content), build a single action plan grouped by action type (archive / delete / rename / leave-alone), present once, get one confirmation, execute. Don't ask permission file-by-file — interruption-per-file is the failure mode this skill exists to prevent.
- **Dedupe across the two sweeps.** A file can match both sweeps (a `-v2` doc whose content is also stale). Treat each file once with its strongest signal — typically the content judgment, since it carries more information than the filename pattern.
- **Anchor the content sweep before scanning.** Identify the project's current-truth sources (PROJECT.md, the shipped product folder, recent decisions) and build the redaction list from them. Without anchors, content judgments become aesthetic preferences.
- **Dates first, content confirms.** Check modification time before reading files; if dates are close or you suspect copies/cross-path duplicates, read content to confirm. `diff` is the only safe test for "exact duplicate" — filenames lie.
- **Reason from structure, not labels.** Infer canonical from completeness, settled facts, and downstream decisions. Explicit status markers ("DRAFT," "FINAL," "pending review") are confirmations, not dependencies — and the misleading ones are exactly what the content sweep exists to catch.
- **State reasoning aloud** for any non-obvious call: same-size files, partially-edited stale files, content judgments that hinge on the project's specific history, "leave alone" decisions on files that match the qualifier regex but are correctly named for their phase/session container.
- **Event names beat dates** for content-stale archives. `architecture-pre-tm-fold.md` survives the next decade better than `architecture-pre-2026-05-10.md` because it names the *why*.
- **Preserve git history when moving tracked files.** Always `git ls-files` before moving. `git mv` keeps `git log --follow` working; plain `mv` on a tracked file breaks it.
- **Scope creep guard.** Two valid triggers for action: (a) filename matches a version-qualifier pattern AND the qualifier doesn't inherit legitimate context from a phase/session container, or (b) content contradicts a current-truth anchor. Aesthetic preference about a filename or a file's purpose is not a trigger. If a file has a clean name, lives in a properly-organized location, AND its content matches current state, leave it alone even if its existence feels redundant.
- **Call the advisor before declaring done** when more than ~5 files are affected, when any single judgment was close, or when a content call rested on a thin grep rather than a full content read. The cost is one tool call; the upside is catching the kind of follow-through gap (a grep hit you didn't pursue, a sibling file you only header-checked, a "living document" you only skimmed) that survives self-review.
