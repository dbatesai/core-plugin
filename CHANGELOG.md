# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Changes will accumulate here between releases. Moved to a versioned section by `/cut-release`.

## [2.0.2] — 2026-05-23

### Added
- Source-registration framework (DC-87) — source-agnostic intake protocol, `/register-sources` slash command, confidence-assignment guide, source-pull-log analyzer
- Codex harness adapter — full CERT-READY at BUILD 20260521.5; dual plugin manifest (Claude Code + Codex)
- Workspace fork-check script — auto-forks copied workspaces, prevents identity confusion
- Ghost-file cleanup in `/process-memory` and `/finalize` — removes macOS cloud-sync duplicates from the unit store

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
