# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.4.0] — 2026-05-25

### Added
- `skills/core/harnesses/gemini.md` — Gemini (Antigravity SDK) harness adapter. Status: `draft — unverified` (Phase 1 design complete; Phase 2 probe rounds pending). Maps `spawn-subagent`/`spawn-team` to `invoke_subagent`, `send-message` to `send_message`, `await-completion` to implicit reactive wakeup, `schedule` to the `schedule` tool, `save-recall-note` to `<appDataDir>/brain/<conversation-id>/scratch/`. `hook-register` and `read-auto-memory` are documented drops.
- `.gemini-plugin/plugin.json` — Gemini harness manifest, version locked to `2.4.0`.
- CI step: "All harness manifests report same version" — `ci.yml` now enforces lockstep across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.gemini-plugin/plugin.json` on every PR and push.

### Changed
- `skills/core/protocols/harness.md` — `detect-harness()` now returns `gemini` as a named harness alongside `claude-code` and `codex`.
- `skills/core/harnesses/codex.md` — `read-auto-memory` section corrected. Old text said Codex has no auto-memory. Corrected to: Codex can inject memory-like context when `features.memories = true` (experimental, gated by `no_memories_if_mcp_or_web_search`). Treat injected memory as harness-local recall; run a startup probe before relying on it for bootstrap behavior.
- `.codex-plugin/plugin.json` — bumped from stale `2.0.1-dev.20260521.5` to `2.4.0` in lockstep with all other manifests.
- `RELEASE.json` — updated to v2.4.0 with `gemini` added to `targets`, `manifests`, and release notes.
- `skills/finalize/SKILL.md`, `skills/process-memory/SKILL.md`, `skills/register-sources/SKILL.md` — path derivation rule updated from "On Codex" to "On Codex and Gemini".
- `skills/orient/SKILL.md` — Gemini path derivation example added alongside existing Claude Code and Codex examples.
- `.github/workflows/version-check.yml` — now checks `.codex-plugin/plugin.json` and `.gemini-plugin/plugin.json` version against `.claude-plugin/plugin.json`; any mismatch fails CI.
- `.github/workflows/ci.yml` — manifest validation step now parses `.codex-plugin/plugin.json`, `.gemini-plugin/plugin.json`, and `.agents/plugins/marketplace.json` in addition to the existing Claude manifests.

### Fixed
- `skills/core/scripts/generate-memory-index.mjs` (bug 3.1) — `spliceSection` no longer throws when `## Top project units` is absent from MEMORY.md. Instead it appends the section at the end of the file and emits a one-line notice to stderr. Idempotent on the next run. Affects workspaces that adopted CORE before this section became a contract (e.g. `local-llm-build`, early BBLens installs).
- `skills/core/scripts/analyze-retrieval-quality.mjs` (bug 3.2) — `buildReport` now counts distinct calendar dates from event `ts` timestamps instead of unique `ev.session` IDs (which were never written). Previously `Sessions analyzed: 0 | Events: 2` when events existed but lacked a session field — now correctly shows `Session dates in window: 1 | Total retrieval events: 2`. Label updated from "Sessions analyzed" to "Session dates in window" to match the counting semantics.
- `skills/core/protocols/startup.md` (bug 3.3) — CORE_ROOT resolver node snippet now calls `.replace(/\\/g, '/')` before emitting the install path. On Windows via Git Bash, `installPath` carries OS-native backslashes; the replacement ensures the shell variable carries a forward-slash path compatible with bash string operations.
- `skills/core/scripts/generate-memory-index.mjs` (bug 3.4) — `path.relative()` result now converted with `.replace(/\\/g, '/')` before being embedded in a markdown link. On Windows, `path.relative()` returns OS-native backslash separators which break markdown link resolution.

## [2.3.3] — 2026-05-24

### Changed
- `scripts/compact-project.mjs` renames `HARD_CAP_BYTES` → `SOFT_TARGET_BYTES` (still 70000). The script never refused to write at this threshold — it only emits an advisory event. The old name implied enforcement the behavior never had. `HARD_CAP_BYTES` remains exported as a back-compat alias; the `project-md-over-cap` event payload now carries both `soft_target` and `hard_cap` (same value) for the same reason. Warning prose updated from "over hard cap" to "over soft target" with explicit "advisory only" framing. Tests updated to assert both the new name and the back-compat alias.

## [2.3.2] — 2026-05-24

### Fixed
- `scripts/generate-memory-index.mjs` now emits project-root-relative paths (`_memories/foo.md`) instead of `dirname(MEMORY.md)`-relative paths. Claude Code resolves MEMORY.md links against the session CWD (the project root), not against the harness-managed `~/.claude/projects/<encoded>/memory/` folder where MEMORY.md lives. The previous behavior produced long `../../../../...` traversals — accidentally fine on CORE-on-CORE, but on BBLens (OneDrive-synced project root) the traversal went through cloud storage and was actively brittle. Reported by Work-Keel on first live run.
- `scripts/generate-memory-index.mjs` description fallback now cascades through frontmatter `description:` field and first non-blank body line before giving up with `(description pending)`. The prior H1-only fallback produced `(description pending)` for every unit on projects whose unit files start prose directly after frontmatter without a markdown H1 — including BBLens. Reported by Work-Keel on first live run.

### Internal
- `renderPriorityBlock()` no longer accepts a `memoryMdPath` parameter; it derives the project root from `dirname(memoriesDir)`.
- New exported helpers: `extractFirstBodyLine(text)`, `resolveDescription(existing, fm, text)`.
- Test suite: 497 → 508 (+11 regression tests for both bugs and the description cascade).

## [2.3.1] — 2026-05-24

### Added
- `/process-memory` Step 0 now catches "source-pull deferral" patterns — sentinel content references found during external-source sweeps but not actually fetched. Backstop when in-loop discipline slips in the Phase 2 sweep.
- New `scripts/generate-memory-index.mjs` mechanically regenerates the "## Top project units" section of MEMORY.md from `priority.mjs` ranking. Preserves existing one-line descriptions for units that remain in top-N; falls back to the unit's H1 for newly-promoted units; idempotent (re-runs with no underlying change write nothing).

### Changed
- `/finalize` Step 5 (Claude Code branch) now calls `generate-memory-index.mjs` for the priority block instead of asking the agent to rewrite manually. Curation pass for the surrounding sections (Recent activity, Feedback pointers, H1-fallback refinement) stays inline.

### Fixed
- `/core` startup: `CORE_ROOT` resolution from `~/.claude/plugins/installed_plugins.json` now handles the array-of-installs shape correctly. The prior resolver assumed an object shape, so the fallback silently returned empty and startup printed a "CORE plugin root not resolved" warning even when the plugin was correctly installed. User-scope install is preferred when present; first entry otherwise.

## [2.3.0] — 2026-05-24

### Added
- DC-85 Phase 1b: `scripts/demote-moves.mjs` auto-demotes closed `[x]` §Moves bullets to `PROJECT-ARCHIVE.md §Moves` when the most-recent backing-unit `updated:` date is >30 days old AND all cited units are in terminal status. Conservative defaults: bullets with no backing-unit citation never demote; bullets with any missing or still-active cited unit never demote; max(updated) across cited; never destructive (move-with-pointer + one-line stub). Auto-applies; `--dry-run` kept as inspection mode.
- Hot-tier 500-token budget enforcement in `scripts/hot-section.mjs`. `applyHotSection()` throws `HOT_SECTION_OVER_BUDGET` when synthesis exceeds the cap (with `allowOverBudget: true` escape hatch).
- `scripts/compact-project.mjs` gains `HARD_CAP_BYTES = 70000` and a new `--section-sizes` flag for inspection-only breakdown.
- New `scripts/log-event.mjs` shared structured-logging helper. Writes JSONL events to `<project>/_sessions/<YYYY-MM-DD>/<filename>` with silent-skip on bad project dir.
- Four new event kinds: `hot-section-synthesis` / `hot-section-over-budget` to `retrieval-log.jsonl`; `demote-moves` / `demote-moves-large-batch` / `compact-project` / `project-md-over-cap` to `hygiene-log.jsonl`.

### Changed
- `/finalize` Step 3 (Memory hygiene): runs `demote-moves` then `compact-project` before ghost-file cleanup. Concurrency order is `demote-moves → compact-project → hot-section`.
- `/process-memory` Step 5 rewritten as "PROJECT.md tier discipline" — both scripts run in order; auto-applies.
- `/orient` Step 4 (elapsed-time signals) surfaces recent `demote-moves-large-batch` and `project-md-over-cap` events from `hygiene-log.jsonl`.
- `protocols/data-storage.md` documents the two log files and the four Phase 1b event kinds.
- PROJECT.md management framing: humans MAY read or edit but the agent treats the file as agent-managed; effectiveness measured via hygiene-log events, not user review. Auto-applies on day 1 (dry-run is the agent's own inspection mode, not a permanent user-ratification gate).

## [2.2.0] — 2026-05-23

### Added
- `protocols/clusters.md` — cluster naming discipline doc (DC-85 Phase 1a). Three valid naming triggers (project-shape at intake, traversal-pattern emergence, deliberate investigation), ratification gate, render-vs-load defaults, when-NOT-to-cluster guidance.
- Source-of-authority hierarchy intake (DC-85 §8) in `protocols/startup.md` new-workspace path and `protocols/hygiene.md` on-demand setup. Captures governance ordering across project artifacts (PRD > HLSD > RTM > chat) as a per-project decision unit. Distinct from DC-87's per-external-source authority.
- `by-when` optional frontmatter field on `open-question` units. Documented in `protocols/data-storage.md`; validated by `check-units.mjs` (ISO date format + wrong-type warning).
- Open-question staleness check at `/orient` Step 4 — surfaces past-due `by-when` items in the readiness summary. Michelle probe mechanism.
- `scripts/hot-section.mjs` — new script with `candidates` / `apply` / `current` / `clear` subcommands. Inserts agent-composed 5-7 line "Right now" section atop `PROJECT.md` between front-matter and §What & Why, bracketed by HTML-comment markers for idempotent find/replace.
- `/orient` Step 4.5 — conditional hot-section refresh on candidate/intent shift.
- `/finalize` Step 2.6 — post-render hot-section refresh capturing session outcome.

### Changed
- **Push policy reframed from universal-confirm to per-user, per-repo with safe default.** Pushes now follow the user's established policy; default when no policy named is confirm every push (safe for new users). Documented in `SKILL.md §Core principles` and `protocols/data-storage.md §"Push policy is per-user, per-repo"`. No behavior change for users who haven't named a policy.

## [2.1.0] — 2026-05-23

### Added
- Ghost-file cleanup in `/process-memory` and `/finalize` — both commands now automatically remove macOS cloud-sync duplicate files from the unit store on each run
- CHANGELOG.md — human-readable release history, Keep a Changelog format
- Version-check CI gate — all PRs to main must bump version in lockstep across plugin.json and marketplace.json
- Auto-tag GitHub Action — pushes to main automatically create a `vX.Y.Z` git tag from plugin.json
- `/cut-release` slash command — LLM-orchestrated release flow with 11 pre-flight checks, dry-run mode, CHANGELOG update, and stranded-release recovery (F-SR)
- `/sync-next` slash command — back-merges main into next after release PR merges

### Changed
- Plugin version is now read from `plugin.json` throughout the skill — `skills/core/VERSION` removed as a redundant (and stale) source; startup.md reads `../../.claude-plugin/plugin.json` from the skill base directory

## [2.0.2] — 2026-05-23

### Added
- Source-registration framework (DC-87) — source-agnostic intake protocol, `/register-sources` slash command, confidence-assignment guide, source-pull-log analyzer
- Codex harness adapter — full CERT-READY at BUILD 20260521.5; dual plugin manifest (Claude Code + Codex)
- Workspace fork-check script — auto-forks copied workspaces, prevents identity confusion

### Fixed
- CLAUDE_PLUGIN_ROOT resolution fallback in startup.md (symlink + non-env environments)
- Symlink resolution on CLI entry guards (realpathSync across all 10 scripts)
- dc77-invariants test now covers `${CORE_ROOT}` as derived plugin-root anchor

## [2.0.1] — 2026-05-20

### Added
- Codex harness adapter (initial) — cross-harness verb contract + adapter pattern
- Downstream plugin cleanup — 8 scripts updated

### Changed
- core-plugin marketplace path corrected: `./` → `./plugins/core`

## [Earlier releases]

History prior to v2.0.1 not retroactively reconstructed. See `git log` and `_summaries/` in the CORE dev repo for context.
