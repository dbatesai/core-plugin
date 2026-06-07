# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.6.0] — 2026-06-07

`/orient` is now a deprecated no-op — typing it prints a notice and points you to `/core`, which does everything it used to, including a fresh readiness summary when you re-run it mid-session. Metrics capture runs by default now: CORE measures how well it recognizes your project across sessions and writes the results to local disk only, with a per-workspace and environment-variable opt-out. The classifier behind that measurement is PROVISIONAL — it isn't calibrated, so the readiness summary only flags an upward recognition-failure trend, never an absolute score. Underneath, the deterministic scripts got safer: writes to irreplaceable files are atomic, the CLI entry guards no longer silently no-op on symlinked installs, and diagnostics fail loudly instead of producing wrong-but-plausible output. The startup protocol loads its rare branches only when it needs them. The test suite grew 490 → 528.

### Deprecated
- **`/orient`.** Folded into `/core`: picking a thread back up, the readiness summary, edit detection, hygiene-log signals, the hot-section refresh, and source-registration readiness all run when you type `/core`. Re-running `/core` mid-session with no task re-composes a fresh readiness summary. `/orient` still resolves but is now a no-op that prints a deprecation notice — kept so existing muscle memory, scripts, and wrappers don't break. Use `/core`.

### Changed
- **Metrics capture defaults to on, opt-out.** CORE captures recognition metrics to local disk under `<project>/_metrics/`. Opt out per workspace with `metrics_enabled: false` in `workspace.json`, or globally with `CORE_METRICS_ENABLED=0`. Capture stays local — nothing leaves your machine. The classifier stays PROVISIONAL until a human-labeled set clears a 0.7-precision gate; every surface that shows a recognition signal says so, and the readiness summary only flags an upward trend.
- **Edge vocabulary adds `refines` and `amends`.** `refines` sharpens a prior decision without replacing it; `amends` modifies specific parts while the prior stands. Both are distinct from `supersedes`. Informal types (`relates`, `related`, `relates-to`) normalize to `cites`.
- **Startup loads its rare branches on demand.** The new-workspace and folder-rename paths live in `protocols/startup-conditional-loads.md`, read only when routing selects them. Cold-start migration stays inline. Returning sessions carry a lighter startup protocol.
- **`/finalize` validates the unit store.** It runs the schema and integrity check over `_memories/` as a closing step.
- **One root-resolution idiom across surfaces.** Scripts resolve from the skill's own base directory; `${CLAUDE_PLUGIN_ROOT}` is documented as not reliably injected into agent shell calls and used only as a fallback. Command bodies in `/finalize`, `/process-memory`, and validation share the one idiom.

### Fixed
- Writes to MEMORY.md and the decision and risk indexes are atomic — an interrupted write can't truncate them or cause a false drift report.
- The CLI entry guards in `metrics-init`, `validate-adversarial-artifacts`, and `audit-memory-boundary` canonicalize both sides, so they run instead of silently no-opping on symlinked installs.
- `/finalize`'s unit check runs both the schema and integrity passes (the flags previously collapsed to integrity-only).
- The validity supersession stamp tolerates CRLF line endings, so Windows/OneDrive-authored units get stamped.
- Diagnostics fail loudly instead of producing wrong-but-plausible output: `priority --today`, retrieval-skip flag parsing, the rollup's PROVISIONAL label on calibrated workspaces, and unreadable adversarial-artifact paths.
- The calibration worksheet is idempotent — a same-day re-run no longer double-counts turns toward the precision gate; capability-history appends are atomic.
- Malformed dates no longer fall through to a demote; a non-finite `--since-days` no longer selects every event; Codex array-form transcript events parse.
- Documentation corrected on shipped surfaces: authority ordering, hygiene verbs, cross-references, and counts.

## [3.5.0] — 2026-06-02

A scripts-hardening release — the full open set from an internal review of all 48 shipped scripts, closed as one pass. Nothing about how you use `/core` changes; the deterministic spine under it gets safer. Highlights: writes to your project's irreplaceable files (PROJECT.md, the archive, the workspace pointer) are now atomic, so an interrupted write can never leave a half-written or truncated file. The capability gates that protect destructive actions now fail closed honestly — a mutation surface that can't prove it's writable, or an adversarial run whose anti-anchoring gate is denied, no longer reads as "all clear." And the self-measurement instruments (the recognition classifier, its calibration gate) got more honest about what they can and can't claim. The test suite grew 445 → 482.

### Changed
- **Fail-closed mutation, enforced.** The adversarial-run gate no longer reports AUTHORIZED when the operation-scoped mutation gate was actually denied, and the collab-files target-surface probe degrades when it can't prove write access instead of silently passing. Both align with the fail-open-observation / fail-closed-mutation doctrine. (A configured collab-files repo that's offline will now show DEGRADED at startup rather than a false PASS — honest signal, not a failure.)
- **The recognition classifier is more honest.** Its in-context check now matches on word boundaries (a short term that was merely a substring of your large PROJECT.md no longer counts as "recognized"), it no longer treats ordinary hyphenated English like "opt-in" as a project term, and the previously-dead mechanics-failure discriminator is wired. Still PROVISIONAL until calibration clears.
- **Calibration gate requires coverage.** The classifier's 0.7-precision gate can no longer clear while whole recognition states sit unmeasured — every state present in the labels must be measured.

### Fixed
- Atomic writes for PROJECT.md / PROJECT-ARCHIVE.md / the workspace pointer (temp-file + rename) across all four hygiene mutators and the workspace fork-check — an interrupted write can no longer truncate them, and the fork-check writes the irreplaceable pointer last.
- The memory-visible canary probe now requires the *agent* to echo the token (injected memory text no longer false-passes it).
- Capability rows always carry the unconditional schema fields (`observed_at`/`harness`/`cwd`/`env_signals`) — the runner backfills any a probe omitted.
- Pipes in a decision/risk title no longer corrupt the generated index tables; the canary strip no longer deletes documentation prose that mentions the canary tag; `generate-memory-index --top <non-integer>` (or a missing target file) now refuses cleanly instead of silently thinning or crashing MEMORY.md; capability-drift no longer fabricates regressions from session-less rows or double-counts across stores; the retrieval-validation report no longer shows contradictory `FAIL | 1 | 1` rows.

## [3.4.0] — 2026-06-02

The instrumented-memory system (Phases 0–4) and the validity dimension. CORE now measures its own recognition — a per-turn classifier, a daily rollup, and an `/orient` signal — all privacy-gated and default-off, with the classifier honestly marked PROVISIONAL until a human-labeled calibration set clears a 0.7-precision gate. Units gain an optional world-time validity dimension (`t_valid`/`t_invalid`) that retrieval honors by suppressing invalidated facts. The whole thing is additive — a project that opts into nothing behaves exactly as on 3.3.0.

### Added
- **Instrumented-memory recognition loop (Phases 0–4).** Per-turn six-state classifier, daily metrics rollup + `/orient` recognition signal, and citation-resolver / stale-context / anticipation-gap detectors — all behind a privacy gate (default-off, opt-in per workspace via `metrics_enabled` / `CORE_METRICS_ENABLED`). The classifier is **PROVISIONAL**: uncalibrated until ~100 hand-labeled turns clear a 0.7-precision gate, and every surface says so. `/orient` only flags an upward recognition-failure trend, never an absolute level.
- **Validity dimension on units.** Optional `t_valid`/`t_invalid` world-time fields, `--as-of` point-in-time reconstruction, a storage-health `--metrics` readout, and Tier-2 retrieval suppression of invalidated units (`--include-invalid` walks cold history). Additive — units without the fields behave exactly as before.
- **Impact-propagation trace** over `depends-on` edges and **absence-with-deadline** detection.
- **Calibration harness** with a self-grading guard: precision is computed only from human labels, never the classifier's own output (the R-1 anti-self-confirmation guard).
- **Memory + metrics extension contracts** for downstream overlays: passthrough capture, additive detectors, and the `world-time-policy` source hook for populating `t_valid` from a source's own timestamps.
- **`orphan-detector`** — definition-of-done enforcement: every script must be reached by a skill and every protocol indexed.

### Changed
- **`demote-moves` archives completed `[x]` §Moves items on checkbox + age** rather than requiring all cited units to be in terminal status (the old gate never fired on real corpora and let PROJECT.md grow unbounded). `--strict` restores the old behavior; a large first batch is held until `--apply-large-batch` so a bulk migration of a user-owned file gets a look.
- **Validity is consolidated as a dimension on units** — read predicates in `priority.mjs`, field-validation in `check-units`, suppression in `graph-walk` — not a standalone subsystem.
- **Frontmatter parsers are CRLF-tolerant**; a `.gitattributes` normalizes line endings to LF (Windows/OneDrive checkouts).

### Fixed
- **demote-moves stub re-demotion**: an archive stub could re-demote itself across a date boundary, degrading the pointer trail. Now guarded. Citation, backtick, and future dates are no longer misread as completion dates.
- **`generate-memory-index` Windows no-op** (`fileURLToPath`); slug encoders handle Windows drive letters.
- Pre-release prose fixes (dev-meta leak, push-policy contradiction, stale references).

### Notes
- R-17 trust-based anti-anchoring on Claude Code remains **DEGRADED** — multi-agent analysis output is advisory-only and watermarked until independent acceptance. The physical-isolation proof that would close R-17 is separate and not in this release.

## [3.3.0] — 2026-06-01

Track B of the Codex co-existence workstream (DC-104) — the structural half: a project bootstrap/health-check for either harness, a real fork-check bug fix, and the supporting contract. Plus the workspace-identity field standardization and the R-17 adversarial-run-gate wiring that were already on `next`. Track B's pre-build `/core` review reshaped it: CORE ships no connector name-map (it ships the contract; the overlay owns the data) because a grep proved CORE hardcodes zero connector names.

### Added
- **`/configure-project` — a new companion skill (and `configure-project.mjs`).** Bootstraps and health-checks a project for the current harness: confirms the install + manifests, validates the memory store, resolves workspace identity (detect-only — never mutates), reports connector capability in two honest tiers, runs the capability probe, and generates `AGENTS.md` from a `CONTRACT.md` when one exists. The Codex-side counterpart to Claude Code's startup mandate; idempotent and report-only unless `--apply`. Wired as the Codex setup step in the Codex adapter. (CORE now ships seven companion utilities.)
- **Two-tier capability reporting.** The check distinguishes what a script can verify from disk (manifests, store validation, MCP servers *declared* in `~/.claude.json` — not verified reachable, capability-probe rows) from session-live questions only the running agent can answer (is a connector reachable + authed this session? the `~/.codex/config.toml` server list, which the script does not parse; the live two-harness check). The script never asserts a capability it cannot check.
- **`dryRun` mode for `workspace-fork-check`** — detect the fork decision without performing the multi-file mutation.

### Changed
- **Workspace-identity field standardized on `path`** across the schema, startup prose, and the fork-check writer. Legacy `project_path` stays read-tolerated for one release, then drops.
- **The R-17 adversarial-run-gate is now wired into `protocols/analysis.md`.** Multi-agent runs are classified AUTHORIZED / ADVISORY / BLOCKED at Phase 0; ADVISORY (the Claude Code norm under R-17) watermarks the synthesis and withholds canonical-mutation authority until independent acceptance. This makes R-17's degraded state *enforced*, not just labelled — it does not close R-17.
- **`source-registration-framework.md`** documents the overlay-owned `connector-map.json` contract and the script-visible/session-live capability boundary.

### Fixed
- **`workspace-fork-check` re-forked an already-registered workspace under a symlinked project root** (macOS `/tmp`→`/private/tmp`, OneDrive/Dropbox/iCloud sync roots). The fork decision compared paths with `resolve()` while the CLI entry-guard canonicalizes with `realpathSync`, so the live cwd and the registered index path differed by symlink-vs-real form and the workspace re-forked on every startup. Both comparison sides now canonicalize with `realpathSync` (resolve-fallback when the path is absent).
- **`generate-agents-md` crashed with an uncaught ENOENT when `CONTRACT.md` was absent.** It now skips cleanly (the common case for a project without an adopted contract); a present-but-malformed contract still throws loudly.

## [3.2.2] — 2026-06-01

A patch fixing a slug-encoding bug that broke MEMORY.md auto-refresh and the visibility canary on dotted usernames, plus three `check-units` validator false-positives. Track A of the Codex co-existence workstream — folder-independent fixes from Crest's multi-source report, converged + ratified with Hale.

### Fixed
- **Slug-encoding bug broke `generate-memory-index` and `write-visibility-canary` on dotted usernames.** The project-path→slug encoding replaced `/` but not `.`, so a username like `David.Bates28` produced a slug (`-Users-David.Bates28-…`) that never matched Claude Code's real projects folder (`-Users-David-Bates28-…`). Two confirmed failures: `generate-memory-index`'s cross-project guard false-refused (MEMORY.md priority block couldn't auto-refresh — manual fix every finalize), and `write-visibility-canary` couldn't locate the right MEMORY.md and returned `memory_written: false`. Fixed with a single canonical `mapProjectPathToSlug()` helper (`/`, `\`, `.` → `-`) used at both sites; legitimate cross-project refusal is preserved (a genuinely different path still mismatches).
- **`check-units` rejected valid flow-style YAML arrays.** Inline `topics: [a, b, c]` was parsed as a scalar string, producing false `topics-format` warnings. The shared frontmatter parser (`priority.mjs` `_coerce`) now parses flow-style arrays as lists.
- **`check-units` false `dangling-edge` on `references-topic`.** Those edges target the controlled vocabulary (`topics.md`), not unit IDs; they're now exempt from the unit-existence check.
- **`check-units` exit code blocked startup on benign warnings.** A healthy store with orphan/stale warnings exited non-zero. New exit contract: `0` pass (incl. pass-with-benign-warnings), `1` degraded (non-benign warnings, still non-blocking), `2` hard fail (schema/enum/required-field/broken edge).
- **Legacy `capability-drift-log.md` left behind on upgrade.** Before v3.1.0 the drift log was written without the `_` prefix; the rename to `_capability-drift-log.md` left the old file in already-migrated projects, where `check-units` treats it as a malformed unit (6 schema FAILs). `analyze-capability-drift` now removes the legacy non-prefixed file when it writes the current one, so upgraders self-heal.

## [3.2.1] — 2026-05-31

A patch fixing a workspace-registration bug surfaced by on-box Windows use (Meridian, R11).

### Fixed
- **Workspace fork-check no longer spuriously re-forks every startup.** It matched index entries on `path`, but the workspace schema specifies `project_path` — so a schema-compliant entry was invisible to the path-match and the check kept forking the workspace (`-2`, `-3`, …) on each fresh session. It now reads `project_path || path` at both match points, recognizing both conventions. Distinct from the v3.1.x resolver fixes (those were plugin identity/authority; this is workspace registration).

## [3.2.0] — 2026-05-31

A structural release. `plugins/core/` becomes the single canonical tree (the dual-tree mirror is gone), and `/orient` now records retrieval events so retrieval-quality analysis measures real data. Transparent to users — `claude plugins update core@core` re-pulls from the new source.

### Added
- **`/orient` records retrieval events.** A resumption bootstrap now emits one retrieval-shaped row per load (`session-start` trigger), so `analyze-retrieval-quality` measures real retrievals instead of empty telemetry. The most common retrieval path was previously invisible to the corpus.

### Changed
- **Structural collapse — `plugins/core/` is the single canonical skill tree.** The top-level `skills/`/`hooks/` trees and the rsync mirror are removed; the Claude marketplace `source` is now `./plugins/core`, matching where Codex already read. Tests live at the repo root and no longer ship in the install bundle (install drops from ~2.4 MB to ~1.2 MB). One tree, both harnesses.
- Version source canonicalized on the `plugins/core` manifests; the repo root keeps only the marketplace listing.

## [3.1.1] — 2026-05-31

A patch release fixing two plugin-root resolver defects surfaced by on-box Windows validation (#45), both confirmed live on the shipped v3.1.0.

### Fixed
- **Windows authority classification.** `classifyAuthority` compared the resolved plugin root against forward-slash path literals while `homedir()` returns a backslash path on Windows, so every Windows install classified as `unknown` and its mutation gates failed closed. Both sides are now normalized to forward slashes before comparison (safe on POSIX, where backslashes can't appear in a path). (#45)
- **Identity DEGRADED on co-located manifests.** When the install root co-locates the Claude and Codex manifests (the shipped layout), the codex-first anchor walk always reported `manifest_harness: codex`, tripping the split-brain check and degrading identity on every Claude resolution. The resolver now re-points to the consuming harness's own manifest when it's co-located in the resolved root — before env reconciliation — and still flags genuine wrong-plugin cases where only the foreign manifest is present. (#45)

### Changed
- CI hardens the script-import glob guards and adds a Codex mirror parity gate.
- Dropped a redundant `RENDER_ONLY_ARTIFACTS` validator guard now subsumed by the `_`-prefix convention.

## [3.1.0] — 2026-05-31

A reliability release on top of v3.0.0: it hardens the startup `CORE_ROOT` resolver against a silent wrong-drive failure, adds a guard against cross-project memory contamination, and removes the Gemini harness (which never had a working callable-skill surface). MINOR rather than patch because it removes a harness and adds a register-sources capability note.

### Fixed
- **`CORE_ROOT` resolver hardened against silent wrong-drive failure.** The tier-3 fallback's inline `node -e` used a backslash regex that collapses in a shell's double-quotes into a compile-time SyntaxError `try/catch` can't catch — which left `CORE_ROOT` empty and resolved `node "/skills/..."` against the Git-Bash MSYS root on Windows, dying silently. Every `node "${CORE_ROOT}/..."` call site is now mechanically gated on the scripts dir, an unresolved root blanks `CORE_ROOT` and surfaces loudly in the readiness receipt instead of crashing, and the separator normalization moved to the shell. The SyntaxError was actually universal (verified on macOS); only the catastrophic empty-path consequence was Windows-specific.
- **`generate-memory-index` refuses cross-project writes.** The script took its `_memories` source and `--memory-md` target as independent path args and never checked they belonged to the same project; pairing one project's units with another's MEMORY.md silently overwrote the target. It now recovers the target's project identity from the Claude Code path mapping and refuses on mismatch.
- `capability-drift-log` render no longer trips the unit validator (underscore-prefixed so `check-units` skips it).
- Corrected the shipped-skill count to six (adds `register-sources`).

### Added
- `register-sources`: an advisory `platform_credentials` note — CORE flags the concept; the overlay owns the value.

### Removed
- Gemini harness support — the `.gemini-plugin` manifest, the `harnesses/gemini.md` adapter, the `generate-gemini-md` generator, and all Gemini detection/capability rows. Gemini CLI has no callable-skill surface, so CORE-on-Gemini relied entirely on the agent inferring the protocol — it didn't work in practice. The contract system now generates CLAUDE.md + AGENTS.md only.

## [3.0.0] — 2026-05-30

This release ships the instruction-surface generator system (CONTRACT.md → harness instruction files). It also includes the full v2.9 evidence-layer hardening, native Codex marketplace support for both repos, and a retrieval-quality analyzer fix that makes metrics fail honest when retrieval-shaped rows are absent. End-to-end retrieval-effectiveness proof remains open until startup/orient/refresh emit retrieval-shaped rows and expected/forbidden-memory scenarios pass. The MAJOR bump reflects the maintenance-model change: generating CLAUDE.md/AGENTS.md/GEMINI.md from a single CONTRACT.md changes how projects maintain instruction surfaces.

### Added (v3.0 — instruction-surface generator system)
- `skills/core/scripts/contract-format.mjs` — parses the canonical CONTRACT.md source format
- `skills/core/scripts/generate-claude-md.mjs`, `generate-agents-md.mjs`, `generate-gemini-md.mjs` — generate harness instruction files from CONTRACT.md
- `skills/core/scripts/migrate-to-contract.mjs` — bootstraps a draft CONTRACT.md from existing files; non-destructive
- Fail-closed release gate: `last_revised: unknown` or non-canonical `canonical_for` → exit 1
- `skills/core/scripts/audit-memory-boundary.mjs` — read-only sampled audit surfacing native-only memory entries as graduation candidates
- `skills/core/scripts/validate-adversarial-artifacts.mjs` — validates adversarial protocol artifacts (initial-frame, persuasion-log, mind-changes)
- `schemas/adversarial-artifacts.md` — schema spec for adversarial output artifacts
- `skills/core/scripts/record-retrieval-event.mjs` — validated retrieval-evidence producer that writes analyzer-visible rows and OTel `core.retrieval` spans
- Golden tests for all three generators + contract parser

### Added (v2.9 — evidence layer)
- `skills/core/scripts/analyze-retrieval-skip.mjs` — transcript-based scan for the recognition-failure signature; candidates not verdicts
- Byte-cap truncation detection in `capability/memory-visible-probe.mjs` — line-count check replaced with byte check (~24.4KB injection cap)
- Codex `function_call`/`custom_tool_call` extraction in `read-transcript.mjs` — flips `memory-accessed` from always-UNKNOWN on Codex to classifying
- `harnesses/claude-code.md` adapter modernization: Workflow/Teams, subagent_type catalog, ScheduleWakeup cadence default; doc-regression tests

### Added (Codex marketplace support)
- `plugins/core/` — self-contained Codex marketplace plugin directory; enables native `codex plugin marketplace add dbatesai/core-plugin --ref main && codex plugin add core@core`
- `scripts/sync-codex-plugin.sh` — sync helper for keeping plugins/core/ current
- CI gate verifying marketplace.json source.path integrity

### Open verification gates
- End-to-end retrieval-effectiveness proof remains `NOT-YET`: live startup/orient/refresh runs still need to use the producer to emit retrieval-shaped rows with selected unit IDs, tier path, suppression counts, context-pack size, and outcome/usefulness fields. **Forbidden-memory scenario gate is now wired** (PR #38 ships the validation gate that catches forbidden-unit hits in the top-5 candidate set); expected-memory precision/recall scoring was already in place. The remaining gap is live startup/orient/refresh actually CALLING the producer on each retrieval operation.

### Fixed
- `analyze-retrieval-quality.mjs` — gated on `isRetrievalShapedEvent()`; stops counting telemetry rows as retrieval proof; surfaces the split plainly
- `check-units.mjs` — render-only exemption narrowed to generated `capability-drift-log.md` only; real units mentioning the phrase still validate
- `protocols/startup.md` — removed stale "Codex has no equivalent auto-memory" text; aligned with `harnesses/codex.md §read-auto-memory`
- Anti-anchoring probe: `CLOSURE_TARGET` corrected from `v2.8.0` (never closed) to `v2.9+`
- `skills/finalize/SKILL.md` — added Step 3.5 ROADMAP.md regen (documented in ROADMAP header but missing from the skill)
- `validate.mjs` — negated-query exclusions: `no <term>` in a validation query is now parsed as an exclusion signal rather than a positive match. The Tier 1 simulator was previously dropping the `no` prefix and rewarding units that mentioned the term, which let stale runtime-probe memory into the top-5 even when better units were present. (Root cause found via core-codex validation: `no heartbeat` was rewarding a stale heartbeat-automation unit.)
- `validate.mjs` — forbidden-candidate gate: validation now scans the top-5 candidate set for units that should NOT appear; a forbidden hit now fails the run rather than silently passing. Live validation against core-codex surfaced a previously-hidden forbidden-memory miss (4/5 pass, 1 fail). This closes the "expected-memory and forbidden-memory scenario tests" open verification gate.
- `validate.test.mjs` CLI regression resolves the script from the test file location (same cwd-independence fix as #35 for the retrieval producer test)
- `record-retrieval-event.test.mjs` CLI regression now resolves the script from the test file's own location rather than the working directory — test passes when run from external project roots and installed plugin caches (Codex `/orient` probe caught this)
- `record-capability-snapshot.mjs` — adds project-local capability history fallback at `<project>/_metrics/capability-history/<workspace-id>.jsonl` for Codex sandbox environments where the primary `~/.core/workspaces/<id>/capability-history.jsonl` is outside the writable sandbox (EPERM/EACCES/EROFS/ENOTDIR errors). `analyze-capability-drift.mjs` reads both stores.

### Improved
- `protocols/startup.md` — inline `record-retrieval-event.mjs` call example with real field names pins agents to the actual schema; explicit warning against rejected alias fields (`session_intent_topics`, `highest_tier_reached`, `selected_units`) prevents first-call mistakes (Codex `/orient` probe caught the ambiguity)

## [2.8.1] — 2026-05-29

A patch fixing the visibility canary, which shipped broken in v2.8.0.

### Fixed
- `write-visibility-canary.mjs` now writes the canary as a **visible markdown line** instead of an HTML comment. A field bootstrap on 2026-05-29 proved Claude Code strips HTML comments when it injects `MEMORY.md` into context — the line-1 `<!-- CORE-VISIBILITY-CANARY -->` did not reach injected memory (injection began at the first `## ` heading) — and separately byte-truncates the injected copy at ~24.4KB. Both kept the canary out of context and blocked the memory-visible field-cycle PASS. The replacement regex now matches both the legacy HTML-comment form and the new visible form, so the upgrade is a clean in-place replacement with no accumulation. Tests cover the visible-not-comment invariant and the legacy-comment migration.

### Notes
- HC adversarial review is still outstanding at release time (the review thread is open). David authorized cutting the release with that flagged — a v2.8.2 is cheap if HC finds something.
- The memory-visible field-cycle PASS is observable at the next bootstrap from the canary already written to `MEMORY.md`, but it is not yet demonstrated. This release's role is durability: it makes the installed plugin emit the visible canary going forward, so `/finalize` stops reverting it to an HTML comment.

## [2.8.0] — 2026-05-29

This release folds in the v2.7 work that was never tagged — capability history, drift detection, the adversarial-run gate, and several new probes — and adds the v2.8 memory-visibility runtime plus the foundation scaffolding that v2.9 will wire up. There is no `v2.7.0` tag; its content ships here under 2.8.0.

### Added
- `skills/core/scripts/capability-history.mjs` — per-session capability snapshots in a JSONL store with an advisory file lock, so drift and regression analysis at `/finalize` and `/process-memory` read a real history instead of a single point.
- `skills/core/scripts/analyze-capability-drift.mjs` — reads that history and reports drift and regressions (a row that was PASS last session and is DEGRADED now, for instance).
- `skills/core/scripts/record-capability-snapshot.mjs` — appends the current session's snapshot to the history; runs at startup after the capability probe.
- `skills/core/scripts/capability/memory-visible-probe.mjs` — proves the auto-loaded memory was actually in the agent's context, not just present on disk, via a startup canary echo. Includes load-completeness detection: when injected memory is truncated, the row DEGRADES instead of reporting PASS. Wired and exercised.
- `skills/core/scripts/write-visibility-canary.mjs` — writes the canary token the next session echoes.
- `skills/core/scripts/capability/auto-memory-injection-probe.mjs` — checks whether the harness injected project memory at all.
- `skills/core/scripts/capability/instruction-surface-resolution-probe.mjs` — checks that CLAUDE.md / AGENTS.md instruction-surface precedence resolves the way the skill expects.
- `skills/core/scripts/capability/anti-anchoring-mechanism-probe.mjs` — surfaces R-17 as a DEGRADED-by-mechanism row rather than claiming a guarantee the harness can't enforce.
- `skills/core/scripts/instruction-surface-adapter.mjs` — dry-run core (inventory + patch plan, no writes) for the v3.0 instruction-surface adapter. Foundation only.
- `skills/core/scripts/read-transcript.mjs` — adapter verb that parses session transcripts (Claude Code + Codex message parsers; Gemini returns null; Codex tool-call extraction still pending). Built and unit-tested in isolation, **not yet wired to a consumer** — foundation for v2.9.
- `skills/core/scripts/capability/memory-accessed-probe.mjs` — store-selection tier that consumes read-transcript to tell "memory present" from "memory actually reached." Built and unit-tested, **not yet wired** — foundation for v2.9.

### Changed
- `skills/core/scripts/adversarial-run-gate.mjs` — consumer gate that enforces the anti-anchoring discipline, with a machine-readable decision enum.
- `skills/core/scripts/capability-probe.mjs` — probe-itself validation: a probe that crashes reports UNKNOWN with a probe-error reason instead of failing silently.
- `protocols/startup.md`, `skills/finalize/SKILL.md`, `skills/process-memory/SKILL.md` — wire capability history and drift snapshots into startup, finalize, and process-memory.

### Risks
- R-17 (trust-based anti-anchoring on Claude Code) is demoted to an honest anti-anchoring-mechanism row that reports DEGRADED-by-mechanism. The earlier 2.6.0 note said this "closes in v2.8.0" — what actually shipped is the honest demotion, not hard enforcement. The mechanism stays trust-based on Claude Code.

### Status notes
- `read-transcript` and `memory-accessed` are foundation: tested in isolation, not wired to any consumer, and do nothing at runtime yet. v2.9 wires them.
- The memory-visibility field-cycle PASS is a cross-session check — it confirms on a future bootstrap, not within this release.
- Every new script ships with unit tests under `tests/scripts/`; the script suite passes at cut.

## [2.6.0] — 2026-05-27

### Added
- `skills/core/scripts/resolve-plugin-root.mjs` — v2.6.0-δ: conflict-not-priority refactor of `detectConsumingHarnessSignal()`. Collects all env signals then classifies as unanimous/conflict/absent instead of first-match-wins. New `consuming_harness_signal_weight` field (`strong`|`weak`|`null`) threads through to row schema. `consuming-harness-conflict` evidence entry emitted when multiple harnesses detected. Block code `consuming_harness_signal_weak` for action profiles that require strong signals.
- `skills/core/scripts/capability/target-surface-collab-files-probe.mjs` — New target-surface capability. Five proofs: (1) files repo path exists, (2) git root matches configured path, (3) working tree state parseable, (4) remote URL matches expected, (5) write/push verified or marked unproven. Config source: descriptor's `surfaces.collab_files_repo` + `surfaces.collab_files_expected_remote` (Option A). Identity_status PASS only when all proofs agree; DEGRADED on root/remote mismatch; UNKNOWN on git failure.
- `skills/core/schemas/harness-capability-descriptor.json` — Two new action profiles: `installed-runtime-write` (installed-cache only) and `source-maintenance-write` (canonical-source only). `allowed_signal_weight: 'strong'` on `collab-files-mutating` and `project-memory-write`. `surfaces` block with `collab_files_repo` + `collab_files_expected_remote` config. `target-surface-collab-files` added to each harness's capabilities + `collab-files-mutating` requires_pass. **Note**: relocated from `scripts/capability/` to `schemas/` during v2.6.0 review (HC v2.6 invariant objection) — descriptor is contract content, not script content; schemas/ is the correct home per Doctrine 2.
- `skills/core/references/architecture-doctrines.md` — Five doctrines with named first consumers: probe-before-propose, documentation-as-contract-reference, schema-consumer-coupling, fail-open-observation/fail-closed-mutation, doctrine-consumer-coupling.
- `protocols/startup.md` — Capability probe wire-in before readiness composition. Runs `capability-probe.mjs --startup`; writes `capability-state.json` to workspace; surfaces non-PASS rows with "continuing with degraded capability evidence" verbatim. All-PASS: silent per `feedback_readiness_only_escalations`.

### Changed
- `skills/core/scripts/capability-probe.mjs` — Extended `invokeProbe()` to handle `capability/`-prefixed delegate paths via dynamic import. Added `allowed_signal_weight` gate to `runPreAction()` with `consuming_harness_signal_weak` block code. Updated `detectConsumingHarness` comment to reflect conflict-not-priority behavior.

### Decision units
- DC-95: capability-probe-distribution — probe approach per harness vs universal
- DC-96: effective-script-root-as-identity-gate — script root as the hard identity signal
- DC-97: fail-open-startup-fail-closed-mutation — mode separation doctrine
- DC-98: schema-and-doctrine-consumer-coupling — consumer-cited schema lifecycle
- DC-99: harness-docs-as-contract-reference — docs-as-contract doctrine
- DC-100: harness-memory-authority-boundary — memory authority per harness
- R-17: trust-based-anti-anchoring-claude-code — DEGRADED-by-mechanism; closes in v2.8.0

## [2.5.0] — 2026-05-27

### Added
- `skills/core/scripts/metrics-init.mjs` (266 lines) — T1 storage scaffold for metrics & observability v1. Idempotent per-workspace setup; library + CLI entry. Behavior per the converged design from collab `design-and-pressuretest-t3-stop-hook-with` (closed 2026-05-26).
  - Non-Windows: default storage at `<project>/_metrics/{traces,payloads,queue}/`.
  - Windows-with-OneDrive: detection via path-substring + `.ini`-scan (UTF-16LE; Personal + Business<N> account dirs); redirects to `~/AppData/Local/core-metrics/<workspace-id>/`. Method (a) catches the common Documents-redirection case; method (c) catches non-default sync setups.
  - Detection-method results logged to `~/.core/workspaces/<id>/metrics/scaffold.log` for forensic trail. Resolved storage path pinned to sibling `storage-path.txt` for write-time consumers.
  - Stub README at project location when storage is redirected — preserves grep-discoverability and points user at actual location.
  - `CORE_METRICS_FORCE_PROJECT_LOCAL=1` and `CORE_METRICS_FORCE_APPDATA_FALLBACK=1` env-var escape hatches; both short-circuit detection.
- `skills/core/scripts/demote-state-narrative.mjs` (~320 lines) — DC-85 Phase 1c §State narrative compaction. Demotes §State bullets to `PROJECT-ARCHIVE.md §State` when ALL three conditions hold: strict `*Backed by ...*` footer citation present, all cited units in terminal status (`resolved`/`archived`/`superseded`/`closed` — mirrors `demote-moves` for cross-script symmetry), AND the most-recent backing-unit `updated:` date is >60 days old. Conservative defaults match `demote-moves` — no citation, missing unit, or any-active-unit → keep. **Default mode is dry-run in v1** (only `--apply` writes) because §State demotion is materially riskier than §Moves demotion and the criteria are tuned for §State-heavy non-CORE corpora that haven't been exercised yet. The flip to apply-default waits on cross-corpus validation against `all-in-mesh-redemption` or similar. Older citation styles (`*DC-XX.*` shorthand) intentionally fall into the no-citation bucket per DC-93 §3. 36 unit tests cover the full classification matrix plus the dry-run-vs-apply contract.

### Changed
- `skills/core/scripts/log-event.mjs` (+100 lines, then +25 lines) — added OTel-format dual-write per spec §17.7 transition path. Legacy JSONL write at `_sessions/<date>/<filename>.jsonl` is byte-identical to before (existing analyzers untouched). New OTel-format span lines land at `<storage>/traces/<session-id>.jsonl` where `<storage>` is resolved via `resolveStoragePath()` honoring scaffold-time pin (preserves (g.5) AppData redirect on Windows+OneDrive). Session id resolves via a four-step chain: explicit option → `CLAUDE_CODE_SESSION_ID` (Claude Code's native env var per Probe 2) → `CODEX_THREAD_ID` (Codex Desktop, observed `019e6287-...` shape per RC Turn evt-c97d empirical confirmation) → sentinel `no-session-context`. New exports: `resolveStoragePath`, `resolveSessionId`, `traceLogPath`, `eventToOtelSpan`, `SCHEMA_VERSION` (semver `1.0.0`). Schema version on every emitted span per Anvil A8.
- Cross-environment empirical validation: Mac (HK) + Windows R11 (RM probe runs). 41 unit tests across `metrics-init.mjs` and `log-event.mjs` cover mode coverage, UTF-16LE fixture handling, false-positive guard, cross-phase integration invariant ("dual-write traces land in pinned location, NOT in project"), and the four-step session-id resolution chain.
- `skills/finalize/SKILL.md` — Step 3 hygiene pass gains a `demote-state-narrative` bullet positioned after `compact-project.mjs`, with the v1 dry-run-default discipline named explicitly and the flip-to-apply gate documented.

### Notes
- v2.5.0 bundles two threads of DC-85 follow-through work that landed end-to-end this release: **T1 Phase 1+2 of the metrics & observability v1 work** per spec `docs/specs/2026-05-25-metrics-and-observability-spec.md` (post-synthesis design, §17.12 v1 scope), and **Phase 1c of the memory architecture redesign** per DC-93 (Phase 1a + 1b already shipped in v2.3.0). T2 (SessionStart/Stop/SessionEnd hooks per WR-1/WR-2/WR-3 + RL-1/RL-3) and T3 (augmentation-event correlation per AS group) are upstream future work; the storage substrate ships first because every later layer depends on it.
- Five collab-recorded design corrections empirically caught during the 30-fire metrics collab — captured in `obs-20260526-pseudo-code-discipline-before-lock` for graduation review.
- Phase 1c first-fire dry-run on CORE PROJECT.md returned `0 demoted, 15 kept` as expected — CORE's §State backing units are all `status: active` (decisions are durable architectural artifacts on this corpus). The deeper criteria-vs-corpus mismatch finding — that the demote-* terminal-status set doesn't align with the actually-used `active` / `retired` vocabulary in CORE's 233-unit corpus — is captured in `obs-20260527-demote-terminal-status-corpus-mismatch` for follow-up alignment of both `demote-moves` and `demote-state-narrative`.

## [2.4.1] — 2026-05-26

### Changed
- `skills/core/protocols/startup.md` — "Compose the readiness summary" section now opens with a "Before composing — view memory" paragraph instructing the agent to re-check the auto-memory it loaded earlier (especially cross-project feedback memories) before writing the first turn. Closes a recognition-failure mode where memory was loaded but not consulted at composition time. Mirrors Anthropic's memory-tool system prompt ("always view your memory directory before doing anything else"). This is Phase 0(b) of the DC-94 measurement window running through 2026-05-31.

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
