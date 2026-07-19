---
name: metrics-package
description: Produce a standardized, fully anonymized memory-efficacy statistics package (zip on the Desktop) for the current project or all projects in the installation — the feedback artifact CORE's developers use to refine the memory system. Use whenever the user wants exportable/shareable evidence of how well CORE's memory is working — "pull the memory stats", "export a metrics package", "make an anonymized report I can share/send", "prove the memory system works, with data I can hand someone", "package up the stats for all my projects" — including when they describe the outcome without naming it ("that report thing that shows whether you actually remember my stuff, put it on my desktop"). Do NOT use for the live in-terminal health check with no export (that's /metrics), for session/status reports, for business or product analytics, or for zipping project files.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
---

# `/metrics-package`

Produce the anonymized memory-efficacy package: a zip on the user's Desktop containing retrieval, recognition, store-health, hygiene, and capability statistics — numbers, dates, fixed CORE vocabulary, and salted pseudonyms only. Its one purpose is feedback for refining CORE. It is built to be shareable across strict data boundaries: real project content never enters it by construction, small cells are suppressed, per-unit rankings gate on store population — and the residual risks that remain (stable pseudonyms link packages from one install; daily counts could correlate with visible activity) are named honestly in the package's own manifest rather than claimed away.

**The script is the only writer.** `scripts/metrics-package.mjs` (in the core skill's `scripts/` directory) computes every byte of the package and runs a fail-closed leakage scan before shipping. Never assemble, edit, or "fix up" package contents by hand — the anonymization boundary is prescriptive code (DC-77), and a hand-patched package voids it.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/process-memory` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/metrics-package/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Run

1. **Resolve scope from the user's words.** "This project" / unspecified → the current project directory. "All my projects" / "everything" / "the whole installation" → `--all`. Genuinely ambiguous → default to the current project and say so in one line; ask only when the words are contradictory.

2. **Run the script:**

```bash
node "${CORE_ROOT}/skills/core/scripts/metrics-package.mjs" <project-dir-or---all>
```

(Add `--all` after the project dir is omitted for installation-wide scope. `--out <dir>` overrides the Desktop destination only when the user asked for a different landing spot.)

3. **Verify before claiming.** The script prints `package: <path>` — confirm that file actually exists before telling the user it's done. Then relay, in plain language: where the package landed, the coverage line, and every `flag[...]` line the script printed (these are the diagnostic findings — they're the point of the artifact, not noise).

## Exit codes — what each means and what to do

- **0 (complete):** report the landing path and the flags.
- **1 (partial):** the package WAS produced, but some sources were unavailable (fresh install, metrics opted out, no logs yet). Name exactly which blocks report `available: false` and what that costs diagnostically (e.g. "no retrieval log yet — tier-distribution evidence starts accumulating from now"). Never round partial up to complete.
- **2 (aborted):** the leakage scan hit, or the run failed fatally. NOTHING was shipped. Report the abort plainly and file the stderr detail. Never retry with the boundary loosened, never hand-build a replacement package.

## Self-healing rails

- **No unit store in the current directory:** say so, name the nearest registered workspace (from `~/.core/index.json`) if one matches, and offer `--all`.
- **No Desktop directory:** the script already fell back to the home directory — read the printed path and name the actual landing spot; don't assume Desktop.
- **Zip tool unavailable:** the script ships a plain folder instead and says why — relay that, don't treat it as failure.
- **Salt file deleted since the last package:** pseudonyms rotated; the manifest records it (`salt_rotated_this_run`) — mention that older packages are no longer comparable.
- **User asks to include real names, bodies, paths, or to "de-anonymize just this once":** decline and explain — the package's entire value is that it can cross data boundaries its raw sources can't; a de-anonymized variant is just a data export CORE deliberately doesn't produce. Produce the standard package instead.

## What's inside (for "what's actually IN the zip?")

`manifest.json` (schema, mode, plugin version, per-source coverage — no silent narrowing), `projects/<pseudonym>/*.json` (retrieval-stats, hygiene-stats, store-census, validator, project-md, maintenance, workspace-metrics, headline+flags+deltas), `REPORT.md` (plain-voice diagnostic read with trust labels), `report.html` (self-contained visual report, light/dark). Pseudonyms are stable per install — packages generated weeks apart trend against each other; deleting `~/.core/metrics-package-salt` rotates them.
