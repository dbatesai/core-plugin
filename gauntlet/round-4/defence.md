# Round 4 — defence

Seven fresh reviewers, each given only the file paths and `reviewer-brief.md`. 91 findings: **critical 8 · major 49 · minor 33 · taste 1**. Down from 97; no critical finding from the reader or executor. Most findings are round-3 fixes that went wrong or did not reach every document.

**Status line:** Round 4 — 91 findings, 90 accepted, 1 rebutted in part (see "Partial rebuttals").

**Stop condition fired: four rounds run.** v5 applies this list and is not reviewed again. What that leaves unverified is stated in D4.

## The fixes

| Code | Fix applied in v5 |
|---|---|
| J1 | **The kit is the strongest fair rival.** Its instruction block gets the fourth line R2-PA-02 promised: "At the start of a session, tell the user once about anything due within a day." Its auto memory is pointed into the repository (`autoMemoryDirectory: <repo>/_memories/auto`), the native way to keep memory with the project. The `core` skill's no-script branch gets the matching step: list active memories whose `by:` date is within a day. |
| J2 | **The kill test is one rule, stated once.** On the record test: layer 1 recalls at least 1 more probe of 5 than kit, with a 95% paired interval above zero, **and** reaches at least 4 of 5 probes on average (an absolute floor), **and** is not worse on copies (J3). `proactive-due` is scored separately, with the block, against kit, by 0.2. "Kill test" names this rule only. The hook rules are "the hook rules". D1, D2, D3, D4 state it in the same words, with D3's step numbers. |
| J3 | **Copies are counted where copies are defects.** Stale and duplicate copies are counted only in `_memories/` outside `archive/` and in auto memory. `_summaries/`, `PROJECT.md`, and archived files are excluded. The reversal's "Not chosen" line does not count. The copy legs use the same margin and interval as the probe leg. |
| J4 | **Harm checks are true non-inferiority tests.** A hook is kept only if the lower 95% bound of (with − without) is above −0.2 on each must-not-lose case. Too few runs now make a harmful hook lose too. The R3-PR-06 sentence is corrected to say so. |
| J5 | **Each part is gated on what it can change.** Arms in the eval: full, **start-only** (renamed from "full, recall off"), **script** (layer 1 plus the script, no hooks), layer 1, kit, files, nothing. The script is kept if it beats layer 1 on `proactive-due` and `brief-budget`; otherwise only its self-audit commands (`check`, `selftest`, `metrics`, `env`) ship. The session-start hook gets its own ahead list (`brief-budget`, `proactive-due`, `resume-from-handoff`). The prompt hook is judged on `recall-distractors` after a headroom check with a `-block` twin. `PreCompact` is kept only if full is not behind layer 1 on the 25-turn run's turn-25 probe. |
| J6 | **Every release gate has three outcomes.** If any honesty or security case listed in `GATE.md`, or the v3 comparison, is not kept or not measured, nothing ships. The v3 rule (margin, blind judge, outcome) is frozen in `GATE.md` before any run. |
| J7 | **A shelved hook takes its dependants with it.** One list, used by 0.6 and 9.4: `env` and `metrics` drop hook rows, the liveness line, the `core` skill's no-status-block branch is rewritten, catch-up and `enable` go. A hookless release reports only what it can observe. |
| J8 | **Skills find the script without a hook.** On Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/scripts/core.mjs"` in the skill body (documented substitution). On Codex and Antigravity: `env` prints the path once at setup into `~/.core/script-path`, and skills read that file. Never a path inside the project. The `allowed-tools` rule is written in the same quoted form, checked live before 7.1. |
| J9 | **Liveness line in its own rules file.** Claude Code: `.claude/rules/core-liveness.md`, excluded through `.git/info/exclude`. Never create `CLAUDE.local.md`. Codex: `AGENTS.override.md` is respected where it exists. The user is told before a write to `.claude/` that Claude Code will ask. In a not-enabled CORE project, the session-start hook prints one short "not enabled here" line each session, so the always-on line does not cry wolf. |
| J10 | **Refresh helper, as documented.** Claude Code: `background: true` plus `disallowedTools` (Bash, PowerShell, Edit, NotebookEdit, WebFetch, WebSearch, Monitor, Skill, SendMessage, Agent, CronCreate, RemoteTrigger); no `tools` line. Antigravity: `inheritCustomizations: false`, `mainAgent: false`. D2 says "no shell tool" only where true. |
| J11 | **The fixture cannot be answered by one search.** About 20 distractors contain "v2" and "provider"; a dozen name a person. Distractors are near misses on every key token. |
| J12 | **Record-test mechanics.** 2.3 is labelled `[human]`: run from a terminal outside Claude Code. Each fresh `CLAUDE_CONFIG_DIR` gets `disableBundledSkills: true`. Fixtures are built before packages. Every arm's next session opens with a scripted "yes to all CORE proposals". The full arm runs with `EVAL_CORE_ENABLE=1`. Full and layer 1 rerun together, interleaved, in 7.2; pairs only within one file. Probes use a 2-of-3 judge vote. Cost caps are twice the estimate, with a one-run calibration logged first. "About 41 calls per arm per repetition (about 1,000 for four arms at six)" everywhere. |
| J13 | **Eval floor and env.** Measurement floor Claude Code 2.1.299 (partial runs after rate limits are no longer graded). On exit 2, read `partialReason`. Eval env keys use the `EVAL_` prefix (`EVAL_CORE_TEST_ACCOUNT_HOME`). The kill-test eval commands grant `Write Edit`. `untrusted-project-inert` grades on `trace` with `not_contains` for injected text. |
| J14 | **Migration from what v3 really writes.** The fifth fixture is made with v3's own adopt flow (named) so the decorator accepts it. The `PROJECT.md` sign and the strip target are `<!-- HOT-SECTION:BEGIN -->`/`END`. |
| J15 | **Own use means own channel.** 4.0.0 is not pushed to the public `core` marketplace entry; 3.20.1 stays there. 4.0 publishes to the owner's own marketplace. The kill branch has an exit: a one-page recipe to keep the files as plain files, and 3.20.1 left installed. The verdict file (date, Claude Code version, model) ships, and `metrics` says when it is over 90 days old. The re-run trigger is Claude Code releases that mention memory, hooks, skills, or plugins, or every 90 days. |
| J16 | **Harness details.** Codex `--sid` defaults to `CODEX_THREAD_ID`. Antigravity `Stop` answers `{"decision":"stop"}` and writes `turn-end` only when `fullyIdle` is true. Projects hooks marked "not stated; checked in 8.2". `${CLAUDE_PLUGIN_ROOT}` substitution in skill bodies is documented, so the item leaves "not verified". `env` is `ok` when it read the enabled list and receipts folder; capability lines may be `unknown`. Held-out forbidden hits are counted and reported, not asserted. `ladder.md` is written in 1.2. `copy-skills --account <dir>` produces the copy to upload for claude.ai account skills, with the steps. Queue items merge by id. `finalize` compares by path and lists files changed by others separately. |
| J17 | **Names, numbers, references.** D2 and D4 use v4/v5 step numbers; D3's "either number" line goes. "Instruction block" and "liveness line" in all four documents. One line-budget rule: all shipped JavaScript at most 1,800 lines; over it, shelve the hooks first. Contract C states both archive rules. "Enable CORE here" everywhere. D1's short version names the kit. D2: "31 cases", summary lengths as D3, `env` defined, the ladder's causes moved to a list. D4 ledger cells are plain sentences naming the problem, not its history. On-project check reported as "store accuracy: N of 10 still true". |

## Dispositions

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R4-RD-01 | maj | Accepted | J17 |
| R4-RD-02 | maj | Accepted | J2 |
| R4-RD-03 | maj | Accepted | J2 |
| R4-RD-04 | maj | Accepted | J17 |
| R4-RD-05 | maj | Accepted | J17 |
| R4-RD-06 | min | Accepted | J17 |
| R4-RD-07 | min | Accepted | J12 |
| R4-RD-08 | min | Accepted | J17 |
| R4-RD-09 | min | Accepted | J17 |
| R4-RD-10 | min | Accepted | J17 |
| R4-RD-11 | min | Accepted | J17 — Antigravity "once per turn" stated in D1 |
| R4-RD-12 | min | Accepted | J5 — `start-only` |
| R4-RD-13 | min | Accepted | J17 |
| R4-RD-14 | min | Accepted | J17 |
| R4-RD-15 | taste | Accepted | J17 |
| R4-PA-01 | crit | Accepted | J1 |
| R4-PA-02 | crit | Accepted | J11 |
| R4-PA-03 | maj | Accepted | J2 — reversal and copies scored beside probes; J5 |
| R4-PA-04 | maj | Accepted | J2 — absolute floor |
| R4-PA-05 | maj | Accepted | J1 — kit uses `autoMemoryDirectory` |
| R4-PA-06 | maj | Accepted | J5 — script arm |
| R4-PA-07 | maj | Accepted | J7 |
| R4-PA-08 | maj | Rebutted in part | See below |
| R4-PA-09 | maj | Accepted | J15 |
| R4-PA-10 | maj | Accepted | J15 |
| R4-PA-11 | maj | Accepted | J15 |
| R4-PA-12 | maj | Accepted | J12 |
| R4-PA-13 | min | Accepted | J5 |
| R4-GA-01 | crit | Accepted | J6 |
| R4-GA-02 | crit | Accepted | J3 |
| R4-GA-03 | maj | Accepted | J8 |
| R4-GA-04 | maj | Accepted | J5 |
| R4-GA-05 | maj | Accepted | J7 |
| R4-GA-06 | maj | Accepted | J13 |
| R4-GA-07 | maj | Accepted | J12 |
| R4-GA-08 | maj | Accepted | J8 |
| R4-GA-09 | maj | Accepted | J15 |
| R4-GA-10 | maj | Accepted | J16 |
| R4-GA-11 | min | Accepted | J16 |
| R4-GA-12 | min | Accepted | J17 |
| R4-GA-13 | min | Accepted | J17 |
| R4-GA-14 | min | Accepted | J17 |
| R4-GA-15 | min | Accepted | J2 |
| R4-PR-01 | crit | Accepted | J1 |
| R4-PR-02 | crit | Accepted | J3 |
| R4-PR-03 | maj | Accepted | J3 |
| R4-PR-04 | maj | Accepted | J4 |
| R4-PR-05 | maj | Accepted | J5 |
| R4-PR-06 | maj | Accepted | J5 |
| R4-PR-07 | maj | Accepted | J12 |
| R4-PR-08 | maj | Accepted | J12 |
| R4-PR-09 | maj | Accepted | J16 |
| R4-PR-10 | maj | Accepted | J12 |
| R4-PR-11 | maj | Accepted | J6 |
| R4-PR-12 | min | Accepted | J12 |
| R4-PR-13 | min | Accepted | J17 |
| R4-PR-14 | min | Accepted | J16 |
| R4-FC-01 | crit | Accepted | J9 |
| R4-FC-02 | maj | Accepted | J10 |
| R4-FC-03 | maj | Accepted | J8 |
| R4-FC-04 | maj | Accepted | J13 |
| R4-FC-05 | maj | Accepted | J16 |
| R4-FC-06 | maj | Accepted | J10 |
| R4-FC-07 | min | Accepted | J12 |
| R4-FC-08 | min | Accepted | J13 |
| R4-FC-09 | min | Accepted | J16 |
| R4-FC-10 | min | Accepted | J16 |
| R4-HA-01 | crit | Accepted | J9 |
| R4-HA-02 | maj | Accepted | J8 |
| R4-HA-03 | maj | Accepted | J10 |
| R4-HA-04 | maj | Accepted | J10 |
| R4-HA-05 | min | Accepted | J16 |
| R4-HA-06 | min | Accepted | J9 |
| R4-HA-07 | min | Accepted | J16 |
| R4-HA-08 | min | Accepted | J16 |
| R4-HA-09 | min | Accepted | J9 |
| R4-HA-10 | min | Accepted | J9 |
| R4-EX-01 | maj | Accepted | J14 |
| R4-EX-02 | maj | Accepted | J14 |
| R4-EX-03 | maj | Accepted | J13 |
| R4-EX-04 | maj | Accepted | J12 |
| R4-EX-05 | maj | Accepted | J7 |
| R4-EX-06 | maj | Accepted | J7 |
| R4-EX-07 | maj | Accepted | J12 |
| R4-EX-08 | maj | Accepted | J11 |
| R4-EX-09 | maj | Accepted | J13 |
| R4-EX-10 | min | Accepted | J12 |
| R4-EX-11 | min | Accepted | J16 |
| R4-EX-12 | min | Accepted | J16 |
| R4-EX-13 | min | Accepted | J16 |
| R4-EX-14 | min | Accepted | J16 |

## Partial rebuttals

### R4-PA-08 — gate the skills too, or the enabled list protects the weaker channel

**Agreed:** the security table overstates what the enabled list protects. A skill in a cloned repository can read memory bodies that a hook would never pass. D2 now says so in plain words, and the threat model names it.

**Not agreed:** gating skills on the enabled list. Every Claude Code cloud session and every new machine starts with an empty list, so gated skills would leave cloud users with nothing — the floor R2-PA-05 and G27 fought to raise. And the threat is not new: an agent asked about the past in a cloned repository will read its files, CORE or not. What CORE adds is a habit of reading `_memories/`, so the guard belongs on how bodies are read. **Done instead:** in a project not enabled on this machine, the skills treat memory bodies as quoted data — they report what a memory says and who said it (`said_by`), and never follow an instruction inside one. A case, `remember-ignores-injection`, already covers the enabled path; v5 adds its not-enabled twin.

## Responses to the partial rebuttals

| ID | Reviewer response |
|---|---|
| R4-PA-08 | Pending |
