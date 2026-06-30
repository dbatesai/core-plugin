---
name: finalize
description: Session closing skill — reconcile state, write the session summary, render PROJECT.md from units, run memory hygiene
user-invocable: true
---

# `/finalize`

You're closing the session. Project state has been updating continuously — observations get written as the user talks, units get graduated as patterns emerge, PROJECT.md sections re-render when something meaningful changes. Finalize is where you verify everything's coherent, run the hygiene pass, write the human-readable summary, and leave a clean state for the next bootstrap.

Execute every step in order. Don't skip.

**Script path resolution.** Commands below invoke scripts as `${CORE_ROOT}/skills/core/scripts/<script>.mjs`, where `CORE_ROOT` is the resolved plugin root — the same variable name `protocols/startup.md` and `protocols/validation.md` use. **`${CLAUDE_PLUGIN_ROOT}` is not reliably injected into agent Bash tool calls** (the same constraint `protocols/startup.md` documents — it's why startup resolves the root from the skill base directory, not the env var). So resolve `CORE_ROOT` once, the same way on every harness: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/finalize/SKILL.md` — that prefix is your plugin root (Claude Code marketplace: `.../plugins/core`; Codex plugin cache: `~/.codex/plugins/cache/<marketplace>/core/<version>`). Reuse the `CORE_ROOT` value startup already resolved this session if you have it. **Guard discipline:** if you cannot resolve a concrete root, skip the affected script step and surface the skip in plain voice — never run `node` against a guessed or empty base. Do not depend on the env var being present.

---

## Mode, incremental discharge, and the reliability spine (spec 2026-06-29)

Finalize runs two ways. **Interactive** — the user typed `/finalize`. **Headless** — `CORE_CLOSE_HEADLESS=1` is set (the SessionEnd close hook spawned you with `claude -p "/finalize"`; `close-pass-hook.mjs`). The work is the same; what differs is that headless can't show a draft or wait for an accept, so it defers anything that needs a human (§Step 2 render-and-accept) to the next startup's incremental gate.

**Discharge is incremental in both modes.** Don't re-run every step unconditionally. Consult the per-op close marker and the DC-110 cadence ledger, run only what's *owed*, skip what's already current. The reliability spine is `close-pass.mjs` (spec §8), which gives a single-flight lock (no two close agents racing the same store), a per-op completion marker (a partial close is detected, not trusted), and three-state startup detection. Use it as the frame around the whole pass:

```bash
# Begin: acquire the lock + write the in-progress marker enumerating owed ops.
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs begin <project> --session <session-id> \
  --ops maintenance-run,render-project-md,hot-section,demote-moves,compact-project,demote-state,check-units,reflection-a,reflection-b,metrics,summary-stub,memory-refresh
# (if it prints "lock held; another close is running" — STOP; a close is already in flight)

# After each op completes, record it (this is what makes a crashed close recoverable):
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs record <project> --op <op> --status done

# At the very end, after every owed op:
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs finish <project> --session <session-id>
```

`begin` refusing the lock is not an error — it means another close (a startup catch-up, or a second exit hook) holds it; stop silently. An op you legitimately skip as not-owed gets `--status skipped`; a failure gets `--status failed --note "..."` so startup re-owes it.

**The control-surface rule — every PROJECT.md write is edit-gated (spec §7).** Before any render (Step 2.4), hot-section (Step 2.6), or §Moves/§State mutation (Steps 3.1–3.3), run edit-detection against `~/.core/state-cache.json` exactly as `startup.md §"Load — returning workspace"` defines it. If the user edited PROJECT.md (outside the hot block) since CORE last wrote it, the user's edit wins: propagate it back to source units, fire anti-resurrection for removals, and do NOT clobber it with a fresh render this pass. A render only proceeds when edit-detection clears. This is non-negotiable in headless mode — there's no human to catch a bad overwrite.

**Kill switch.** `CORE_AUTO_CLOSE=0` halts auto-discharge (it gates the hook before you're ever spawned). It also covers any in-session autonomous maintenance — if it's set, don't run the EDIT-GATED writers unattended; surface what's owed and let the next interactive close handle it.

**The two reflection tasks are the heart of the close (spec §5), not ceremony.** They replace the old scattered fresh-eyes/self-eval/summary steps:

- **Reflection Task A — Resynthesis (every substantive close).** Re-read the session and distill what it actually decided, concluded, or changed — separated from the meander and the paths not taken. Then ensure each is captured: graduate the units that didn't get written in-flight (Step 2.1), update PROJECT.md (edit-gated), write the resume stub (Step 4). The deterministic completeness check (every explicit request → a task or unit; every decision named in the transcript → a written unit; the citation-resolver / anticipation-gap detectors in Step 3.13) is the *floor* of this task — the mechanical guarantee under the synthesis, not a substitute for it. Record op `reflection-a`.
- **Reflection Task B — Perspective pass (when the session produced decisions/conclusions).** Turn the right critical perspective on what the session concluded, before it hardens: did we converge too fast (R-3)? did a decision get smuggled without being surfaced (R-DM-SMUGGLING)? is a conclusion overconfident or self-serving (R-1)? does anything contradict a prior decision? Load the relevant prior decision units to apply cross-time perspective. This is CORE's "challenge overconfidence" turned on the session's *own* output — the check the in-session agent does poorly because it's too close to the work. Gated: run it when the session actually produced a decision or conclusion worth critiquing (a trivial session skips it); it MAY run every N closes rather than every close if the ledger cadence shows per-session is overkill. When Task B surfaces something real, it is **not** silently absorbed — leave it for the next startup to raise (write it as an open-question unit or a `_sessions/<date>/perspective-note.md`). Record op `reflection-b`.

In **headless** mode you run both reflection tasks and all EDIT-GATED writers *only where edit-detection clears*; a materially-changed §State/§Moves render that would need a human accept (Step 2.5) is written but flagged for the next startup's incremental accept gate rather than declared canonical. In **interactive** mode the human is present, so Step 2.5 runs live.

---

## Step 1 — Session reflection (Tasks A + B)

This is Reflection Task A + Task B from the Mode section above — the heart of the close, not a checklist. Re-read the session from the top against the user's stated intent, goal, and measure of success. Ask:

- What did we actually accomplish vs. what we set out to do?
- What decisions were made? Are they captured as units?
- Did changes in direction during the session cause anything important to slip?
- What was left incomplete? Is it tracked as a unit or in §Moves?
- What surprised us? What did we learn that wasn't expected?
- Did anything break or degrade that we didn't fix?
- Is the project better than we found it?

Task A (resynthesis) distills what the session concluded and ensures each conclusion is captured (graduation in Step 2.1, the resume stub in Step 4). Task B (perspective, when the session produced decisions/conclusions) turns the R-1/R-3/smuggling lens on the session's own output and leaves anything real for the next startup to raise. Write a one-paragraph honest assessment; it feeds the resume stub and, on demand, the full narrative. Record ops `reflection-a` and (when run) `reflection-b` via `close-pass.mjs record`.

---

## Step 2 — Reconcile units, render PROJECT.md

Project state has been updating continuously. Finalize is when you verify the render is current and the units that drive it are complete.

1. **Reconcile open observations.** Any unprocessed observation that's been referenced more than twice this session, or that captures a substantive cross-session-relevant claim, gets graduated to a unit per `protocols/data-storage.md` §"Graduation — observation → unit" (where the triggers and seven-step process live; `hygiene.md` only surfaces candidates). Anti-miss bias: when in doubt, write the unit.

2. **Update touched units.** For every unit you wrote to during the session, verify frontmatter — `updated:` timestamp, `last_accessed:`, `access_count:`, edges. Make sure inverse edges are set on `supersedes` / `depends-on` / `conflicts-with`.

3. **Run mechanical maintenance (DC-110).** Run the consolidated mechanical pass — it regenerates both indexes + the summary index, cleans cloud-sync ghost duplicates, and checks the PROJECT.md cap, all signature-gated (cheap on an unchanged store) and recorded in the cadence ledger:

   ```bash
   node ${CORE_ROOT}/skills/core/scripts/maintenance-run.mjs <project>
   ```

   Ships with the plugin per DC-77. Surface its one-line narration to the user (it's never silent — visible-continuous-curation). Heavier hygiene ops (demote-moves, compaction, validation) stay in their own steps below; this consolidates the cheap deterministic regen/cleanup that used to be separate `generate-*-index.mjs` calls.

4. **Render PROJECT.md from units.** Walk canonical units, compose the six sections (What & Why / State / People / Moves / Decisions & Risks / Notes), and show the user the draft. **Skip re-render when the user's PROJECT.md is curated and the new units are sparse backing-only.** Anti-resurrection cuts both ways — don't strip the user's curation just because the unit store is thin. If the existing PROJECT.md already reflects current truth and the new units add traceability without changing what the user sees, present the existing PROJECT.md for re-acceptance and note the choice; don't re-render from a sparse unit set.

5. **Render-and-accept — incremental gate (spec §7, kept not deleted).** The gate fires only when a render *materially changed* §State or §Moves (what the user actually reads); a silent pass otherwise — don't make the user re-accept an unchanged surface. When it fires: present the draft (or the preserved-existing PROJECT.md per the skip rule above). User accepts (Mode A continues) or edits (Mode B-ish — edits become ground truth, propagate back to units, anti-resurrection fires for removals). Write the accepted PROJECT.md to disk. **Headless mode:** no human to accept — write the render only where edit-detection cleared, and if §State/§Moves materially changed, leave a `render-pending-accept` flag (in `~/.core/workspaces/<id>/`) so the next startup surfaces the material change for the user's accept rather than declaring it canonical. Record op `render-project-md`.

6. **Refresh the hot section (DC-85 Phase 1a).** After the accepted PROJECT.md lands, refresh the hot tier atop it. This captures the new state the user just left — the session's actual outcome, not the state at session start. Steps:
   - Call `node ${CORE_ROOT}/skills/core/scripts/hot-section.mjs candidates <project> --top 12 --session-topic <topic1> --session-topic <topic2>...` with the session-intent topics from this session.
   - Compose 5-7 lines of plain prose blending priority candidates (stable structural heft) and session-level awareness (what closed, what's still open, what's next). Usually 1-3 items per spec §1.1; no bold-lead-in paragraphs unless they earn their weight.
   - Write the composed prose to `~/.core/workspaces/<id>/hot-section-draft.md` with the file-write tool (never as a bare `--text` shell argument — unit-derived prose carries quotes and backticks), then call `node ${CORE_ROOT}/skills/core/scripts/hot-section.mjs apply <project> --file ~/.core/workspaces/<id>/hot-section-draft.md` to land it.
   - Narrate the refresh in one sentence as part of the closing.
   - Skip when the session was trivial (no substantive work, no state changes) and the existing hot section still describes current truth. Don't refresh just to refresh.
   - Phase 1b enforces the 500-token cap programmatically; for Phase 1a, the agent self-disciplines on length.

---

## Step 3 — Memory hygiene pass

Walk the unit store and run the hygiene operations from `protocols/hygiene.md`, in the numbered order below.

**If a script fails — the recovery contract.** A non-zero exit from any sub-step gets narrated and skipped, not silently retried. Say which script failed and what it printed, then move to the next sub-step. Don't re-run a failed script without first re-running its preconditions — a step that depends on an earlier writer needs that writer's output on disk. Two specifics:

- `demote-moves.mjs` and `compact-project.mjs` write atomically — a non-zero exit means nothing landed, so it's safe to keep going past them.
- `bitemporal.mjs --stamp` writes to historical units. If the dry-run itself errors, do NOT run `--apply` this session — skip the whole validity-stamp sub-step (3.14) and name the skip in Step 6.

Sub-steps 3.1–3.7 change the store; 3.8 onward are read-and-report passes — except the validity stamp in 3.14, which is why it gets the dry-run rule above. A failure in a read-and-report pass costs visibility, not data. Every skipped or failed sub-step gets named in the Step 6 closing declaration.

### 3.1 Demote closed §Moves bullets (DC-85 Phase 1b)

Run `node ${CORE_ROOT}/skills/core/scripts/demote-moves.mjs <project>` before `compact-project.mjs`. Auto-applies. A completed `[x]` bullet is **done** — it moves to `PROJECT-ARCHIVE.md §Moves` (date-stamped subsection, one-line stub left behind) on **checkbox + age**, not on its cited units' status. Age comes from the most-recent non-future date in the bullet text (the completion proxy — citation `(…)`, backtick, wikilink, and obs-id dates are stripped first), falling back to cited-unit dates only when the bullet carries no date. Kept when no age is provable (`no-age-signal`) or age < 30 days (`too-recent`); already-archived stubs are never re-demoted (`already-stubbed`). `--strict` restores the old conservative gate (require all cited units terminal). A large first batch (≥20) is **held** — nothing written, candidates surfaced — until you re-run with `--apply-large-batch`, so a bulk migration of PROJECT.md gets a look. Event emission to `_sessions/<date>/hygiene-log.jsonl` (`kind: demote-moves`). Narrate "demoted N items" only if N > 0; if a batch is held, say so and surface the count.

*On failure:* atomic write — nothing landed. Narrate and continue to 3.2; PROJECT.md keeps its pre-run content.

### 3.2 Tighten PROJECT.md to soft target (DC-85 Phase 1b)

After demote-moves, run `node ${CORE_ROOT}/skills/core/scripts/compact-project.mjs <project>` to compact §Decisions stubs. Emits `compact-project` event with section-size breakdown; if still over the 70KB soft target, emits `project-md-over-cap` and a stderr warning. The agent narrates the warning in plain voice; §State narrative demotion (3.3, below) handles the §State half of what compact-project + demote-moves leave behind.

*On failure:* atomic write — nothing landed. Narrate and continue to 3.3.

### 3.3 Demote stale §State narrative (DC-85 Phase 1c)

Run `node ${CORE_ROOT}/skills/core/scripts/demote-state-narrative.mjs <project>` after `compact-project.mjs`. **Default is dry-run in v1** — surfaces a candidate list to stdout and a `demote-state` event to hygiene-log.jsonl without writing. A §State bullet is a demote candidate only when it carries a strict `*Backed by ...*` footer, ALL cited units are in terminal status (`resolved`/`archived`/`superseded`/`closed` — mirrors `demote-moves` for cross-script symmetry), AND the most-recent backing-unit `updated:` date is >60 days old. Conservative defaults match `demote-moves` — no citation, missing unit, or any-active-unit → keep. Older citation styles (`*DC-XX.*` shorthand) fall into no-citation by design per DC-93 §3. Pass `--apply` only when a §State-heavy non-CORE corpus has been exercised and produces clean candidate lists for multiple sessions; flip the default in a tracked decision then. Narrate "would demote N items" only if N > 0; surface large-batch warnings (>20 candidates) in plain voice.

*On failure:* dry-run by default, so a failure costs nothing. Narrate and continue.

### 3.4 Cloud-sync ghost cleanup — folded into `maintenance-run` (Step 2.3)

Verified-redundant with Step 2.3 (spec §10 delete). `maintenance-run.mjs` already walks `<project>/_memories/` for `* 2.md` ghosts, verifies byte-identity to the un-suffixed original, and removes only exact duplicates — the same content-verified-before-delete discipline. No separate ghost pass here. If `maintenance-run` surfaced a ghost that *differs* from its original (a real sync-preserved divergence), surface it to the user; never delete an unverified ghost.

### 3.5 Lifecycle proposals — archive, retire, cold-store

- **Archive proposals** — surface low-priority candidates (R·S < 0.05, no recent reference) for `y / N / per-unit` approval. User-authored units always gate here.
- **Retire confirmations** — any unit whose claim disappeared from PROJECT.md this session gets `status: retired`.
- **Cold-store proposals** — surface any archived-and-retired-and-365d+ units.

*On failure:* these are conversational proposals, not scripts — nothing to recover.

### 3.6 Unit-store validation (schema + integrity)

Run `node ${CORE_ROOT}/skills/core/scripts/check-units.mjs --store <project> --mode all`. (`--mode all` runs both checks; `--schema --integrity` now does too, since the flags are additive — but `--mode all` states the intent plainly rather than relying on it.) `/finalize` is the primary scheduled hygiene event, so it carries the validator rather than leaving schema/integrity checks only to `/process-memory` — a project that runs only `/finalize` would otherwise never see a frontmatter, enum, or edge problem (the disjoint-surface gap surfaced by the local-llm-build field report, 2026-06-03). Exit tiers: **0** pass-with-benign-warnings (`orphan`/`stale`/`external-ref` — cross-store and citation refs are expected, not breaks), **1** degraded (a real `dangling-edge`, `edge-unknown-type`, or other non-benign warning — surface it in plain voice; non-blocking), **2** hard fail (schema/enum/required-field — fix before closing). `edge-unknown-type` has no auto-fix (the safe-fix list covers only the inverse-duplicate types) — surface it as a relabel candidate, don't silently leave it. A `--schema`-only fast path is acceptable when the session didn't touch the store structurally.

*On failure:* exit 2 is the one blocking tier in this whole pass — fix before closing. If the validator itself crashes (no tier output), narrate and continue, and don't claim the store validated in Step 6.

### 3.7 Index regeneration — folded into `maintenance-run` (Step 2.3)

Verified-redundant with Step 2.3 (spec §10 delete). `maintenance-run.mjs` regenerates both indexes + the summary index, signature-gated, whenever the unit set changed this session. No separate regen here. Only fall back to a manual `generate-*-index.mjs` if Step 2.3 was skipped (unresolved `CORE_ROOT`) — name the skip.

### 3.8 File-cap check

Check `IMPROVEMENT_LOG.md` by name first — a generic "any synthesis file" sweep misses it reliably:

```bash
wc -c "<project>/IMPROVEMENT_LOG.md"
```

If it's over ~66KB, act now: IMPROVEMENT_LOG has a count-based rotation pattern (DC-42) that waits for `/finalize` discretion — `/process-memory` only surfaces the recommendation, and this is the step where the discretion actually runs. Propose the rotation to the user; don't carry the recommendation forward another session. Skip silently when the project has no `IMPROVEMENT_LOG.md`.

Then the general sweep: if any other synthesis file is over the Read-tool threshold, follow the graduation pattern in `protocols/hygiene.md`.

*On failure:* nothing to recover — this is a read-only size check.

### 3.9 Continuous self-evaluation

Review session-level signals (under-recall, over-recall, voice drift, smuggled architecture); write the retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`.

*On failure:* if the write fails, include the retrospective content in the session summary instead — don't lose it.

### 3.10 Retrieval quality — log scan + transcript scan

- **Retrieval-quality surfacing** — run `node ${CORE_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project>` and narrate top anomalies in plain voice. Same shape `/process-memory` uses. If the project has no `_sessions/*/retrieval-log.jsonl` yet, say so in one sentence; don't pretend the corpus exists.
- **Retrieval-skip surfacing (transcript-based, v2.9)** — run `node ${CORE_ROOT}/skills/core/scripts/analyze-retrieval-skip.mjs <project>`. Complements the log-based scan above by reading the session transcript directly, so it works with no retrieval log. It flags the recognition-failure signature — a memory-dependent turn answered without reaching `_memories/` first. These are **candidates, not verdicts** (term presence is a heuristic). On `SKIPS-FOUND`, name the term(s) as an honest self-audit in one line; `CLEAN` → a sentence or silence; `UNKNOWN` on Codex is expected (tool extraction pending) — say so, don't read it as clean. This is the behavioral consumer of the `read-transcript` helper (a self-dispatching script, not a `harness.md` contract verb).

*On failure:* read-and-report — narrate and continue. A missing log or transcript is a one-sentence honest statement, not an error.

### 3.11 Memory-boundary audit (v3.0)

Run `node ${CORE_ROOT}/skills/core/scripts/audit-memory-boundary.mjs <project>`. Read-only, sampled: surfaces native-memory facts (MEMORY.md / `~/.codex/memories`) not represented in the CORE store. **Candidates, never auto-promote** — a native-only entry may be a user-deleted fact (anti-resurrection, DC-83). Name any candidates as graduation prompts in plain voice and let the normal graduation path decide; `0 native-only` → a sentence or silence. Not a gate; conflict detection deferred.

*On failure:* read-only — narrate and continue.

### 3.12 Capability drift + source-pull monitoring

- **Capability drift surfacing (v2.7)** — run `node ${CORE_ROOT}/skills/core/scripts/analyze-capability-drift.mjs <project>`. It reads the per-session `~/.core/workspaces/<id>/capability-history.jsonl` (appended each session at startup by `record-capability-snapshot.mjs`), renders `<project>/_memories/_capability-drift-log.md`, and reports degrading drift + regressions. Narrate only what's actionable in plain voice — a capability that slipped PASS→DEGRADED, or one that stopped reporting between sessions. If there's no history yet (fresh workspace), say so in one sentence; don't invent drift. Healing-direction changes are informational — don't lead with them.
- **Source-pull monitoring** — when `<project>/_sources/` exists, run `node ${CORE_ROOT}/skills/core/scripts/analyze-source-pull-log.mjs --workspace <id>` against the workspace id from `workspace.json` (not the project path). The analyzer reads `~/.core/workspaces/<id>/source-pull-log.jsonl` and aggregates the last 14 days. Surface only the signals worth acting on, in plain voice: a registered source with no pulls in window (the orchestration skill stopped firing for it), a source whose error count climbed this session, or a source showing Mode-C distribution above ~30% (the extractor is producing more judgment-needed observations than usual). If the log file doesn't exist yet ("No source-pull events in window"), say so in one sentence — common on a fresh workspace before the installation's orchestration skill has run. Skip the whole bullet when `<project>/_sources/` is absent.

*On failure:* read-and-report — narrate and continue.

### 3.13 Metrics interpretation pass (Layer 2/3 — the recognition feedback loop)

Run `node ${CORE_ROOT}/skills/core/scripts/classify-turns.mjs <project>` then `node ${CORE_ROOT}/skills/core/scripts/metrics-rollup.mjs <project>`. The classifier reads this session's transcript and labels each turn with one of the six recognition states (the headline is `rec-fail-tier-0` — the answer was in context and the agent asked anyway); the rollup aggregates the day and writes the one-line signal the next session's startup reads. Then run `node ${CORE_ROOT}/skills/core/scripts/metrics-detectors.mjs <project>` — three detectors run: **citation-resolver** flags any `DC-XX`/`R-XX`/`[[unit]]` the agent cited that doesn't resolve to a real unit; **stale-context** flags units the agent read via tool calls that haven't been updated in >30 days and aren't marked final/stable; **anticipation-gap** (PROVISIONAL — a filename-token heuristic, uncalibrated) flags turns where the user introduced a distinctive project term the agent hadn't surfaced first. Treat anticipation-gap as a self-audit prompt, never a graded signal — it over-fires on command-injection turns and generic vocabulary; name it only if a flagged term looks like a genuine miss, otherwise stay silent. Surface citation/stale findings in plain voice; `clean` on each → a sentence or silence. All passes are capture-gated (default-on per DC-107; opt out via `CORE_METRICS_ENABLED=0` or `workspace.json` `metrics_enabled: false`) — on a workspace that has opted out they print `DISABLED` and write nothing; say so once and move on. **The classifier output is PROVISIONAL** — the heuristics aren't calibrated to >0.7 precision yet (Phase 3), so narrate the rollup's headline as a self-audit signal, never as a graded metric. If the transcript is unavailable (`UNAVAILABLE`) or there are no classified turns, say so in one sentence; don't invent a distribution. Capture (the transcript) is the ground truth; this interpretation is replayable when the heuristics improve.

*On failure:* interpretation only — capture is the ground truth and the pass is replayable later. Narrate and continue.

### 3.14 Validity-dimension stamp + impact pass (storage-side metrics)

Three operations over the world-time validity dimension — a hygiene write, a query readout, and an impact trace — all on the project's own corpus:

1. `node ${CORE_ROOT}/skills/core/scripts/bitemporal.mjs <project> --stamp` — **dry-run first.** Lists the `t_invalid` stamps a supersedes-edge would set this session and the **loose supersedes edges** (a supersedes edge pointing at a still-active target — a mis-typed edge or a status-hygiene gap). The writer is conservative (only targets whose status is already terminal, never an active unit, never overwriting an explicit value, earliest superseder wins), but `t_invalid` is a write to historical units, so **eyeball the stamps before applying** — a semantically-wrong supersedes edge whose target happens to be retired would otherwise stamp a wrong `t_invalid` unattended. If the stamps look right, re-run with `--apply`. Name the loose edges in plain voice as fix candidates. (This dry-run-first discipline is deliberate: it's what caught a near-miss on a foundational unit when the validity dimension was built — see DC-106.)
2. `node ${CORE_ROOT}/skills/core/scripts/bitemporal.mjs <project> --metrics` — the storage-health readout (churn rate, invalidated count, validity-interval distribution, loose-edge count). This is the storage half of "is the memory architecture effective," next to the retrieval half the recognition loop captures. Surface only what's actionable.
3. `node ${CORE_ROOT}/skills/core/scripts/impact-trace.mjs <project> --superseded-impact` — for any unit invalidated this session, what still depends on it (review candidates the supersession created). `clean` → silence.

Privacy-gated like the rest; on a workspace that has opted out, the metrics/detector passes print `DISABLED` — the validity-stamp pass still runs (it's storage hygiene, not capture), but say so once if metrics are off.

*On failure:* per the recovery contract — if the `--stamp` dry-run errors, do NOT run `--apply`; skip the sub-step and name the skip in Step 6. A `--metrics` or `impact-trace` failure is read-only; narrate and continue.

### 3.15 Calibration readiness check (Phase 3 gate)

Run `node ${CORE_ROOT}/skills/core/scripts/calibrate-classifier.mjs <project> --check`. This prints whether the classifier has cleared the gate that lifts the PROVISIONAL tag from rollup output — the 0.7-precision bar **and** per-class coverage (every recognition state present in the gold labels must be measured, not just the ones the heuristic happens to predict) — plus how many turns are in the labeling pool and how many labeled turns exist. When `pool_size >= 100` and the state is still provisional, surface that as a one-liner: *"Calibration pool ready — run `--export-worksheet` to generate the labeling worksheet."* When calibrated, say so and nothing more. The script is the precision gate; the DM orchestrates the labeling pass via `analysis.md` when enough real turns have accumulated. On a single-user install the default 100-turn pool fills slowly — **PROVISIONAL is the expected steady state there, not a failure**; report it once, don't nag. A workspace that wants the gate reachable sooner can set `calibration_min_labeled` in `workspace.json` (floor 30 — below that, six-state precision estimates are noise). Revisit the default when the pool clears 100 or the install grows beyond a single user. Skip if the workspace has opted out (prints `metrics disabled`).

*On failure:* read-only — narrate and continue.

### 3.16 Plugin orphan check (dev-meta; definition-of-done enforcement)

When this session edited the plugin tree itself (a new `scripts/*.mjs` or a `protocols/*.md`), run `node ${CORE_ROOT}/skills/core/scripts/orphan-detector.mjs`. It flags any script no skill/protocol/descriptor reaches and any protocol missing from the SKILL.md index — the "built but never wired" debt that recurs (`metrics-init` and `adversarial-run-gate` were both caught this way; the orphaned `clusters.md` protocol was retired rather than wired). Exit 1 = a new orphan: wire it AND assert the wiring in a test, or add it to the detector's `ALLOWLIST` with a reason if it's deliberately-staged forward-wiring. Allowlisted items still print every run so they stay visible. Skip on projects where you didn't touch the plugin (running it against an unmodified install is always clean).

*On failure:* dev-meta only — narrate and continue; it never blocks a user project's close.

The deeper sub-protocols (edge-integrity sweep, session-log auto-prune) live in `references/hygiene-strategies.md`.

---

## Step 4 — Resume stub + on-demand narrative (spec §6)

The old unconditional full-narrative summary is dropped — git is the corruption backup (lossy prose can't rebuild units anyway), and the durable per-session trace is the one-line MEMORY.md recent-activity entry (Step 5). What every close DOES write is cheap and high-value:

**The resume stub** — `<project>/_summaries/summary-<YYYY-MM-DD>.md` (letter suffix if today already has one), 2–3 lines, the intent-continuity pointer that §Moves (what's queued) and the hot section (where things stand) don't carry:

```markdown
# Session Summary — <YYYY-MM-DD>

## Resume here
[2–3 lines: start here, in this order — e.g. "Mid-pull on X; the next step is Y; Z is blocked on <decision>." The thing a returning agent needs to pick up the thread that the structured surfaces don't say.]
```

Record op `summary-stub`.

**Full narrative on demand.** When the user asks for a real session writeup, build it from the transcript + git + the units written this session, using the old section set (fresh-eyes assessment, what was done, current state, decisions made, open work, open questions, active risks, read-first, recommended-start). Don't write it every close — it's a request, not a ceremony.

Summaries stay write-only from your perspective — you don't re-read them at bootstrap (anti-resurrection: a summary could resurrect facts the user removed from PROJECT.md after it was written). Future bootstraps load from PROJECT.md and `_memories/`.

---

## Step 5 — Refresh harness-local recall

Use the `detect-harness` adapter verb to branch by harness. The verb is defined in the sibling core skill's harness protocol — take the absolute path you loaded this `SKILL.md` from, replace `/skills/finalize/SKILL.md` with `/skills/core/protocols/harness.md`, and read that. (Claude Code: `${CORE_ROOT}/skills/core/protocols/harness.md`. Codex: `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/core/protocols/harness.md`.) Authority ordering puts harness-local recall at the bottom of the stack — see DC-86 for the principle.

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

**Priority block (mechanical).** Run `node ${CORE_ROOT}/skills/core/scripts/generate-memory-index.mjs <project>/_memories --memory-md ~/.claude/projects/<mapped-cwd>/memory/MEMORY.md --top 15`. The script regenerates only the "## Top project units" section in place: it preserves existing one-line descriptions for units that remain in top-N (so prior curation isn't lost), falls back to the unit's H1 for newly-promoted units, and removes entries for units that dropped out of top-N. Idempotent — re-runs with no underlying change are no-ops. (Top-15, not 30: the block is an eager-loaded cache that duplicates PROJECT.md §Decisions and pushes MEMORY.md over its ~24.4KB injection cap; the live retrieval ladder surfaces anything below the cut, so the cache stays lean.)

**Curation pass (inline, judgment).** Update the "Recent activity" section with this session's one-line entry. Sweep the "Feedback + project pointers" section: drop pointers to retired memories; add pointers for any `feedback_*.md` / `project_*.md` / `reference_*.md` you wrote this session. For any unit the script flagged with an H1-fallback description, refine if the H1 reads thin. Keep `MEMORY.md` under 200 lines.

Do this inline in the main agent — don't dispatch a subagent. The previous Haiku-subagent design required `git worktree`, which fails on non-git workspaces (any cloud-sync-backed project, any non-versioned project directory) with *"Cannot create agent worktree: not in a git repository."* Per CORE's harness-agnostic design intent, git is not a precondition for project intelligence. Project intelligence workspaces hold data, not code — versioning isn't the right tool here. The script does the heavy lifting; the curation pass stays in the main agent.

Narrate the refresh plainly: *"Refreshing MEMORY.md priority block from the top 30 units now."*

**Write the visibility canary (v3.0 memory-visible-in-agent-context).** After the MEMORY.md refresh above, write a fresh per-session canary so the *next* session can prove memory was actually injected into context — not merely present on disk:

```bash
node "${CORE_ROOT}/skills/core/scripts/write-visibility-canary.mjs" --workspace-id <id> 2>/dev/null || true
```

This idempotently replaces a single tagged `CORE-VISIBILITY-CANARY` line at the top of MEMORY.md (inside the injection window) and records the expected token to `~/.core/workspaces/<id>/visibility-canary.json`. Next session's startup echoes the token and `capability/memory-visible-probe.mjs` verifies the echo preceded any read of the canary surfaces. Fail-open — never block close on it.

### If harness is Codex

Do not auto-write to `~/.codex/memories/`. Codex memory is explicit-save only — see `harnesses/codex.md §read-auto-memory` for the rule and `harnesses/codex.md §save-recall-note` for the mechanics of explicit recall writes. Trigger phrases (when a user request counts as "save this") live in the user's install-level config, not in CORE.

Confirm project facts are captured in `<project>/_memories/` and the session summary written in Step 4. If harness-level observations surfaced during the session (workflow lessons, tooling collisions, Codex-specific patterns), include them in the session summary so the next session reads about them.

If the user explicitly asked to save observations earlier in the session via `save-recall-note`, that ran at the trigger moment — don't duplicate-write here.

Narrate plainly: *"On Codex — project facts already captured in `_memories/`. No harness-memory writes."*

---

## Step 6 — Closing declaration + mark the close complete

First mark the close finished so the per-op marker says "closed" and the single-flight lock releases — this is what tells the next startup it has nothing to catch up on:

```bash
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs finish <project> --session <session-id>
```

(If you ran `begin` at the top, every owed op should now carry a `record` line; `finish` stamps the marker `closed`. Skip only if `begin` was refused because another close held the lock.)

Then declare in plain voice. Concrete shape:

> *"Session closed. Resume stub at `_summaries/summary-<date>.md`. PROJECT.md rendered from current units (edit-detection clean). Hygiene pass complete — N archives, M retires, no cold-stores this pass."*

If anything couldn't be completed, name it explicitly. Don't silently skip a step. Surface the blocker plainly and recommend a next move. **Headless mode:** there's no user reading this turn — write the declaration into the resume stub instead, and leave anything that needs the user (a `render-pending-accept` flag, a Task B concern) for the next startup to raise.
