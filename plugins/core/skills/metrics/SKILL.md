---
name: metrics
description: Run an evidence-first health check of the CORE memory system for the project in the current directory, and present a compact, glanceable verdict — a live round-trip PROOF (write→validate→index→retrieve→suppress on a throwaway store, fresh every run), this store's validator counts and unit census, retrieval-log coverage, and the recognition-signal state — each line carrying an honest trust label (proven-live / direct / proxy / provisional / self-report). Use whenever the user runs /metrics, asks "is memory working", "prove the memory system works", "memory health", "show me the memory metrics", "can I trust the store", or wants evidence rather than claims about storage and retrieval. Do NOT use for general project status (that's PROJECT.md) or for full hygiene passes (/process-memory).
user-invocable: true
allowed-tools:
  - Read
  - Bash
---

# `/metrics` — is the memory system working, with proof

The point of this skill: someone runs it and can **confidently say "it's working" backed by real evidence**, in ten seconds of reading. Every number in the output was measured during THIS run or carries a label saying exactly how much to trust it. Never soften a failure; never let a proxy number dress up as proof.

**The script is the only renderer.** `scripts/metrics-check.mjs` (in the core skill's `scripts/` directory) gathers every number AND renders the final report text — the verdict heading, the bar gauges, the narrative. It prints the finished report on stdout; relay it verbatim. Never hand-compute a bar, re-word the narrative, or round a number yourself — the render is prescriptive code so two runs against the same data always read identically.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics-package` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/metrics/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Step 1 — run the check

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-check.mjs" <project-dir>
```

(`<project-dir>` defaults to the current directory. The script needs the CORE plugin installed — it calls the plugin's own validator, retriever, and calibration-readiness check directly, so the proof exercises the real product path, not a reimplementation. Add `--json` to also get the full data object after the rendered report, if you need a specific number the report doesn't show.)

The script does three things, all real:
1. **Live probe** — builds a throwaway scratch store in the temp dir, writes synthetic units through the plugin's own scripts, and proves the full round trip: a fact is written, validates clean, gets indexed, is retrieved by content, and a retired fact stays suppressed. Fresh every run. Scratch is deleted after.
2. **This-store health** — read-only checks against the project's real `_memories/`: validator pass/warn/fail counts, unit census by status, retrieval-log coverage, recognition-signal state.
3. **Calibration pool** — read-only: the classifier's labeled-turn count against the 100-turn gate (via `calibrate-classifier.mjs`'s own readiness check), and whether it has cleared the gate.

## Step 2 — relay the result verbatim

Print exactly what the script printed on stdout — nothing added, nothing reworded. It has this shape:

```
CORE Memory Health — <workspace-name>

Round-trip proof        [██████████] proven-live   PASS
Unit integrity (293)     [█████████░] direct        1 warning
Retrieval-log coverage   [███████░░░] direct        73%
Recognition signal       [████░░░░░░] provisional   50% rec-fail (↑ vs 21% avg)
Calibration pool         [██░░░░░░░░] direct        22/100 labeled

"Core mechanics are proven and working. Recognition is trending down
this session (worth a look), and the classifier stays unofficial until
the calibration pool clears 100 labeled turns — currently 22."
```

A bold verdict line sits above the block, one of:
- **WORKING** — round trip proven live, schema clean, zero integrity failures, zero attention-tier warnings.
- **WORKING — with caveats** — round trip proven, no failures, but attention-tier warnings exist. Look at the row that shows them.
- **DEGRADED** — a hard check failed. The narrative leads with which one.
- **MACHINERY WORKING, NO STORE** — the plugin round-trips fine but this project has no memory store.

Each row is a 10-character gauge (`█` filled, `░` empty) plus a trust label plus the raw value:
- **Round-trip proof** — binary: full bar + PASS on success; the bar renders in a distinct fail glyph (never a partial fill) on failure, so a broken round trip can't be mistaken for "just a low score."
- **Unit integrity (N)** — the percentage of the store's N units carrying no attention-tier warning.
- **Retrieval-log coverage** — retrieval-log rows against session files, as a direct percentage (capped at 100%).
- **Recognition signal** — **inverted on purpose**: the underlying number is a *failure* rate (rec-fail-tier-0), so the bar shows `100 − rate` — a fuller bar always means healthier, same as every other row, even though the number quoted next to it is a failure rate.
- **Calibration pool** — labeled turns out of the 100-turn calibration gate, straightforward.

Trust labels mean exactly this, and say so if asked: **proven-live** = demonstrated during this run on the real product path; **direct** = a real measurement, read from disk, but not exercised this run; **provisional** = the instrument itself is uncalibrated, never evidence.

## Step 3 — the narrative (1–3 sentences, plain voice)

The script writes this for you — it's part of the report, in quotes, right after the bars. Its rules, so you can sanity-check it or explain it if asked: every label and number is explained in the sentence it appears in; it names what's provisional vs proven; and if the verdict is DEGRADED it leads with what failed and the single next action instead of anything else. Never pad it, never cite the recognition signal as effectiveness proof, never claim retrieval quality from the retrieval-log row (it counts rows, not correctness).

Never: pad the reply with sections beyond verdict/block/narrative, hand-edit the bars or narrative text, or run the check against a guessed `CORE_ROOT`.
