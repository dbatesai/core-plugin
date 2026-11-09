# Round 1 — Harness Auditor

Reviewed: `gauntlet/v1-d1.md`, `v1-d2.md`, `v1-d3.md`, `v1-d4.md`.
Checked against: Claude Code docs (`code.claude.com/docs/en/*.md`, fetched today), Codex source at `raw.githubusercontent.com/openai/codex/rust-v0.167.0/codex-rs/…` and `learn.chatgpt.com/docs/*.md`, Antigravity docs (`antigravity.google/docs/*.md`). Nothing was run on a live harness.

---

### R1-HA-01  —  critical
- **Artifact:** D3, D2
- **Location:** D3 contract F, last line: "Every hook call that says something, or that fails, appends one receipt row." D3 rule 6: "A hook always exits 0, finishes fast, and leaves a receipt." D2 §5: "Every hook and every watcher tick leaves one line in a receipts file." D3 step 7.4: `recall_rate` = "`prompt` rows with `hits > 0` ÷ `prompt` rows"; `hook_coverage` = "sessions with a `session-start` row ÷ sessions".
- **What is wrong:** The documents disagree on whether a healthy hook that finds nothing leaves a receipt. Contract F is the binding one, and it says no. So a prompt hook that ran and matched nothing looks exactly like a prompt hook that never ran. That is the defect class this rewrite exists to kill. The metrics built on the receipts then lean toward success. `recall_rate` counts only the prompts that matched or failed, so it runs near 100%. `hook_coverage` divides by sessions found in the receipts, and a session whose hooks never ran has no rows at all. So it is near 100% too. D3 also says "In a folder that is not a CORE project … No receipt", and the Antigravity repeat "write[s] no receipt".
- **What breaks if we ship it as-is:** `metrics` reports high recall and full hook coverage on a machine where the prompt hook is dead. This is the "nothing needs your attention while the recorder is dead" failure D1 §3 names. The live checks also cannot pass. Steps 8.2 to 8.4 send "Say only: ok", which matches no memory, so no `prompt` row is written and `prompt_hook` stays `unknown`. An executing agent will mark three harness checks failed with correct hooks.
- **Suggested fix:** Every hook call in a CORE project writes one row, including `hits: 0` and the Antigravity repeat, with `ev` and `status`. Compute `hook_coverage` against an independent session count, such as the transcripts or the agent-side `env` run. Without one, report it as `unmeasured`.
- **Evidence:** v1-d3.md:51, :339, :888–889; v1-d2.md:152, :210.

### R1-HA-02  —  critical
- **Artifact:** D3, D2
- **Location:** D3 step 8.1, `env`: "`session_hook` | a `session-start` receipt for `--sid`, or within the last 12 hours if no `--sid`" and "`harness` | the `harness` value on the newest `session-start` receipt".
- **What is wrong:** When the hooks are dead, the agent has no session id, because the id comes from the `CORE:` block that never arrived. `env` then falls back to any session-start receipt from the last 12 hours, from any harness on this machine. Take one project used in Claude Code at 10:00 and in Codex at 11:00, where the Codex hooks were reset by a CORE update (D2 §5 says this happens on every update). `env` says `session_hook: ok` and `harness: claude-code`. The `metrics` skill then tells the user, in the three honest words, that it is "working". The `watch_alive` and `reading_nothing` rows have the same weakness: they read whichever harness wrote last.
- **What breaks if we ship it as-is:** The one tool meant to say which rung you are on reports the wrong harness and a live hook while the hook is dead. That is a check saying "fine" about something it did not look at. D2 §6 claims this cannot happen.
- **Suggested fix:** With no `--sid`, `session_hook`, `prompt_hook` and `harness` return `unknown`, reason `no-session-id`, and never fall back to time windows. The skill passes `--harness` from its own knowledge of which harness it runs in. `env` reads only `receipts-*-<that harness>.jsonl`.
- **Evidence:** v1-d3.md:974, :977; v1-d2.md:153 (the dead-hook case has no block, so no sid).

### R1-HA-03  —  critical
- **Artifact:** D3, D2
- **Location:** D3 step 6.2, `core-refresh.md` frontmatter `tools: Read, Write, Glob`, with "on Claude Code start the `core-refresh` helper with the file path and allow it the one MCP tool named in the source file". D2 §5 ladder: "Yes, with its tools cut down to read, write, and the one MCP tool (doc)". D2 §9: "On Claude Code its tools are cut to read, write, and the one MCP tool".
- **What is wrong:** In Claude Code, `tools` is a static allowlist, and a list without MCP tools removes all of them. The docs say: "This example uses `tools` to allow only Read, Grep, Glob, and Bash. The subagent can't edit files, write files, or use any MCP tools." The Agent tool has no way to add a tool at spawn time. A plugin subagent also cannot declare `mcpServers`, which is "ignored when loading agents from a plugin". The tool name differs for every source, so it cannot be listed in a fixed file either.
- **What breaks if we ship it as-is:** On rung A, the best rung, every refresh fails. The helper cannot call the tracker, sets `fetch_status: failed`, and the Update job never works on Claude Code. The D2 security claim built on this, that a poisoned ticket cannot make the helper run a shell command, is about a helper that cannot reach the ticket at all. The step 6.2 fallback ("If Claude Code rejects the agent file's `tools` … line") never triggers, because Claude Code does not reject the line. It just quietly removes the MCP tool.
- **Suggested fix:** Drop `tools` and use `disallowedTools: Bash, PowerShell, Edit, WebFetch, WebSearch, Agent`. That keeps every MCP tool and still removes the shell. Correct both D2 sentences to say "every MCP tool the session has, no shell".
- **Evidence:** https://code.claude.com/docs/en/sub-agents.md lines 300, 452 ("can't … use any MCP tools"), 234 ("plugin subagents don't support the `hooks`, `mcpServers`, or `permissionMode` frontmatter fields"); v1-d3.md:831, :837; v1-d2.md:169, :304.

### R1-HA-04  —  critical
- **Artifact:** D2, D3, D1
- **Location:** D2 §9 "Unattended runs": "When no person is watching — a headless run, a scheduled task, a background agent — CORE … does not write memories". D3 decision 23, and step 5.1 section 10: "if no user is present, write the proposal to `_core/inbox/`". D1 §7 risk table: "unattended runs cannot write memories".
- **What is wrong:** None of the three harnesses tells a hook or a skill whether a person is present. Claude Code's common hook input has `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `effort`, and `hook_event_name`. It has no interactivity field. Codex's `permission_mode` is only ever `default` or `bypassPermissions` at 0.167.0. Antigravity's common fields have nothing of the kind. So the rule is the agent's guess. It is also contradicted by CORE's own test suite. `claude plugin eval` runs the agent "as a `claude -p` child process", which is a headless run by D2's own definition. Yet `remember-decision`, `remember-supersede` and `finalize-handoff` pass only if the agent writes to `_memories/` or `_summaries/`.
- **What breaks if we ship it as-is:** One of two things happens, and both are bad. The agent obeys the rule in `-p`, so every Remember and Close eval fails. Or it ignores the rule, which is what the graders reward, so the "unattended runs cannot write memories" control does nothing in exactly the runs it targets. The security story in D1 §7 and D4 Part 2 #15 rests on a signal that does not exist.
- **Suggested fix:** Say plainly that the harnesses give no attended/unattended signal. Make the inbox rule opt-in through an explicit marker, for example `EVAL_`-style `CORE_UNATTENDED=1` set by the user's scheduler (this costs the one-switch budget), and drop the claim from D1's risk table. Or give up the rule and say so.
- **Evidence:** https://code.claude.com/docs/en/hooks.md §Common input fields (line 735 onward); https://code.claude.com/docs/en/plugin-evals.md:481 ("runs there as a `claude -p` child process"); research-codex.md §4 input contract (`permission_mode` two values in source); https://antigravity.google/docs/hooks.md §Common input fields; v1-d2.md:311; v1-d3.md:780, step 7.6 table.

### R1-HA-05  —  major
- **Artifact:** D3, D2
- **Location:** D3 decision 26: "Every harness keeps skill descriptions in context." D2 §5: "the `core` skill's own description — which every harness keeps in context — tells the agent to say that CORE's hooks are not running." D3 step 4.3 puts that instruction in the *last* sentence of the `core` description.
- **What is wrong:** Two of the three harnesses drop or shorten descriptions when the skill list is over budget. Claude Code: "if you have many skills, Claude Code drops some descriptions to fit the listing's character budget … starting with the skills you invoke least". On rung C nothing invokes `core`, so it is among the first dropped. Codex 0.167.0 caps the list at 2% of the context window, or 8,000 characters, and when that is exceeded, "All skill descriptions were removed". It also truncates long descriptions with "...", which cuts the dead-hook sentence first because it comes last.
- **What breaks if we ship it as-is:** The only detector of a dead hook goes silent for any user with many skills. Rung C then becomes the silent no-op that hard requirement 3 forbids.
- **Suggested fix:** Put the dead-hook sentence first in the description. Add the same one-line check to the optional `AGENTS.md` block, which every harness loads in full. Say in D2 that the description is best-effort on Claude Code and Codex.
- **Evidence:** https://code.claude.com/docs/en/skills.md (§skill listing budget, "drops some descriptions … starting with the skills you invoke least"); `codex-rs/ext/skills/src/render.rs` @rust-v0.167.0 lines 23–31 (`DEFAULT_SKILL_METADATA_CHAR_BUDGET: 8_000`, `SKILL_METADATA_CONTEXT_WINDOW_PERCENT: 2`, "All skill descriptions were removed"); v1-d3.md:99.

### R1-HA-06  —  major
- **Artifact:** D3
- **Location:** Contract A: "Every `core.mjs` command prints exactly one line of JSON as its last line on stdout". Contract F: "Nothing to say | empty stdout" (Claude Code/Codex) and "exactly one JSON object" (Antigravity). Step 1.1: the honesty test "lists every command in contract K" and asserts "deleted or unreadable → exit 1 or 3, never 0".
- **What is wrong:** Contract A excuses `hook` commands from the exit codes only. It does not excuse them from the JSON result line. The `hook` rows in the step 1.1 test also contradict rule 6, which says hooks always exit 0. An agent that follows contract A literally breaks all three harnesses. On Codex, a "nothing to say" call prints only `{"status":…}`. Codex sees stdout starting with `{` (`looks_like_json`), fails it against the hook schema, and marks the hook *failed* on every non-matching prompt. On Antigravity, the brief plus a result line is two JSON objects, which the harness drops silently. On Claude Code, the result line lands in the model's context as noise.
- **What breaks if we ship it as-is:** Either the test in 1.1 can never pass for hook rows, or a builder makes it pass by printing the result line. Then Codex reports a hook error on most prompts and Antigravity drops the brief without a word.
- **Suggested fix:** State in contract A that `hook` and `watch` print no result line, and that their status lives only in the receipt. Remove `hook` and `watch` from the step 1.1 table, and test their receipts instead.
- **Evidence:** `codex-rs/hooks/src/engine/output_parser.rs`:360–362 (`starts_with('{')`); `hooks/src/events/session_start.rs`:288 and `user_prompt_submit.rs`:212 (JSON-looking stdout → `Failed`); https://antigravity.google/docs/build-plugins.md ("must … write a JSON response object to stdout"); v1-d3.md:173, :506.

### R1-HA-07  —  major
- **Artifact:** D2, D1
- **Location:** D2 §5 rungs: "**B — Hooked** | Claude Code headless or cloud; …". D1 §2: "on a laptop and in cloud sessions".
- **What is wrong:** Claude Code cloud sessions provision a fresh VM. The trust list lives at `~/.core/projects.json` on that VM, so it is empty every time. So every cloud session gets "this folder has CORE memory but is not enabled", and enabling it is lost when the VM is replaced. The ladder also leaves out two other remote surfaces. Codex cloud orchestration "does not support command … handlers, hooks from … plugins". Antigravity Remote Agents do not get local plugins or hooks. None of these is rung B. Cloud Claude Code is permanently at the "not enabled" notice, and the other two are at rung C or D.
- **What breaks if we ship it as-is:** The user D1 describes, who works in cloud sessions, gets the one-line refusal every time, while D2 promises brief, recall, queue and close. The ladder names a rung that cannot occur.
- **Suggested fix:** Add a "remote / fresh machine" row that names what is lost (the trust list, receipts, the watcher) and the workaround, if any. For example, an `--temp` trust entry written by a SessionStart setup script, with the security cost stated. Move Codex cloud and Antigravity Remote Agents to the rungs they actually reach.
- **Evidence:** https://code.claude.com/docs/en/claude-code-on-the-web.md ("provision a fresh VM"); https://learn.chatgpt.com/docs/hooks.md ("Cloud orchestration supports only Global MCP hooks … It does not support command, prompt, or agent handlers, hooks from local configuration, plugins"); research-antigravity.md §6 "Remote agents"; v1-d2.md:179.

### R1-HA-08  —  major
- **Artifact:** D3, D2
- **Location:** D3 step 7.6: "Cases marked **W** need `--allow-tools Write Edit`". Accept: `claude plugin eval … --allow-tools Write Edit …`. The skills that run the script: `pulse` (1) "run the script with `queue`", `finalize` (4) "Run `core.mjs verify` … `close`", `metrics` (1) "run the script with `check --project`, then `metrics`, then `selftest`", `remember` (9) "run the script with `index`", and step 5.3 (`metrics --days 7`).
- **What is wrong:** No case grants Bash, so in every eval run the agent cannot run `core.mjs`. Each case that relies on the script measures the agent's reaction to "not granted" instead. `honesty-unknown-not-ok` (with `_core` planted as a file) passes on "not measured" whether or not CORE noticed the broken `_core`. The test cannot tell "detected the fault" from "could not run anything", which is the defect class again, this time inside the test. `finalize-counts-from-disk` and `catch-up-unclosed` have the same problem. Granting Bash does not fix it. The docs say native Windows "has no backend, so run shell-granting suites under WSL2". Under the sandbox, "your home directory … [is] unreadable", so the agent-side script cannot read `~/.core` (the trust list and `install-id`).
- **What breaks if we ship it as-is:** The honesty and close gates in step 9.4 ("score 1.0 each") pass without testing what they name. Native Windows can never run the suite that matters.
- **Suggested fix:** Grant `"Bash(node *)"` for the cases that need the script. Have each script-dependent case check `tool_used` on a Bash call naming `core.mjs`, so that "could not run" fails the case. State in D2 that this suite runs only on macOS, Linux, and WSL2.
- **Evidence:** https://code.claude.com/docs/en/plugin-evals.md:347 (read-only default set), :355 (sandbox: "your home directory and Claude Code configuration are unreadable"; "Native Windows has no backend"); v1-d3.md:955 and the step 7.6 table.

### R1-HA-09  —  major
- **Artifact:** D3
- **Location:** Step 0.6: `claude plugin eval plugins/core --scaffold --ablation none … --json docs/headroom.json --max-cost-usd 10`. Step 7.6 Accept: the same command shape with `--json docs/results-v4.json`. Step 9.4 v3 run.
- **What is wrong:** With a path target, `claude plugin eval` refuses to run under `--json`, or with no terminal, unless the directory was already trusted in an interactive session or `--trust-plugin` is passed: "under `--json`, the run can't ask and is refused with exit 1". An agent with zero context runs non-interactively, and none of the three commands passes `--trust-plugin`. The "If it fails" text covers only "not installed, version below 2.1.269, or no credentials".
- **What breaks if we ship it as-is:** Step 0.6 is the stop/go decision, and it exits 1 with nothing in `docs/headroom.json`. The agent goes into the general failure procedure with no named fallback. It marks the step BLOCKED and skips every measurement step, so the release gate can never be met.
- **Suggested fix:** Add `--trust-plugin` to all three commands. CORE is the maintainer's own code, which the docs allow for. Add "exit 1 with a trust refusal" to the 0.6 and 7.6 failure lists.
- **Evidence:** https://code.claude.com/docs/en/plugin-evals.md:467; v1-d3.md:490, :955.

### R1-HA-10  —  major
- **Artifact:** D2, D3, D1
- **Location:** D2 §7 release bar "averaged over recall, focus and interact cases"; D3 step 9.4 "The plugin beats plain files | mean A − B of +0.3 … across the four **T** cases"; D2 §5 rung A "Everything above".
- **What is wrong:** The only thing that separates rung A from rung B is the watcher. The eval runner can never run it, because the agent runs as `claude -p`, and "plugin monitors don't start in non-interactive mode with the `-p` flag". `proactive-due` measures only the session-start queue, which every hooked rung has. The ladder's top rung, and D1's "Interact: Yes on Claude Code", have no measurement path. The `watch_alive` metric in step 7.4 has never seen a real monitor.
- **What breaks if we ship it as-is:** The release says Interact passed when the between-prompt loop, the thing the brief asks for, was never tested. A broken `monitors.json` would ship green.
- **Suggested fix:** State in D2 §7 that the eval measures rung B only, and that Interact-between-prompts is "not measured". Add a live step to 8.2: an interactive `claude` session with a memory made due during the session, checking for one "new item" notification and a `watch` receipt.
- **Evidence:** https://code.claude.com/docs/en/plugin-evals.md:481; https://code.claude.com/docs/en/plugins/components.md §Monitors ("plugin monitors don't start in non-interactive mode with the `-p` flag").

### R1-HA-11  —  major
- **Artifact:** D2
- **Location:** D2 §5 rungs: "**A — Full** | Claude Code, interactive, on macOS, Linux, or Windows | Everything above | Nothing".
- **What is wrong:** Monitors are not available on every Claude Code install. The Monitor tool on Windows "is available only when Git Bash is installed". The plugin-monitor page does not state the Windows rule. But monitor commands are "shell command[s]" and run the same way, and with no Git Bash, Claude Code falls back to PowerShell. Also, on Bedrock, AWS, Google Cloud's Agent Platform, or Foundry, or with telemetry or nonessential traffic disabled, "monitors require Claude Code v2.1.310 or later". D2 lists none of this. D2 §5 also says "CORE's hooks avoid the shell altogether", but `monitors.json` is shell form and has no exec form.
- **What breaks if we ship it as-is:** A Windows user without Git Bash, or an enterprise user on Bedrock with an older Claude Code, sits on rung B while CORE describes rung A. With no `watch` receipt, `env` says `unknown` instead of "your harness cannot run the watcher", so the loss is never stated.
- **Suggested fix:** Add both conditions to rung A and to the ladder file in step 8.5, with the sentence to say. Have the session-start hook record whether `watch` receipts exist, so the next brief can say "between-prompt reminders are not running here" once.
- **Evidence:** https://code.claude.com/docs/en/tools-reference.md:393–396; https://code.claude.com/docs/en/plugins/components.md:585–590; v1-d2.md:188.

### R1-HA-12  —  major
- **Artifact:** D2, D3
- **Location:** D2 §5 "Node.js 20+ on the PATH | Needed | Needed | Needed"; D3 step 8.1 "`node` | `process.version` is 20 or newer"; D3 decision 3 "Node.js 20 or newer".
- **What is wrong:** "On the PATH" is not one PATH. Hooks and the agent's shell inherit different environments on each harness. Codex runs hook commands on Unix as `$SHELL -lc`, a login shell. On macOS zsh that reads `.zprofile` but not `.zshrc`, where nvm, fnm, and asdf usually put `node`. Antigravity runs hooks with `sh -c` (third-party reports; the docs are silent). The Codex desktop app, Antigravity App, and IDE launched from the Dock get the minimal launchd PATH. So a hook can fail to find `node` while the agent's terminal finds it. `env`'s `node` row cannot show this. It runs inside `node`, so it can only ever answer `ok`, and it measures the agent's process, not the hook's. A separate point: Node 20 reached end of life on 2026-04-30, and CI pins it.
- **What breaks if we ship it as-is:** On macOS with nvm, Codex hooks fail with "command not found". The user sees rung C, and the one diagnostic CORE offers says Node is fine. On Antigravity the failure is silent (hooks fail open).
- **Suggested fix:** Have the hook record `process.execPath` and its version in the session-start receipt. Drop `env`'s `node` row, or replace it with "the hook's node, from its last receipt, or `unknown`". Document `commandWindows` and an absolute-path option for Codex. Raise the floor to Node 22.
- **Evidence:** `codex-rs/hooks/src/engine/command_runner.rs`:452–460 (`/C` on Windows, `-lc` on Unix) and :490–520 (`$SHELL` / `COMSPEC`); research-antigravity.md §6 "OS differences"; v1-d3.md:972.

### R1-HA-13  —  major
- **Artifact:** D3, D2
- **Location:** D3 decision 15 and step 3.1: `coreDir()` = `os.userInfo().homedir/.core`. D3 contract H: `<machine>` from `~/.core/install-id`. Contract E `no-handoff`: "an earlier session on this machine". D2 §5: "*Codex on Windows* turns a writable sandbox into a read-only one until its Windows sandbox is set up".
- **What is wrong:** Codex's Windows `elevated` sandbox "uses dedicated lower-privilege sandbox users". Hooks run outside the sandbox as the real user. Commands the agent runs, such as `trust add`, `close`, `index`, and `env`, run as a sandbox user, whose account record names a different home folder. On that path CORE splits into two `~/.core` folders. "Enable CORE here" writes the trust list the hooks never read. `close` writes its receipt under a different machine id, or `nohome`, so "earlier session on this machine … no `close` row" stays true for ever. Separately, Codex is read-only on every OS when the project has no trust decision ("Otherwise `read-only`"), not only on Windows, and D2 names only Windows.
- **What breaks if we ship it as-is:** On Codex for Windows, enabling a project does nothing, and every session opens with a false "last session was not closed". On a Codex project that was never trusted, on any OS, the agent cannot write memories, and the ladder does not name that rung.
- **Suggested fix:** Have the session-start hook print the real core dir on its `script:` line. Agent-side commands then take `--core-dir` from the block instead of working it out. Match `close` to its session by `sid` alone. Add "Codex, project not trusted → read-only" to the OS notes.
- **Evidence:** https://learn.chatgpt.com/docs/windows/windows-sandbox.md:115 ("dedicated lower-privilege sandbox users"); research-codex.md §11 ("With no mode set, a project that has any trust decision gets `workspace-write`. Otherwise `read-only`", `config_toml.rs#L872-L881`); v1-d3.md:88, :597.

### R1-HA-14  —  major
- **Artifact:** D2, D3
- **Location:** D2 §5: "**D — Files only** | Any agent with no CORE plugin | … If you add three lines to `AGENTS.md` …"; "**E — No file access** | … CORE says 'this environment cannot run CORE' and stops."; "A rung is never silent. On B, C, and D the first reply of the session states what is missing". D3 step 3.6 writes the block to `AGENTS.md` only.
- **What is wrong:** On rungs D and E, no CORE code or skill is loaded, so nothing exists to "state what is missing". The `AGENTS.md` block in step 3.6 says to read `PROJECT.md`. It does not say CORE is absent. Rung E has no actor at all. The block also does not reach Claude Code in many repositories: Claude Code reads `AGENTS.md` only "when you have no `CLAUDE.md`", and needs v2.1.277 or later. Antigravity reads `AGENTS.md` but not `CLAUDE.md`. D3 contract B says "`AGENTS.md` or `CLAUDE.md`", but step 3.6 offers only `AGENTS.md`.
- **What breaks if we ship it as-is:** Hard requirement 3, "no rung is a silent no-op", is met on paper only. On D the agent works silently with no habits. On Claude Code in a repo with a `CLAUDE.md`, the rung-D block is never read.
- **Suggested fix:** Make the block itself say the line: "If CORE's hooks did not report at session start, tell the user CORE is not active here." Offer the block for `CLAUDE.md` when one exists. Delete rung E, or mark it "nothing can speak here".
- **Evidence:** grounding.md §4.1 (`memory.md` §AGENTS.md: needs v2.1.277; research-codex §13 quoting "reads `AGENTS.md` only when you have no `CLAUDE.md`"); grounding.md §4.3 (Antigravity: `CLAUDE.md` not read); v1-d2.md:181–184.

### R1-HA-15  —  minor
- **Artifact:** D3
- **Location:** Step 7.6: `plugins/core/evals/mocks/tracker/list_issues.md`, used by `pulse-refresh-stale`, `update-refresh-uses-mock`, and `update-ignores-injected-tool-text`.
- **What is wrong:** The docs tie a mock folder to "the server's name in your plugin's MCP configuration" and register "a substitute server under each server's own name". CORE ships no `.mcp.json` and declares no server called `tracker`. So nothing says a `tracker` mock will be registered at all. This is not verified either way.
- **What breaks if we ship it as-is:** All three Update cases may find no `tracker` tool and fail, or pass only through `not connected`. The `update-server-missing-says-so` twin then cannot be told apart from the mocked case.
- **Suggested fix:** Ship an eval-only `.mcp.json` entry for `tracker` under `experimental.evals`, or confirm with one `--runs 1` run in step 0.6 and record the result.
- **Evidence:** https://code.claude.com/docs/en/plugin-evals.md:285–287.

### R1-HA-16  —  minor
- **Artifact:** D3, D2
- **Location:** Contract F, Antigravity: prompt output `{"injectSteps":[{"ephemeralMessage":"<text>"}]}`; repeat rule "If this session's receipts already hold a `prompt` row with that value in `ph`, answer `{}`"; project folder "first entry of `workspacePaths`". D2 §5: "CORE answers only the first call after a new prompt".
- **What is wrong:** Three small Antigravity mismatches. (a) The docs define `ephemeralMessage` only as "A transient system message". The "new item … Raise it at the next natural pause" line rides in it, and if it lasts one model call, it is gone before the pause. (b) Keying on the hash of `lastUserInput` suppresses recall for a repeated prompt in a later turn, such as "continue" or "yes". (c) Taking `workspacePaths[0]` with no walk-up misses a CORE project in a subfolder or a second root. That is silent, because "not a CORE project → say nothing".
- **What breaks if we ship it as-is:** Reminders can vanish mid-turn on Antigravity. Repeated short prompts lose recall. Monorepo users get no CORE and no notice.
- **Suggested fix:** Send the "new item" line as `systemMessage`. Key the repeat on `conversationId` plus `initialNumSteps`, or `invocationNum` from the PreInvocation input. Search each `workspacePaths` entry for the nearest `PROJECT.md`.
- **Evidence:** https://antigravity.google/docs/hooks.md §PreInvocation (`invocationNum`, `initialNumSteps`, "`ephemeralMessage` (string): A transient system message").

### R1-HA-17  —  minor
- **Artifact:** D3
- **Location:** Step 8.3: "start `codex` in the temp project, open `/hooks`, and approve CORE's two hooks. Send one prompt. Run `env` … Accept: `session_hook` and `prompt_hook` are `ok`."
- **What is wrong:** `SessionStart` already fired, and was skipped as untrusted, before the approval. Approving mid-session does not replay it. So no `session-start` receipt exists for this session, and the step fails as written.
- **What breaks if we ship it as-is:** The executing agent marks Codex hooks failed on a correct install, or re-approves in a loop as the "If it fails" text suggests.
- **Suggested fix:** After approving, quit and start `codex` again, then send the prompt.
- **Evidence:** research-codex.md §4 Trust ("Otherwise it is listed but not run"); v1-d3.md:993.

### R1-HA-18  —  minor
- **Artifact:** D3
- **Location:** Step 7.6: "each `fixture.sh` also runs `node <plugin>/scripts/core.mjs trust add --temp --project .` … The plugin path inside `fixture.sh` is the fixture file's own folder, three levels up."
- **What is wrong:** (a) The scaffold runs "as you, outside the agent's sandbox" with `HOME` set to a temp folder. But CORE ignores `HOME` and resolves the real account home, so every eval run writes to the maintainer's real `~/.core/projects.json`. That is the exact thing `scripts/release/real-home-guard.mjs` exists to forbid. (b) The fixture's folder is `plugins/core/evals/<case>/`. Three levels up from it is `plugins/`, not the plugin.
- **What breaks if we ship it as-is:** Each `claude plugin eval` run adds trust entries for temp folders to the real list. Read literally, `fixture.sh` calls a `scripts/core.mjs` that does not exist, the scaffold exits non-zero, and every run "scores 0 with a `scaffold failed` error".
- **Suggested fix:** Pass `--core-dir "$HOME/.core"` in `fixture.sh`, which is the eval's temp home, and have the hooks honour the same location through an `EVAL_`-prefixed variable the eval passes. Say "two levels up".
- **Evidence:** https://code.claude.com/docs/en/plugin-evals.md:264, :281; scripts/release/real-home-guard.mjs:3 ("the test suite must not write into the real account's ~/.core").

### R1-HA-19  —  minor
- **Artifact:** D3
- **Location:** Step 4.2, `watch` "appends a `watch` receipt … prints one line for each `now` item not printed before in this run". Contract F prompt hook: "If a new `now` item has appeared since the last one this session announced, add: `CORE: new item needs you …`".
- **What is wrong:** The watcher writes `watch` rows, not `announce` rows. The prompt hook decides what is new from `announce` rows only. So on rung A the same item is raised twice: once by the monitor, then again by the next prompt hook. A second Claude Code session in the same project starts a second monitor, which raises it a third time.
- **What breaks if we ship it as-is:** This breaks D2 §3's "never the same reminder twice" exactly on the rung that is meant to be the best.
- **Suggested fix:** Have `watch` append an `announce` row with the ids it printed. Have the prompt hook read `announce` rows from both sources.
- **Evidence:** v1-d3.md step 4.2 and contract F; v1-d2.md §3.

---

What checked out: Claude Code's exec-form `hooks.json` with `${CLAUDE_PLUGIN_ROOT}` in `args` matches the docs. The Codex `hooks-codex.json` shape, the `timeout` field name, the manifest `hooks` override of the default `hooks/hooks.json`, the textual `${PLUGIN_ROOT}` substitution, plain stdout used as context, and `SessionStart` re-firing with `source: compact` all match the 0.167.0 source. Antigravity's root `hooks.json` flat shape for `SessionStart` and `PreInvocation`, the plugin-root working directory, and the `injectSteps` shapes match today's docs.

critical 4 · major 10 · minor 5 · taste 0
