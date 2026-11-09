# Research: what Claude Code already provides to a project-memory plugin

Opened 2026-11-09 with `curl -sSL https://code.claude.com/docs/en/<page>.md`. Every claim below carries `[OPENED <url>]` and a verbatim quote of 25 words or fewer. Lines marked *Inference* are my reading, not the docs' words.

## What a plugin author should take from this

1. Memory already has three native layers: CLAUDE.md/AGENTS.md/rules (you write), auto memory (Claude writes), subagent `memory`. Extend them; do not rebuild them (§1, §5).
2. Cloud Projects keep their own project memory across cloud threads. Local auto memory never leaves the machine (§1, §8).
3. Hooks are the main lever. `additionalContext` injects text; over 10,000 characters it becomes a file path (§3).
4. Hook-added context is summarized away at compaction. Re-inject with a `SessionStart` hook matching `compact` (§7).
5. Keep state in `${CLAUDE_PLUGIN_DATA}`, never `${CLAUDE_PLUGIN_ROOT}`. Uninstall deletes the data directory by default (§6).
6. Do not parse transcript JSONL. Its format is internal and it can lag. Use `last_assistant_message`, `compact_summary` and friends (§2).
7. `SessionEnd` has a 1.5-second budget, and plugin timeouts do not raise it. Do no real work there (§3).
8. Unattended options: `/loop` (open session, 7-day expiry), Desktop tasks (app open), cloud tasks (fresh clone), `/goal` (§8).
9. Cloud sessions skip `~/.claude`, repo-declared plugins and, in Project threads, repo hooks and skills. Plan a degraded mode (§8, §12).
10. Measure with `claude plugin eval` (with/without delta), `plugin details`, `plugin validate --strict`, `/skill-doctor`, `/doctor prompt-audit` (§10).
11. `.claude/` is a protected path for Claude's own writes; auto-memory markdown is exempt. Hooks run outside sandbox and permissions (§11).
12. Windows: prefer exec-form hooks (`node` + `args`); shell form may land in PowerShell. Native Windows has no sandbox (§12).

## 1. Memory

**CLAUDE.md and rules**
- Ancestors load at launch, subdirectories on demand. [OPENED https://code.claude.com/docs/en/memory.md] "CLAUDE.md and CLAUDE.local.md files in the directory hierarchy above the working directory are loaded at launch. Files in subdirectories load on demand."
- It is context, not enforcement. [OPENED https://code.claude.com/docs/en/memory.md] "CLAUDE.md content is delivered as a user message after the system prompt, not as part of the system prompt itself."
- Size target. [OPENED https://code.claude.com/docs/en/memory.md] "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence."
- Imports do not save context. [OPENED https://code.claude.com/docs/en/memory.md] "help you organize a long file but don't reduce its context cost, because imported files load together with the CLAUDE.md that imports them."
- Import depth. [OPENED https://code.claude.com/docs/en/memory.md] "Imported files can recursively import other files, with a maximum depth of four hops."
- HTML comments are free. Useful for generated-block markers. [OPENED https://code.claude.com/docs/en/memory.md] "Use them to leave notes for human maintainers without spending context tokens on them."
- Rules: only `paths` is read. [OPENED https://code.claude.com/docs/en/memory.md] "`paths` is the only field Claude Code reads from a rule; any other field is ignored without an error."
- Path-scoped rules trigger on file tools. [OPENED https://code.claude.com/docs/en/memory.md] "A path-scoped rule loads when Claude uses the Read, Write, or Edit tool on a matching file."
- On-demand files are truncated past a per-file limit. [OPENED https://code.claude.com/docs/en/memory.md] "**200K context window**: 40,000 characters"
- Files over 4 MiB are skipped. [OPENED https://code.claude.com/docs/en/memory.md] "Claude Code skips a file over 4 MiB and loads none of it."
- Built-in audit exists (see §10). Built-in CLAUDE.md trim: [OPENED https://code.claude.com/docs/en/memory.md] "it cuts content Claude can derive from the codebase, such as directory layouts, dependency lists, and architecture overviews"

**AGENTS.md**
- Default rule. [OPENED https://code.claude.com/docs/en/memory.md] "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it."
- Version. [OPENED https://code.claude.com/docs/en/memory.md] "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later."
- A SessionStart hook that prints AGENTS.md now duplicates it. [OPENED https://code.claude.com/docs/en/memory.md] "Once Claude reads `AGENTS.md` directly, the hook adds a second copy to the context."
- `InstructionsLoaded` is blind to it. [OPENED https://code.claude.com/docs/en/hooks.md] "This event doesn't fire when Claude [reads `AGENTS.md` directly]"
- Not read: [OPENED https://code.claude.com/docs/en/memory.md] "`AGENTS.local.md`, `AGENTS.override.md`, or anything under a `.agents/` directory"

**Auto memory**
- Four note types; `project` overlaps our job. [OPENED https://code.claude.com/docs/en/memory.md] "`project`: ongoing work, deadlines, and decisions that Claude can't derive from the code or git history"
- Default state. [OPENED https://code.claude.com/docs/en/memory.md] "Auto memory is on by default in local sessions."
- Self-hosted default. [OPENED https://code.claude.com/docs/en/memory.md] "a session in a [self-hosted environment]"; same sentence ends "runs with auto memory off by default."
- Location, keyed on the git repository. [OPENED https://code.claude.com/docs/en/memory.md] "The `<project>` path is derived from the git repository, so all worktrees and subdirectories within the same repo share one auto memory directory."
- Machine-local. [OPENED https://code.claude.com/docs/en/memory.md] "Files are not shared across machines or cloud environments."
- Load limit. [OPENED https://code.claude.com/docs/en/memory.md] "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation."
- Topic files load lazily. [OPENED https://code.claude.com/docs/en/memory.md] "Claude Code doesn't load topic files such as `user_role.md` or `feedback_testing.md` at startup."
- Freshness stamp. [OPENED https://code.claude.com/docs/en/memory.md] "Claude Code records the write time in a `modified` frontmatter field as an ISO 8601 timestamp."
- Not swept by retention. [OPENED https://code.claude.com/docs/en/memory.md] "`MEMORY.md` and topic files stay until you or Claude edits or deletes them."
- Off switches. [OPENED https://code.claude.com/docs/en/memory.md] "To disable auto memory via environment variable, set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`."
- Relocation, gated by trust in project settings. [OPENED https://code.claude.com/docs/en/memory.md] "The value must be an absolute path or start with `~/`."

**`CLAUDE_CONFIG_DIR` effects**
- Moves everything. [OPENED https://code.claude.com/docs/en/env-vars.md] "All settings, session history, and plugins are stored under this path."
- Path docs shift with it. [OPENED https://code.claude.com/docs/en/claude-directory.md] "every `~/.claude` path on this page lives under that directory instead."
- No `~` expansion in settings `env`. [OPENED https://code.claude.com/docs/en/env-vars.md] "No shell processes them, so shorthand such as `~` or `$HOME` stays as typed."
- Projects cannot set it. [OPENED https://code.claude.com/docs/en/env-vars.md] "Project and local settings can't set some variables, such as `CLAUDE_CONFIG_DIR`"
- Pinned project name (v2.1.234+). [OPENED https://code.claude.com/docs/en/sessions.md] "Claude Code ignores `CLAUDE_CODE_PROJECT_DIR_NAME` when `CLAUDE_CONFIG_DIR` is unset."
- Desktop task prompts move too. [OPENED https://code.claude.com/docs/en/desktop-scheduled-tasks.md] "or at `scheduled-tasks/<task-name>/` under [`CLAUDE_CONFIG_DIR`]"
- *Inference:* never hard-code `~/.claude`. Use `transcript_path` from hook input and `$CLAUDE_PLUGIN_DATA`.

## 2. Transcripts and what hooks receive

- Location. [OPENED https://code.claude.com/docs/en/sessions.md] "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path"
- *Inference:* transcripts key on the working-directory path; auto memory keys on the git repository (§1). Do not assume they share a folder.
- Format is unstable. [OPENED https://code.claude.com/docs/en/sessions.md] "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."
- Supported alternatives. [OPENED https://code.claude.com/docs/en/sessions.md] "To build on session data, use `/export` or the [script interfaces]"
- Retention. [OPENED https://code.claude.com/docs/en/claude-directory.md] "The default is 30 days and the minimum is 1"
- Subagent transcripts. [OPENED https://code.claude.com/docs/en/claude-directory.md] "`projects/<project>/<session>/subagents/`"
- Plaintext. [OPENED https://code.claude.com/docs/en/claude-directory.md] "Transcripts and history are not encrypted at rest."
- Common hook input includes `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`, and `agent_id`/`agent_type` in subagents. [OPENED https://code.claude.com/docs/en/hooks.md] "Hook events receive these fields as JSON, in addition to event-specific fields"
- The transcript lags. [OPENED https://code.claude.com/docs/en/hooks.md] "The transcript file is written asynchronously and may lag the in-memory conversation"
- Use the turn text instead. [OPENED https://code.claude.com/docs/en/hooks.md] "The `last_assistant_message` field contains the text content of Claude's final response, so hooks can access it without parsing the transcript file."
- `Stop` also lists pending work. [OPENED https://code.claude.com/docs/en/hooks.md] "Stop hooks receive `stop_hook_active`, `last_assistant_message`, `background_tasks`, and `session_crons`."
- `PostCompact` gets the summary. [OPENED https://code.claude.com/docs/en/hooks.md] "The `compact_summary` field contains the conversation summary generated by the compact operation."
- `SessionStart` on resume gets staleness data (v2.1.251+). [OPENED https://code.claude.com/docs/en/hooks.md] "`seconds_since_last_response` | Wall-clock seconds since the last response in the resumed transcript"
- `UserPromptSubmit` sees a slash command unexpanded. [OPENED https://code.claude.com/docs/en/hooks.md] "the hook receives that line as you typed it rather than the expanded skill content."
- `InstructionsLoaded` gives `file_path`, `memory_type`, `load_reason`. [OPENED https://code.claude.com/docs/en/hooks.md] "`\"session_start\"`, `\"nested_traversal\"`, `\"path_glob_match\"`, `\"include\"`, or `\"compact\"`" (*quote shown with JSON quotes escaped*)
- No model variable. [OPENED https://code.claude.com/docs/en/hooks.md] "There is no `$CLAUDE_MODEL` environment variable."

## 3. Hooks

- 33 events in the summary table (my count), incl. `SessionStart`, `Setup`, `InstructionsLoaded`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStart/Stop`, `PreCompact`, `PostCompact`, `FileChanged`, `CwdChanged`, `ConfigChange`, `SessionEnd`. [OPENED https://code.claude.com/docs/en/hooks.md] "Events fall into three cadences"
- Five handler types. [OPENED https://code.claude.com/docs/en/hooks.md] "`\"command\"`, `\"http\"`, `\"mcp_tool\"`, `\"prompt\"`, or `\"agent\"`"
- Same events on every surface. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code fires the same hook events wherever it runs"
- Plugin hooks are always on. [OPENED https://code.claude.com/docs/en/plugins/components.md] "Claude Code registers them when a session loads the plugin, and they fire on their events from then on."
- Matching hooks run in parallel. [OPENED https://code.claude.com/docs/en/hooks.md] "When an event fires, its matching hooks run in parallel."
- Hooks also fire inside subagents. [OPENED https://code.claude.com/docs/en/hooks.md] "Hooks from settings files, managed policy settings, and plugins also run inside [subagents]"

**Context injection**
- Mechanism. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code wraps the string in a [system reminder]"
- Size cap. [OPENED https://code.claude.com/docs/en/hooks.md] "If a value exceeds 10,000 characters, Claude Code writes the text to a file in the session directory and passes Claude the file path"
- Plain stdout works for `SessionStart` and `UserPromptSubmit`. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code adds a SessionStart hook's [plain-text stdout](#exit-code-0) to Claude's context."
- Phrase it as fact. [OPENED https://code.claude.com/docs/en/hooks.md] "Write the text as factual statements rather than imperative system instructions."
- Resume replays, does not re-run. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code replays the saved text rather than re-running the hook for past turns, so values like timestamps or commit SHAs become stale."
- `SessionStart` extras: `sessionTitle`, `watchPaths`, `reloadSkills`, `initialUserMessage` (-p only). [OPENED https://code.claude.com/docs/en/hooks.md] "A SessionStart hook can add context for Claude, supply the first user message, set the session title, watch files, and reload skills."
- `SessionStart` can't use MCP at launch. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code skips their `mcp_tool` hooks without calling the tool"
- Interactive `SessionStart` runs in background. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude's first response still waits for the hooks to finish, so their context reaches Claude."
- `PreCompact` steers the summary. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code uses its stdout as instructions for the compaction summary. Keep that stdout under 10,000 characters per hook."
- `UserPromptSubmit` also fires on `/loop` fires, background-subagent reports, and cross-session messages. [OPENED https://code.claude.com/docs/en/hooks.md] "`UserPromptSubmit` hooks don't fire only on prompts you type."
- Stop-hook loop cap. [OPENED https://code.claude.com/docs/en/hooks.md] "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn."
- `FileChanged` sees all writers. [OPENED https://code.claude.com/docs/en/hooks.md] "it runs the hook no matter what changed the file"

**Timeouts**
- Defaults. [OPENED https://code.claude.com/docs/en/hooks.md] "Defaults: 600 for `command`, `http`, and `mcp_tool`; 30 for `prompt`; 60 for `agent`."
- `UserPromptSubmit` is 30 s and fails open. [OPENED https://code.claude.com/docs/en/hooks.md] "The prompt still reaches Claude without that context."
- `SessionEnd`. [OPENED https://code.claude.com/docs/en/hooks.md] "SessionEnd hooks have a default timeout of 1.5 seconds."
- Plugins can't extend it. [OPENED https://code.claude.com/docs/en/hooks.md] "Timeouts set on plugin-provided hooks don't raise the budget."
- Fail closed when needed (v2.1.295+). [OPENED https://code.claude.com/docs/en/hooks.md] "To block the action instead, set `\"onFailure\": \"block\"` on a `command` or `http` hook."
- Async hooks report next turn; `asyncRewake` wakes an idle session on exit 2. [OPENED https://code.claude.com/docs/en/hooks.md] "an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle."
- `-p` kills async hooks. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code kills any async hook still running at teardown and finalizes it with outcome `cancelled`"

**Shell and Windows**
- Shell form. [OPENED https://code.claude.com/docs/en/hooks.md] "`sh -c` on macOS and Linux, Git Bash on Windows, or PowerShell when Git Bash isn't installed."
- Exec form avoids quoting. [OPENED https://code.claude.com/docs/en/hooks.md] "Set `args` whenever the hook references a [path placeholder](#reference-scripts-by-path), since each element is passed as one argument with no quoting."
- `.cmd` shims fail in exec form. [OPENED https://code.claude.com/docs/en/hooks.md] "The `node` plus script-path pattern works on every platform because `node.exe` is a real binary."
- Windows without Git Bash blocks on odd exit codes. [OPENED https://code.claude.com/docs/en/hooks.md] "Without Git Bash, any exit code other than 0 or 2 from that hook counts as a [failure]"

**Plugin variables**
- Exported to hooks. [OPENED https://code.claude.com/docs/en/plugins/components.md] "every hook process receives `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` in its environment, plus `CLAUDE_PLUGIN_OPTION_<KEY>` for each [user configuration]"
- `${user_config.*}` only in exec form. [OPENED https://code.claude.com/docs/en/hooks.md] "A shell-form plugin hook whose `command` references `${user_config.*}` fails with an [error]"
- Not in Claude's Bash. [OPENED https://code.claude.com/docs/en/plugins/manifest-reference.md] "The variables aren't present in the environment of commands Claude runs through the Bash tool"
- Worktrees: [OPENED https://code.claude.com/docs/en/hooks.md] "`${CLAUDE_PROJECT_DIR}` stays put"; "`cwd` follows Claude"

**Headless and cloud**
- `-p` runs project hooks untrusted. [OPENED https://code.claude.com/docs/en/headless.md] "a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted."
- `--bare` skips hooks, even plugin ones passed by flag. [OPENED https://code.claude.com/docs/en/headless.md] "Don't use bare mode for a run that needs them."
- `--bare` will become the `-p` default. [OPENED https://code.claude.com/docs/en/headless.md] "will become the default for `-p` in a future release."
- Cloud ignores user settings. [OPENED https://code.claude.com/docs/en/hooks.md] "Cloud sessions [...] don't read your local `~/.claude/settings.json`." (*elided link*)
- Detect cloud. [OPENED https://code.claude.com/docs/en/hooks.md] "The `$CLAUDE_CODE_REMOTE` environment variable is `\"true\"` in remote web environments and not set in the local CLI."
- Cloud `SessionStart` hooks get 600 s. [OPENED https://code.claude.com/docs/en/cloud-environments.md] "Claude Code cancels a `command` hook after 600 seconds unless you set [`timeout`]"

## 4. Skills

- Open standard. [OPENED https://code.claude.com/docs/en/skills.md] "Claude Code skills follow the [Agent Skills](https://agentskills.io) open standard"
- Listing cap. [OPENED https://code.claude.com/docs/en/skills.md] "the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing"
- Listing budget. [OPENED https://code.claude.com/docs/en/skills.md] "The budget scales at 1% of the model's context window."
- Overflow drops rarely-used descriptions first. [OPENED https://code.claude.com/docs/en/skills.md] "Claude Code drops descriptions starting with the skills you invoke least"
- Invocation control. `disable-model-invocation: true` hides the description and blocks scheduled fires. [OPENED https://code.claude.com/docs/en/skills.md] "Description not in context, full skill loads when invoked"
- Fork into a subagent: `context: fork`, `agent`, `background`. [OPENED https://code.claude.com/docs/en/skills.md] "Set to `fork` to run in a forked subagent context."
- Skill hooks persist. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code registers them when you or Claude invoke the skill and keeps running them for the rest of the session"
- Content is not re-read. [OPENED https://code.claude.com/docs/en/skills.md] "Claude Code does not re-read the skill file on later turns"
- Size. [OPENED https://code.claude.com/docs/en/skills.md] "Keep `SKILL.md` under 500 lines."
- Dynamic context via `` !`command` ``. [OPENED https://code.claude.com/docs/en/skills.md] "Claude Code extends the standard with additional features like [invocation control]"
- Cloud does not read local skills. [OPENED https://code.claude.com/docs/en/skills.md] "don't read `~/.claude/skills/` on your machine."
- Desktop tasks do. [OPENED https://code.claude.com/docs/en/skills.md] "Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks.md) run locally on your machine, so they do load `~/.claude/skills/`."

## 5. Subagents

- Fresh context. [OPENED https://code.claude.com/docs/en/sub-agents.md] "Each subagent starts with a fresh, isolated context window."
- CLAUDE.md does load (not for Explore/Plan, or with `omitClaudeMd`). [OPENED https://code.claude.com/docs/en/sub-agents.md] "every level of the [CLAUDE.md hierarchy]"
- Main auto memory does not. [OPENED https://code.claude.com/docs/en/sub-agents.md] "the main conversation's [auto memory](https://code.claude.com/docs/en/memory.md#auto-memory) isn't loaded."
- Forks are the exception. [OPENED https://code.claude.com/docs/en/memory.md] "the exception is a [fork]"
- `memory` field scopes. [OPENED https://code.claude.com/docs/en/sub-agents.md] "`project` | `.claude/agent-memory/<name-of-agent>/`"
- It loads its own index. [OPENED https://code.claude.com/docs/en/sub-agents.md] "The subagent's system prompt also includes the first 200 lines or 25KB of `MEMORY.md` in the memory directory"
- It grants file tools. [OPENED https://code.claude.com/docs/en/sub-agents.md] "Read, Write, and Edit tools are automatically enabled so the subagent can manage its memory files."
- Depends on auto memory. [OPENED https://code.claude.com/docs/en/sub-agents.md] "if you turn auto memory off [...] the `memory` field has no effect" (*elided setting names*)
- Recommended scope. [OPENED https://code.claude.com/docs/en/sub-agents.md] "`project` is the recommended default scope."
- Tool restriction. [OPENED https://code.claude.com/docs/en/sub-agents.md] "If both are set, `disallowedTools` is applied first, then `tools` is resolved against the remaining pool."
- Background subagents lose some tools silently. [OPENED https://code.claude.com/docs/en/sub-agents.md] "the same definition can resolve to different tools in the foreground and the background."
- Plugin agents: `memory` works; hooks do not. [OPENED https://code.claude.com/docs/en/plugins/components.md] "**Ignored fields**: `permissionMode`, `hooks`, `mcpServers`, and `initialPrompt`."

## 6. Plugins

- Components: skills, commands, agents, hooks, MCP, LSP, `bin/`, default settings, themes, output styles, channels, monitors (directory listing in source). `bin/` reaches Claude's shell. [OPENED https://code.claude.com/docs/en/plugins/security.md] "Claude Code adds each enabled plugin's `bin/` directory to the `PATH` of the Bash tool's shell"
- Default settings are narrow. [OPENED https://code.claude.com/docs/en/plugins/components.md] "Two keys take effect, `agent` and `subagentStatusLine`, and every other key is dropped."
- Cache per version. [OPENED https://code.claude.com/docs/en/plugins/loading.md] "One directory per installed version of a marketplace plugin."
- Old versions linger 14 days. [OPENED https://code.claude.com/docs/en/plugins/loading.md] "It removes that directory in a background cleanup 14 days later"
- Do not write to root. [OPENED https://code.claude.com/docs/en/plugins/components.md] "the path changes when the plugin updates. Don't write state there"
- Data dir. [OPENED https://code.claude.com/docs/en/plugins/components.md] "It resolves to `~/.claude/plugins/data/<id>/` and is created when first referenced"
- Uninstall deletes data. [OPENED https://code.claude.com/docs/en/plugins/manifest-reference.md] "By default, Claude Code deletes the `${CLAUDE_PLUGIN_DATA}` directory when you uninstall the plugin from the last place it's installed."
- Copied plugins can't reach outside their root. [OPENED https://code.claude.com/docs/en/plugins/loading.md] "Files outside the plugin directory aren't copied"
- `userConfig` types. [OPENED https://code.claude.com/docs/en/plugins/manifest-reference.md] "One of `string`, `number`, `boolean`, `directory`, or `file`"
- Secrets. [OPENED https://code.claude.com/docs/en/plugins/manifest-reference.md] "masks input and stores the value in secure storage instead of `settings.json`"
- Shell install never prompts. [OPENED https://code.claude.com/docs/en/plugins/components.md] "The `claude plugin install` shell command never prompts for `userConfig` values."
- Monitors. [OPENED https://code.claude.com/docs/en/plugins/components.md] "A monitor is a shell command that runs in the background for the whole session. What it prints reaches Claude as notifications"
- Monitor limits. [OPENED https://code.claude.com/docs/en/plugins/components.md] "plugin monitors don't start in non-interactive mode with the `-p` flag"
- Monitors can start lazily. [OPENED https://code.claude.com/docs/en/plugins/manifest-reference.md] "With `\"on-skill-invoke:<skill>\"`, it starts the first time that skill runs"
- Repository-shared plugins: no monitors, trust required. [OPENED https://code.claude.com/docs/en/plugins/loading.md] "Background monitors](https://code.claude.com/docs/en/plugins/components.md#monitors) do not load"
- Mods: JS handlers in-process. Hooks run everywhere the plugin loads; drawing only in terminal, Desktop, VS Code. [OPENED https://code.claude.com/docs/en/plugins/mods/overview.md] "Drawing is narrower: what a mod draws appears in the terminal, the Desktop app, and the VS Code extension."

## 7. Compaction

- What returns. [OPENED https://code.claude.com/docs/en/context-window.md] "| Project-root CLAUDE.md and unscoped rules | Re-injected from disk |"
- Auto memory returns. [OPENED https://code.claude.com/docs/en/context-window.md] "| Auto memory | Re-injected from disk |"
- Hook context does not. [OPENED https://code.claude.com/docs/en/context-window.md] "| Context that hooks added earlier | Summarized with the rest of the conversation |"
- `SessionStart` re-runs. [OPENED https://code.claude.com/docs/en/context-window.md] "Claude Code runs them and adds their output to the compacted context"
- Path rules get lost until re-triggered. [OPENED https://code.claude.com/docs/en/context-window.md] "If a rule must persist across compaction, drop the `paths:` frontmatter or move it to the project-root CLAUDE.md."
- Skills. [OPENED https://code.claude.com/docs/en/context-window.md] "Re-injected, capped at 5,000 tokens per skill and 25,000 tokens total; oldest dropped first"
- Files. [OPENED https://code.claude.com/docs/en/context-window.md] "Claude Code re-reads up to five, most recently modified first"
- `PreCompact` can block or steer (§3); matcher `auto` also covers idle compaction. [OPENED https://code.claude.com/docs/en/hooks.md] "Auto-compact when the conversation reaches the [auto-compact window]"
- Per-subagent window (v2.1.296+). [OPENED https://code.claude.com/docs/en/sub-agents.md] "Lower the [auto-compact window](#subagent-auto-compact-window) for this subagent"

## 8. Loops and schedules — what runs with no user present

| Mechanism | Runs where | Needs | Evidence |
| - | - | - | - |
| `/loop`, `CronCreate` | Open session | Session idle | [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "Tasks only fire while Claude Code is running and idle." |
| Desktop task | Your machine | App open, awake | [OPENED https://code.claude.com/docs/en/desktop-scheduled-tasks.md] "Tasks only run while the desktop app is running and your computer is awake." |
| Cloud task | Anthropic cloud | GitHub access | [OPENED https://code.claude.com/docs/en/routines.md] "so they keep working when your laptop is closed." |
| `/goal` | Current session, also `-p` | Auto mode to avoid prompts | [OPENED https://code.claude.com/docs/en/goal.md] "To let goal turns run unattended, run `/goal` in [auto mode]" |
| Monitor | Interactive session | Not `-p` | §6 |
| Channel | Open session | Plugin + Bun | [OPENED https://code.claude.com/docs/en/channels.md] "Events only arrive while the session is open" |

- `/loop` expiry. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "Recurring tasks automatically expire 7 days after creation."
- Cap. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "A session can hold up to 50 scheduled tasks at once."
- No catch-up. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "No catch-up for missed fires."
- Bare `/loop` runs a maintenance prompt, replaceable by `.claude/loop.md`. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "Create a `loop.md` file to replace the [built-in maintenance prompt]"
- Scheduled fires skip model-blocked skills. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "A scheduled fire only runs skills that Claude is [allowed to invoke on its own]"
- Self-paced loops aren't restored on resume. [OPENED https://code.claude.com/docs/en/scheduled-tasks.md] "A [self-paced `/loop`](#let-claude-choose-the-interval) isn't restored, so run `/loop` again to restart it."
- Desktop catch-up. [OPENED https://code.claude.com/docs/en/desktop-scheduled-tasks.md] "Desktop starts exactly one catch-up run for the most recently missed time and discards anything older."
- Desktop prompt on disk. [OPENED https://code.claude.com/docs/en/desktop-scheduled-tasks.md] "The file uses YAML frontmatter for `name` and `description`, with the prompt as the body."
- Cloud tasks: research preview; triggers schedule, API, GitHub. [OPENED https://code.claude.com/docs/en/routines.md] "Scheduled tasks are in research preview. Behavior, limits, and the API surface may change."
- Cloud permission mode. [OPENED https://code.claude.com/docs/en/routines.md] "that session begins in [auto mode]"
- Cloud limits. [OPENED https://code.claude.com/docs/en/routines.md] "| Scheduled runs, including one-off runs | 100 per hour | Your account |"
- Cloud loses local skills. [OPENED https://code.claude.com/docs/en/skills.md] "Claude Code reports that the skill was not found when a [cloud scheduled task]"
- `/goal` evaluator can't read files. [OPENED https://code.claude.com/docs/en/goal.md] "It doesn't run commands or read files independently"
- `/goal` is hook-gated. [OPENED https://code.claude.com/docs/en/goal.md] "`/goal` is also unavailable when [`disableAllHooks`]"
- `-p` waits for background work, 10 min cap. [OPENED https://code.claude.com/docs/en/headless.md] "Claude Code stops whatever is still running after 10 minutes of continuous idle waiting by default"
- **Projects** (beta, Pro/Max/Ultra) have native project memory. [OPENED https://code.claude.com/docs/en/claude-projects.md] "Every cloud thread reads the index file `MEMORY.md` when it starts and opens the other files when it needs them"
- It is separate from local auto memory. [OPENED https://code.claude.com/docs/en/claude-projects.md] "They're separate from the [auto memory](https://code.claude.com/docs/en/memory.md) Claude Code keeps on your machine"
- Project threads skip repo hooks, skills, `.mcp.json`. [OPENED https://code.claude.com/docs/en/claude-projects.md] "Cloud threads load each repository's `CLAUDE.md` instructions but not its skills, `.mcp.json` servers, or `.claude/settings.json`"
- Plugins reach threads via settings. [OPENED https://code.claude.com/docs/en/claude-projects.md] "Plugins: add them in **Project settings > Plugins**; they load into each new cloud thread."

## 9. MCP

- Plugin servers start with the plugin. [OPENED https://code.claude.com/docs/en/mcp.md] "When you enable a plugin, Claude Code starts its MCP servers automatically"
- Tool naming for matchers. [OPENED https://code.claude.com/docs/en/plugins/components.md] "a tool from an [MCP server this plugin declares](#mcp-servers) is named `mcp__plugin_<plugin>_<server>__<tool>`"
- Tool search defers definitions. [OPENED https://code.claude.com/docs/en/mcp.md] "Only tool names and server instructions load at session start"
- Description limits. [OPENED https://code.claude.com/docs/en/mcp.md] "**Server instructions, and the description of a tool that loads upfront**: 4,096 characters"
- Output cap. [OPENED https://code.claude.com/docs/en/mcp.md] "**Default limit**: the default maximum is 25,000 tokens"
- Idle timeout. [OPENED https://code.claude.com/docs/en/mcp.md] "The idle window defaults to five minutes for HTTP, SSE, WebSocket, and [claude.ai connector]"
- `-p` drops background MCP calls. [OPENED https://code.claude.com/docs/en/headless.md] "A `claude -p` run doesn't wait for MCP work in the background"
- Cloud uses claude.ai connectors; local `claude mcp add` servers do not travel. [OPENED https://code.claude.com/docs/en/routines.md] "MCP servers you added locally in the CLI with `claude mcp add` are stored on your machine rather than your claude.ai account"
- Channels are MCP servers that push. [OPENED https://code.claude.com/docs/en/channels.md] "A channel is an MCP server that pushes events into your running Claude Code session"
- *Inference:* an MCP server is the one plugin component that can serve memory queries in-session without spending listing tokens until called.

## 10. Measurement and audit

- `claude plugin eval` (v2.1.269+) runs WITH and W/OUT arms. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "Their difference, `Δ`, is what the plugin contributed."
- Runs per arm. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "| `--runs <n>` | Each case's `runs`, else 3 | Runs per case per arm |"
- Graders: `regex`, `tool_used`, `tool_order`, `file_exists`, `llm`, `baseline`. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "There are no custom-code graders."
- Isolation hides memory. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "Your user settings, hooks, `CLAUDE.md` files, MCP servers, other installed plugins, memory, and skills are absent."
- Runs are `-p` children. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "the agent under test runs there as a `claude -p` child process with only your plugin loaded."
- Multi-session behaviour can be seeded. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "save the transcript as a `.jsonl` file and name it in `context.history_file`"
- Tool grants. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "To let cases use `Bash`, `Write`, `Edit`, `WebFetch`, or `WebSearch`, grant them yourself"
- Windows. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "Native Windows has no backend, so run shell-granting suites under WSL2"
- CI. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "The with-minus-without delta is reported but never changes the exit code"
- Server kill switch. [OPENED https://code.claude.com/docs/en/plugin-evals.md] "Anthropic has switched the command off server-side."
- `claude plugin details`. [OPENED https://code.claude.com/docs/en/plugins/measure.md] "the tokens that the names and descriptions of the plugin's skills, agents, and commands add to every session"
- It ignores hooks. [OPENED https://code.claude.com/docs/en/plugins/measure.md] "Hooks and MCP servers get no cost estimate and no per-component row"
- `claude plugin validate --strict` (`--json` v2.1.259+). [OPENED https://code.claude.com/docs/en/plugins/cli-reference.md] "Treat warnings as errors, so unrecognized fields and missing metadata that the runtime tolerates fail the run"
- `/doctor prompt-audit` (v2.1.283+). [OPENED https://code.claude.com/docs/en/memory.md] "references to files or commands that don't exist, and files that contradict each other"
- `/skill-doctor` (v2.1.252+). [OPENED https://code.claude.com/docs/en/plugins/measure.md] "It flags skills that are in Claude's skill listing but have never been invoked, including skills from plugins."
- Authors get no usage data. [OPENED https://code.claude.com/docs/en/plugins/measure.md] "Claude Code doesn't report a plugin's usage back to its author."
- Fleet signals: `plugin_loaded`, `skill_activated`, `hook_plugin_metrics` (official marketplace only). [OPENED https://code.claude.com/docs/en/plugins/measure.md] "emitted only for hooks in official-marketplace plugins"

## 11. Security

- Modes: `default` (Manual), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. [OPENED https://code.claude.com/docs/en/permissions.md] "Claude Code supports several permission modes that control how it approves tool calls."
- `-p` default mode (v2.1.302+). [OPENED https://code.claude.com/docs/en/headless.md] "`claude -p` runs start in Manual mode when [nothing sets a permission mode]"
- Unattended prompts become denials. [OPENED https://code.claude.com/docs/en/headless.md] "Anything that would prompt is denied unless a `PermissionRequest` hook allows it"
- Workspace trust is interactive only. [OPENED https://code.claude.com/docs/en/permissions.md] "Claude Code shows the trust dialog in interactive sessions only."
- Interactive sessions hold all settings hooks until trust. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code holds back hooks from every settings file, including your own `~/.claude/settings.json`, until you accept the [workspace trust dialog]"
- `-p` treats folders as trusted. [OPENED https://code.claude.com/docs/en/hooks.md] "Claude Code never shows the dialog and treats the folder as trusted"
- `.claude` is protected; auto memory is not. [OPENED https://code.claude.com/docs/en/permission-modes.md] "Markdown files in the project's [auto memory](https://code.claude.com/docs/en/memory.md#storage-location) directory"
- Allow rules can't pre-approve it. [OPENED https://code.claude.com/docs/en/permission-modes.md] "an entry such as `Edit(.claude/**)` in `~/.claude/settings.json` or `.claude/settings.json` does not change the per-mode outcome"
- Plugin code is outside the sandbox. [OPENED https://code.claude.com/docs/en/plugins/security.md] "Claude Code runs hooks, monitors, MCP servers, LSP servers, and the processes a [mod]"
- Plugin trust baseline. [OPENED https://code.claude.com/docs/en/plugins/security.md] "A Claude Code plugin you install can execute arbitrary code on your machine with your user privileges."
- Auto-mode classifier blocks e.g. force push, `git reset --hard`, sending data out. [OPENED https://code.claude.com/docs/en/permission-modes.md] "Sending sensitive data to external endpoints"
- `bypassPermissions` warning. [OPENED https://code.claude.com/docs/en/permission-modes.md] "`bypassPermissions` offers no protection against prompt injection or unintended actions."
- Injection hygiene for injected text. [OPENED https://code.claude.com/docs/en/hooks.md] "Text framed as out-of-band system commands can trigger Claude's prompt-injection defenses"
- Reminder tags are neutralized. [OPENED https://code.claude.com/docs/en/hooks.md] "If your string contains a `<system-reminder>` or `</system-reminder>` tag, Claude receives the string with that tag's `<` replaced by `&lt;`."
- User guidance. [OPENED https://code.claude.com/docs/en/security.md] "Avoid piping untrusted content directly to Claude"
- Auto-update can change reviewed code. [OPENED https://code.claude.com/docs/en/plugins/security.md] "the files you reviewed can change on disk."

## 12. Differences by OS and surface

**OS**
- Managed CLAUDE.md paths differ. [OPENED https://code.claude.com/docs/en/memory.md] "Linux and WSL: `/etc/claude-code/CLAUDE.md`"
- Windows shell tool. [OPENED https://code.claude.com/docs/en/setup.md] "If Git for Windows is not installed, Claude Code uses PowerShell as the shell tool instead."
- Windows symlinks: use `@AGENTS.md` import. [OPENED https://code.claude.com/docs/en/memory.md] "Creating a symlink there needs Administrator privileges or Developer Mode"
- Windows plugin paths. [OPENED https://code.claude.com/docs/en/plugins/components.md] "On Windows, most substituted paths use forward slashes, as in `C:/Users/you/...`."
- Sandbox. [OPENED https://code.claude.com/docs/en/sandboxing.md] "On native Windows, Claude Code runs commands unsandboxed."
- Linux needs packages. [OPENED https://code.claude.com/docs/en/sandboxing.md] "the sandbox relies on `bubblewrap` and `socat`"
- Credential storage differs. [OPENED https://code.claude.com/docs/en/security.md] "API keys and tokens are stored in the macOS Keychain when available. On Linux they're stored in a file with mode `0600`"

**Surface**
- Desktop WSL sessions have no plugins. [OPENED https://code.claude.com/docs/en/plugins/mods/overview.md] "No, because plugins aren't available in WSL sessions"
- Cloud: fresh clone; repo-declared and user-enabled plugins don't load. [OPENED https://code.claude.com/docs/en/cloud-environments.md] "A cloud session doesn't install the plugins a repository turns on under [`enabledPlugins`]"
- Cloud: no user CLAUDE.md. [OPENED https://code.claude.com/docs/en/cloud-environments.md] "| Your user `~/.claude/CLAUDE.md` | No |"
- Cloud: no `/plugin`. [OPENED https://code.claude.com/docs/en/claude-code-on-the-web.md] "Commands that only run in the terminal interface, such as `/plugin` or `/resume`, aren't available."
- Cloud VM pauses when idle. [OPENED https://code.claude.com/docs/en/cloud-environments.md] "after a few minutes without activity, a session's VM pauses with its files saved"
- Account-only features. [OPENED https://code.claude.com/docs/en/feature-availability.md] "These require signing in with a claude.ai account and are not reachable with an Anthropic Console API key or from a third-party provider"
- Channels not on Bedrock/Vertex/Foundry. [OPENED https://code.claude.com/docs/en/channels.md] "not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry"
- `-p`: no monitors (§6), no trust dialog (§11), async hooks killed (§3), mod hooks run but don't draw (§6).

## Corrections to grounding.md Part 4

1. **Mods.** Grounding says "CLI, Desktop, and VS Code only." Only *drawing* is limited to those. Mod hooks also run in `claude -p`, the Agent SDK, Remote Control and cloud sessions. [OPENED https://code.claude.com/docs/en/plugins/mods/overview.md] "A mod's hooks run in every kind of session that loads the plugin"
2. **InstructionsLoaded.** Grounding implies it reports every instruction file. It does not fire for `AGENTS.md` read directly (§1).
3. **Default settings.** Grounding lists "default settings" as a component without the limit: only `agent` and `subagentStatusLine` take effect (§6).
4. **Compaction.** "Instruction files are reloaded after compaction" is only true for project-root CLAUDE.md and unscoped rules. Path-scoped rules and nested CLAUDE.md reload on demand; hook-added context is summarized, not re-run (§7).
5. **SessionStart.** "Only `command` and `mcp_tool`" is right, but `mcp_tool` hooks are skipped at launch and resume (§3).
6. **Transcript path.** "A hook never has to compute where the transcript is" is right, but the file may lag and its format is internal; grounding should not suggest parsing it (§2).
7. **Eval tool grants.** Grounding names Write, Edit, Bash. WebFetch and WebSearch also need a grant (§10).
8. **Monitors.** Missing: monitors of repository-shared plugins do not load, and monitors can start `on-skill-invoke` (§6).
No outright false quotes found; the SessionEnd, `/loop`, eval, and headless quotes match the pages.

## Unconfirmed — do not rely on

- Whether local-style auto memory runs at all in ordinary Anthropic-hosted cloud sessions. Docs say only "on by default in local sessions" and "not shared across... cloud environments."
- Whether a plugin turned on for a claude.ai account loads, with hooks, in a plain cloud session (not Cowork, not a Project thread). The web page's plugin-suggestion card implies it; no page states it.
- Whether plugin hooks fire inside `claude plugin eval` runs. *Inference:* yes, since runs load the plugin in `-p`; and monitors would not start there.
- Whether `${CLAUDE_PLUGIN_DATA}` moves under `CLAUDE_CONFIG_DIR`. The env-vars page says plugins move; the data-dir rows only show `~/.claude/plugins/data/<id>/`. `CLAUDE_CODE_PLUGIN_CACHE_DIR` also moves the plugins root.
- How hook-injected `additionalContext` counts toward cost; `plugin details` does not count it.
- Exact rule for the auto-memory `<project>` name versus the transcript `<project>` name when launched from a repo subdirectory.
- Projects are beta and rolling out; cloud scheduled tasks are research preview. Both may change.
