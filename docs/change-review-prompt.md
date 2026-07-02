# core-plugin change-review prompt

Paste this when reviewing any change to core-plugin. It checks the change against the five failure patterns the 2026-07-01 audit found recurring. Its job is to catch the problem, not to reassure you — so it is written to look for trouble and report evidence, and to say "clean" only when it genuinely is.

Give it: the diff (`git diff <base>..<branch>`) or the list of files touched. It should read the actual code, not trust the description.

---

## The prompt

> You are reviewing a change to the core-plugin codebase adversarially. This project has a documented history of five recurring defect patterns. Your only job is to check whether this change introduces, re-introduces, or fails to fix any of them. Do not summarize the change or praise it. Read the actual code at every site you reference and cite `file:line`. If you find nothing for a pattern, say so plainly — but only after you have actually looked, and name where you looked. A clean bill with no evidence of looking is a failure.
>
> Here is the change: [paste the diff, or name the files and branch].
>
> Check each of these five patterns:
>
> **1. A rule that lives in prose the agent won't reliably run.** Did this change add a load-bearing obligation to a protocol, SKILL.md, or a skill file — something the agent is *told* to do every session/turn/close — without a script or hook that guarantees it? Load-bearing means: if the agent skips it, correctness or a user-facing promise breaks (edit-detection, capture, a retrieval log, a security gate). If so, name the obligation, its file:line, and what silently breaks when the agent doesn't do it. (The plugin's own lesson: obligations that live only in prose get executed ~40% of the time. Guarantees belong in scripts/hooks, or the prose must honestly mark itself best-effort.)
>
> **2. A fix that landed in one file but not its copies.** Does this change fix a bug, add a guard, or change a behavior in one place where the same logic is duplicated elsewhere? Search the repo for siblings: other frontmatter parsers, other store-walkers, other "is this unit active/retrievable" checks, other CLI-entry guards, other arg parsers, other path-to-slug encoders, other spawn calls. For each duplicate you find, state whether the change was applied there too. A fix applied to one of N copies is the single most common defect in this repo — assume duplicates exist until you've grepped and proven they don't.
>
> **3. An instrument that reports "healthy" while recording nothing.** Does this change touch logging, metrics, telemetry, a validator, a drift/health check, or a status/exit code? Check: on a write failure (bad path, permissions, full disk, malformed input), does it exit 0 / print "clean" / return success anyway? Does a swallowed error turn into a positive all-clear? Does a test inject a fake so the real failing path is never exercised (a green test on a mock is not coverage of the real thing)? Name any place the instrument can go dark while still reporting fine.
>
> **4. A soft trust boundary — a path from an untrusted repo to a real action.** Does this change touch a hook (SessionStart / UserPromptSubmit / SessionEnd), a spawn, a file write, a path built from an env var or from project-controlled input, or the workspace-trust / registration check? A repo the user opens is untrusted even after the folder-trust dialog: its files, its `workspace.json`, its `.claude/settings.json` env block (Claude Code forwards project env into hook subprocesses) are all attacker-influenceable. Trace whether project-controlled input can: redirect a path, trigger a spawn, get a file written into a repo the plugin doesn't own, or pass the trust gate. Name the chain from untrusted input to the action.
>
> **5. A read-side invariant with no single owner.** (A specific, high-value case of pattern 2, for memory-store changes.) If this change touches how units are stored, filtered, ranked, or retrieved, check the invariants that must hold at *every* read site — a retired/archived/superseded unit must not surface by default; an invalidated (`t_invalid` in the past) unit must not surface by default; a stale index must not linger deleted units. There are multiple read paths (`graph-walk`, `rankUnits`/`priority`, `retrieve-context`/`generate-summary-index`, `select-relevant-units`). Verify the change holds the invariant at *all* of them via the shared predicate, not just the one it edited. A predicate applied at one read site and not another is exactly how deleted facts resurfaced before.
>
> For each of the five: verdict (clean / at-risk / broken), the file:line evidence, and — if at-risk or broken — the concrete failure scenario (what input, what breaks, for whom). Rank anything you find by severity. End with the single highest-priority thing to fix, or "no pattern found — checked all five" with where you looked for each.

---

## Notes on using it

- Run it with a *fresh* agent, not the one that wrote the change — the point is independent eyes, and an agent reviewing its own work rubber-stamps.
- For a memory-store change, pattern 5 is the one that bites; for a hook/spawn/path change, pattern 4; for anything touching a protocol or SKILL.md, pattern 1.
- If it comes back all-clean too fast with thin evidence, that itself is the sycophancy signal the audit warned about — push back: "show me where you looked for pattern 2, list every duplicate you grepped for."
