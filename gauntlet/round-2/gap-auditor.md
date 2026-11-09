# Round 2 — Gap auditor

Reviewed: `gauntlet/v2-d1.md`, `v2-d2.md`, `v2-d3.md`, `v2-d4.md` against `gauntlet/contract.md` and `gauntlet/reviewer-brief.md`. I read the round-1 reviewer files, `round-1/defence.md`, `round-1/judge-PA-03.md`, and the D4 ledger first. Nothing below repeats a round-1 finding. Where a round-1 fix is wrong or incomplete, the finding cites the earlier ID.

Web check: `https://code.claude.com/docs/en/plugin-evals.md`, fetched directly (HTTP 200, 63,948 bytes).

## Coverage

| Item | Verdict | Where in v2 | Findings |
|---|---|---|---|
| R1 Native across harnesses and OSes | Partial | D2 §5 rung table (no OS column); "By operating system" has four bullets, none for Antigravity or Linux | GA-06, GA-07 |
| R2 Native-first, per thing built | Partial | D3 "Why each command exists" covers the 14 commands only; four answer "—" | GA-08 |
| R3 Ladder-down, no silent rung | Partial | D2 §5 rungs; the signal for two rungs is the `AGENTS.md` line, which Claude Code skips in any repo with a `CLAUDE.md` | GA-02, GA-03 |
| R4 Minimal: size budget, each script justified | Delivered, one gap | D3 Budget, `check --plugin` `budget`; justification table | GA-08 |
| R5 Measurement in the first build phase | Partial | D3 0.6 (paid, Claude Code only) and Phase 1; 0.6's convention arm is not Layer 1 | GA-01 |
| R6 Security: read, write, run, untrusted, unattended | Partial | D2 §9, D3 decisions 14–16, 23–24 | GA-05, GA-10 |
| R7 Metrics plus blind comparison | Partial, Claude Code only | D2 §7, D3 7.4–7.7, 9.4 | GA-01, GA-11 |
| R8 Self-audit, incl. instruments reading nothing | Delivered in code, not in what the user is told | D2 §6, §8; D3 7.1, 7.2, 7.4 | GA-04 |
| R9 Voice | Delivered | D1, D2; D3 dense by design for an agent | — |
| Defect class killed | Partial | D2 §6, D3 contract A | GA-04, GA-11 |
| Remember closed | Partial | D2 §4; D3 5.1–5.3 | GA-09, GA-10 |
| Recall closed | Delivered on the hooked rungs | D3 3.2–3.4 | — |
| Interact closed | Partial: in session on Claude Code; out of session only on Claude Code cloud | D2 §2, §4, §11; D3 4.2, 4.5 | GA-06 |
| Update closed | Delivered in design; tested by mock | D3 6.2, 7.6 | — |
| Focus closed | Delivered | D2 §3; D3 4.3 | — |
| Two closing sections in each document | Delivered | all four | — |
| **D1** problem, solution, alternatives, feature comparison, verdict | Partial | §6 cells are bare "Partial"; the verdict rests on Layer 1 being separable, which it is not | GA-02, GA-15 |
| **D2** one session, every dependency, use cases, shortfalls, detection, ladder, measurement, security | Partial | §10 omits version floors and helper agents | GA-14 |
| **D3** zero-context finish; deliverable per phase; file-by-file; decisions; Accept and failure path per step | Partial | 21 steps lack their own "If it fails"; the enable-failure detection cannot be built as written | GA-11, GA-13 |
| **D4** attack, questions, ledger with severity / decision / reason / round / judge / stop condition | Partial | Ledger reasons for the five partial rebuttals and all fix codes live outside D4; 127 of 146 "what was wrong" cells are cut mid-sentence | GA-12 |

---

## Findings

### R2-GA-01  —  critical
- **Artifact:** D2 / D3 / D1
- **Location:** D2 §7, arm table: "**Convention** | The record and the `AGENTS.md` block, no plugin — the honest runner-up", and "**Plugin minus convention** is what the wiring adds." D3 7.6 "Convention twins … Only their without-plugin score is used." D3 7.7: "Arm **convention** writes `AGENTS.md` with the block and uses no plugin." D3 3.6, the block text.
- **What is wrong:** Layer 1 is "a file layout, five skills, and a three-line `AGENTS.md` block" (D1 §4, D3 "What you are building"). The convention arm has the files and the block, but none of the five skills. The runner loads skills only from the plugin under test ("Ship any skills … a case depends on in the plugin under test"), and the convention arm runs without the plugin. So "plugin minus convention" measures skills plus hooks plus script, not the wiring. Worse for step 7.7: the block's three lines say read `PROJECT.md`, look in `_memories/`, and report dead hooks. Nothing in them says to *write* a memory. That instruction lives only in the `remember` skill. So the convention arm in the ten-session test has no reason to write anything, and its write rate will sit near zero. Third, the block's last line tells a no-plugin agent to report that "CORE's hooks are not running", so every convention answer can carry a false warning that a rubric may count against it (`proactive-due`, "in at most two sentences"). This is the fix for R1-PA-01 (F6a), done without the skills that R1-PA-01's own suggested fix named ("the `AGENTS.md` text and CORE's skill files").
- **What breaks if we ship it as-is:** The gate that decides whether Layer 2 exists is biased toward keeping it. The 9.4 "or" branch ("the plugin's probe score beats the convention's by at least 1 (of 5) … with a write rate no lower") is close to guaranteed, because only one arm was ever told to write. D1 §8's verdict then keeps 1,800 lines of code on a comparison against a strawman. The judge-PA-03 ruling asked for exactly the contrast between CORE and the convention; this arm does not deliver it.
- **Suggested fix:** Make the convention arm a second, skills-only plugin: the five `SKILL.md` files and the block, no hooks, no monitor, no script calls. Use it in 0.6, 7.6, and 7.7. Drop the dead-hook line from the text appended in that arm.
- **Evidence:** `v2-d2.md:234`, `:238`; `v2-d3.md:43`, `:705–709`, `:998`, `:1043`, `:1138`; `plugin-evals.md` §How runs are isolated: "Ship any skills, agents, hooks, or MCP servers a case depends on in the plugin under test"; `round-1/premise-attacker.md:16`; `round-1/judge-PA-03.md`.

### R2-GA-02  —  critical
- **Artifact:** D1 / D2 / D3
- **Location:** D1 §5: "If the wiring cannot beat the convention, the convention is still worth having, and nothing is lost by dropping the code." D1 §8: "**Layer 1 ships unconditionally.**" D1 §4: "Layer 1 needs no code and no install beyond copying files." D3 9.4: "'Keep Layer 2' fails after one round of fixes: stop and report … a person decides."
- **What is wrong:** As specified, Layer 1 cannot run without Layer 2. Every one of the five skills calls the script: `core` §10–11 run `enable add`; `remember` §5 searches `INDEX.md` and §10 runs `index`; `pulse` §1 runs `queue`; `finalize` §4 runs `verify` and `close`; `metrics` §1 runs `check`, `metrics`, `selftest`. `INDEX.md` is built only by the script and is git-ignored (decision 12), so a fresh clone without the script has no index, yet D1 §4 says the block tells the agent "to check the memory index". The block's third line ("tell the user CORE's hooks are not running") is a permanent false alarm once Layer 2 is dropped. And no step ships the five skills anywhere except inside the plugin, which is Layer 2's vehicle. No phase defines the Layer-1-only release that D1 promises.
- **What breaks if we ship it as-is:** If the gate fails, the plan's own verdict cannot be carried out. "Drop Layer 2" leaves five skills that each fail on their first command, a block that warns about dead hooks every session, and no index. "Nothing is lost" becomes "everything stops working", and the executing agent is told only that "a person decides".
- **Suggested fix:** Write each skill so the script is optional ("if the script is present, run …; otherwise …"), make the block's third line conditional on the plugin being installed, and add a 9.4 branch that produces the Layer-1-only package: skills copied to the harness's project skill folder, block, no script.
- **Evidence:** `v2-d1.md:116`, `:118`, `:162`, `:222`; `v2-d3.md:93`, `:762–763`, `:782`, `:814`, `:819`, `:837`, `:965`, `:1147`.

### R2-GA-03  —  critical
- **Artifact:** D1 / D2 / D3
- **Location:** D2 §1: "All three harnesses read `AGENTS.md` [G 4.1–4.3] … That is why Layer 1 works everywhere." D1 §4: "All three harnesses read `AGENTS.md`." D3 3.6: appends the block "to `AGENTS.md` (creating the file if needed)". D2 §5 rung table, "How you are told" for Skills only and Files only: "The `AGENTS.md` block line, if installed".
- **What is wrong:** Claude Code reads `AGENTS.md` "only when you have no `CLAUDE.md` in your working directory or above it", and only from v2.1.277. R1-HA-14 raised this and suggested offering the block for `CLAUDE.md`. The fix (F3) moved the dead-hook warning into the block but kept `AGENTS.md` as its only home, and the claim "all three read `AGENTS.md`" stayed. On Claude Code, in any project with a `CLAUDE.md`, the block is never loaded. The test cannot catch this: the runner loads no instruction files, and the convention arm gets the block as an appended system prompt.
- **What breaks if we ship it as-is:** On the main harness, in the common case of a project that already has a `CLAUDE.md`, Layer 1's instructions never reach the agent, and the Skills-only and Files-only rungs, whose only signal is that block, become silent. Requirement 3 fails even for a user who said yes to the block. D2 §10 lists no Claude Code 2.1.277 floor, so the ladder cannot name the cause.
- **Suggested fix:** When a `CLAUDE.md` exists, offer the block there too (or add `@AGENTS.md` to it, which Claude Code expands). State the 2.1.277 floor in D2 §10 and in `ladder.md`. Change "all three read `AGENTS.md`" to the true condition.
- **Evidence:** `grounding.md:197`; `research-claude-code.md:36–37` ("By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md`"; "requires Claude Code v2.1.277 or later"); `round-1/harness-auditor.md:115`; `v2-d1.md:116`; `v2-d2.md:76`, `:185–186`, `:334`; `v2-d3.md:711`.

### R2-GA-04  —  critical
- **Artifact:** D2 / D3
- **Location:** D3 contract F, the status block's first line: "`CORE: hooks ok · harness=<name> · …`". D2 §5: "When the `CORE:` block appears, the agent knows the hooks ran and which harness ran them." D2 §6, the heartbeat: "`core.mjs metrics` shows the age of the newest receipt, and flags any session with a start receipt but no prompt receipts". D3 7.4, the `metrics` skill: "answer three questions, one line each, in 'working', 'broken', 'not measured'".
- **What is wrong:** The session-start hook prints "hooks ok" about hooks it has not observed. It proves only that it ran itself. A prompt hook that is killed by its 5 s timeout, crashes before writing its receipt, or is dropped by Antigravity (hooks "fail open … logged and ignored"; any `metadata` field drops the whole output) leaves no receipt and no message, while every session still opens with "hooks ok". The heartbeat that would catch this (`silent_sessions`, `newest_receipt_age`) exists only as numbers in `metrics`, which runs only when the user asks. And even then no rule turns those numbers into an answer: `hook_coverage` still divides by sessions seen in receipts, and the skill has no line saying "newest receipt older than X, or a silent session in the window → 'not measured', not 'working'". R1-GA-05 was fixed by adding the numbers (F1), not by making any verdict read them.
- **What breaks if we ship it as-is:** Recall can be dead on every prompt for weeks while CORE greets each session with "hooks ok", and "is it pointing to memories?" answers "working" from receipts written before the hook died. That is the defect class, shipped in the first line of every session.
- **Suggested fix:** Print what was proven: "CORE: session hook ran". At session start, read this machine's receipts for the last session; if it had a start row and no prompt row, add one line: "CORE: the prompt hook did not run last session." In the `metrics` skill, map a silent session or a receipt older than the window to "not measured", never "working".
- **Evidence:** `v2-d3.md:345`, `:378`, `:940–952`, `:965`; `v2-d2.md:175`, `:214`; `research-antigravity.md:452–453`, `:483`; `round-1/gap-auditor.md` R1-GA-05.

### R2-GA-05  —  major
- **Artifact:** D2 / D3
- **Location:** D3 decision 23: "Runs CORE schedules itself pass `unattended` to the `pulse` skill." D2 §9: "**runs CORE itself schedules** pass the word `unattended`". D3 4.4 `pulse` description: "Pass 'unattended' as the argument when no person is present." D3 4.4 §7: "never start it unasked." D3 4.5: "never sets one up unasked."
- **What is wrong:** CORE schedules nothing. The only scheduled run the plan defines is the 4.5 prompt, which neither calls `pulse` nor passes `unattended`. The only loop is `/loop 30m /core:pulse`, typed by the user, also without the word. So the narrowed rule from F4 applies to an empty set. Meanwhile the `pulse` description asks the agent to decide "when no person is present", which D2 §9 says no harness can tell it. The real unattended runs are a `/loop` left running while the user is away, Desktop scheduled tasks (they "load `~/.claude/skills/`"), and Codex app scheduled tasks (they "can use plugins" and "skills"). All of them run as "the user's own" and can refresh sources, writing digests of outside tool text into `_sources/`, with no person watching. The only test (`pulse-unattended-no-writes`) passes the word by hand.
- **What breaks if we ship it as-is:** Requirement 6's "how it behaves unattended" is met on paper. The one safeguard has no caller, and the unattended runs that do happen get full write access to the store. This is the R1-GA-06 / R1-HA-04 / R1-EX-19 problem, still standing after its fix.
- **Suggested fix:** Put `/core:pulse unattended` into the 4.5 prompt and the `/loop` line the skill suggests, so every run CORE tells the user to schedule carries the word. Remove "when no person is present" from the description.
- **Evidence:** `v2-d3.md:104`, `:778`, `:782`, `:788`, `:1012`; `v2-d2.md:322`; `research-claude-code.md:148`; `research-codex.md:426`.

### R2-GA-06  —  major
- **Artifact:** D1 / D2 / D3
- **Location:** D2 §11: "Elsewhere, and when the laptop is shut, a native scheduled task does the out-of-session check." D2 §2: "**That evening your laptop is shut.** A Claude Code cloud scheduled task … runs a short prompt against the repository". D1 §6, CORE 4 row, Interact: "via native schedulers elsewhere". D3 4.5: "Codex app scheduled task (desktop app or web; not the CLI) … Antigravity Automations (App)".
- **What is wrong:** The F5 fix (for R1-PA-06 and R1-GA-17) holds with the laptop shut on one harness only. Codex project scheduled tasks need "the machine powered on and the ChatGPT desktop app running"; web tasks "cannot use a local folder"; the Codex app does not exist on Linux. Claude Code Desktop tasks "only run while the desktop app is running and your computer is awake." Antigravity Automations are App-only, and what happens when the machine is off "is not stated". The one route that works with the laptop shut, the Claude Code cloud task, works on a fresh clone. It sees only memories that were committed and pushed. The plan leaves committing `_memories/` to the user, and nothing pushes mid-session writes.
- **What breaks if we ship it as-is:** The owner's stated need, "tell me what's due while my laptop is closed", is met only on Claude Code cloud, and only for facts that reached the remote. A commitment recorded in Tuesday's session and not yet pushed is invisible to Tuesday night's check, and the check says "nothing due". For Codex and Antigravity users the claim in D1 §6 and D2 §11 is false.
- **Suggested fix:** State per harness whether the route runs with the machine off, and add to the 4.5 prompt and `schedule.md` that the cloud task sees only pushed commits. Change D2 §11 to "on Claude Code cloud only".
- **Evidence:** `research-codex.md:426`, `:430`, `:537`; `research-claude-code.md:201`; `research-antigravity.md:701`, `:1048`; `grounding.md:230`; `v2-d2.md:132`, `:349`; `v2-d1.md:182`.

### R2-GA-07  —  major
- **Artifact:** D2 / D3 / D1
- **Location:** D2 §5 "By operating system" (four bullets: Claude Code on Windows, Codex on Windows, Codex on macOS, "hooks are not the agent"). D3 9.4 gate: "Live hooks | fire on each harness and OS tested". D3 0.4: every manifest description ends "Works on Claude Code, Codex, and Antigravity." D1 §6: "All 3 harnesses: Yes, with stated losses".
- **What is wrong:** R1-GA-13 was accepted as "Ladder gains OS notes per capability". v2 has no OS column and no per-capability notes. Antigravity has no OS line at all, though its research names three real differences: the terminal sandbox (Windows needs 11 24H2 with the August 2026 update; Linux hosts without unprivileged user namespaces cannot use it), how hook commands launch on Windows (`cmd /c`, reported by a third party), and path handling. Linux appears nowhere. The release gate passes on "each harness and OS tested", so a release where 8.3 and 8.4 are `BLOCKED` and 8.2 ran on one OS meets it, while the shipped description still says "Works on … Codex, and Antigravity".
- **What breaks if we ship it as-is:** Requirement 1's test ("with the OS it works on") is unmet for one harness of three. A release can go out with zero live checks on Codex and Antigravity and still advertise them, which tells a user "this works" when nobody looked.
- **Suggested fix:** Add an Antigravity bullet with the sandbox floors and the `cmd /c` launch. Make the 9.4 gate read "not verified on <harness/OS>" for each untested cell, and make the manifest description drop any harness that is not verified.
- **Evidence:** `v2-d2.md:189–194`; `v2-d3.md:500`, `:1140`; `research-antigravity.md:17`, `:492`, `:904–909`, `:1036`; `round-1/gap-auditor.md` R1-GA-13.

### R2-GA-08  —  major
- **Artifact:** D3 (and D1 §4)
- **Location:** D3 "Why each command exists", and its rows for `close`, `selftest`, `migrate`, `sample`, whose "Why not the harness" cell is "—".
- **What is wrong:** Requirement 2's test is "for each thing CORE builds". F11 answered R1-GA-12 with a table of the 14 commands only. The other things CORE builds get no "does the harness already do this?" line: the five skills, the three hook files, the monitor, the `core-refresh` helper, `snooze.json`, `_core/inbox/`, and the receipt format. Two of these duplicate native features without saying why: the watcher against Claude Code's own `/loop` (which `pulse` §7 itself recommends), and the `finalize` close pass against native session summaries and auto memory. Four command rows answer "—", which is no answer.
- **What breaks if we ship it as-is:** Requirement 2 is met only for the parts that are code. On Claude Code CORE ships two ways to check the queue between prompts (monitor and `/loop`), with no stated reason the native one is not enough. Every later "should this exist?" review has nothing to point to.
- **Suggested fix:** Extend the table to every shipped file group, one row each, and replace each "—" with the harness feature checked and the answer (for example, `close`: "no harness records that a handoff file exists for a session").
- **Evidence:** `v2-d3.md:114–133`, `:782` (§7 `/loop`); `research-claude-code.md:14`; `round-1/gap-auditor.md` R1-GA-12.

### R2-GA-09  —  major
- **Artifact:** D3 / D2
- **Location:** D3 contract E: "`no-handoff` | … | `soon`". Contract F: "At most 3 'now' items not in `data.recent`". D3 5.3: "prose in `core/SKILL.md` section 2. When the queue lists a `no-handoff` item…". D3 4.3 §2: "read the `CORE:` block if present. Give the brief". D2 §2: "On Thursday the status block lists the Wednesday session as never closed".
- **What is wrong:** R1-PR-06's fix demoted `no-handoff` from `now` to `soon`. The status block names only `now` items; `soon` items appear only as a count ("3 soon"). The `core` skill's start-of-session section does not tell the agent to run `queue`. So the agent never sees a `no-handoff` item, and the 5.3 catch-up never starts. D2's worked session shows a behavior the contracts no longer produce. The eval cannot catch it: `catch-up-unclosed` passes on any `_summaries/summary-` file, and the "Where are we?" prompt can produce one by other paths.
- **What breaks if we ship it as-is:** Most sessions end without "wrap up" (D2 §2 says so). Remember's safety net for those sessions, the catch-up, is delivered in words only. Decisions from every unclosed session are lost, and nothing says so.
- **Suggested fix:** Have the status block name `no-handoff` items in a separate line ("Last session not closed: <sid>") whatever their level, or tell `core` §2 to run `queue` when the count of `soon` is non-zero. Make the eval grader check the late summary names a fact only the planted transcript holds.
- **Evidence:** `v2-d3.md:309`, `:354`, `:754`, `:842`, `:1025`; `v2-d2.md:130`; `round-1/practitioner.md` R1-PR-06.

### R2-GA-10  —  major
- **Artifact:** D3 / D2
- **Location:** D3 contract H: "`<machine>`: first 8 characters of `~/.core/install-id`; `nohome` if it cannot be read or created." D3 3.4: "this machine's receipts file". D3 5.3: "`metrics --days 7`, which lists unclosed sessions with their `tp` from **this machine's** receipts". D3 7.6: "Inside the runner's sandbox the home folder is unreadable". `catch-up-unclosed` fixture: `_core/receipts-nohome-claude-code.jsonl`.
- **What is wrong:** Hooks and the agent compute "this machine" differently. Hooks run outside the sandbox and read the real `~/.core/install-id` through the OS account record. The agent's `node core.mjs …` runs inside the sandbox, where the eval docs say "your home directory … [is] unreadable", so it gets `nohome`. The same split exists on Codex with the Windows elevated sandbox (D2 §5: "a different user with a different home folder"). The hooks then write `receipts-<id>-…` while the agent's `queue`, `metrics`, and 5.3 read only `receipts-nohome-…`. In the eval, `catch-up-unclosed` works only because its fixture is named for the agent's side; the session-start hook, which reads the other file, never counts it. In real sandboxed use the agent never sees the hooks' receipts, so `no-handoff`, `unclosed`, and `data.recent` are empty. Separately, a committed `_core/receipts-nohome-*.jsonl` in a cloned repo is read as "this machine's" by a sandboxed agent, so its `tp` (any path ending `.jsonl`, such as another project's transcript) is handed to a helper, despite D2 §9's "Never read: Other projects".
- **What breaks if we ship it as-is:** In sandboxed sessions the agent's view of CORE's own state reads nothing and reports it as empty, not unknown. That is the defect class again. The eval case passes on a path users never hit. The R1-GA-15 fix (F15) is incomplete: "this machine's own receipts" is a file name an attacker can match.
- **Suggested fix:** Put the machine id in the status block (`machine=<id>`) and have the agent pass it as `--machine`; when the agent's side gets `nohome`, return `unknown`, never "nothing". Never accept a `tp` from a `nohome` file, and require `tp`'s file to be untracked by git.
- **Evidence:** `v2-d3.md:397`, `:555`, `:656`, `:842`, `:999`, `:1025`; `v2-d2.md:192`, `:297`; `plugin-evals.md` §Grant tools: "your home directory and Claude Code configuration are unreadable", and "hooks and servers run outside the agent's sandbox"; `round-1/gap-auditor.md` R1-GA-15.

### R2-GA-11  —  major
- **Artifact:** D3 (and D2 "What was not verified", D4 Part 1 item 4)
- **Location:** D3 7.6 "If it fails": "If the plugin data folder in a run is not under the temp folder, `EVAL_CORE_ENABLE` will not take effect: every case then measures the 'not enabled' path. Detect this from `untrusted-project-inert` passing in a case that should be enabled, record it".
- **What is wrong:** `untrusted-project-inert` is its own case; it cannot "pass in a case that should be enabled". The sentence describes no check an agent can build. No enabled case has a grader that proves the hooks ran: nothing asserts a receipts file exists (`files` target), and nothing asserts the trace lacks "not enabled on this machine". The `tool_used: Skill` graders are "scored only as an indicator". Several security and honesty cases (`pulse-unattended-no-writes`, `remember-no-secret`, `remember-ignores-injection`, `setup-consent`) pass by doing nothing, so they pass when CORE never switched on. The enabling path is new in v2 (F6e), so this is new.
- **What breaks if we ship it as-is:** If the temp-folder condition fails, the whole plugin arm silently measures "not enabled". The gate then compares a dead plugin with the convention and drops Layer 2, while the honesty and security gates report 1.0. The eval becomes an instrument that reports success while measuring nothing.
- **Suggested fix:** Give every enabled case a `regex` grader on `{source: file, path: _core/}` or `files` for `receipts-` and a `regex not_contains` on `trace` for `not enabled on this machine`. If either fails in any run, mark the whole suite "not measured: enabling failed".
- **Evidence:** `v2-d3.md:97`, `:637`, `:1012`, `:1021–1022`, `:1028`, `:1030`, `:1032`, `:1036`; `v2-d2.md:373`.

### R2-GA-12  —  major
- **Artifact:** D4
- **Location:** Part 3: "Fix codes (F1–F16) are defined in `round-1/defence.md`." Rows R1-PA-10, R1-PR-13, R1-GA-25, R1-RD-01, R1-RD-19: "Accepted in part | See partial rebuttals". The "What was wrong" column, e.g. R1-FC-13 "Each count is wrong in its own way:", R1-EX-06 "Four problems in one step."
- **What is wrong:** The contract says D4 "records every gauntlet finding with severity, accepted or rebutted, the reason, and the round". D4 has no partial-rebuttals section, so for the five rows where the reason matters most, the rebuttal's reason is not in D4 at all. About 100 rows give their reason only as a fix code (`F6g`, `F10`) defined in another file. 127 of 146 "What was wrong" cells are cut mid-sentence with "…", and several cut before any content. D4 Part 3 cannot be read on its own.
- **What breaks if we ship it as-is:** The D4 deliverable fails its acceptance test for the reason column. A reader of D4 cannot tell what was rebutted, or why, without opening `defence.md`. Round 3 reviewers, told to read the D4 ledger to avoid repeats, cannot tell from it what a finding said.
- **Suggested fix:** Add a short "Partial rebuttals" table to D4 (ID, what was accepted, what was rebutted and why, reviewer's reply). Put the F-code legend (one line each) above the ledger. Replace each cut cell with a one-sentence summary.
- **Evidence:** `v2-d4.md:107`, `:120`, `:134`, `:163`, `:238`, `:256`; `grep -c '…'` over the ledger rows returns 127 of 146; `contract.md` D4 row.

### R2-GA-13  —  minor
- **Artifact:** D3 / D4
- **Location:** `round-1/defence.md` F10: "every step has 'If it fails'". D4 ledger rows R1-GA-21 and R1-EX-29: "Accepted | F10". D3 steps 2.1–2.5, 3.1, 3.3, 3.4, 3.6, 4.1, 4.2, 4.4, 4.5, 5.1–5.3, 7.2, 7.4, 7.5, 8.1, 9.4.
- **What is wrong:** 21 steps still have no "If it fails". The ledger records the fix as made. Some of these are code steps the general procedure covers. Others are not: 4.5 (a native scheduler is missing on this harness), 5.3 (no helper agent), and 9.4 (a `[human]` gate with no person available) have outside failure modes and no fallback.
- **What breaks if we ship it as-is:** The D3 spec "a failure procedure per step" is not met, and D4 says it is. An agent at 9.4 with no human has no rule and will either stall or mark the gate passed.
- **Suggested fix:** Add one "If it fails" line to the three steps with outside failure modes, and say once at the top that code steps without one use the general procedure. Correct the ledger.
- **Evidence:** `v2-d3.md` headings at `:565–:1126` (an awk pass over step headings finds 21 without the line); `v2-d4.md:159`, `:233`.

### R2-GA-14  —  minor
- **Artifact:** D2
- **Location:** §10 "What it depends on".
- **What is wrong:** The D2 spec is "names every dependency". The table omits: Claude Code 2.1.277 for `AGENTS.md` (GA-03); Codex 0.167.0 and Antigravity CLI 1.5.2, the floors D3 8.3 and 8.4 rely on for plugin hooks; helper agents, which the catch-up (5.3), the refresh, and the on-project blind check need (5.3 has no no-helper path); Git Bash for the watcher on Windows (mentioned in §5, missing here); and a signed-in Claude account for the paid steps.
- **What breaks if we ship it as-is:** A user on an older Codex or Antigravity sits on the Skills-only rung and the ladder cannot say why. On a harness without helpers the catch-up has no defined behavior.
- **Suggested fix:** Add those five rows with "if missing" answers, and give 5.3 the same "with no helpers, do the steps yourself" fallback that 6.2 has.
- **Evidence:** `v2-d2.md:191`, `:332–339`; `v2-d3.md:842`, `:875`, `:1083`, `:1089`.

### R2-GA-15  —  minor
- **Artifact:** D1
- **Location:** §6 comparison table, e.g. "Harness built-ins alone | Partial | Partial | Partial | Partial | Partial", and "Notes on the cells are in the research files."
- **What is wrong:** The R1-RD-18 fix trimmed the cells to single words and moved the qualifiers out of D1. "Partial" now appears 18 times with no meaning given. A cold reader cannot say what built-ins, the kit, or claude-mem do on Recall or Focus that differs from CORE 4's "Yes". The D1 acceptance test asks the reader to "state … how CORE compares feature-for-feature".
- **What breaks if we ship it as-is:** The comparison reads as a scorecard with no basis. A reader cannot check whether CORE 4's "Recall: Yes" (word matching that the plan expects to fail on paraphrase) beats claude-mem's "Yes", so the D1 test fails for that section.
- **Suggested fix:** Add a note line under the table, one per row, saying what "Partial" means for that row in under 15 words.
- **Evidence:** `v2-d1.md:170–184`; `v2-d4.md` Part 1 item 6.

---

Sound: contract A's three exit codes, the positive planted answers in selftest (7.2), and the judge-ordered step 7.7 are real fixes.

critical 4 · major 8 · minor 3 · taste 0
