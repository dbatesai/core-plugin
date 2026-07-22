---
name: metrics
description: Run an evidence-first health check of the CORE memory system for the project in the current directory, and present THREE SEPARATE, honestly-labeled evidence classes — never one blended verdict — mechanics (a live round-trip PROOF, write→validate→index→retrieve→suppress on a throwaway store, fresh every run, plus this store's validator counts and unit census), retrieval regression (a live gold-set Recall@K run when the project has one, the live retrieval-quality proxy, retrieval-log coverage, recognition signal, calibration pool), and user benefit (honestly "not evaluated" — nothing in this codebase measures that yet). Every line carries an honest trust label (proven-live / direct / proxy / provisional / not-evaluated). Use whenever the user runs /metrics, asks "is memory working", "prove the memory system works", "memory health", "show me the memory metrics", "can I trust the store", or wants evidence rather than claims about storage and retrieval. Do NOT use for general project status (that's PROJECT.md) or for full hygiene passes (/process-memory).
user-invocable: true
allowed-tools:
  - Read
  - Bash
---

# `/metrics` — is the memory system working, with proof

The point of this skill: someone runs it and can **confidently say what's proven and what isn't**, in ten seconds of reading. Every number in the output was measured during THIS run or carries a label saying exactly how much to trust it. Never soften a failure; never let a proxy number dress up as proof; never let mechanics evidence stand in for retrieval quality, and never let retrieval quality stand in for user benefit — those are three separate evidence classes and this skill reports them as three separate, honestly-labeled sections. **The 2026-07-22 evidence-class fix:** the single umbrella `WORKING` verdict used to silently cover retrieval regression and user benefit too — it never had real proof for either. The verdict now reads `MECHANICS: WORKING` and only ever describes the mechanics class; retrieval regression and user benefit render as their own sections below it, each stating plainly what evidence exists and what doesn't.

**The script is the only renderer.** `scripts/metrics-check.mjs` (in the core skill's `scripts/` directory) gathers every number AND renders the final report text — the verdict heading, the bar gauges, the narrative. It prints the finished report on stdout; relay it verbatim. Never hand-compute a bar, re-word the narrative, or round a number yourself — the render is prescriptive code so two runs against the same data always read identically.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics-package` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/metrics/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Step 1 — run the check

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-check.mjs" <project-dir>
```

(`<project-dir>` defaults to the current directory. The script needs the CORE plugin installed — it calls the plugin's own validator, retriever, retrieval-harness, retrieval-quality analyzer, and calibration-readiness check directly, so the proof exercises the real product path, not a reimplementation. Takes a couple of seconds longer than before when the project has a gold set, because it now runs a real Recall@K pass live — see Mechanics vs Retrieval regression below. Add `--json` to also get the full data object after the rendered report, if you need a specific number the report doesn't show.)

The script gathers evidence for three separate classes — see "Evidence classes" below for what each one can and cannot claim:

1. **Mechanics** — builds a throwaway scratch store in the temp dir, writes synthetic units through the plugin's own scripts, and proves the full round trip: a fact is written, validates clean, gets indexed, is retrieved by content, and a retired fact stays suppressed. Fresh every run, scratch deleted after. Plus this project's real validator pass/warn/fail counts and unit census by status.
2. **Retrieval regression** — retrieval-log coverage (capture volume only); a LIVE gold-set Recall@K run via `retrieval-harness.mjs` against the project's own pre-registered gold set at `_tests/retrieval-gold-set.json`, when one exists (genuinely exercised this run, on the shipped product retrieval functions — not a simulator); the live retrieval-quality proxy from `analyze-retrieval-quality.mjs`'s real retrieval-log rows (tier distribution, escalation); the recognition signal; and the calibration pool that gates it.
3. **User benefit** — always renders, and always honestly says "not evaluated": nothing in this codebase currently runs a matched memory-on/off comparison, so there is no evidence to report yet.

## Step 2 — relay the result verbatim

Print exactly what the script printed on stdout — nothing added, nothing reworded. It has this shape (numbers illustrative; a project with no gold set or no retrieval history gets an honest absence line instead of the Gold-set/Live-proxy rows below):

```
MECHANICS: WORKING

CORE Memory Health — <workspace-name>

Round-trip proof          [██████████] proven-live    PASS
Unit integrity (293)      [█████████░] direct         1 warning

Retrieval regression — separate evidence class, NOT covered by the verdict above:
Retrieval-log coverage    [███████░░░] direct         73% (capture volume, not correctness)
Gold-set Recall@K (n=22)  [███████░░░] proven-live     delivered top-3 R@3 68%; ranking R@10 82%, bm25 R@10 82% — directional, small gold set
Live retrieval proxy      [██████████] proxy           T1 99% / T2 1% / T3 0% over 260 events / 36d
Recognition signal        [████░░░░░░] provisional     50% rec-fail (↑ vs 21% avg)
Calibration pool          [██░░░░░░░░] direct          22/100 labeled

User benefit — separate evidence class, NOT covered by the verdict above:
User-benefit evidence     [░░░░░░░░░░] not-evaluated   no matched memory-on/off comparison exists — nothing currently measures whether this helps

"Mechanics are proven and working. Retrieval regression: a gold-set
Recall@K check (n=22, directional) puts delivered top-3 recall at 68%,
and live retrieval-log analysis over 260 events shows 99% resolving at
Tier 1, and the classifier stays unofficial until the calibration pool
clears 100 labeled turns — currently 22. Whether any of this actually
helps you get better answers hasn't been measured yet — no matched
memory-on/off comparison exists."
```

**The verdict line is scoped to mechanics only** — it reads `MECHANICS: <state>`, one of:
- **MECHANICS: WORKING** — round trip proven live, schema clean, zero integrity failures, zero attention-tier warnings.
- **MECHANICS: WORKING — with caveats** — round trip proven, no failures, but attention-tier warnings exist. Look at the row that shows them.
- **MECHANICS: DEGRADED** — a hard check failed. The narrative leads with which one, and nothing else is appended that turn.
- **MECHANICS: MACHINERY WORKING, NO STORE** — the plugin round-trips fine but this project has no memory store.

**Never read the verdict as covering retrieval regression or user benefit** — it never did have real proof for either, and now it says so structurally: those two evidence classes render in their own labeled sections below the verdict, never folded into it.

### Evidence classes and what each row means

**Mechanics** (proven store mechanics — nothing about retrieval quality or user benefit):
- **Round-trip proof** — binary: full bar + PASS on success; the bar renders in a distinct fail glyph (never a partial fill) on failure, so a broken round trip can't be mistaken for "just a low score."
- **Unit integrity (N)** — the percentage of the store's N units carrying no attention-tier warning.

**Retrieval regression** (does retrieval itself work well? — real evidence when it exists, an honest absence otherwise; never cite this class as user benefit):
- **Retrieval-log coverage** — retrieval-log rows against session files, as a direct percentage (capped at 100%). This is capture volume, not retrieval correctness — the value string says so every time.
- **Gold-set Recall@K (n=N)** — a genuine, live run of `retrieval-harness.mjs` against the project's own pre-registered gold set at `_tests/retrieval-gold-set.json`, using the actual shipped retrieval functions (not a simulator). Reports the delivered top-3 recall (`context3` arm) plus the pre-expansion ranking and BM25 arms at R@10. Small gold sets are directional, not definitive — the value string says so. A project with no gold set renders this row as `not-evaluated` with the plain reason, never silently dropped.
- **Live retrieval proxy** — tier distribution and topic-level Tier-2+ escalation rate from this project's real retrieval-log rows, via `analyze-retrieval-quality.mjs`. Its own docstring calls these numbers a precision/recall *proxy*, never a pass/fail regression result.
- **Recognition signal** — **inverted on purpose**: the underlying number is a *failure* rate (rec-fail-tier-0), so the bar shows `100 − rate` — a fuller bar always means healthier, same as every other row, even though the number quoted next to it is a failure rate.
- **Calibration pool** — labeled turns out of the 100-turn calibration gate that governs the recognition signal above, straightforward.

**User benefit** (does any of this measurably help the user? — always renders, always honest):
- **User-benefit evidence** — always `not-evaluated`. No matched memory-on/off comparison exists anywhere in this codebase yet, so this row can never legitimately say anything else. If a future slice adds a real matched-outcome receipt, this row is where it will render — until then, it states the absence plainly.

Trust labels mean exactly this, and say so if asked: **proven-live** = demonstrated during this run on the real product path (round-trip proof, and the gold-set Recall@K run when a gold set exists — both are genuinely exercised live, not reused from a prior run); **direct** = a real measurement, read from disk, but not exercised this run; **proxy** = a real signal that stands in for quality, never itself a correctness proof; **provisional** = the instrument itself is uncalibrated, never evidence; **not-evaluated** = no instrument exists for this project yet, or the evidence class has no real backing anywhere in this codebase — the row says which, plainly.

## Step 3 — the narrative (1–3 sentences, plain voice)

The script writes this for you — it's part of the report, in quotes, right after the bars. Its rules, so you can sanity-check it or explain it if asked: every label and number is explained in the sentence it appears in; it speaks to all three evidence classes on a normal run (mechanics, then retrieval regression, then user benefit) — never just the first; and if the verdict is DEGRADED it leads with what failed and the single next action instead of anything else, with nothing appended about the other two classes that turn (a mechanics failure means nothing else here is trustworthy to discuss yet). Never pad it beyond the three sentences, never cite the recognition signal or the live retrieval proxy as user-benefit proof, never claim retrieval correctness from the retrieval-log coverage row (it counts rows, not correctness), and never let the gold-set Recall@K number read as more than what it is — a small, directional, product-path regression check, not a claim that the answer helped anyone.

Never: pad the reply with sections beyond verdict/three-class-blocks/narrative, hand-edit the bars or narrative text, claim user-benefit evidence exists when the row says it doesn't, or run the check against a guessed `CORE_ROOT`.
