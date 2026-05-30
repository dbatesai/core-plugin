# CORE Plugin — Field Experience Report
**Session:** 2026-05-29, Watch Collection workspace (new workspace, first 2 sessions)
**Plugin version:** v2.8.1 build 20260527.2
**Harness:** Claude Code (Sonnet 4.6, 1M context)
**Reported by:** DM (the agent), for the core-plugin developer

---

## What worked well

**Startup protocol** ran cleanly. The workspace resolution, fork-check, and routing decision all worked without intervention. The `workspace-fork-check.mjs` script correctly returned `(no fork needed)` on a registered workspace.

**Unit graduation** from PROJECT.md prose worked exactly as designed. The gap was real — decisions and risks existed in prose but weren't in the retrieval ladder. Graduating them was straightforward: write the files with correct frontmatter, run the index generators, run check-units. The flow is solid.

**check-units.mjs** is useful and the error messages are specific. The `required-field: updated` failures on all 6 new units were exactly right — I'd omitted the field. The `by-when-on-wrong-type` and `status-value: proposed/monitor` warnings were also correct catches. The schema is doing its job.

**generate-decisions-index / generate-risks-index** are reliable. Both scripts ran clean every time and the index files were accurate.

**demote-moves / compact-project / demote-state-narrative** all ran without errors on a fresh store. Nothing to demote (too new), which is the correct result.

**priority.mjs** ran and ranked correctly. All units at equal weight with no session intent topics set — correct behavior for an idle state.

**capability-probe and record-capability-snapshot** — I did not manage to run these explicitly this session (CORE_ROOT resolution failed via installed_plugins.json), but the scripts were found via direct plugin path.

---

## Bugs / issues found

### 1. `analyze-capability-drift.mjs` overwrites `capability-drift-log.md` without frontmatter — RECURRING

**Severity:** Annoying / medium  
**Frequency:** Every time the script runs (3× this session)

The script regenerates `capability-drift-log.md` as a render-only artifact without YAML frontmatter. `check-units.mjs` then flags it as having 6 missing required fields (`id`, `type`, `status`, `created`, `updated`, `topics`). The agent patches the frontmatter, the script runs again, strips it. Repeat.

**Root cause:** The script writes its own header directly and doesn't know about or preserve unit frontmatter.

**Suggested fix:** Either (a) the script writes valid frontmatter at the top of its output, or (b) `check-units.mjs` has an explicit exclusion for `capability-drift-log.md` since it's a render-only artifact, not a unit. Option (b) is probably cleaner — the file is explicitly tagged as "Render-only artifact" in its body. The script could check for that tag and skip schema validation.

---

### 2. CORE_ROOT resolution fails via `installed_plugins.json`

**Severity:** Medium — causes scripts to not run when using the built-in resolution pattern

The startup protocol's CORE_ROOT resolution snippet reads `~/.claude/plugins/installed_plugins.json` for a `core@core` entry. This file either doesn't exist or doesn't have that entry in this environment. The resolution returns empty string, scripts fail.

**Workaround used:** Hard-coded `CORE_ROOT="/Users/dbates/Documents/Projects/core-plugin"` (the plugin base directory injected by the skill `SKILL.md` header). Works reliably.

**Suggested fix:** The startup protocol should include the skill-base-directory fallback as a primary, not a secondary. The harness always injects the base directory via the `SKILL.md` load path — that's always available. The `installed_plugins.json` lookup should be the fallback, not the primary.

---

### 3. `check-units.mjs` doesn't validate observation files in subdirectories consistently

**Observation:** After adding 3 new observation files to `_memories/observations/2026-05/`, the schema check still reported `PASS: 7` — same count as before. The observation files weren't counted. But they also weren't counted as failures.

**Impact:** Unknown — it's unclear whether the validator intentionally skips subdirectory observations (treating them as non-units) or simply doesn't find them. The observation files don't have `updated:` fields and would fail if validated. Since they don't fail, there's either intentional exclusion or silent miss.

**Suggested investigation:** Clarify in documentation whether `_memories/observations/` files are expected to pass the same schema as top-level units, or whether they're a lighter-weight format. If lighter-weight, the validator behavior is correct. If same format, there's a miss.

---

### 4. `hot-section.mjs` candidates scores all equal (0.4) — no differentiation

**Observation:** With 7 units and session-intent topics set (`--session-topic validation`, `--session-topic images`, etc.), all 7 candidates returned score=0.4. None of the session topics matched any unit's topic tags, so there was no boosting.

**Root cause (likely):** The session topics I used (`validation`, `images`, `caliber`) don't match any `topics:` values in the graduated units (which have topics like `data-storage`, `collecting-strategy`, `kurono`). The corpus is too new and the topic tags aren't aligned with session language yet.

**Not a bug** — this is expected behavior for a fresh store where topic tags haven't stabilized. Worth noting for the developer as a new-workspace UX pattern: first few sessions will always have flat priority scores until topics align.

---

### 5. `priority.mjs` — same flat-score issue

Same as #4: all units at 0.400 because the corpus topics don't match session intent yet. Not a bug, but the UX could be improved with a hint when all scores are equal ("No topic boost applied — session topics don't match any unit tags yet. Current unit topics: [list]").

---

## Gaps / missing capabilities

### A. No mechanism to prevent `capability-drift-log.md` frontmatter from being stripped

See bug #1. This required 3 manual patches in one session. An automated prevention would remove this maintenance burden entirely.

### B. `capability-probe.mjs` and `record-capability-snapshot.mjs` — no explicit startup call in this session

The startup protocol says to run these before composing the readiness summary. They didn't run (CORE_ROOT was unresolved at that point). The session worked fine without them, but the capability history is likely missing this session's entry or has gaps. Worth verifying the history file after this session.

### C. No validation for `observations/` subdirectory files

As noted in bug #3. The `_memories/observations/YYYY-MM/` tier is a real part of the architecture but has no schema validation. If the frontmatter spec changes for units, observations will silently diverge.

---

## Quality observations

The overall protocol discipline is good. The startup/finalize/process-memory cycle is coherent and the protocol files (startup.md, data-storage.md) are specific enough to follow without ambiguity. The unit frontmatter spec is clear and the validator catches deviations correctly (when it runs on the files).

The biggest friction point this session was the `installed_plugins.json` resolution failure, which blocked the capability probe and required a workaround. Second-biggest was the capability-drift-log frontmatter churn. Both are addressable.

The workspace graduated from 0 units to 7 units + 9 observations in one session, the indexes are current, and the project is ready for the next session with a clean §Moves list. That's the intended outcome and it worked.
