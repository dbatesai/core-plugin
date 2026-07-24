---
name: metrics
description: The ONE door to the CORE memory system's health and measurement surface. Default output is answer-shaped — the three questions that matter (is it storing the right memories, is it loading them when you need them, does it pass its own blind test), one plain sentence each, sourced from pinned scorecards with an honest trust label and a nothing-needs-your-attention line (or the escalation that replaces it). Modes behind the same door — "/metrics full" (the complete instrument readout — live round-trip PROOF on a throwaway store, validator counts, telemetry, gold-set snapshot, recognition/calibration — every line trust-labeled, artifact-first on harnesses with an artifact surface), "/metrics export" (the fully anonymized memory-efficacy zip on the Desktop — what /metrics-package used to do), "/metrics self-test" (author-verify-run a blind test round now — what /self-test used to do). Use whenever the user runs /metrics (any mode), asks "is memory working", "prove the memory system works", "memory health", "show me the memory metrics", "can I trust the store", "test the memory on this project", "run a blind retrieval self-test", "export a metrics package", "make an anonymized report I can share", or wants evidence rather than claims about storage and retrieval. Do NOT use for general project status (that's PROJECT.md) or full hygiene passes (/process-memory).
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
  - Task
  - Artifact
---

# `/metrics` — the one door to memory health

The point: someone runs it and can **confidently say what's proven and what isn't** in ten seconds of reading. Every number was measured mechanically or carries a label saying exactly how much to trust it. Never soften a failure; never let a proxy dress up as proof.

**One door, four modes (v3.14.0, the single-door ruling):** the plain `/metrics` default answers the three outcome questions from stored conclusions; `full` opens the instrument panel; `export` produces the anonymized shareable package; `self-test` runs a deliberate blind test round now. `/self-test` and `/metrics-package` still exist as deprecation shims that point here (removal scheduled v3.15.0).

**Script path resolution (all modes).** Take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/metrics/SKILL.md` — that prefix is the plugin root (`CORE_ROOT`). Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

---

## Default mode — the answer view

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-check.mjs" <project-dir> --answers
```

Relay stdout **verbatim** — it is already the finished, plain-language view. It reads ONLY pinned conclusions (the scorecard history the maintenance cadence writes) plus the tripwire state — no live recomputation, so two reads of the same history always say the same thing. Its shape:

```
Memory health — <project>                          checked <when>

Is it storing the right memories?    YES — no gaps found in 124 graded turns
Is it loading them when you need?    MOSTLY (mechanical grade) — right memories 89% of turns; 6 missed, 4 noisy
Does it pass its own blind test?     82% (down 3 from last check — watching, not alarming)

Nothing needs your attention right now.
```

- **"mechanical grade"** is a real limit, not decoration: the grading re-runs the same text search with the full question in hindsight — it measures whether the right stored text was found, not whether the answer was semantically right. Say so if asked.
- Degradation is honest: before any grading exists the lines read "not yet measured"; a user who turned capture off sees "turn capture is off" instead of a pretend verdict; a tripped wire replaces the last line with a plain-language escalation naming the likely locus.
- If the user wants any depth beyond this — numbers, proofs, history — that's `full`, below. Offer it in one line, don't dump it unasked.

## `full` mode — the instrument panel

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-check.mjs" <project-dir>
```

**The script is the only renderer** — it gathers every number AND renders the report (verdict heading, bar gauges, narrative). Relay it verbatim; never hand-compute a bar, re-word the narrative, or round a number. Add `--json` for the machine object (`render-metrics-artifact --json-in` consumes it).

The report covers **three separately-labeled evidence classes** — never one blended verdict:

1. **Mechanics** — a live round-trip PROOF on a throwaway scratch store (write → validate → index → retrieve → suppress, fresh every run), this store's validator counts and unit census, telemetry capture counts (never a percentage — no valid denominator), and the **turn-capture state line**, which ALWAYS renders: ON shows the plain-language disclosure (each turn's prompt and delivered memory context saved locally for later grading — never exported, auto-deleted after 30 days) with volumes, write-failure health, and every off-switch (`CORE_TURN_CAPTURE=0`, `"turn_capture": false` in the project's `workspace.json`, master `CORE_METRICS_ENABLED=0`); OFF confirms the opt-out took effect and names the consequence (no evidence for grading). See `protocols/data-storage.md` §"Two capture streams" for the full contract.
2. **Retrieval regression** — the newest blind self-test round when one exists (per-kind breakdown, trap-leak rate, old-vs-new overfitting delta), else the small static gold set. Labeled `provisional`, never `proven-live`: the execution is live, the answer key's authority is not independently established. A regression *snapshot*, never a passing *gate*.
3. **Measurement readiness** — the recognition signal (inverted bar: fuller = healthier) and the calibration pool gating it.

*(A fourth class — user benefit — rendered "not evaluated" through v3.13.x. REMOVED per DC-129: the matched on/off comparison is unobservable, so the question left scope by decision, not by gap. Never resurrect the row; if asked, say exactly that.)*

The **verdict heading is scoped to mechanics only** (`MECHANICS: HEALTHY` / `HEALTHY — with caveats` / `DEGRADED` / `MACHINERY WORKING, NO STORE`) — never read it as covering the other classes. Trust labels: **proven-live** = demonstrated this run on the real product path; **direct** = real measurement read from disk, not exercised this run; **proxy** = a stand-in signal, never a correctness proof; **provisional** = the instrument or its reference isn't independently validated; **not-evaluated** = no instrument exists for this project yet.

**Artifact display (harnesses with an artifact surface):** the full report displays artifact-first — a self-contained plain-language HTML page from the SAME canonical object:

```bash
node "${CORE_ROOT}/skills/core/scripts/render-metrics-artifact.mjs" <project-dir> --out <scratch-path>/core-metrics.html
```

Narrate the printed manifest (content class `aggregates-only`, byte count, producer identity), publish **private** via the Artifact tool, keep a stable URL by republishing the same path, and record the outcome with `--record-publish` (the script refuses `published-private` without evidence + authorization fields). Consent: ask-first by default; narrate-and-proceed only under this user's own durably-recorded standing authorization. On Codex (no artifact surface — DC-75): say so by name, give the `--out` path, never fake a publish.

## `export` mode — the anonymized package (was `/metrics-package`)

1. **Scope from the user's words:** "this project"/unspecified → current project; "all my projects"/"everything" → `--all`. Ambiguous → current project, said in one line.
2. ```bash
   node "${CORE_ROOT}/skills/core/scripts/metrics-package.mjs" <project-dir | --all>
   ```
3. **Verify before claiming:** the script prints `package: <path>` — confirm the file exists, then relay the landing path, the coverage line, and every `flag[...]` line (the flags are the point, not noise). Exit codes: **0** complete; **1** partial — the package shipped but some sources were unavailable; name exactly which and what that costs, never round up to complete; **2** aborted — the fail-closed leakage scan hit or the run failed; NOTHING shipped; never retry with the boundary loosened, never hand-build a package. **The script is the only writer** — a hand-patched package voids the anonymization boundary (DC-77). If the user asks to de-anonymize "just this once": decline and explain — the package's entire value is that it can cross data boundaries its raw sources can't. Turn-capture evidence content NEVER enters the package by construction (canary-tested).

## `self-test` mode — a deliberate blind round now (was `/self-test`)

The scheduled path authors rounds automatically when the current one goes stale (capped once a week); this mode is for a user who wants one **now**. The discipline is identical — the machinery is `self-test-round.mjs`, and the one thing a script can't do is spawn a genuinely blind author:

1. **`new-round`** — freezes the corpus identity, creates the append-only round dir, prints the blind-authoring brief:
   ```bash
   node "${CORE_ROOT}/skills/core/scripts/self-test-round.mjs" new-round <project-dir>
   ```
2. **Spawn the BLIND author** — a fresh subagent whose entire prompt is the brief verbatim plus the active unit bodies from `<project>/_memories/` (skip `_`-prefixed and `INDEX` files). Nothing else: no session context, no prior rounds, no retrieval code, no search tools. The author records `meta.blind_attestation` and `meta.author` (registration refuses a set without them). Prefer a different model family than the project's own reasoning model when an alternate CLI is available; when not, say so honestly — the old-vs-new delta is the backstop.
3. **`register <round> <goldset-file>`** — mechanical verification (schema, zero word-overlap for indirect kinds, false-premise entity checks, per-kind quota, corpus identity), then FROZEN. **On refusal, the violations go back to the author — never silently patch the set yourself**; that defeats the blindness.
4. **`run <round>`** — the real shipped retrieval path against the frozen set. Relay the headline, the per-kind breakdown, and the trap-leak rate in plain words ("questions whose answer is deliberately absent, where the right behavior is saying 'nothing stored about that'"), plus the old-vs-new delta once a prior round exists (a large positive delta = the store may be tuned to its old test). Never call it a pass/fail gate — self-authored answer key, directional snapshot. `status` shows history.
5. Results feed the default view and `full` automatically — the grading run writes the same log the scorecards pin.

**Rails:** under ~30 active units → say so and stop (a self-test on a tiny store measures noise); no `_memories/` → nothing to test, offer `/core`; author can't fill a kind's quota with clean zero-overlap pairs → an honestly short kind beats a padded one — itself a finding; never author in a session that has been discussing the questions.

## Never (all modes)

Pad the default view with sections it doesn't have; hand-edit bars, verdicts, or narrative; claim the gold-set/self-test snapshot is `proven-live`; resurrect the user-benefit row; run against a guessed `CORE_ROOT`; publish an artifact without narrating it; let any display source a different data object than the script emitted.
