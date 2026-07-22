---
name: metrics
description: Run an evidence-first health check of the CORE memory system for the project in the current directory, and present FOUR SEPARATE, honestly-labeled evidence classes — never one blended verdict — mechanics (a live round-trip PROOF, write→validate→index→retrieve→suppress on a throwaway store, fresh every run, this store's validator counts and unit census, plus plain-count telemetry capture — never a percentage), retrieval regression (a provisional gold-set snapshot when the project has a pre-registered gold set — the run is live, the reference answer key is not), measurement readiness (the recognition signal and the calibration pool that gates it), and user benefit (honestly "not evaluated" — nothing in this codebase measures that yet). Every line carries an honest trust label (proven-live / direct / proxy / provisional / not-evaluated). Use whenever the user runs /metrics, asks "is memory working", "prove the memory system works", "memory health", "show me the memory metrics", "can I trust the store", or wants evidence rather than claims about storage and retrieval. Do NOT use for general project status (that's PROJECT.md) or for full hygiene passes (/process-memory).
user-invocable: true
allowed-tools:
  - Read
  - Bash
---

# `/metrics` — is the memory system working, with proof

The point of this skill: someone runs it and can **confidently say what's proven and what isn't**, in ten seconds of reading. Every number in the output was measured during THIS run or carries a label saying exactly how much to trust it. Never soften a failure; never let a proxy number dress up as proof; never let mechanics evidence stand in for retrieval quality, retrieval quality stand in for measurement readiness, or any of those stand in for user benefit — those are four separate evidence classes and this skill reports them as four separate, honestly-labeled sections. **The 2026-07-22 evidence-class fix (two passes, same day):** the single umbrella `WORKING` verdict used to silently cover retrieval regression and user benefit too — it never had real proof for either. The first pass split it into three sections; a same-day peer review (Hale) caught that the new "Retrieval regression" section was STILL mixing three different kinds of claim — a capture-volume percentage with an invalid denominator, a mechanism diagnostic (tier distribution), and a measurement-readiness gate (recognition/calibration) — none of which are actually regression evidence. The verdict now reads `MECHANICS: HEALTHY` and covers mechanics only; telemetry capture is a plain-count instrumentation fact under mechanics (no percentage — there's no valid denominator to divide by); the one real regression signal (a gold-set snapshot) gets its own section labeled `PROVISIONAL`, never a passing gate; recognition/calibration get their own `MEASUREMENT READINESS` section; and user benefit stays last, always `NOT EVALUATED`.

**The script is the only renderer.** `scripts/metrics-check.mjs` (in the core skill's `scripts/` directory) gathers every number AND renders the final report text — the verdict heading, the bar gauges, the narrative. It prints the finished report on stdout; relay it verbatim. Never hand-compute a bar, re-word the narrative, or round a number yourself — the render is prescriptive code so two runs against the same data always read identically.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics-package` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/metrics/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Step 1 — run the check

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-check.mjs" <project-dir>
```

(`<project-dir>` defaults to the current directory. The script needs the CORE plugin installed — it calls the plugin's own validator, retriever, retrieval-harness, retrieval-quality analyzer, and calibration-readiness check directly, so the proof exercises the real product path, not a reimplementation. Takes a couple of seconds longer than before when the project has a gold set, because it now runs a real Recall@K pass live — see Mechanics vs Retrieval regression below. Add `--json` to also get the full data object after the rendered report, if you need a specific number the report doesn't show.)

The script gathers evidence for four separate classes — see "Evidence classes" below for what each one can and cannot claim:

1. **Mechanics** — builds a throwaway scratch store in the temp dir, writes synthetic units through the plugin's own scripts, and proves the full round trip: a fact is written, validates clean, gets indexed, is retrieved by content, and a retired fact stays suppressed. Fresh every run, scratch deleted after. Plus this project's real validator pass/warn/fail counts, unit census by status, and telemetry-capture counts (typed retrieval events / calendar days, tier mix, and any rejected malformed rows — schema-validated via `analyze-retrieval-quality.mjs`'s reuse of the canonical producer contract, never a percentage claim).
2. **Retrieval regression** — exactly one signal today: a LIVE gold-set snapshot run via `retrieval-harness.mjs` against the project's own pre-registered gold set at `_tests/retrieval-gold-set.json`, when one exists (genuinely exercised this run, on the shipped product retrieval functions — not a simulator). Labeled `provisional`, never `proven-live`: the execution is real, but the reference answer key is a small, project-authored, directional set with no preregistered pass/fail threshold — a regression *snapshot*, not a passing *gate*.
3. **Measurement readiness** — is the instrumentation itself ready to be trusted? The recognition signal (a provisional need/failure classifier) and the calibration pool that gates it. Neither is retrieval regression or user benefit.
4. **User benefit** — always renders, and always honestly says "not evaluated": nothing in this codebase currently runs a matched memory-on/off comparison, so there is no evidence to report yet.

## Step 2 — relay the result verbatim

Print exactly what the script printed on stdout — nothing added, nothing reworded. It has this shape (numbers illustrative; a project with no gold set or no retrieval history gets an honest absence line instead of the Gold-set-snapshot/Telemetry-capture rows below):

```
MECHANICS: HEALTHY

CORE Memory Health — <workspace-name>

Round-trip proof          [██████████] proven-live    PASS
Unit integrity (293)      [█████████░] direct         1 warning
Telemetry capture                      direct         269 typed events / 36 days; closure denominator unavailable; T1 99%/T2 1%/T3 0% mix; 0 rejected

RETRIEVAL REGRESSION: PROVISIONAL
Gold-set snapshot (n=22)  [███████░░░] provisional    execution proven-live (retrieveContext + buildFinalContextPack, this run); reference authority provisional (Keel-authored, directional, n=22, no preregistered pass threshold); delivered top-3 R@3 68%; ranking R@10 82%, bm25 R@10 82%

MEASUREMENT READINESS
Recognition signal        [████░░░░░░] provisional     50% rec-fail (↑ vs 21% avg)
Calibration pool          [██░░░░░░░░] direct          22/100 labeled

USER BENEFIT: NOT EVALUATED
Matched comparison        [░░░░░░░░░░] not-evaluated   no matched memory-on/off comparison exists — nothing currently measures whether this helps

"Mechanics are proven and working; telemetry capture shows 269 typed
events across 36 days (99%/1%/0% T1/T2/T3 mix). Retrieval regression:
A provisional gold-set snapshot (n=22, Keel-authored, directional, no
pass threshold) puts delivered top-3 recall at 68% — a regression
snapshot, not a passing gate; measurement readiness: recognition is
trending down this session (worth a look), and the classifier stays
unofficial until the calibration pool clears 100 labeled turns —
currently 22. Whether any of this actually helps you get better answers
hasn't been measured yet — no matched memory-on/off comparison exists."
```

**The verdict line is scoped to mechanics only** — it reads `MECHANICS: <state>`, one of:
- **MECHANICS: HEALTHY** — round trip proven live, schema clean, zero integrity failures, zero attention-tier warnings.
- **MECHANICS: HEALTHY — with caveats** — round trip proven, no failures, but attention-tier warnings exist. Look at the row that shows them.
- **MECHANICS: DEGRADED** — a hard check failed. The narrative leads with which one, and nothing else is appended that turn.
- **MECHANICS: MACHINERY WORKING, NO STORE** — the plugin round-trips fine but this project has no memory store.

**Never read the verdict as covering retrieval regression, measurement readiness, or user benefit** — it never did have real proof for any of those, and now it says so structurally: those three evidence classes render in their own labeled sections below the verdict, each with its own honest status word, never folded into the mechanics heading.

### Evidence classes and what each row means

**Mechanics** (proven store mechanics + instrumentation health — nothing about retrieval quality or user benefit):
- **Round-trip proof** — binary: full bar + PASS on success; the bar renders in a distinct fail glyph (never a partial fill) on failure, so a broken round trip can't be mistaken for "just a low score."
- **Unit integrity (N)** — the percentage of the store's N units carrying no attention-tier warning.
- **Telemetry capture** — a **no-gauge, counts-only** row (no bracket/bar at all — there is no valid eligible-hook denominator to turn into a percentage): typed retrieval events / calendar days, the T1/T2/T3 tier mix (a mechanism diagnostic, not a regression claim), the top Tier-2+ escalation topic when one exists, and rejected-row counts split by schema tier (`current-schema` rows are checked against the full producer contract in `record-retrieval-event.mjs`; `legacy` rows predate schema versioning and get a narrower compatibility check; either kind that fails validation is REJECTED and counted with a closed reason code, never silently dropped or silently folded into a passing count).

**Retrieval regression** (does retrieval work well against a reference answer key? — real evidence when it exists, an honest absence otherwise; never `proven-live`, never cite this class as user benefit):
- **Gold-set snapshot (n=N)** — a genuine, live run of `retrieval-harness.mjs` against the project's own pre-registered gold set at `_tests/retrieval-gold-set.json`, using the actual shipped retrieval functions (not a simulator). Reports the delivered top-3 recall (`context3` arm) plus the pre-expansion ranking and BM25 arms at R@10. Trust is `provisional`, not `proven-live`: the EXECUTION is genuinely live this run, but the reference answer key is a small, project-authored, directional set with no preregistered pass/fail threshold — a live run does not independently validate its own expected answers. A project with no gold set renders this row as `not-evaluated` with the plain reason, never silently dropped.

**Measurement readiness** (is the instrumentation itself ready to be trusted? — neither row here is retrieval regression or user benefit):
- **Recognition signal** — **inverted on purpose**: the underlying number is a *failure* rate (rec-fail-tier-0), so the bar shows `100 − rate` — a fuller bar always means healthier, same as every other row, even though the number quoted next to it is a failure rate.
- **Calibration pool** — labeled turns out of the 100-turn calibration gate that governs the recognition signal above, straightforward.

**User benefit** (does any of this measurably help the user? — always renders, always honest):
- **Matched comparison** — always `not-evaluated`. No matched memory-on/off comparison exists anywhere in this codebase yet, so this row can never legitimately say anything else. If a future slice adds a real matched-outcome receipt, this row is where it will render — until then, it states the absence plainly.

Trust labels mean exactly this, and say so if asked: **proven-live** = demonstrated during this run on the real product path (round-trip proof — the only row that still earns this label); **direct** = a real measurement, read from disk, but not exercised this run; **proxy** = a real signal that stands in for quality, never itself a correctness proof; **provisional** = either the instrument itself is uncalibrated, or (gold-set snapshot) the execution is live but the reference answer key's authority is not independently established — never full evidence; **not-evaluated** = no instrument exists for this project yet, or the evidence class has no real backing anywhere in this codebase — the row says which, plainly.

## Step 3 — the narrative (1–3 sentences, plain voice)

The script writes this for you — it's part of the report, in quotes, right after the bars. Its rules, so you can sanity-check it or explain it if asked: every label and number is explained in the sentence it appears in; it speaks to mechanics (incl. telemetry capture), retrieval regression, measurement readiness, and user benefit on a normal run — never just the first; and if the verdict is DEGRADED it leads with what failed and the single next action instead of anything else, with nothing appended about the other classes that turn (a mechanics failure means nothing else here is trustworthy to discuss yet). Never pad it beyond the three sentences, never cite the recognition signal or telemetry capture as user-benefit proof, never claim retrieval correctness from the telemetry-capture row (it counts events, not correctness), and never let the gold-set snapshot read as more than what it is — a small, directional, provisional product-path regression check, not a passing gate and not a claim that the answer helped anyone.

Never: pad the reply with sections beyond verdict/four-class-blocks/narrative, hand-edit the bars or narrative text, claim user-benefit evidence exists when the row says it doesn't, claim the gold-set snapshot is `proven-live` (it is `provisional`), or run the check against a guessed `CORE_ROOT`.
