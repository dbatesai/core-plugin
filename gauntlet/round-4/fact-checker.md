# Round 4 — Fact-checker findings (v4)

Reviewer: fact-checker. Drafts read: `v4-d1.md`, `v4-d2.md`, `v4-d3.md`, `v4-d4.md`. I read the reviewer files in rounds 1–3 and the D4 Part 3 ledger (fix codes H1–H18) first. Nothing below repeats an earlier finding. Where an earlier fix is wrong or incomplete, the finding cites the earlier ID.

I fetched the vendor pages in this session with direct `curl` from `code.claude.com/docs/en/*.md` and `antigravity.google/docs/*.md`, plus one Codex source file from `raw.githubusercontent.com/openai/codex/rust-v0.167.0/`. I checked the CORE 3 numbers against this checkout.

---

### R4-FC-01  —  critical
- **Artifact:** D3 (and D2, D4)
- **Location:** D3 step 1.1: "Claude Code appends it to `CLAUDE.local.md` (created if missing, added to `.git/info/exclude` unless Git ignores it)" (v4-d3.md:666). Contract B: "`CLAUDE.local.md` per machine, uncommitted: the liveness line" (:261). D2 §1: "`CLAUDE.local.md` on Claude Code" (v4-d2.md:86). D4 H12.
- **What is wrong:** This is the H12 fix for R3-FC-03, and it brings back the problem R3-FC-03 raised. The plan states the fact itself: "any `CLAUDE.md` or `CLAUDE.local.md` in or above the folder stops Claude Code reading `AGENTS.md`" (v4-d1.md:195). It then creates a `CLAUDE.local.md` in every project where the user says yes to the liveness line. The docs warn about exactly this case. Claude Code then stops reading the project's `AGENTS.md`. That file holds the user's own instructions and CORE's Codex block. Rules files are safe because they do not count; `CLAUDE.local.md` does count.
- **What breaks if we ship it as-is:** Take a project that runs on Claude Code and Codex, which is CORE's target user. Its build commands and conventions live in `AGENTS.md`. The user says yes to CORE's offer. From the next session on, every Claude Code session on that machine silently loses all of `AGENTS.md`. CORE caused the loss. `check --project` does not look for it, and the record test cannot see it, because its temp project has no `AGENTS.md`. A plugin whose defect class is "silently doing nothing" makes the harness silently drop the user's instructions.
- **Suggested fix:** Never create `CLAUDE.local.md`. Put the liveness line in a second rules file, such as `.claude/rules/core-local.md`, listed in `.git/info/exclude`. Rules files do not count against `AGENTS.md`. Or put it in `~/.claude/rules/core.md`; the line already limits itself to "a project with a `_memories/` folder".
- **Evidence:** `https://code.claude.com/docs/en/memory.md` §AGENTS.md table: "An `AGENTS.md` and a `CLAUDE.md` or `CLAUDE.local.md` in your working directory or above it | Your `CLAUDE.md` files only"; "**Don't count, and keep loading alongside `AGENTS.md`**: your `~/.claude/CLAUDE.md`, … and `.claude/rules/` files"; "Because `CLAUDE.local.md` counts, adding one to keep your own uncommitted instructions in a project that relies on `AGENTS.md` stops Claude from reading `AGENTS.md` for you."

### R4-FC-02  —  major
- **Artifact:** D3 (and D2, D4)
- **Location:** D3 1.8, helper frontmatter: "`tools: Read, Write, Glob, Grep, mcp__*`" (v4-d3.md:824). D3 6.1 `helper-tools` check: "its `tools` line is not exactly `Read, Write, Glob, Grep, mcp__*`" (:1140). D2 §9: "a `tools` allowlist (`Read, Write, Glob, Grep, mcp__*`)" (v4-d2.md:379). D4 H10, Q14.
- **What is wrong:** This is the H10 fix for R3-FC-11, which suggested this exact line. The docs give no form of `tools` that grants every MCP server's tools. The documented `tools` entry for MCP names one server: `mcp__<server>__*`. A bare `mcp__*` appears only as a `disallowedTools` or deny entry. For allow-side rules, the permissions page says an unanchored `mcp__*` is skipped. A plugin file cannot name the server either, because every user's tracker server has a different name. Most likely the helper starts with Read, Write, Glob, and Grep only. If no entry had resolved at all, it would refuse to launch.
- **What breaks if we ship it as-is:** On Claude Code, the refresh helper cannot call the tracker's tool. Every refresh then ends `fetch_status: failed` or "not connected", so Update does not work on Claude Code. `check --plugin` asserts the broken line exactly, so the audit locks the bug in. Step 1.8's fallback is "if Claude Code rejects a frontmatter line, remove it". Removing `tools` gives the helper every tool, Bash included. That undoes the security fix.
- **Suggested fix:** Have the main agent call the MCP tool, under the harness's own prompts, and save the raw output to a file. The helper then gets `tools: Read, Write` only and turns that file into the digest. Or write `mcp__<server>__*` into a per-project helper when the source is registered. Either way, test it before `check --plugin` asserts it.
- **Evidence:** `https://code.claude.com/docs/en/sub-agents.md`: "| Give the subagent every tool from one server | `tools` | `mcp__github__*` |"; "| Withhold every MCP tool from any server | `disallowedTools` | `mcp__*` |"; "If no entry in the list resolves to a tool, the subagent usually fails to launch". `https://code.claude.com/docs/en/permissions.md` §Tool name wildcards: "Allow rules accept tool-name globs only after a literal `mcp__<server>__` prefix … An unanchored allow glob such as `"*"`, `"B*"`, or `"mcp__*"` is skipped".

### R4-FC-03  —  major
- **Artifact:** D3 (and D2)
- **Location:** D3 1.2: "`allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/core.mjs *)`" (v4-d3.md:681). Contract K: "Run it as `node "<path>" <command>`", with the path taken from the status block's double-quoted `script:` line (:500). D3 2.1/7.2, record-test full arm: "No blanket `Bash(node *)`: on full, the skills' own `allowed-tools` admit the script" (:893). D2 §9: "where skills pre-approve exactly that command" (v4-d2.md:368).
- **What is wrong:** This is the H16 fix for R3-HA-08. It fails in two ways the docs state.
  1. A skill's `allowed-tools` grant lasts only for the turn that invokes the skill, and it "clears when you send your next message". Script calls in any other turn are not covered. Those include the `core` brief's `queue`, the `recall --prompt` before an answer about the past, and the `index` after a `remember`.
  2. Bash rules match "everything before the first `*` as written". The prescribed command `node "/…/core.mjs" queue` has quotes the rule lacks. On Windows, the rule has backslashes and the status block has forward slashes (H16).

  In `claude -p` with no permission mode, a call that is not pre-approved is denied, not asked. D3 knows the quote risk: its fix is in step 8.2 (:1358). But 8.2 runs in phase 8, after 7.2 has already measured the full arm.
- **What breaks if we ship it as-is:** In the record test's full arm (7.2), the agent's script calls are denied without a word. Full then runs on the skills' no-script paths: no `close` receipts and no `how: finalize`. The hook rule "neither hook is kept if full trails layer 1" is then decided on a full arm whose script never ran, and it is recorded as measured. That is an instrument reporting a result while measuring something else. For users in default mode, every script call outside the skill's own turn prompts, which R3-HA-08 was meant to stop.
- **Suggested fix:** Move 8.2's quote check before 7.2. Write the rule and the command in one form: unquoted with forward slashes, or quoted in both. In the record test, fail a repetition when any `Bash` call to `core.mjs` was denied, and say plainly that the grant covers only the skill's own turn.
- **Evidence:** `https://code.claude.com/docs/en/skills.md`: "`allowed-tools` | … Tools Claude can use without asking permission during the turn that invokes this skill. The grant clears when you send your next message." `permissions.md` §Wildcard patterns: "Claude Code matches everything before the first `*` as written". `headless.md`: "In a Manual mode `claude -p` run, a call that needs approval is denied unless something approves it".

### R4-FC-04  —  major
- **Artifact:** D1, D2, D3
- **Location:** "Measurement: Claude Code 2.1.269 or newer" (v4-d1.md:195); D2 §10 "Claude Code 2.1.269+ | Both tests" (v4-d2.md:405); D3 0.6 and 7.1 "below 2.1.269" (v4-d3.md:631, 1317); 8.1 `native_eval` "≥ 2.1.269" (:1346). The gate depends on "drops runs with `error` set" (2.2) and "An errored run is 'not measured'" (D2 §7).
- **What is wrong:** 2.1.269 is when `claude plugin eval` appeared. The behaviour the gate relies on came later:
  - **v2.1.299.** A run that ended on an API error (rate limit or plan usage limit) "scored 0 without grading". Before v2.1.299, such a run "was graded on what it had produced".
  - **v2.1.283.** The runner refuses an old git that would leave repository hooks and credential helpers running. Before v2.1.283, it ran anyway.
  - **v2.1.283.** `/doctor prompt-audit`, which `metrics` names, needs this version too (R1 fact-checker's verified list).
- **What breaks if we ship it as-is:** The gate runs 10 runs per arm per case, on several arms, on one person's plan. On 2.1.269–2.1.298, a run cut off by a usage limit is graded on half-done work. `cells.mjs` then counts it as a real low score, not "not measured". The arm that ran when the limit hit loses points it never earned, and the gate records a result that measured the rate limit. That is the defect class.
- **Suggested fix:** Set the measurement floor to 2.1.299 in D1, D2 §10, D3 0.6, 7.1, and 8.1's `native_eval`. Have `cells.mjs` record the `claude --version` that produced each results file.
- **Evidence:** `https://code.claude.com/docs/en/plugin-evals.md` §"ended on an API error and scored 0 without grading": "Such a run scores 0 with no grader results … Before v2.1.299, such a run was graded on what it had produced." §"is too old for claude plugin eval": "Before v2.1.283, `claude plugin eval` didn't check the git version, and on an older git the suite ran with those programs left on." Requirements: "Claude Code v2.1.269 or later".

### R4-FC-05  —  major
- **Artifact:** D1, D2 (and D4)
- **Location:** D1 §6: "A Projects thread loads CORE's skills if CORE is added in Project settings > Plugins; hooks do not run there [claude-code §8]" (v4-d1.md:187). D2 rung table, Skills only: "a Projects thread with CORE added in Project settings > Plugins, where hooks do not run [research-claude-code §8]" (v4-d2.md:219). D4 H11.
- **What is wrong:** This is the H11 fix for R3-FC-05, and it adds a claim that no source supports. R3-FC-05 said a plugin added in Project settings brings its hooks. The cited section says that Project threads skip *repository* hooks, the ones in `.claude/settings.json`. The Projects page says the same: "Hooks in `.claude/settings.json` | Not run". It says plugins added in Project settings "load into each new cloud thread", and nothing about their hooks being stripped. The same research file says plugin mod hooks "run in every kind of session that loads the plugin". It lists plugin hooks in cloud sessions as unconfirmed.
- **What breaks if we ship it as-is:** Requirement 3 asks the ladder to name what is lost and how the user is told. If plugin hooks run in a Projects thread, each thread starts on a fresh machine, so it is never enabled. The user then gets the "not enabled on this machine. Say 'enable CORE here'" line in every thread. Saying it writes `~/.core` on a machine that is thrown away. The ladder says "hooks do not run" and lists nothing in "How you are told" for this case. D1's rival comparison repeats the same unsourced claim.
- **Suggested fix:** Write "plugin hooks in Projects threads: not stated; each thread is a fresh machine, so they would only print the not-enabled line". Add that line to the "How you are told" cell. Have the session-start hook say nothing when `CLAUDE_CODE_REMOTE` is `true`.
- **Evidence:** `https://code.claude.com/docs/en/claude-projects.md`: "| Plugins enabled in `.claude/settings.json` | Not loaded. Add the plugin in **Project settings > Plugins** instead |"; "| Hooks in `.claude/settings.json` | Not run. …"; "Plugins: add them in **Project settings > Plugins**; they load into each new cloud thread." `research-claude-code.md:224` ("Project threads skip repo hooks, skills, `.mcp.json`"); `:302` ("A mod's hooks run in every kind of session that loads the plugin"); `:315` (Unconfirmed: whether an account plugin "loads, with hooks, in a plain cloud session").

### R4-FC-06  —  major
- **Artifact:** D3 (and D2 §9)
- **Location:** D3 1.8, Antigravity helper frontmatter: `tools: [...]`, `commandExecutionPolicy: off`, `inheritMcp: true`, with no `inheritCustomizations` and no `mainAgent` (v4-d3.md:834–843). D2 §9: "On Antigravity, CORE ships its own helper file with command execution off".
- **What is wrong:** On Antigravity, a plugin agent's `inheritCustomizations` defaults to `true`, and that inherits "skills, rules, and hooks". So the helper that reads untrusted tracker text also runs CORE's own `SessionStart`, `PreInvocation`, and `Stop` hooks, and loads its rules. `mainAgent` also defaults to `true`, so the helper shows up as an agent the user can pick as their main session agent.
- **What breaks if we ship it as-is:** Each refresh is a conversation of its own. If CORE's hooks fire in it, CORE puts memory pointers and "item needs you" lines into the helper's context, next to outside text. It also writes `prompt` rows under the helper's `conversationId`, with no `close`. After 2 hours, contract E's `no-handoff` rule (≥ 3 `prompt` rows, no `close`) turns each multi-call refresh into an "unclosed session". The catch-up helper then reads the refresh transcript, outside tool text included, and writes proposals from it. The queue fills with false alarms, and outside text gets a path into `_core/inbox.md`.
- **Suggested fix:** Add `inheritCustomizations: false` and `mainAgent: false` to the Antigravity helper. Have the `skills-shape` test assert both.
- **Evidence:** `https://antigravity.google/docs/build-plugins.md` agent table: "| `inheritMcp` / `inheritCustomizations` | `true` | Controls whether the agent inherits workspace MCP servers (`inheritMcp`) and skills, rules, and hooks (`inheritCustomizations`). |"; "| `mainAgent` | `true` | When `true`, users can select this agent as their primary session agent …". v4-d3.md Contract E `no-handoff` row.

### R4-FC-07  —  minor
- **Artifact:** D2, D3, D4
- **Location:** D2 §7: "Ten would be 1,200 paid calls on one person's account; six is 720" (v4-d2.md:309); D2 alternatives (:434); D3 alternatives (v4-d3.md:1461); D4 Part 1 §1 "about 720 calls" (v4-d4.md:21); D4 rebuttal of R3-PR-06 (:644). Against D3 2.3: "about 41 calls per arm per repetition, 738 in all" for three arms (v4-d3.md:910).
- **What is wrong:** The 720 figure counts only the 30 session calls (10 sessions × 3 turns). D3's own count adds the control call, 5 probes, and 5 grader calls, for 41 per arm per repetition. Four arms at six repetitions is 984 calls, not 720. Ten repetitions is 1,640, not 1,200. The `--long` runs come on top.
- **What breaks if we ship it as-is:** The maintainer budgets for about a third fewer calls than the plan spends. D4's rebuttal of R3-PR-06 weighs 1,200 against 720. The real choice is 1,640 against 984, and the reader judges the rebuttal on the wrong numbers.
- **Suggested fix:** Use D3's basis everywhere: "about 41 calls per arm per repetition: 984 for four arms at six repetitions, 1,640 at ten, plus the long sessions."
- **Evidence:** v4-d3.md:893–895 (control, three turns per session, probes, blind grader); :910.

### R4-FC-08  —  minor
- **Artifact:** D3
- **Location:** 0.6: "Exit 2 means the cost cap stopped it: log the cases that never started as not measured; do not rerun." (v4-d3.md:627)
- **What is wrong:** Exit 2 also means the credential was rejected before or at the first run. The JSON then says `partialReason: auth_failed`, not `cost_ceiling`.
- **What breaks if we ship it as-is:** If the sign-in has expired when the kill-test eval runs (2.3 step 3), every case is logged as stopped by the cost cap, and the rule says not to rerun. The kill test reads "not measured", so the build stops. The build log gives the wrong reason, when signing in again and rerunning would have fixed it.
- **Suggested fix:** On exit 2, read `partialReason`. `cost_ceiling` → as written. `auth_failed` → sign in again and rerun once. Anything else → log it as not measured with that reason.
- **Evidence:** `plugin-evals.md` exit codes: "| 2 | Partial run: the `--max-cost-usd` ceiling was hit, or your credential was rejected before or at the first run. `results.json` is still written with `partial: true` and the reason |"; result fields: "`partial`, `partialReason` | `true` with `cost_ceiling`, `interrupted`, or `auth_failed`".

### R4-FC-09  —  minor
- **Artifact:** D3
- **Location:** Contract F: "**`hook turn-end`** (Antigravity's `Stop`): writes a `turn-end` receipt and answers `{}`." (v4-d3.md:414)
- **What is wrong:** Antigravity's `Stop` output field `decision` is marked **Required**. Its docs say "any other value allows the stop", but they never say that a missing field is accepted.
- **What breaks if we ship it as-is:** If Antigravity checks hook output against its schema, every turn ends with a hook error. That error appears beside the one hook whose receipt marks turn boundaries. An Antigravity that drops or retries invalid hook output could also upset the once-per-turn recall rule that test 3.4 asserts.
- **Suggested fix:** Answer `{"decision":"stop"}`, which the docs say allows the stop. Have `hook-files.test.mjs` assert it.
- **Evidence:** `https://antigravity.google/docs/hooks.md` §Stop, output fields: "| `decision` | string | **Required.** Set to `"continue"` to prevent the agent from stopping and re-enter the execution loop. Any other value allows the stop. |"

### R4-FC-10  —  minor
- **Artifact:** D2, D3
- **Location:** D2 "not verified": "That Claude Code fills in `${CLAUDE_PLUGIN_ROOT}` in a skill's body, not only in `allowed-tools`." (v4-d2.md:445). D3 "not verified": the same, plus "Whether Claude Code also loads the plugin's `agents/` and `rules/` folders" (v4-d3.md:1478–1479).
- **What is wrong:** The docs answer both.
  - Claude Code does replace `${CLAUDE_PLUGIN_ROOT}` in a plugin skill's markdown body as well as in `allowed-tools` Bash rules.
  - A manifest `agents` entry replaces the default `agents/` scan, so the Claude manifest's `"agents": ["./claude/agents/core-refresh.md"]` keeps Claude Code from loading `agents/core-refresh-antigravity.md`.
- **What breaks if we ship it as-is:** The "not verified" lists are how a reader tells settled from open. Two settled items listed as open hide which of the real open items, such as R4-FC-03's quote matching, matter. They also send step 8.2 to re-test something the docs already state.
- **Suggested fix:** Drop both items. Cite `skills.md` for the replacement and `plugins-reference.md` for the agents scan. Keep the open item about quote matching.
- **Evidence:** `https://code.claude.com/docs/en/skills.md`: "In a plugin skill, Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in the same two places", namely "the skill's markdown content, and Bash rules in the `allowed-tools` frontmatter". `https://code.claude.com/docs/en/plugins-reference.md`: "| `agents` | Path, or array of paths | Agent `.md` files. … Replaces the default `agents/` scan |".

---

**What checked out.** These new or changed v4 claims match their sources:
- **CORE 3 numbers.** These were re-run on this checkout: 100 scripts, 34,313 lines, 606,815 bytes in 40 `.md` files, 34 `CORE_*` names, 176 `*.test.mjs` files, and 46 releases from 2026-05-20 to 2026-10-17. The 132 reported-fine changelog rows match `source-changelog.md`.
- **Rules files and `AGENTS.md`.** `.claude/rules/` files without `paths` load at launch and do not count against `AGENTS.md`. Cloud sessions and Projects threads load the repository root's `.claude/rules/`.
- **Account skills.** Claude.ai account skills load in cloud sessions and cloud scheduled tasks, and sync to terminal sessions. A `CLAUDE_CODE_OAUTH_TOKEN` credential stops that sync, as the record test assumes.
- **Auto memory.** It is stored under `<config dir>/projects/<project>/memory/`. `autoMemoryEnabled` is accepted from any settings file. The eval runner loads no memory.
- **`claude plugin eval`.** `--threshold`, `--tag`, `--model`, `--judge-model`, `--ablation none`, `--trust-plugin`, `--scaffold`, `--no-publish`, `--max-cost-usd`, `--output-dir`, and `--json` exist as described. The H17 grader keys are now correct. `EVAL_*` env keys are required.
- **Codex `additionalContextLimit`.** It counts tokens, with a default of 2,500 (`output_spill.rs`), so 4,000 holds the 7,200-byte block.
- **Antigravity.** `trigger: always_on`, and a bad trigger "silently discards the rule". Plugin `rules/AGENTS.md` is always on. Plugin hooks run with the plugin root as working directory. `/schedule` has `IsDaemon`. Agent frontmatter supports `commandExecutionPolicy: off`.
- **Ledger.** Round 3 totals (97; 16 · 54 · 26 · 1) match the seven reviewer count lines.

critical 1 · major 5 · minor 4 · taste 0
