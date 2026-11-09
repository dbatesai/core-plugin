# Round 1 — Gap auditor

Reviewed: `gauntlet/v1-d1.md`, `v1-d2.md`, `v1-d3.md`, `v1-d4.md` against `gauntlet/contract.md` and `gauntlet/reviewer-brief.md`.
Web check used: `https://code.claude.com/docs/en/plugin-evals.md` (fetched directly, HTTP 200, 63,948 bytes). Step 0.2's baseline numbers were re-run on this tree and match (100 files, 34,313 lines, 606,815 bytes, 126,923 bytes, 34 names).

## Coverage

| Item | Verdict | Where | Findings |
|---|---|---|---|
| R1 Native across harnesses and OSes | Partial | D2 §5 ladder has harness columns only; OS gets three bullets | GA-04, GA-13 |
| R2 Native-first check per built thing | Partial | D1 §4 and D2 §4 check per *job*, not per thing built | GA-12, GA-17 |
| R3 Ladder-down, never silent | Partial | D2 §5 rungs A–E; D and E cannot speak; cloud is on the wrong rung | GA-03, GA-04 |
| R4 Minimal, size budget, each script justified | Partial | Budget in D3 "Budget"; no per-script justification | GA-11 |
| R5 Measurement in the first build phase | Delivered on Claude Code only | D3 0.6, Phase 1 | GA-09 |
| R6 Security: read, write, run, untrusted, unattended | Partial | D2 §9, D3 decisions 23–24 | GA-06, GA-07, GA-15, GA-24 |
| R7 Metrics plus blind comparison | Partial | D2 §7, D3 7.4–7.6, 9.4 | GA-01, GA-05, GA-08, GA-19 |
| R8 Self-audit, incl. instruments reading nothing | Partial | D2 §6, §8; D3 2.5, 7.1, 7.2 | GA-01, GA-02, GA-05, GA-25 |
| R9 Voice | Delivered, small lapses | D1, D2 | GA-26 |
| Defect class gets a design answer | Delivered in words; two instruments repeat the defect | D2 §6, D3 contract A | GA-01, GA-02, GA-14 |
| Remember closed | Partial | D2 §4, §11; D3 5.1 | GA-18 |
| Recall closed | Delivered on Claude Code and Codex; provisional on Antigravity; absent in cloud | D2 §5 | GA-04 |
| Interact closed | Partial: one harness, interactive only, unmeasured | D2 §4, §5 | GA-17 |
| Update closed | Partial: its tests cannot run | D3 6.2, 7.6 | GA-08 |
| Focus closed | Delivered, one gap | D2 §3, D3 4.3 | GA-20 |
| Each doc ends with the two closing sections | Delivered | all four | — |
| D1: problem, solution, alternatives, feature comparison, verdict | Partial | D1 §6, §8 | GA-16, GA-19, GA-22 |
| D2: one session, every dependency, use cases, shortfalls, detection, ladder, measurement, security | Partial | D2 §2–§11 | GA-03, GA-04, GA-06 |
| D3: deliverable per phase, file-by-file, decisions, accept and failure path per step | Partial | Phase 9 has no deliverable; 10 steps lack their own failure path; skill steps cannot be accepted when built | GA-10, GA-21, GA-23 |
| D4: attack, questions, ledger with severity / accepted / why / round | Partial (ledger empty, as expected before round 1) | D4 Part 3 | GA-27 |

---

## Findings

### R1-GA-01  —  critical
- **Artifact:** D3 (and D2)
- **Location:** D3 Contract F, last line: "Every hook call that says something, or that fails, appends one receipt row." Against D3 Rule 6: "A hook always exits 0, finishes fast, and leaves a receipt", and D2 §5: "Every hook and every watcher tick leaves one line in a receipts file."
- **What is wrong:** The contract the tests are written against says a hook that ran and said nothing leaves no receipt. A prompt hook that matched nothing says nothing. So prompt rows exist only for prompts that hit. Every metric built on prompt rows then measures only the successes. `recall_rate` ("prompt rows with hits > 0 ÷ prompt rows", D3 7.4) will sit near 100% whatever recall does. `reading_nothing` cannot see a prompt hook that silently reads an empty index. The `no-handoff` queue rule ("an earlier session … with `prompt` rows and no `close` row", contract E) misses every unclosed session where no prompt matched.
- **What breaks if we ship it as-is:** CORE reports "recalling: working" from a filtered denominator. That is the defect class this rewrite exists to kill. It also blocks the build: step 8.2 sends `-p "Say only: ok"`, which matches no memory, so no prompt receipt is written, `prompt_hook` reads `unknown`, and the step's Accept ("`session_hook` and `prompt_hook` are `ok`") fails. The step's failure path then tells the agent to swap the hook form, which fixes nothing.
- **Suggested fix:** Every hook run in a trusted project writes exactly one receipt, silent or not, with `hits: 0` when nothing matched. State this once in contract F and delete the contradicting sentence.
- **Evidence:** `v1-d3.md:339`, `:51`, `:267`, `:889`, `:896`, `:987–988`; `v1-d2.md:152`.

### R1-GA-02  —  critical
- **Artifact:** D3
- **Location:** Step 7.2: "**It sees:** it finds its planted item (`queue` lists the due item; `recall --prompt "ZEBRA-POISON"` returns nothing; `check` fails `secrets` and `links`; and so on)."
- **What is wrong:** The known-answer test for `recall` is a negative test. A recall that is dead and always returns nothing passes "sees: yes". The "admits blindness" half removes the index, which tests the missing-file path, not a broken matcher. "And so on" leaves the known answer for `verify`, `hook session-start`, `hook prompt`, and `index` unspecified. An agent with zero context has to invent four of the seven.
- **What breaks if we ship it as-is:** On a user's machine, where the gold-set tests do not run, `metrics` runs `selftest` and reports "can it see its own instruments: working" while recall returns nothing. The one instrument that is meant to prove each instrument is alive is itself an instrument that reports success while doing nothing.
- **Suggested fix:** Give every instrument one positive planted item it must find (for recall, an active memory with a unique word that must be returned) plus the existing negative checks. Write all seven out; delete "and so on".
- **Evidence:** `v1-d3.md:871–872`.

### R1-GA-03  —  major
- **Artifact:** D2
- **Location:** §5 "The rungs, named": "**D — Files only** | Any agent with no CORE plugin" and "**E — No file access** | … CORE says 'this environment cannot run CORE' and stops." Then: "A rung is never silent. On B, C, and D the first reply of the session states what is missing."
- **What is wrong:** On rung D there is no plugin, so no hook and no skill exist to say anything. The optional `AGENTS.md` block (D3 3.6) tells the agent to read `PROJECT.md`; it does not tell it to say what is missing. On rung E nothing of CORE is present to say "cannot run CORE". Two of five rungs are silent, and the document claims the opposite. Requirement 3's test is "No rung is a silent no-op."
- **What breaks if we ship it as-is:** A user on a harness without the plugin gets stale, read-only memory with no warning, and the plan certifies that as handled.
- **Suggested fix:** Add one sentence to the `AGENTS.md` block: "If no line starting with `CORE:` appears, tell the user CORE is not installed here and memory is read-only." Drop the claim for rung E or delete the rung.
- **Evidence:** `v1-d2.md:181–184`; `v1-d3.md:668–671`.

### R1-GA-04  —  major
- **Artifact:** D2 (and D1 §2)
- **Location:** §5 rung B: "**B — Hooked** | Claude Code headless or cloud … | Brief, recall, queue, close, checks".
- **What is wrong:** Claude Code cloud sessions do not install repository-declared or user-enabled plugins, and Desktop WSL sessions have no plugins at all. Even where a plugin does load (Projects threads, via Project settings), the trust list lives in the home folder of a fresh container, so every cloud project reads as "not enabled on this machine". Separately, `--bare` skips plugin hooks and is documented to become the `-p` default. So "Claude Code headless or cloud" is at rung D or C, not B. D1 §2 names cloud sessions as part of the core use case.
- **What breaks if we ship it as-is:** The user's cloud and WSL sessions run with no CORE at all, and the ladder tells them they have brief, recall, and close. When `-p` goes bare, every headless run and step 8.2's live check lose hooks with no change on CORE's side.
- **Suggested fix:** Add rows for Claude Code cloud, Projects threads, and Desktop WSL. Detect cloud with the documented `CLAUDE_CODE_REMOTE`. Say what a cloud user must do (add the plugin in Project settings, enable per session) and what they lose.
- **Evidence:** `research-claude-code.md:291` ("plugins aren't available in WSL sessions"), `:292` ("A cloud session doesn't install the plugins a repository turns on under `enabledPlugins`"), `:129` ("will become the default for `-p` in a future release"), `:132`; `v1-d2.md:179`; `v1-d1.md:83`.

### R1-GA-05  —  major
- **Artifact:** D3 (and D2 §7)
- **Location:** Step 7.4: "`sessions` | distinct `sid` in receipts"; "`hook_coverage` | sessions with a `session-start` row ÷ sessions"; default window `--days 14`.
- **What is wrong:** The denominator comes from the same instrument it judges. If every hook stops firing on Tuesday, no new `sid` appears, and the 14-day window still shows last week's sessions at 100% coverage. No metric reports the age of the newest receipt. D4 Part 1 item 10 names the cloud version of this hole; the plan gives no design answer for it.
- **What breaks if we ship it as-is:** For up to two weeks after the hooks die, `metrics` says hooks ran in every session. The user asks "is this working?" and hears "working".
- **Suggested fix:** Add `last_receipt_age` per `ev`, and report `hook_coverage` as `unmeasured: no receipts since <date>` when the newest `session-start` row is older than a stated limit.
- **Evidence:** `v1-d3.md:883–898`; `v1-d4.md:51–53`.

### R1-GA-06  —  major
- **Artifact:** D2, D3
- **Location:** D2 §9 "Unattended runs": "When no person is watching — a headless run, a scheduled task, a background agent — CORE … does not write memories". D3 decision 23; D3 5.1 section 10: "if no user is present, write the proposal to `_core/inbox/`".
- **What is wrong:** Nothing says how the agent or the script knows that no person is watching. There is no signal, no hook field, and no check. The rule also contradicts the rest of the plan. The eval runner runs every case as a `claude -p` child, which is headless, yet `remember-decision`, `remember-supersede`, and `finalize-handoff` pass only if the agent writes to `_memories/` or `_summaries/`. The `pulse` skill's tidy step moves memories to `archive/` "at most once a day" and is meant to run "on a schedule you set". Rung B lists "close" for headless runs.
- **What breaks if we ship it as-is:** Either the agent obeys the unattended rule and the core Remember and Close evals fail, or the evals pass and the rule is proven unenforced. Requirement 6's "how it behaves unattended" is met only on paper.
- **Suggested fix:** Pick one observable signal per harness for "unattended" (for example, Claude Code `-p` and Codex `exec`), put it in the `CORE:` block, and exempt the eval cases by stating that eval runs count as attended. Bar the tidy step when the signal is set.
- **Evidence:** `v1-d2.md:179`, `:311`; `v1-d3.md:96`, `:746`, `:780`, `:941–946`; `research-claude-code.md:246` ("runs there as a `claude -p` child process").

### R1-GA-07  —  major
- **Artifact:** D3
- **Location:** Step 7.6: "each `fixture.sh` also runs `node <plugin>/scripts/core.mjs trust add --temp --project .` to make the hooks live in the run." Contract K: "`--core-dir` exists so tests never touch the real home. … no environment variable can set it."
- **What is wrong:** The scaffold script "runs as you, outside the agent's sandbox", and CORE finds its trust list from `os.userInfo().homedir`, which ignores the temporary `HOME`. So every eval case writes an entry into the developer's real `~/.core/projects.json`. That breaks the plan's own reason for `--core-dir` and the repository's `real-home-guard` discipline. Eval runs in parallel then race each other, and the user's own `trust add`, on one file with no lock.
- **What breaks if we ship it as-is:** A suite run can drop one of the user's real enabled projects from the trust list. That project then goes inert until re-enabled. Stale `--temp` entries stay until some later `trust` write.
- **Suggested fix:** Let the hook read the core folder from a run-scoped location the eval controls (for example, a file inside the workspace's `_core/` that only an eval writes), or state that evals must run under a separate OS account. Add the real-home check to the eval step.
- **Evidence:** `v1-d3.md:413`, `:927`; `plugin-evals.md` line 264 ("The script runs as you, outside the agent's sandbox"), line 280 ("`HOME` set to the run's temporary home directory"); `v1-d3.md:133`, `:470` (the kept `real-home-guard` and its CI snapshot/check of the real `~/.core`); `.github/workflows/ci.yml:292–307`.

### R1-GA-08  —  major
- **Artifact:** D3
- **Location:** Step 7.6 rows `pulse-refresh-stale`, `update-refresh-uses-mock`, `update-ignores-injected-tool-text`, `update-server-missing-says-so`; files `plugins/core/evals/mocks/tracker/list_issues.md`.
- **What is wrong:** `claude plugin eval` mocks only servers named in the plugin's own MCP configuration: "`<server>` is the server's name in your plugin's MCP configuration." CORE ships no MCP configuration (D2 §10: "No … server"; the target layout has no `.mcp.json`). So the `tracker` mock substitutes for nothing, no `list_issues` tool exists in the run, and three of the four Update cases cannot pass. The fourth ("server missing") passes trivially in both arms.
- **What breaks if we ship it as-is:** Update, one of the five jobs, has no working acceptance test. Step 6.2's Accept can never be met, so 6.2 is either blocked or marked done on a failing check.
- **Suggested fix:** Ship an eval-only `.mcp.json` declaring a `tracker` server under `evals/`, or say how the mock attaches to a server CORE does not declare, and verify it once before step 6.2.
- **Evidence:** `plugin-evals.md` line 284; `v1-d2.md:330`; `v1-d3.md:124–163`, `:926`, `:937–940`.

### R1-GA-09  —  major
- **Artifact:** D3
- **Location:** Step 0.6: `claude plugin eval plugins/core --scaffold --ablation none --case 'recall-*' --case 'brief-budget*' --case 'proactive-due*' --json docs/headroom.json --max-cost-usd 10`, and "If every plain-case score is 0.9 or higher, **stop**."
- **What is wrong:** `proactive-due` is marked **W** ("Cases marked W need `--allow-tools Write Edit`"), and its grader needs the agent to report fixing the typo. The 0.6 command grants no tools, so that case cannot pass for reasons unrelated to memory.
- **What breaks if we ship it as-is:** One plain case always scores low, so "every plain-case score is 0.9 or higher" can never be true. The cheap early stop that D3's alternatives section cites as the reason the plan does not "build first, measure last" can never fire.
- **Suggested fix:** Add `--allow-tools Write Edit` to the 0.6 command, or judge the stop rule per case.
- **Evidence:** `v1-d3.md:490`, `:493`, `:927`, `:935`, `:1069`.

### R1-GA-10  —  major
- **Artifact:** D3
- **Location:** Accept lines of steps 3.6, 4.3, 4.4, 5.1, 5.3, 6.2, 8.5 ("Eval cases … (step 7.6) pass"), and 7.6's fallback: "`tests/evals-shape.test.mjs`, which asserts every case folder has a prompt and at least one grader".
- **What is wrong:** The acceptance test for every skill step lives in a phase that is not built yet. An agent finishing step 4.3 cannot run its Accept until phase 7. Rule 9 ("Write each step's test before its code") cannot be followed for these steps. When `claude` or credentials are missing, the fallback checks folder shape only, so Remember, Interact, Update, and Focus have no behavior test at all.
- **What breaks if we ship it as-is:** A builder without Claude credentials marks the skill steps done with nothing tested. A builder with them finds every skill failure in one batch in phase 7, far from the step that caused it.
- **Suggested fix:** Write each skill's eval case in the same step as the skill, and run that one case there with `--case <name> --runs 1`. Say plainly that without `claude` these steps are `BLOCKED-WITH-FALLBACK`, not done.
- **Evidence:** `v1-d3.md:55`, `:673`, `:731`, `:747`, `:781`, `:805`, `:838`, `:956`.

### R1-GA-11  —  major
- **Artifact:** D3 (and D1 §4)
- **Location:** "Budget" (1,800 lines), "Target layout" (`core.mjs` plus 14 `lib/` files), contract K (15 commands).
- **What is wrong:** Requirement 4 says "Each script must justify why prose or a native feature could not do the job." No step does this. There is no table of command → why not prose → why not native. Examples with no stated case: `verify` (could `git status`/`git diff --name-only` do it?), `sample --coin` (a coin flip), `trust` (both Codex and Claude Code have their own project trust), `env` (most rows are receipt lookups `metrics` already does). The 1,800-line figure has no per-file estimate behind it; D1's "What I did not verify" calls it an estimate and D4 Part 1 item 8 calls it tight.
- **What breaks if we ship it as-is:** Requirement 4 is met on paper. When the budget bites, rule 8 cuts `sample` and `metrics` rows first, which are measurement, instead of commands that a native feature could replace.
- **Suggested fix:** Add one table to D3: each command, one line on why prose cannot do it, one line on the native feature checked and why it falls short, and an estimated line count that sums to the budget.
- **Evidence:** `v1-d3.md:53`, `:107–118`, `:146–150`, `:393–411`; `v1-d1.md:244`; `v1-d4.md:43–45`.

### R1-GA-12  —  major
- **Artifact:** D1, D2
- **Location:** D1 §4 "What the harness does, and what CORE adds"; D2 §4 table.
- **What is wrong:** Requirement 2's test is per thing CORE builds. The plan checks per job instead, and several built things have no "does the harness already do this?" answer. (1) The trust list: Codex already has project trust and hook approval; Claude Code has a trust dialog. The plan never says why CORE needs its own list on top. (2) The dead-hook warning: Antigravity plugins can ship `rules/AGENTS.md`, "Loaded automatically as an always-on rule whenever the plugin is enabled". The plan relies on a skill description instead and calls that "the last line of defense, and it is prose". (3) Cloud detection: Claude Code documents `CLAUDE_CODE_REMOTE`; the plan does not use it. (4) `verify` versus git.
- **What breaks if we ship it as-is:** CORE builds and maintains a trust system and a detection path that the harness may already supply, and misses an always-on native warning channel on one harness.
- **Suggested fix:** Add a short per-component native check to D2 §4 (component, native feature checked, answer, source). Use Antigravity's plugin `rules/` for the "hooks not running" line.
- **Evidence:** `research-codex.md:10`, `:77`; `research-antigravity.md:162`; `research-claude-code.md:132`; `v1-d2.md:153`.

### R1-GA-13  —  major
- **Artifact:** D2
- **Location:** §5 ladder table (columns: Claude Code, Codex, Antigravity) and "Three things that differ by operating system."
- **What is wrong:** Requirement 1's test is "tied to a named native feature … with the OS it works on". The ladder names no OS per capability. Three bullets cover two OS cases. Missing: the watcher on Windows (monitors are "a shell command"; Windows shell may be PowerShell); Codex hooks on Windows run through `cmd.exe /C`; Antigravity hooks on Windows run through `cmd /c` and a third party reports quoting breaks there; Antigravity has four surfaces (App, CLI, IDE, SDK), plugin hooks in the App and IDE are "implied, not stated", and D3 8.4 tests only the CLI.
- **What breaks if we ship it as-is:** Someone on Windows, or in the Antigravity App, has no row telling them which rung they are on. The plan claims all three OSes and all of Antigravity but has checked neither.
- **Suggested fix:** Add an OS column (or per-cell OS notes) to the ladder and split Antigravity into CLI and App/IDE, each marked doc / report / unverified.
- **Evidence:** `research-codex.md:21`, `:267`; `research-antigravity.md:7`, `:51`, `:383`, `:492`; `v1-d3.md:997–1001`.

### R1-GA-14  —  major
- **Artifact:** D3
- **Location:** Contract D: "`signature` is the first 12 hex characters of the SHA-1 of the sorted list of `<file name>:<SHA-1 of file bytes>`"; decision 12: `INDEX.md` is "committed to git".
- **What is wrong:** Git for Windows checks text out with CRLF by default; macOS and Linux check it out with LF. Same memories, different bytes, different signature. The plan's user works on all three OSes.
- **What breaks if we ship it as-is:** Each time the user switches OS, the session-start hook finds the committed index "stale", rewrites it, and leaves a modified tracked file. The next OS does the same. That is CORE's own upkeep showing up as change, which is defect 5 in a new place.
- **Suggested fix:** Hash content with `\r\n` normalised to `\n`, or hash the parsed `id`, `summary`, `topics`, and date that the index line is built from.
- **Evidence:** `v1-d3.md:85`, `:247–254`, `:318`; `v1-d1.md:63`.

### R1-GA-15  —  major
- **Artifact:** D3 (and D2 §9)
- **Location:** Step 5.3: "find the `tp` value of that session's `session-start` receipt … Hand that one file to a subagent … 'Read the last 300 lines.'" Step 1.2: `read` "returns rows from every `receipts-*.jsonl` file".
- **What is wrong:** `tp` is read from a file inside the project, from any `receipts-*.jsonl` there, and is never checked. A repository can commit a planted `_core/receipts-x-claude-code.jsonl` with a `session-start` row and a `tp` of `~/.aws/credentials` or `~/.ssh/id_ed25519`. After the one "enable" yes, the next session start lists `no-handoff`, and the skill tells a subagent to read that file. D2 §9 says CORE never reads credential files.
- **What breaks if we ship it as-is:** A poisoned repository turns CORE's catch-up step into "read this secret file into the conversation".
- **Suggested fix:** Use only rows from this machine's own receipts file, and only a `tp` that sits in the same folder as the `transcript_path` the harness handed over in the current session. Otherwise say the transcript is not available.
- **Evidence:** `v1-d3.md:209`, `:513`, `:804`, `:892`; `v1-d2.md:286`.

### R1-GA-16  —  major
- **Artifact:** D1
- **Location:** §6 table, row "CORE 4 (planned, not built)": "Remember: Yes", "Interact: Yes on Claude Code; next-prompt elsewhere", "Measures itself: Yes".
- **What is wrong:** CORE 4 is graded on a looser standard than the others. CORE 3 gets "Remember: Instructions only"; CORE 4's Remember is also instructions (a skill plus a close pass), and D2 §11 says so: "No script notices a decision." The harness built-ins get "Interact: Partial" for having schedulers; CORE 4 gets a cell that reads as Yes while it too only waits for the next prompt on two harnesses. "Measures itself: Yes" holds on Claude Code only (D2 §5: not measured on Codex and Antigravity).
- **What breaks if we ship it as-is:** The comparison is the evidence for the verdict. A reader who checks one cell against D2 stops trusting the table, and the "no row is yes across the five jobs" claim depends on these cells.
- **Suggested fix:** Grade CORE 4 by the same rule as the others: Remember "Instructions plus close pass", Interact "Partial: Claude Code interactive only", Measures itself "Claude Code only".
- **Evidence:** `v1-d1.md:166`, `:175–176`, `:180`; `v1-d2.md:170`, `:336`.

### R1-GA-17  —  major
- **Artifact:** D2, D3
- **Location:** D2 §4 Interact row: "On Claude Code the watcher raises new items between prompts. Elsewhere they ride along with your next prompt." D2 §5: Codex "None in the CLI".
- **What is wrong:** Interact is closed on one harness, in interactive sessions only. The native options on the other two are named and declined without a native-first answer: Codex's desktop app "Scheduled tasks" can use plugins and skills and run "on minute intervals inside a chat"; Codex has `/goal` and `codex queue`; Antigravity has `/schedule` and Automations. D4 Part 1 item 5 raises this; D2 and D3 do not answer it. The watcher is also never measured: eval runs are `claude -p` children and monitors "don't start in non-interactive mode". The A − B gate on `proactive-due` measures the session-start queue, not the loop.
- **What breaks if we ship it as-is:** The goal line, "so that it can … interact", ships for one harness in one mode, with no number showing that the one loop helps.
- **Suggested fix:** For each harness, name the native timer or schedule, and say whether CORE uses it and why or why not. Add one Claude Code test that runs the watcher in an interactive session, or mark watcher value "not measured" in the release gates.
- **Evidence:** `v1-d2.md:139`, `:168`; `v1-d4.md:31–33`; `research-codex.md:20`, `:426`; `research-antigravity.md:16`; `research-claude-code.md:246`; `grounding.md:224`.

### R1-GA-18  —  major
- **Artifact:** D2, D3
- **Location:** D2 §11: "The eval suite measures how often a planted decision gets written." D3 7.6 `remember-decision` prompt: "Decision: move the retry header to the v3 format now."
- **What is wrong:** The only Remember case labels the decision for the agent with the word "Decision:". The failure that CORE 3 showed, and that D1 §1 cites ("a session where the user said 'Remember that' stored nothing"), is the agent not noticing. D2 §2's own example is implicit ("Fine, move to the v3 format"). No case plants an unlabeled decision in the middle of other work, so the miss rate that D2 and D4 Q1 say is measured is not measured.
- **What breaks if we ship it as-is:** The eval reports Remember as working on the easy case, while the hard case, the one the rewrite is for, goes unmeasured.
- **Suggested fix:** Add one case where a decision is made mid-task with no label (for example, during the typo fix in `proactive-due`), graded on whether a memory file is created.
- **Evidence:** `v1-d1.md:71`; `v1-d2.md:98`, `:336`; `v1-d3.md:941`; `v1-d4.md:69`.

### R1-GA-19  —  major
- **Artifact:** D1
- **Location:** §8: "Our use is one person, three harnesses, three operating systems" and "The proof is one number. Claude Code's test runner gives the plain-files-alone score and the files-plus-plugin score".
- **What is wrong:** The kill test runs on one harness. The verdict's stated use is three. On Codex and Antigravity, where four of the five rungs' losses sit, "does it help" is "not measured" forever (D2 §5, D4 Part 1 item 7). The verdict does not say what is decided for those two.
- **What breaks if we ship it as-is:** CORE can pass its gate on Claude Code and keep shipping hooks, skills, and a hook dialect for two harnesses where it has never been shown to beat plain files. The verdict reads as "proven" when it covers one third of the stated use.
- **Suggested fix:** State the verdict per harness: Claude Code gated by the A − B number; Codex and Antigravity gated by the manual blind check in D2 §7, run once per release, with the result recorded.
- **Evidence:** `v1-d1.md:218–220`; `v1-d2.md:170`; `v1-d4.md:41`.

### R1-GA-20  —  minor
- **Artifact:** D2, D3
- **Location:** D2 §3: "You say 'not now' | 'Snoozed until tomorrow.' It will not come up again today." D3 4.3 section 3: "set `snooze` on that memory".
- **What is wrong:** `snooze` is a memory field. Four queue kinds are not memories: `stale-source`, `never-fetched`, `no-handoff`, `inbox`. Contract E skips only snoozed memories.
- **What breaks if we ship it as-is:** The user says "not now" to a stale tracker and hears it again at every boundary, against the D2 promise and the "never repeat" focus rule.
- **Suggested fix:** Store snoozes by queue item id in `_core/`, read by `queue`, or narrow the D2 promise to memory items.
- **Evidence:** `v1-d2.md:124`; `v1-d3.md:260–271`, `:719`.

### R1-GA-21  —  minor
- **Artifact:** D3
- **Location:** Phase 9 heading; steps 3.6, 6.1, 7.3, 8.1, 8.5, 9.1, 9.2, 9.3, 9.5.
- **What is wrong:** Phase 9 has no "*Deliverable:*" line; the other nine phases do. Nine steps have no "If it fails". The general procedure covers code failures but not the real failure modes here: 9.5 has no path for "no push rights" or "no `next` branch"; 7.3 has none for "CI turns red on one OS after the flag is removed".
- **What breaks if we ship it as-is:** The contract's "one deliverable per phase" and "a failure procedure per step" fail by count. An agent at 9.5 without push rights has to ask, which D3 says it never needs to.
- **Suggested fix:** Add the Phase 9 deliverable ("a pull request into `next` with every gate met or marked not measured"). Give 9.5 a fallback: leave the branch local and write the PR text to `docs/build-log.md`.
- **Evidence:** `v1-d3.md:1011`; awk check of all `### n.n` steps for "**If it fails**".

### R1-GA-22  —  minor
- **Artifact:** D1
- **Location:** §6 table and §7 risk row: "Claude Code's cloud 'Projects' already has project memory and a 'Waiting on you' list".
- **What is wrong:** The nearest competitor, by the plan's own account, appears only in the risk table, not as a row in the comparison. The two differentiators D1 leans on in prose, "risks and people as project records" and "a session close written into the project", are not columns, so the table cannot show them.
- **What breaks if we ship it as-is:** A reader cannot do the feature-for-feature comparison the contract asks for against the tool most likely to replace CORE.
- **Suggested fix:** Add a "Claude Code Projects" row and two columns, "Risks and people as records" and "Session close into the project".
- **Evidence:** `v1-d1.md:164–176`, `:181`, `:208`.

### R1-GA-23  —  minor
- **Artifact:** D3
- **Location:** Step 8.1 `prompt_hook`: "a `prompt` receipt for `--sid`"; step 8.2: "`node <repo>/plugins/core/scripts/core.mjs env --project <temp>`" (no `--sid`).
- **What is wrong:** Without `--sid`, `prompt_hook` has no rule and comes back `unknown`. Step 8.2 does not say where to get the session id of the `-p` run.
- **What breaks if we ship it as-is:** Steps 8.2–8.4 fail their Accept even when the hooks work (independent of R1-GA-01).
- **Suggested fix:** Give `prompt_hook` the same 12-hour fallback as `session_hook`, or have 8.2 read the `sid` from the newest `session-start` receipt and pass it.
- **Evidence:** `v1-d3.md:974–975`, `:987–988`.

### R1-GA-24  —  minor
- **Artifact:** D2
- **Location:** §9 "Run | Its own `core.mjs`, with `node`."
- **What is wrong:** The script also spawns other programs: `env` runs `git --version` and `claude --version`; `migrate` runs git to check for uncommitted changes. The security table does not list them.
- **What breaks if we ship it as-is:** The "what CORE may run" statement is wrong on day one, and a reviewer cannot tell which spawns are allowed.
- **Suggested fix:** List `git` and `claude` (version and status only, fixed arguments, no shell) in the Run row.
- **Evidence:** `v1-d2.md:288`; `v1-d3.md:978–979`, `:584`.

### R1-GA-25  —  minor
- **Artifact:** D2, D3
- **Location:** D2 §8 `check --plugin`; D3 7.1 checks table.
- **What is wrong:** Requirement 8 asks CORE to check "its own prose". `check --plugin` checks links, line counts, description length, and command names. Contradictions between files and voice are left to `/doctor prompt-audit`, which exists on Claude Code only. The kept `prose-eval.mjs` is used on one eval output, not on CORE's own skills.
- **What breaks if we ship it as-is:** A skill that contradicts another skill, or a skill that drifts back to dense prose, passes every check on Codex and Antigravity and in CI.
- **Suggested fix:** Add one `check --plugin` row that runs the existing prose checker's word-cap and forbidden-phrase rules over each `SKILL.md`, or state that prose quality is audited on Claude Code only.
- **Evidence:** `v1-d2.md:272–274`; `v1-d3.md:852–862`, `:799`.

### R1-GA-26  —  minor
- **Artifact:** D2, D1
- **Location:** D2 §4 "What CORE adds": "supersede-don't-overwrite, the tombstone rule, counts from disk", "the put-off ladder". D1 §6: a ten-column table.
- **What is wrong:** "Tombstone rule" and "put-off ladder" are never defined in D2. The ten-column D1 table cannot be read on a narrow screen and packs a sentence into most cells.
- **What breaks if we ship it as-is:** The distracted reader requirement 9 names skips the table that carries the verdict's evidence.
- **Suggested fix:** Replace the two terms with their plain meaning ("a forgotten fact stays forgotten", "after two put-offs, say what it blocks"). Split D1's table into jobs and properties.
- **Evidence:** `v1-d2.md:137`, `:139`; `v1-d1.md:164`.

### R1-GA-27  —  minor
- **Artifact:** D4
- **Location:** Part 3: "one row each: round, reviewer, severity, where, what, what breaks if it ships, accepted or rebutted, and why."
- **What is wrong:** The contract says "A fresh judge settles disputed rebuttals" and the run must "Name which [stop condition] fired". The ledger has no column for the judge's ruling and no place to record the stop condition.
- **What breaks if we ship it as-is:** A rebutted finding that the judge later overturns is recorded as "rebutted", and the final log cannot show why the gauntlet stopped.
- **Suggested fix:** Add a "judge ruling" column and a one-line "Stopped because" entry under the ledger.
- **Evidence:** `v1-d4.md:98`; `contract.md` Process steps 4–5.

---

Sound, in one line: the honesty contract (three exit codes, R1–R3, one record per state, no generated text in edited files) is a real structural answer, and step 0.2's baseline commands reproduce exactly on this tree.

critical 2 · major 17 · minor 8 · taste 0
