# Round 3 — defence

Seven fresh reviewers, each given only the file paths and `reviewer-brief.md`. 97 findings: **critical 16 · major 54 · minor 26 · taste 1**. Down from 129, with no critical finding from the reader, fact-checker, or harness auditor.

**Status line:** Round 3 — 97 findings, 96 accepted, 1 rebutted in part (see "Partial rebuttals").

What round 3 found, in one line: the tests that decide whether CORE exists still could not fail, and "not measured" still shipped by default. Those two are fixed first. Every accepted finding maps to one fix below. The fix list is what v4 implements.

## The fixes

| Code | Fix applied in v4 |
|---|---|
| H1 | **The existence test can fail.** The record test's arms become: **built-in** (Claude Code auto memory on, nothing else), **kit** (auto memory on, plus the same three-line block in `CLAUDE.md` and `AGENTS.md`, no skills), **layer 1** (kit plus the five skills), **full** (layer 1 plus hooks and script). Every arm has auto memory on, because that is what ships. Kill test 1: layer 1 must beat kit. Kill test 2 is folded in: kit already contains built-in, so built-in is reported, not a separate rule. `proactive-due` (with the block) joins the layer 1 vs kit comparison, so being told what is due is measured too. |
| H2 | **"Not measured" never ships.** Every keep rule has three outcomes. Kept: the layer ships. Not kept or not measured: it does not. For Layer 1 that means CORE is not shipped and the report says which. For the hooks it means they are shelved on `v4-layer2`. Step 9.4 gets an Accept and a branch per outcome. |
| H3 | **Test before you build.** The phases are reordered. Layer 1 (the five skills' no-script steps, the block, the package) and the record test's built-in, kit, and layer 1 arms run right after the gate is frozen. If layer 1 does not beat kit, the build stops there, before any hook or script is written. D1 says "do not ship" where it said "do not build", and says when it is known. |
| H4 | **The script is not on trial; the hooks are.** `check`, `selftest`, `metrics`, `migrate`, and `queue` ship with Layer 1 whenever Layer 1 ships, so requirements 7 and 8 never depend on the hooks' gate. The hooks are gated one at a time: a **full, recall off** arm (session-start hook only, using the existing `recall: off` setting) separates the two. The session-start hook is kept if full-recall-off beats layer 1. The prompt hook is kept if full beats full-recall-off on the recall cases. |
| H5 | **The gate is fair and readable.** Gated "ahead" cases are `recall-distractors`, `proactive-due`, and `brief-budget`: kept if at least 2 of 3 are ahead by 0.2 or more and the mean gap is 0.2 or more. `null-rename` and `recall-paraphrase` are non-inferiority checks only: not behind by more than 0.2. Ten runs per arm per gated case. All arms in one comparison use the same `--model` and `--judge-model`. `GATE.md` holds a fenced JSON block that `cells.mjs` reads. `cells.mjs` scores both arms from per-grader results with one fixed list of scored graders per case. Every eval command passes `--threshold 0`; cases are picked by `--tag`. The honesty and security cases are listed by name in `GATE.md` with their pass rule. "Score step" is replaced by "0.2" everywhere. |
| H6 | **The fixture cannot give the answer away.** Every fixture memory gets an opaque id of one shape (`dc-2026MMDD-NNN`); no file name names its fact. The gold set uses its own 300-memory store, written by a fresh helper across at least 10 topics, one fact per memory, not Lantern. |
| H7 | **The record test measures what it says.** Auto memory is read only from `$CLAUDE_CONFIG_DIR/projects/*/memory/`, never transcripts. Each session is three turns (`-p`, then `--resume` twice), so the unclosed-session path can fire. The junk, duplicate, and stale counts enter the rules: an arm is not kept if it has more stale or duplicate copies than the arm it beats. Six repetitions, one margin for every rule, and a paired interval over repetitions reported. `sessions.mjs` takes `--max-cost-usd` and stops at it. Runs use `CLAUDE_CODE_OAUTH_TOKEN` with an empty `CLAUDE_CONFIG_DIR`, and assert no account skills leaked in. Kill tests re-run every minor release of a harness, or every six months. |
| H8 | **Close receipts say how the session closed.** `close` rows carry `how: finalize | catch-up | skipped`. Handoff coverage counts `finalize` only. Sessions the catch-up never read are `skipped`. |
| H9 | **`finalize` counts this session, not the working tree.** The session-start hook writes a snapshot (path, size, mtime) of `_memories/`, `_summaries/`, and `PROJECT.md` to `_core/snap-<session>.json`. `finalize` compares against it and reports written and archived by id. Without the script, `finalize` uses `git status --porcelain --untracked-files=all`, counts files per folder, and labels it "uncommitted changes, not just this session's". Either way it compares the writes it attempted with what is on disk and says so when they differ. A zero from disk is reported as "0 written", next to the number of writes attempted. |
| H10 | **Never run project content.** Skills run the script only from the status block's `script:` line, never by a path relative to the skill. The committed `.agents/skills/` copy contains no script path. The security table splits writes into two rows: hooks (enabled projects only) and skills (any project, when called). Unattended `pulse` refreshes no sources: it lists stale sources as proposals. The refresh helper uses `background: true` plus a `tools` allowlist (`Read, Write, Glob, Grep, mcp__*`), not a denylist; `check --plugin` asserts it. On Codex and Antigravity, D2 states the helper is a general agent with a shell, and Antigravity ships its own helper file with command execution off. |
| H11 | **Cloud and Projects, as documented.** Claude Code cloud sessions and cloud scheduled tasks never load plugins or `.agents/skills/`. The laptop-shut beat runs the plain scheduled prompt, which reads `_memories/`. Setup offers, for cloud use, to enable the five skills on the claude.ai account. A Projects thread loads CORE's skills when CORE is added in Project settings > Plugins; hooks do not run there. Scheduled routes use local-project mode, not a throwaway worktree, and unattended `pulse` puts its proposals in its final message too. |
| H12 | **The block goes where each harness reads it.** Claude Code: a whole file, `.claude/rules/core.md`, so no `CLAUDE.md` variant can hide it. Antigravity: `.agents/rules/core.md` with `trigger: always_on`. Codex: the `AGENTS.md` block. The plugin-specific fourth line (report a missing `CORE:` line) goes in per-machine, uncommitted places: the plugin's own rules on Antigravity, `CLAUDE.local.md` on Claude Code, and `~/.codex/AGENTS.md` scoped to projects with `_memories/` on Codex. The two-copy check is dropped. |
| H13 | **Antigravity turn detection.** A `Stop` hook writes a `turn-end` receipt; the first `PreInvocation` after `SessionStart` or `turn-end` is the new turn. Test 3.4 asserts one recall block per turn. "Hooks run outside the sandbox" is marked not stated by Google and checked in 8.4. `agy plugin install <repo URL>` is tested in 8.4, with the clone fallback written. `/schedule` is suggested as a standing (daemon) schedule. |
| H14 | **Liveness lines say the truth.** The zero line reads `CORE recall: no keyword match — if this is about the past, search _memories/ yourself`. An unreadable index reads `CORE recall: not measured (index unreadable)`. A session counts as silent only when its transcript (from the start receipt's `tp`) holds a user prompt and no prompt receipt exists. |
| H15 | **Hooks check what they point at.** The prompt hook checks each pointed-to file exists and is active before printing it. The session-start hook runs the `fork` and two-live checks. A `now` item is not re-announced in a session that already announced it, and the line reads "item needs you". |
| H16 | **Harness details.** Skills that call the script carry `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/core.mjs *)`, and the blanket `Bash(node *)` grant is dropped outside evals. On Codex, setup prints the `copy-skills` and `enable add` commands for the user to run, since `.agents` is read-only in Codex's sandbox. The Codex session-start handler sets `additionalContextLimit: 4000`. Claude Code hooks resolve the project from `CLAUDE_PROJECT_DIR`, then walk up. Status-block paths print with forward slashes, in double quotes. |
| H17 | **Eval and build mechanics.** Grader keys match the runner (`llm` → `criteria` / file body; `file_exists` → `path`; `tool_order` → `before`, `after`). No inline `(?i)`: patterns are written `[Rr]edis`, and `evals-shape.test.mjs` compiles every pattern. `package-layer1.mjs` drops `canary` and gives layer 1 its own canary (a `Skill` call in the trace). The v3 comparison registers each workspace in v3's registry first. `honesty.test.mjs` builds its rows from the dispatch table and fails on a command with no row. A fifth migrate fixture comes from a real decorated v3 project; v3 is detected from committed signs, not `_lib/`. The selftest risk id is renamed so it shares no word with the zebra prompt. "All five version fields" listed. `untrusted-project-inert` runs with eval mode on and the condition failed. `evals/` is stripped from shipped packages and given a budget row. `pulse` says one line when `queue` is not `ok`. Early stop judged on the three recall cases. The on-project blind check uses D2's design: the user's true or false mark is the key, every kind kept. |
| H18 | **Text fixes.** One archive rule in every place. Promises are `type: deliverable`, prefix `dl`. "Status block" vs "the `AGENTS.md` block" named apart. "Enable CORE here" is the one phrase for the opt-in. Config counted as "2 environment switches and 4 project settings". Budget rows read "Limit; checked after the build". One line-budget rule: if the hooks need more than 1,800 lines, they are shelved. D2 §1 pastes the real status block. The five skills described by what they do. Receipts: "not pointed to on this machine". D4's fix-code text matches what v3/v4 does. |

## Dispositions

| ID | Sev | Decision | Fix / reason |
|---|---|---|---|
| R3-RD-01 | maj | Accepted | H18 |
| R3-RD-02 | maj | Accepted | H18 |
| R3-RD-03 | maj | Accepted | H18 |
| R3-RD-04 | maj | Accepted | H11 |
| R3-RD-05 | maj | Accepted | H9 |
| R3-RD-06 | min | Accepted | H3 |
| R3-RD-07 | min | Accepted | H5 |
| R3-RD-08 | min | Accepted | H18 |
| R3-RD-09 | min | Accepted | H14 |
| R3-RD-10 | min | Accepted | H18 |
| R3-RD-11 | min | Accepted | H18 |
| R3-RD-12 | min | Accepted | H18 |
| R3-RD-13 | min | Accepted | H10 |
| R3-RD-14 | min | Accepted | H18 |
| R3-RD-15 | taste | Accepted | H18 |
| R3-PA-01 | crit | Accepted | H1 |
| R3-PA-02 | crit | Accepted | H6 |
| R3-PA-03 | crit | Accepted | H1 — every arm has auto memory on |
| R3-PA-04 | crit | Accepted | H4 |
| R3-PA-05 | maj | Accepted | H1 — kill test 2 folded into the kit arm |
| R3-PA-06 | maj | Accepted | H4 — full, recall off arm |
| R3-PA-07 | maj | Accepted | H3 |
| R3-PA-08 | maj | Accepted | H17 |
| R3-PA-09 | maj | Accepted | H11 |
| R3-PA-10 | maj | Accepted | H1 |
| R3-PA-11 | maj | Accepted | H7 |
| R3-GA-01 | crit | Accepted | H2 |
| R3-GA-02 | crit | Accepted | H17 |
| R3-GA-03 | crit | Accepted | H9 |
| R3-GA-04 | crit | Accepted | H8 |
| R3-GA-05 | crit | Accepted | H10 |
| R3-GA-06 | maj | Accepted | H10 |
| R3-GA-07 | maj | Accepted | H10 |
| R3-GA-08 | maj | Accepted | H17 |
| R3-GA-09 | maj | Accepted | H9 |
| R3-GA-10 | maj | Accepted | H6 |
| R3-GA-11 | maj | Accepted | H7 |
| R3-GA-12 | maj | Accepted | H3 |
| R3-GA-13 | maj | Accepted | H14 |
| R3-GA-14 | min | Accepted | H18 |
| R3-GA-15 | min | Accepted | H17 |
| R3-PR-01 | crit | Accepted | H1 |
| R3-PR-02 | crit | Accepted | H7 |
| R3-PR-03 | crit | Accepted | H2 |
| R3-PR-04 | crit | Accepted | H8 |
| R3-PR-05 | maj | Accepted | H5 |
| R3-PR-06 | maj | Rebutted in part | See below |
| R3-PR-07 | maj | Accepted | H7 |
| R3-PR-08 | maj | Accepted | H14 |
| R3-PR-09 | maj | Accepted | H6 |
| R3-PR-10 | maj | Accepted | H17 |
| R3-PR-11 | maj | Accepted | H15 |
| R3-PR-12 | maj | Accepted | H15 |
| R3-PR-13 | min | Accepted | H18 |
| R3-PR-14 | min | Accepted | H15 |
| R3-PR-15 | maj | Accepted | H5 |
| R3-FC-01 | maj | Accepted | H17 |
| R3-FC-02 | maj | Accepted | H17 |
| R3-FC-03 | maj | Accepted | H12 — a rules file avoids every `CLAUDE.md` variant |
| R3-FC-04 | maj | Accepted | H11 |
| R3-FC-05 | maj | Accepted | H11 |
| R3-FC-06 | maj | Accepted | H13 |
| R3-FC-07 | maj | Accepted | H13 |
| R3-FC-08 | maj | Accepted | H17 |
| R3-FC-09 | min | Accepted | H18 |
| R3-FC-10 | min | Accepted | H18 |
| R3-FC-11 | min | Accepted | H10 |
| R3-EX-01 | min | Accepted | H17 |
| R3-EX-02 | maj | Accepted | H5 |
| R3-EX-03 | crit | Accepted | H17 |
| R3-EX-04 | maj | Accepted | H17 |
| R3-EX-05 | maj | Accepted | H17 |
| R3-EX-06 | maj | Accepted | H17 |
| R3-EX-07 | crit | Accepted | H17 |
| R3-EX-08 | maj | Accepted | H5 |
| R3-EX-09 | maj | Accepted | H17 |
| R3-EX-10 | maj | Accepted | H17 |
| R3-EX-11 | maj | Accepted | H5 |
| R3-EX-12 | maj | Accepted | H5 |
| R3-EX-13 | min | Accepted | H17 |
| R3-EX-14 | crit | Accepted | H7 |
| R3-EX-15 | maj | Accepted | H5 |
| R3-HA-01 | maj | Accepted | H13 |
| R3-HA-02 | maj | Accepted | H10 |
| R3-HA-03 | maj | Accepted | H10 |
| R3-HA-04 | maj | Accepted | H16 |
| R3-HA-05 | maj | Accepted | H11 |
| R3-HA-06 | maj | Accepted | H11 |
| R3-HA-07 | maj | Accepted | H12 |
| R3-HA-08 | min | Accepted | H16 |
| R3-HA-09 | min | Accepted | H16 |
| R3-HA-10 | min | Accepted | H16 |
| R3-HA-11 | min | Accepted | H16 |
| R3-HA-12 | min | Accepted | H7 |
| R3-HA-13 | min | Accepted | H13 |
| R3-HA-14 | min | Accepted | H13 |
| R3-HA-15 | min | Accepted | H12 |

## Partial rebuttals

### R3-PR-06 — at least 10 repetitions of the record test

**Agreed:** the two rules used different margins, and 3 repetitions is too few to tell a one-probe gap from noise. One margin is now used for every rule, and a paired interval over repetitions is reported next to each result.

**Not agreed:** 10 repetitions. With four arms, ten sessions per repetition, and three turns per session (H7), 10 repetitions is 1,200 paid calls on one person's account, before the hooks' own gate. The plan sets 6 repetitions (720 calls) and a hard cost cap. A difference whose paired interval includes zero at 6 repetitions counts as "no difference shown", which under H2 means the layer is **not kept**. So too few repetitions can only make CORE lose, never win. That is the safe direction for a plan whose defect class is false success.

## Responses to the partial rebuttals

| ID | Reviewer response |
|---|---|
| R3-PR-06 | **ACCEPT.** H7 delivers one margin and a paired interval; under H2 a gap whose interval includes zero is not kept, so low power errs toward CORE losing, never shipping unproven. Rebuttal stands. |
