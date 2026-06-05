---
name: finalize
description: Session closing skill — reconcile state, write the session summary, render PROJECT.md from units, run memory hygiene
user-invocable: true
---

# `/finalize`

You're closing the session. Project state has been updating continuously — observations get written as the user talks, units get graduated as patterns emerge, PROJECT.md sections re-render when something meaningful changes. Finalize is where you verify everything's coherent, run the hygiene pass, write the human-readable summary, and leave a clean state for the next bootstrap.

Execute every step in order. Don't skip.

**Script path resolution.** This file writes script invocations as `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs` for readability, but **`${CLAUDE_PLUGIN_ROOT}` is not reliably injected into agent Bash tool calls** (the same constraint `protocols/startup.md` documents — it's why startup resolves the root from the skill base directory, not the env var). So resolve the concrete root once, the same way on every harness: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/finalize/SKILL.md` — that prefix is your plugin root. Substitute it for `${CLAUDE_PLUGIN_ROOT}` in every command below (Claude Code marketplace: `.../plugins/core`; Codex plugin cache: `~/.codex/plugins/cache/<marketplace>/core/<version>`). Reuse the `CORE_ROOT` value startup already resolved this session if you have it. **Guard discipline:** if you cannot resolve a concrete root, skip the affected script step and surface the skip in plain voice — never run `node` against a guessed or empty base. Do not depend on the env var being present.

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

1. **Reconcile open observations.** Any unprocessed observation that's been referenced more than twice this session, or that captures a substantive cross-session-relevant claim, gets graduated to a unit per `protocols/data-storage.md` §"Graduation — observation → unit" (where the triggers and seven-step process live; `hygiene.md` only surfaces candidates). Anti-miss bias: when in doubt, write the unit.

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

- **Demote closed §Moves bullets (DC-85 Phase 1b).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/demote-moves.mjs <project>` before `compact-project.mjs`. Auto-applies. A completed `[x]` bullet is **done** — it moves to `PROJECT-ARCHIVE.md §Moves` (date-stamped subsection, one-line stub left behind) on **checkbox + age**, not on its cited units' status. Age comes from the most-recent non-future date in the bullet text (the completion proxy — citation `(…)`, backtick, wikilink, and obs-id dates are stripped first), falling back to cited-unit dates only when the bullet carries no date. Kept when no age is provable (`no-age-signal`) or age < 30 days (`too-recent`); already-archived stubs are never re-demoted (`already-stubbed`). `--strict` restores the old conservative gate (require all cited units terminal). A large first batch (≥20) is **held** — nothing written, candidates surfaced — until you re-run with `--apply-large-batch`, so a bulk migration of PROJECT.md gets a look. Event emission to `_sessions/<date>/hygiene-log.jsonl` (`kind: demote-moves`). Narrate "demoted N items" only if N > 0; if a batch is held, say so and surface the count.
- **Tighten PROJECT.md to soft target (DC-85 Phase 1b).** After demote-moves, run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs <project>` to compact §Decisions stubs. Emits `compact-project` event with section-size breakdown; if still over the 70KB soft target, emits `project-md-over-cap` and a stderr warning. The agent narrates the warning in plain voice; §State narrative demotion (Phase 1c, below) handles the §State half of what compact-project + demote-moves leave behind.
- **Demote stale §State narrative (DC-85 Phase 1c).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/demote-state-narrative.mjs <project>` after `compact-project.mjs`. **Default is dry-run in v1** — surfaces a candidate list to stdout and a `demote-state` event to hygiene-log.jsonl without writing. A §State bullet is a demote candidate only when it carries a strict `*Backed by ...*` footer, ALL cited units are in terminal status (`resolved`/`archived`/`superseded`/`closed` — mirrors `demote-moves` for cross-script symmetry), AND the most-recent backing-unit `updated:` date is >60 days old. Conservative defaults match `demote-moves` — no citation, missing unit, or any-active-unit → keep. Older citation styles (`*DC-XX.*` shorthand) fall into no-citation by design per DC-93 §3. Pass `--apply` only when a §State-heavy non-CORE corpus has been exercised and produces clean candidate lists for multiple sessions; flip the default in a tracked decision then. Narrate "would demote N items" only if N > 0; surface large-batch warnings (>20 candidates) in plain voice.
- **Cloud-sync ghost cleanup** — macOS sync engines (iCloud, OneDrive, Dropbox) leave `<filename> 2.md` duplicates when they detect concurrent-write conflicts. Most settle as exact duplicates with identical content but pollute validator output. Walk `<project>/_memories/` for any `* 2.md` file, verify it's identical to its un-suffixed original via `diff -q`, and delete the ghost if so. Surface to the user if any ghost differs from its original (rare; means a real divergence the sync engine preserved). Narrate "Cleaned N ghost duplicates" only if N > 0.
- **Archive proposals** — surface low-priority candidates (R·S < 0.05, no recent reference) for `y / N / per-unit` approval. User-authored units always gate here.
- **Retire confirmations** — any unit whose claim disappeared from PROJECT.md this session gets `status: retired`.
- **Cold-store proposals** — surface any archived-and-retired-and-365d+ units.
- **Unit-store validation (schema + integrity).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs --store <project> --mode all`. (`--mode all` runs both checks; `--schema --integrity` now does too, since the flags are additive — but `--mode all` states the intent plainly rather than relying on it.) `/finalize` is the primary scheduled hygiene event, so it carries the validator rather than leaving schema/integrity checks only to `/process-memory` — a project that runs only `/finalize` would otherwise never see a frontmatter, enum, or edge problem (the disjoint-surface gap surfaced by the local-llm-build field report, 2026-06-03). Exit tiers: **0** pass-with-benign-warnings (`orphan`/`stale`/`external-ref` — cross-store and citation refs are expected, not breaks), **1** degraded (a real `dangling-edge`, `edge-unknown-type`, or other non-benign warning — surface it in plain voice; non-blocking), **2** hard fail (schema/enum/required-field — fix before closing). `edge-unknown-type` has no auto-fix (the safe-fix list covers only the inverse-duplicate types) — surface it as a relabel candidate, don't silently leave it. A `--schema`-only fast path is acceptable when the session didn't touch the store structurally.
- **Index regeneration** — re-run if you see drift from Step 2; also run for any unit types changed this session.
- **File-cap check** — if any synthesis file is over the Read-tool threshold, follow the graduation pattern in `protocols/hygiene.md`.
- **Continuous self-evaluation** — review session-level signals (under-recall, over-recall, voice drift, smuggled architecture); write the retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`.
- **Retrieval-quality surfacing** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project>` and narrate top anomalies in plain voice. Same shape `/process-memory` uses. If the project has no `_sessions/*/retrieval-log.jsonl` yet, say so in one sentence; don't pretend the corpus exists.
- **Retrieval-skip surfacing (transcript-based, v2.9)** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-skip.mjs <project>`. Complements the log-based scan above by reading the session transcript directly, so it works with no retrieval log. It flags the recognition-failure signature — a memory-dependent turn answered without reaching `_memories/` first. These are **candidates, not verdicts** (term presence is a heuristic). On `SKIPS-FOUND`, name the term(s) as an honest self-audit in one line; `CLEAN` → a sentence or silence; `UNKNOWN` on Codex is expected (tool extraction pending) — say so, don't read it as clean. This is the behavioral consumer of the `read-transcript` helper (a self-dispatching script, not a `harness.md` contract verb).
- **Memory-boundary audit (v3.0)** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/audit-memory-boundary.mjs <project>`. Read-only, sampled: surfaces native-memory facts (MEMORY.md / `~/.codex/memories`) not represented in the CORE store. **Candidates, never auto-promote** — a native-only entry may be a user-deleted fact (anti-resurrection, DC-83). Name any candidates as graduation prompts in plain voice and let the normal graduation path decide; `0 native-only` → a sentence or silence. Not a gate; conflict detection deferred.
- **Capability drift surfacing (v2.7)** — run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-capability-drift.mjs <project>`. It reads the per-session `~/.core/workspaces/<id>/capability-history.jsonl` (appended each session at startup by `record-capability-snapshot.mjs`), renders `<project>/_memories/_capability-drift-log.md`, and reports degrading drift + regressions. Narrate only what's actionable in plain voice — a capability that slipped PASS→DEGRADED, or one that stopped reporting between sessions. If there's no history yet (fresh workspace), say so in one sentence; don't invent drift. Healing-direction changes are informational — don't lead with them.
- **Source-pull monitoring** — when `<project>/_sources/` exists, run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-source-pull-log.mjs --workspace <id>` against the workspace id from `workspace.json` (not the project path). The analyzer reads `~/.core/workspaces/<id>/source-pull-log.jsonl` and aggregates the last 14 days. Surface only the signals worth acting on, in plain voice: a registered source with no pulls in window (the orchestration skill stopped firing for it), a source whose error count climbed this session, or a source showing Mode-C distribution above ~30% (the extractor is producing more judgment-needed observations than usual). If the log file doesn't exist yet ("No source-pull events in window"), say so in one sentence — common on a fresh workspace before the installation's orchestration skill has run. Skip the whole bullet when `<project>/_sources/` is absent.

- **Metrics interpretation pass (Layer 2/3 — the recognition feedback loop).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/classify-turns.mjs <project>` then `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/metrics-rollup.mjs <project>`. The classifier reads this session's transcript and labels each turn with one of the six recognition states (the headline is `rec-fail-tier-0` — the answer was in context and the agent asked anyway); the rollup aggregates the day and writes the one-line signal `/orient` reads next session. Then run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/metrics-detectors.mjs <project>` — three detectors run: **citation-resolver** flags any `DC-XX`/`R-XX`/`[[unit]]` the agent cited that doesn't resolve to a real unit; **stale-context** flags units the agent read via tool calls that haven't been updated in >30 days and aren't marked final/stable; **anticipation-gap** (PROVISIONAL — a filename-token heuristic, uncalibrated) flags turns where the user introduced a distinctive project term the agent hadn't surfaced first. Treat anticipation-gap as a self-audit prompt, never a graded signal — it over-fires on command-injection turns and generic vocabulary; name it only if a flagged term looks like a genuine miss, otherwise stay silent. Surface citation/stale findings in plain voice; `clean` on each → a sentence or silence. All passes are capture-gated (default-on per DC-107; opt out via `CORE_METRICS_ENABLED=0` or `workspace.json` `metrics_enabled: false`) — on a workspace that has opted out they print `DISABLED` and write nothing; say so once and move on. **The classifier output is PROVISIONAL** — the heuristics aren't calibrated to >0.7 precision yet (Phase 3), so narrate the rollup's headline as a self-audit signal, never as a graded metric. If the transcript is unavailable (`UNAVAILABLE`) or there are no classified turns, say so in one sentence; don't invent a distribution. Capture (the transcript) is the ground truth; this interpretation is replayable when the heuristics improve.
- **Validity-dimension stamp + impact pass (storage-side metrics).** Three operations over the world-time validity dimension — a hygiene write, a query readout, and an impact trace — all on the project's own corpus:
  1. `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/bitemporal.mjs <project> --stamp` — **dry-run first.** Lists the `t_invalid` stamps a supersedes-edge would set this session and the **loose supersedes edges** (a supersedes edge pointing at a still-active target — a mis-typed edge or a status-hygiene gap). The writer is conservative (only targets whose status is already terminal, never an active unit, never overwriting an explicit value, earliest superseder wins), but `t_invalid` is a write to historical units, so **eyeball the stamps before applying** — a semantically-wrong supersedes edge whose target happens to be retired would otherwise stamp a wrong `t_invalid` unattended. If the stamps look right, re-run with `--apply`. Name the loose edges in plain voice as fix candidates. (This dry-run-first discipline is deliberate: it's what caught a near-miss on a foundational unit when the validity dimension was built — see DC-106.)
  2. `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/bitemporal.mjs <project> --metrics` — the storage-health readout (churn rate, invalidated count, validity-interval distribution, loose-edge count). This is the storage half of "is the memory architecture effective," next to the retrieval half the recognition loop captures. Surface only what's actionable.
  3. `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/impact-trace.mjs <project> --superseded-impact` — for any unit invalidated this session, what still depends on it (review candidates the supersession created). `clean` → silence.
  Privacy-gated like the rest; on a workspace that hasn't opted in, the metrics/detector passes print `DISABLED` — the validity-stamp pass still runs (it's storage hygiene, not capture), but say so once if metrics are off.
- **Calibration readiness check (Phase 3 gate).** Run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/calibrate-classifier.mjs <project> --check`. This prints whether the classifier has cleared the gate that lifts the PROVISIONAL tag from rollup output — the 0.7-precision bar **and** per-class coverage (every recognition state present in the gold labels must be measured, not just the ones the heuristic happens to predict) — plus how many turns are in the labeling pool and how many labeled turns exist. When `pool_size >= 100` and the state is still provisional, surface that as a one-liner: *"Calibration pool ready — run `--export-worksheet` to generate the labeling worksheet."* When calibrated, say so and nothing more. The script is the precision gate; the DM orchestrates the labeling pass via `analysis.md` when enough real turns have accumulated. Skip if the workspace hasn't opted in (prints `metrics disabled`).
- **Plugin orphan check (dev-meta; definition-of-done enforcement)** — when this session edited the plugin tree itself (a new `scripts/*.mjs` or a `protocols/*.md`), run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/orphan-detector.mjs`. It flags any script no skill/protocol/descriptor reaches and any protocol missing from the SKILL.md index — the "built but never wired" debt that recurs (`metrics-init` and `adversarial-run-gate` were both caught this way; the orphaned `clusters.md` protocol was retired rather than wired). Exit 1 = a new orphan: wire it AND assert the wiring in a test, or add it to the detector's `ALLOWLIST` with a reason if it's deliberately-staged forward-wiring. Allowlisted items still print every run so they stay visible. Skip on projects where you didn't touch the plugin (running it against an unmodified install is always clean).

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

**Write the visibility canary (v3.0 memory-visible-in-agent-context).** After the MEMORY.md refresh above, write a fresh per-session canary so the *next* session can prove memory was actually injected into context — not merely present on disk:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/write-visibility-canary.mjs" --workspace-id <id> 2>/dev/null || true
```

This idempotently replaces a single tagged `CORE-VISIBILITY-CANARY` line at the top of MEMORY.md (inside the injection window) and records the expected token to `~/.core/workspaces/<id>/visibility-canary.json`. Next session's startup echoes the token and `capability/memory-visible-probe.mjs` verifies the echo preceded any read of the canary surfaces. Fail-open — never block close on it.

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
