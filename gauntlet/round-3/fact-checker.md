# Round 3 — Fact-checker findings (v3)

Reviewer: fact-checker. Drafts read: `v3-d1.md`, `v3-d2.md`, `v3-d3.md`, `v3-d4.md`. I read the round-1 and round-2 reviewer files and the D4 Part 3 ledger first. Nothing below repeats an earlier finding. Where an earlier fix is wrong or incomplete, the finding names the earlier ID.

I fetched the vendor pages in this session with direct `curl` from `code.claude.com/docs/en/*.md`, `antigravity.google/docs/*.md`, and `learn.chatgpt.com/docs/*.md`. I checked CORE 3 claims against the source in this checkout.

---

### R3-FC-01  —  major
- **Artifact:** D3
- **Location:** Step 7.6, case `remember-no-resurrection`: "`tool_used` `Write`, `input_match: '(?i)redis'`, `max: 0`" (v3-d3.md:1121).
- **What is wrong:** This is the fix for R2-EX-17, and it cannot work. The runner's regexes are JavaScript regexes. The docs say inline `(?i)` is not supported, and `tool_used` has no `flags` option. In JavaScript, `(?i)redis` is not a valid pattern ("Invalid group"). So the grader either errors on every run or never matches. If it never matches, a `max: 0` count always passes.
- **What breaks if we ship it as-is:** The anti-resurrection check, which is CORE's own "a removed fact stays removed" rule, either fails every run whatever the agent does or passes every run whatever the agent does. If it always passes, it is a grader that reports success while checking nothing. That is the defect class.
- **Suggested fix:** Use `input_match: '[Rr]edis'`. Add a test in `evals-shape.test.mjs` that compiles every `pattern` and `input_match` with `new RegExp()` and fails on `(?i)`.
- **Evidence:** `https://code.claude.com/docs/en/plugin-evals.md` §Grader types: "`regex` | `pattern`, `flags`, `match`, `target` | The JavaScript regex `pattern` … Put case-insensitivity in `flags: i`; inline `(?i)` isn't supported"; "`tool_used` | `tool`, `input_match`, `min`, `max`". `round-2/executor.md:171` (the R2-EX-17 suggestion this copies).

### R3-FC-02  —  major
- **Artifact:** D3
- **Location:** Step 7.6 grader table: "`llm` | `rubric`, optional `focus`"; "`file_exists` | `glob`, optional `exists: false`"; "`tool_order` | `tools` | Called in that order" (v3-d3.md:1081–1083). Also "one file per grader in `graders/`, YAML frontmatter and a one-line note" (:1075).
- **What is wrong:** This table is the fix for R2-RD-07. Three of its key names do not match the runner:
  - `llm` takes `criteria`, not `rubric`. In the `.md` layout the file body *is* the criteria. D3 tells the builder to put a "one-line note" in the body.
  - `file_exists` takes `path` (a glob), not `glob`.
  - `tool_order` takes `before` and `after`, not `tools`.
- **What breaks if we ship it as-is:** A builder who follows D3 writes `rubric: "PASS if …"` in the frontmatter and a short note in the body. The judge then grades against the note, not the rubric. That includes the gated `proactive-due` case. `setup-new-project` has a `file_exists` grader with no `path`. The runner either rejects these graders or scores them against the wrong text. Either way, scores in the gate stop meaning what GATE.md says they mean.
- **Suggested fix:** Copy the option names from the docs: `llm` → `criteria` (or the body); `file_exists` → `path`, `exists`; `tool_order` → `before`, `after`. In the `.md` layout, the `llm` rubric goes in the body. Have `evals-shape.test.mjs` reject any other key.
- **Evidence:** `plugin-evals.md` §Grader types: "`tool_order` | `before`, `after`"; "`file_exists` | `path`, `exists` | A file Claude created matches the `path` glob"; "`llm` | `criteria`, `focus` | … In the `.md` layout the file body is the criteria". `round-2/reader.md` R2-RD-07.

### R3-FC-03  —  major
- **Artifact:** D1, D2, D3
- **Location:** D2 §1: "near the top of `AGENTS.md`, and of `CLAUDE.md` too when one exists … Claude Code reads `AGENTS.md` only without a `CLAUDE.md`, and only from v2.1.277" (v3-d2.md:80). D1 §7 (:188). D3 3.6: "of `CLAUDE.md` too when one exists". D3 decision 26. D2 §10: "Claude Code 2.1.277+".
- **What is wrong:** The quote is shortened, and the setup rule built on it is wrong. These files also stop Claude Code reading `AGENTS.md`:
  - `CLAUDE.local.md`
  - `.claude/CLAUDE.md`
  - a `CLAUDE.md` in any parent folder
  
  Step 3.6 writes `CLAUDE.md` only "when one exists", so in those projects the block goes only into an `AGENTS.md` that Claude Code never reads. The version floor is also incomplete. Before v2.1.281, Bedrock sessions and sessions with telemetry off read `CLAUDE.md` only. The first session after an upgrade from 2.1.276 or earlier may skip `AGENTS.md` too. Last, the docs' own common setup, a `CLAUDE.md` that holds `@AGENTS.md`, puts both copies of the block in context.
- **What breaks if we ship it as-is:** A user who keeps private notes in `CLAUDE.local.md`, the documented way to do that, gets no block on Claude Code. They also lose its fourth line, the dead-hook warning. That makes a dead CORE silent, which D4 Part 1 §6 names as the risk. `check --project` only compares the two copies, so it cannot see the problem.
- **Suggested fix:** Say Claude Code reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` sits in the folder or above it. When any of those exists, write the block into a project `CLAUDE.md`, creating it if needed. Skip the `CLAUDE.md` copy when it already imports `@AGENTS.md`. Raise the stated floor to 2.1.281.
- **Evidence:** `https://code.claude.com/docs/en/memory.md` §When Claude Code reads AGENTS.md: "**Count, so Claude reads them instead of `AGENTS.md`**: a `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` in your working directory or any directory above it"; "Because `CLAUDE.local.md` counts, adding one … stops Claude from reading `AGENTS.md` for you"; §When AGENTS.md support is unavailable: "Before v2.1.281, some sessions, such as those on Amazon Bedrock or with telemetry disabled, read `CLAUDE.md` files only"; "it's your first session after you upgrade from v2.1.276 or earlier".

### R3-FC-04  —  major
- **Artifact:** D2, D3, D4
- **Location:** D2 §2: "A Claude Code cloud scheduled task you set up once runs `/core:pulse unattended` on the repository" (v3-d2.md:154). D2 §4: "a native scheduled task runs `/core:pulse unattended`". D2 rung table: "not enabled here (e.g. a cloud session with the plugin)" (:203). D2 "not verified": "Whether Claude Code cloud sessions load the plugin" (:430). D4 Part 1 §9: "a cloud session with the plugin gets Layer 1 in full" (v3-d4.md:53). D4 R2-PA-05 "Done instead (4)" (:493).
- **What is wrong:** The docs answer the "not verified" item, and the answer is no. A Claude Code cloud session does not install plugins named in the repository's `.claude/settings.json`, and it does not load plugins enabled only in user settings. Cloud scheduled tasks are fresh cloud sessions. So `/core:pulse` never exists in the one route D2 says runs with the laptop shut. The task always takes step 4.5's fallback, where the model reads the dates, even though D2 says models misjudge dates. There is also no "cloud session with the plugin" outside Projects threads (R3-FC-05). Last, G27's committed copy goes in `.agents/skills/`, which Claude Code does not read. Claude Code cloud sessions do load `.claude/skills/` from the clone and skills enabled on the claude.ai account. The plan rejects the first and never mentions the second.
- **What breaks if we ship it as-is:** D2 §2 shows a check-in that runs CORE's `pulse` and script. What actually runs is a free prompt. For a Claude Code user, R2-PA-05's accepted fix does nothing in the case it was raised for, cloud sessions. That user stays at "Files only" while D4 says they get "Layer 1 in full".
- **Suggested fix:** Write in D2 that Claude Code cloud sessions and cloud scheduled tasks never load the plugin, and drop the "not verified" line. Rewrite the Thursday-evening story around the fallback prompt. Name the two native routes that do work for Claude Code cloud sessions, account-enabled skills and `.claude/skills/`, and either offer one or say plainly that Layer 1 is absent there.
- **Evidence:** `https://code.claude.com/docs/en/cloud-environments.md` §What carries over: "Plugins and marketplaces declared in your repo's `.claude/settings.json` | No | A cloud session doesn't install the plugins a repository turns on"; "Plugins enabled only in your user settings | No"; "Your repo's `.claude/skills/` … | Yes | Part of the clone". `skills.md`: "cloud sessions, including cloud scheduled tasks, don't read `~/.claude/skills/`"; locations table lists `.claude/skills/`, plugin, and "claude.ai account", and no `.agents/skills/`. `memory.md`: "**Not read**: … anything under a `.agents/` directory".

### R3-FC-05  —  major
- **Artifact:** D1, D2
- **Location:** D2 rung table, Files only: "a Claude Code Projects cloud thread (loads `CLAUDE.md`, not skills or plugins)" (v3-d2.md:204). D1 §6: "Its threads skip repository skills, so there CORE is the record and the block [claude-code §8]" (v3-d1.md:180). D2 §11: "Cloud sessions and Projects threads sit low on the ladder".
- **What is wrong:** A Projects thread skips plugins named in `.claude/settings.json`, but it does load plugins added in **Project settings > Plugins**. It also loads skills enabled on the claude.ai account. D1 cites `[claude-code §8]`, and that very section says "Plugins reach threads via settings". With CORE added there, a Projects thread has Layer 1 and the hooks. Its "not enabled" notice then shows because each thread starts on a fresh machine. That puts it on the Skills only rung, not Files only.
- **What breaks if we ship it as-is:** Requirement 3 asks the ladder to name what is lost at each rung. This row names the wrong rung and the wrong loss. D1's comparison with "the closest native rival" rests on a conclusion its own citation contradicts. Also, the `ladder.md` text in step 8.5 never tells a Projects user the one-step route that exists.
- **Suggested fix:** Move Projects threads to "Skills only (if CORE is added in Project settings > Plugins; Files only otherwise)". Say that the enabled list blocks the hooks there. Fix D1 §6 to match.
- **Evidence:** `https://code.claude.com/docs/en/claude-projects.md`: "Plugins: add them in **Project settings > Plugins**; they load into each new cloud thread"; "| Plugins enabled in `.claude/settings.json` | Not loaded. Add the plugin in **Project settings > Plugins** instead |"; "Skills: enable them for your claude.ai account, and cloud threads load the skills you enable there". `research-claude-code.md` §8: "Plugins reach threads via settings."

### R3-FC-06  —  major
- **Artifact:** D3
- **Location:** Contract F: "Key the turn as the first 8 hex characters of SHA-1 of `<conversationId>:<initialNumSteps>`" (v3-d3.md:364). Step 3.4 Accept: "a later call with the same `lastUserInput` but a new `initialNumSteps` → recall runs again" (:690).
- **What is wrong:** This is the fix for R2-HA-13 and R1-HA-16. R2-HA-13 asked for `initialNumSteps` taken *at the first call of a turn*. v3 keys on it for every call. The docs define `initialNumSteps` as "the number of steps currently in the trajectory". Their own example shows `invocationNum: 3` with `initialNumSteps: 10`. The step count grows with each tool call and result inside one turn. So every model call in a turn gets a new key, and the repeat branch only catches exact retries. Step 3.4's test enshrines the wrong behaviour, and step 8.4's fallback runs only if a person with Antigravity takes part.
- **What breaks if we ship it as-is:** On Antigravity, a turn with ten tool calls injects the recall line and pointers ten times. It also writes ten non-repeat `prompt` rows. Those rows feed `no-handoff` (≥ 3 `prompt` rows), the heartbeat, and `metrics`' prompt counts, so all three overcount. Requirement-4 "focus" is broken on that harness. If 8.4 is `BLOCKED`, as D4 expects, this ships.
- **Suggested fix:** Key on `conversationId` plus `lastUserInput` plus the receipt sequence: write a non-repeat row only when `lastUserInput` differs from this conversation's last `prompt` row, or on `invocationNum == 0` if 8.4 shows it restarts per turn. Change step 3.4's Antigravity test to match.
- **Evidence:** `https://antigravity.google/docs/hooks.md` §PreInvocation: "`invocationNum` | integer | The 0-indexed sequence number of the current model invocation"; "`initialNumSteps` | integer | The number of steps currently in the trajectory"; example input `"invocationNum": 3, "initialNumSteps": 10`. `round-2/harness-auditor.md` R2-HA-13 suggested fix: "Key the repeat on `conversationId` plus `initialNumSteps` at the first call of a turn."

### R3-FC-07  —  major
- **Artifact:** D2
- **Location:** §5: "**Under Antigravity's sandbox**, agent-side commands drop to Layer 1 behaviour; hooks run outside it, so brief and recall still work." (v3-d2.md:215). Rung table: "Antigravity with hooks working … Hooked".
- **What is wrong:** "Hooks run outside it" has no source. The cited research lists it as unknown in two places. The sandbox makes invisible anything not mounted, and by default it mounts the workspace and temp folders. The plugin folder (`~/.gemini/config/plugins/…`) and `~/.core` are not mounted. D2's "not verified" list names only the sandbox's effect on agent-side commands. It does not name hooks.
- **What breaks if we ship it as-is:** If Antigravity runs hooks inside the terminal sandbox, the hook cannot read the enabled list under `~/.core`. It then answers "not enabled" or nothing on every Antigravity App session, where the sandbox is on by default. The Hooked rung for Antigravity would really be Skills only, and D2 tells the user the opposite.
- **Suggested fix:** Mark it "not stated by Google; checked in 8.4". Add an 8.4 check that the session-start receipt exists with the sandbox on. Put the Antigravity App at "Skills only, unless 8.4 shows otherwise".
- **Evidence:** `research-antigravity.md:858`: "Whether hook commands themselves run inside the sandbox is not stated."; `:1038` (Unconfirmed list): "7. **Whether hook commands run inside the terminal sandbox.** Not stated."; `:857`: "anything not explicitly mounted is invisible inside the sandbox"; `:885`: Default preset files "Workspace and temp"; `:913`: "a terminal sandbox, enabled by default".

### R3-FC-08  —  major
- **Artifact:** D3
- **Location:** Step 9.4, the v3 comparison: "v3 ignores `EVAL_CORE_ENABLE` and registers projects itself; that is fine." (v3-d3.md:1262).
- **What is wrong:** v3 cannot register a project inside the eval runner:
  1. v3 finds `~/.core` through `os.userInfo().homedir`, the OS account record, which is the maintainer's real home, not the runner's temporary `HOME`.
  2. Registration is a script the model runs through Bash, and the runner sandboxes every Bash command. In that sandbox, writes stay in the workspace and the home folder is unreadable.
  3. v3's per-prompt hook runs outside the sandbox. It reads the real `~/.core/projects.json`, and it acts only on a registered folder.
  
  So in every v3 run the recall hook injects nothing, and v3's startup scripts fail to read or write `~/.core`.
- **What breaks if we ship it as-is:** The "Against v3" release gate compares v4 with a v3 that has its recall hook switched off. The gate passes because v3 was crippled, not because v4 is as good. The report still records it as "met". That is a comparison that reports success while measuring something else.
- **Suggested fix:** Before the v3 run, append each case workspace to v3's registry the way v3's own tests do. `tests/helpers/account-home-preload.mjs` can point `os.userInfo().homedir` at a temp home through `NODE_OPTIONS`, if that variable reaches hooks. Otherwise run the v3 cases with the registry pre-seeded. Then add a `trace` regex for v3's injected recall block and score runs without it "not measured".
- **Evidence:** `plugins/core/skills/core/scripts/trusted-home.mjs:5–8, :28` ("`os.userInfo()` reads the OS account database"; `home = userInfo().homedir`); `grounding.md` §2.9; `source-runtime.md:331`: "Only a folder registered in `~/.core` is read (`retrieve-context-hook.mjs:148-149`)"; `source-runtime.md` Appendix A: "`os.userInfo().homedir` … is the only thing that moves CORE's `~/.core`". `plugin-evals.md` §Grant tools: "When you grant `Bash` in any form, every command runs under Claude Code's OS-level sandbox. Writes are confined to the run's workspace, your home directory and Claude Code configuration are unreadable".

### R3-FC-09  —  minor
- **Artifact:** D2, D3, D4
- **Location:** D2 §7 "Numbers with a stated basis": "Skill listing cost | 400 tokens | Measured by `claude plugin details`." (v3-d2.md:328). D4 Part 2 Q6: "About 400 tokens always on (the skill listing)."
- **What is wrong:** Nothing is built, so nothing has been measured. In D3, 400 tokens is a budget limit (v3-d3.md:141), checked at release in 9.4. D2 puts it in a "basis" column and says "Measured", next to rows honestly marked "Chosen" and "Estimate".
- **What breaks if we ship it as-is:** A reader takes a target for a measurement in the table built to separate the two. This is the plan's own rule, "not measured is never shown as working", broken in prose.
- **Suggested fix:** "Budget; checked by `claude plugin details core` at release (D3 9.4)."
- **Evidence:** v3-d3.md:141 (Budget table: "Skill listing cost | 400 tokens | `claude plugin details core`"); v3-d4.md Part 2 Q8: "**Not measured** until built."

### R3-FC-10  —  minor
- **Artifact:** D1
- **Location:** §4 size table: "2 environment switches (one off-switch, one for test runs) plus 5 project settings" (v3-d1.md:137).
- **What is wrong:** This is the fix for R2-FC-14, and the count matches nothing. Contract J lists seven keys. Four are settings (`recall`, `now_hours`, `archive_after_days`, `active_soft_cap`). Three are one-time answers (`agents_block`, `skills_copy`, `auto_memory_offer`). Neither 4 nor 7 is 5. R2-FC-14 suggested six.
- **What breaks if we ship it as-is:** The "minimal" headline is the one size row a cold reader checks against the contract, and it does not reconcile. `check --plugin` counts switches, not config keys, so nothing will catch the mismatch.
- **Suggested fix:** "2 environment switches plus 4 project settings (and 3 recorded one-time answers) in `_core/config.json`."
- **Evidence:** v3-d3.md:425 (contract J JSON); `round-2/fact-checker.md` R2-FC-14.

### R3-FC-11  —  minor
- **Artifact:** D2, D3, D4
- **Location:** D2 §9: "It keeps MCP, Read, and Write: no tool on today's list that runs a command." (v3-d2.md:367). D3 6.2 (:936). D4 Q14.
- **What is wrong:** This is the fix for R2-FC-04 (G12). It is better, but the list still misses `RemoteTrigger`. That tool "Creates, updates, runs" cloud scheduled tasks, and those run "shell commands" on a fresh clone of the user's repository. It is not in the background-subagent tool set. But in `claude -p` and the SDK, Claude may run a subagent in the foreground "on its own judgment". A foreground subagent inherits every built-in tool except a short list, and that list does not include `RemoteTrigger`. `Artifact`, which publishes a file to claude.ai, also stays available in both modes. D3 also says the helper "keeps Read, Write, Glob, Grep, and MCP tools", which is not the full set.
- **What breaks if we ship it as-is:** Tracker text that says "schedule a task that runs …" reaches a helper that can still start command execution on the user's repository, in the cloud and under the user's account. The claim "no tool that runs a command" is the reason D2 gives for trusting outside text, and `check --plugin` would pass it.
- **Suggested fix:** Use the `tools` allowlist instead: `tools: Read, Write, Glob, Grep, mcp__*`. Have `check --plugin` assert the allowlist, not a denylist that grows with every release.
- **Evidence:** `https://code.claude.com/docs/en/tools-reference.md`: "`RemoteTrigger` | Creates, updates, runs, and lists cloud scheduled tasks … Backs the `/schedule` command"; `routines.md`: "The session runs shell commands"; `sub-agents.md` §Available tools: first-filter list (no `RemoteTrigger`), and background set "`Read`, `Grep`, … `Artifact`"; §Which subagents run in the background: "`claude -p` and the Agent SDK: Claude can wait, on its own judgment".

---

**What checked out.** These new or changed v3 claims match their sources:
- **`CLAUDE_CODE_SESSION_ID`** is set in Bash and in hooks, and it equals the hooks' `session_id` (`env-vars.md`).
- **`Workflow` and the helper.** `Workflow` is removed from every subagent automatically, so leaving it off the helper's list is correct (`sub-agents.md`).
- **The no-instruction-files premise.** The runner loads no `CLAUDE.md` or `AGENTS.md`, which justifies `append_system_prompt` (`plugin-evals.md`).
- **The eval tool grant.** `Agent` and `Skill` are in the runner's read-only grant set.
- **Linux eval prerequisites.** `bubblewrap` and `socat` are both required on Linux.
- **Hooks reference.** The `PreCompact` stdout becomes the compaction summary instructions. Hook output is capped at 10,000 characters, above CORE's 7,200 bytes. `UserPromptSubmit` fires on `/loop` runs, subagent reports, and cross-session messages, and does not mark them.
- **Project `env` can't redirect folders.** Claude Code drops `HOME` and `TMPDIR` set in a project's or local settings' `env` (`settings-reference.md`).
- **Codex.** The 32 KiB shared cap holds, and `AGENTS.md` is skipped only in a project explicitly marked untrusted. `PLUGIN_DATA` reaches hook commands.
- **Antigravity.** The Windows sandbox floor (11 24H2, August 2026 update) and `initialNumSteps`/`invocationNum` existing as fields both match.
- **Cloud scheduled tasks.** They start from the default branch, are in research preview, and run on Pro plans and above.
- **D4 ledger totals.** These match the reviewer count lines: round 1 146 (14 · 81 · 50 · 1), round 2 129 (17 · 81 · 30 · 1).

critical 0 · major 8 · minor 3 · taste 0
