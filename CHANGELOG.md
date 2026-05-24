# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
