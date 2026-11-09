# Codex native capabilities — research for a cross-harness memory and project-management plugin

Research date: 2026-11-09. Codex version studied: **0.167.0** (latest stable). Citation key: `T/` = `https://github.com/openai/codex/blob/rust-v0.167.0/` · `M/` = same repo at `main` · `CC/` = `https://code.claude.com/docs/en/` · `AP/` = `https://github.com/agentplugins/agent-plugins-spec/blob/main/` · `NPM` = `https://registry.npmjs.org/@openai/codex`.

## What a plugin author should take from this

1. Latest stable Codex is 0.167.0, published 2026-11-06. Official docs were blocked, so almost everything here is read from source at tag `rust-v0.167.0`. [OPENED NPM — `"latest": "0.167.0"`, time `2026-11-06T01:46:01.347Z`] [SOURCE T/codex-rs/Cargo.toml#L173]
2. Codex has Claude-style lifecycle hooks. They are stable and on by default. There are 14 events. [SOURCE T/codex-rs/features/src/lib.rs#L1464-L1469] [SOURCE T/codex-rs/hooks/src/lib.rs#L29-L44]
3. `SessionStart` and `UserPromptSubmit` hooks can inject context. Plain stdout becomes model context. [SOURCE T/codex-rs/hooks/src/events/session_start.rs#L218-L223] [SOURCE T/codex-rs/hooks/src/events/user_prompt_submit.rs#L218-L227]
4. No user, project, or plugin hook runs until the user has approved it. Headless runs need `--dangerously-bypass-hook-trust`. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L917-L940] [SOURCE T/codex-rs/utils/cli/src/shared_options.rs#L61-L64]
5. Plugin hook approval is tied to a hash of every file in the plugin folder, re-checked on each run. Never write state into the plugin folder. Never ship symlinks. [SOURCE T/codex-rs/hooks/src/engine/plugin_fingerprint.rs#L1-L5] [SOURCE T/codex-rs/hooks/src/engine/plugin_fingerprint.rs#L82-L86] [SOURCE T/codex-rs/hooks/src/engine/plugin_trust.rs#L40-L44]
6. Codex loads Claude Code plugin layouts as they are: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/`, `.mcp.json`, `.claude-plugin/marketplace.json`. [SOURCE T/codex-rs/exec-server-protocol/src/protocol.rs#L54-L59] [SOURCE T/codex-rs/core-plugins/src/loader.rs#L74-L77] [SOURCE T/codex-rs/core-plugins/src/marketplace.rs#L20-L25]
7. Plugin hook commands get `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA`, as env vars and as `${...}` text replacement. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L311-L319] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L714-L716]
8. The plugin's persistent data folder is `$CODEX_HOME/plugins/data/<plugin>-<marketplace>`. The installed copy is `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`. [SOURCE T/codex-rs/core-plugins/src/store.rs#L112-L127] [SOURCE T/codex-rs/core-plugin-common/src/installed.rs#L10-L12]
9. Do not use the root `plugin.json` "Agent Plugins" manifest if you need hooks. That format gets no hooks on Codex today. Use `.codex-plugin/plugin.json` or `.claude-plugin/plugin.json`. [SOURCE T/codex-rs/core-plugins/src/loader.rs#L985-L995] **Conflict:** the official plugin docs say hooks can go under `extensions.com.openai` in root `plugin.json`. The docs may describe a newer build than 0.167.0. Test before relying on either. [OPENED https://developers.openai.com/plugins/build/plugins.md — "Add `extensions.com.openai` to root `plugin.json` for presentation, existing registered MCP server mappings, lifecycle hooks, and onboarding."]
10. Native memory exists but is off by default. It is global, not per project. It is built in the background from old session files, not during the session. [SOURCE T/codex-rs/features/src/lib.rs#L1398-L1403] [SOURCE T/codex-rs/memories/README.md#L29-L38]
11. `AGENTS.md` is the always-loaded instruction file. Project files share a 32 KiB budget. Claude Code now reads `AGENTS.md` too. [SOURCE T/codex-rs/config/src/config_toml.rs#L77] [OPENED CC/memory.md#L367 — "Reading `AGENTS.md` directly requires Claude Code v2.1.277 or later."]
12. Skills use the same `SKILL.md` format with progressive disclosure. The shared location is `.agents/skills`. [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L27-L28] [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L225] [SOURCE T/codex-rs/ext/skills/src/catalog_prompt.rs#L27]
13. Inside the sandbox, `.git`, `.agents`, `.codex` and `.aws` under the workspace are read-only. Keep project memory files somewhere else. Hooks run outside the sandbox. [SOURCE T/codex-rs/protocol/src/permissions.rs#L40-L51] [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L444-L462]
14. Proactive tools in the CLI: `codex exec`, `/goal` with automatic continuation, `clock.sleep`, `codex queue`, `notify`. There is no `/loop` and no cron in the CLI. App "Automations" are now called "Scheduled tasks". They run from the desktop app or ChatGPT web, not the CLI. [SOURCE T/codex-rs/ext/goal/src/extension.rs#L180-L201] [SOURCE T/codex-rs/cli/src/queue_cmd.rs#L18-L32] [OPENED https://learn.chatgpt.com/docs/automations.md — "Codex CLI doesn't provide the Scheduled management interface. Use ChatGPT web or the desktop app to create and manage scheduled tasks."]
15. Windows is native: win32 builds on npm, hooks through `cmd.exe /C` with a `commandWindows` override, and a `[windows] sandbox` setting. `codex mcp-server` no longer exists. [OPENED NPM — `'@openai/codex-win32-x64': 'npm:@openai/codex@0.167.0-win32-x64'`] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L660-L664] [SOURCE T/codex-rs/cli/src/main.rs#L145-L245]

---

## 0. Method, versions, and how to read the tags

**How I got the evidence.**

- `developers.openai.com` was blocked when this was first written. I did not use any mirror. It was reachable on the 2026-11-09 re-check; see "Primary-docs check" at the end. The repo's own `docs/*.md` files are stubs that point to that host. [OPENED T/docs/agents_md.md — "For information about AGENTS.md, see [this documentation](https://developers.openai.com/codex/guides/agents-md)."]
- So the primary evidence is Rust source, fetched file by file from `raw.githubusercontent.com/openai/codex/rust-v0.167.0/`. Line numbers come from those raw files. The `T/` links point to the same files on github.com.
- I did not run Codex. Nothing here was tested live.
- Tags used: `[SOURCE url#L]` = code I read. `[OPENED url — "quote"]` = page or file I read, with a verbatim quote. `[OPENED-VIA-WEBFETCH url]` = page read through a summarizing fetch tool, so I never saw the raw text. `[SEARCH-ONLY url]` = I only saw a search extract.

**Versions.**

- Stable: `0.167.0`. npm `latest` tag. Published 2026-11-06T01:46:01Z. [OPENED NPM — `"latest": "0.167.0"`]
- GitHub release tag `rust-v0.167.0` is marked Latest, shown as "06 Nov 01:40". The page shows no year. npm supplies the year. [OPENED-VIA-WEBFETCH https://github.com/openai/codex/releases]
- Newest pre-release: `0.169.0-alpha.6`, 2026-11-09T19:34Z. [OPENED NPM — `"alpha": "0.169.0-alpha.6"`]
- Native builds shipped on npm: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64, win32-arm64. [OPENED NPM — `optionalDependencies` of 0.167.0 lists all six]
- Where `main` differs from the tag and it matters, I say so.

**Surfaces.**

- The repo names four surfaces: CLI, IDE extension (VS Code, Cursor, Windsurf), desktop app (`codex app`), and Codex Web (cloud). [OPENED T/README.md — "If you want Codex in your code editor (VS Code, Cursor, Windsurf)"]
- The features below live in the shared Rust core. [OPENED T/codex-rs/core/README.md — "This crate implements the business logic for Codex. It is designed to be used by the various Codex UIs written in Rust."]
- The terminal UI runs on the app-server. [SOURCE T/codex-rs/features/src/lib.rs#L537]
- The core knows VS Code sessions as a session source. [SOURCE T/codex-rs/protocol/src/protocol.rs#L3121-L3132]
- `codex app` exists only on macOS and Windows builds. [SOURCE T/codex-rs/cli/src/main.rs#L177-L179]
- The IDE extension, the desktop app, and the cloud service are closed source. **For those three, "supported" below means "the core supports it". I could not check the clients.**

**Feature flags.**

- Each feature has a stage: under development, experimental, stable, deprecated, removed. [SOURCE T/codex-rs/features/src/lib.rs#L51-L68]
- "Stable" does not mean "on". Each feature also has a default. [SOURCE T/codex-rs/features/src/lib.rs#L1110-L1115]
- Turn a feature on with `[features] <key> = true` in `config.toml`, with `--enable <key>`, or with `codex features enable <key>`. [SOURCE T/codex-rs/cli/src/main.rs#L957-L966] [SOURCE T/codex-rs/cli/src/main.rs#L1006-L1025]

---

## 1. AGENTS.md

**What it is.** The always-loaded instruction file. Codex joins one global file and the project files into one block of user instructions.

**Discovery order.**

1. Global file: `$CODEX_HOME/AGENTS.override.md`, else `$CODEX_HOME/AGENTS.md`. The first non-empty one wins. [SOURCE T/codex-rs/codex-home/src/instructions/mod.rs#L12-L13] [SOURCE T/codex-rs/codex-home/src/instructions/mod.rs#L43-L44] [SOURCE T/codex-rs/codex-home/src/instructions/mod.rs#L68-L77]
2. Project root: walk up from the working directory until a root marker is found. The default marker is `.git`. Config key: `project_root_markers`. With no marker found, only the working directory is used. [SOURCE T/codex-rs/core/src/agents_md.rs#L10-L14] [SOURCE T/codex-rs/config/src/config_toml.rs#L525-L528]
3. For each directory from project root down to the working directory, take the first file that exists: `AGENTS.override.md`, then `AGENTS.md`, then each name in `project_doc_fallback_filenames`. One file per directory. [SOURCE T/codex-rs/core/src/agents_md.rs#L246-L259] [SOURCE T/codex-rs/core/src/agents_md.rs#L272-L296]
4. Join them root first. Global text comes first, then the separator `--- project-doc ---`, then project files. [SOURCE T/codex-rs/core/src/agents_md.rs#L49] [SOURCE T/codex-rs/core/src/agents_md.rs#L386-L419]
5. Codex never walks above the project root, and never walks below the working directory. [OPENED T/codex-rs/core/src/agents_md.rs — "We do **not** walk past the project root."] [OPENED T/codex-rs/core/src/agents_md.rs — "Collect every `AGENTS.md` found from the project root down to the current working directory (inclusive) and concatenate their contents in that order."]

**Limits.**

- `project_doc_max_bytes`. Default 32 KiB. It is one shared budget for all project files. A file that does not fit is cut off. [SOURCE T/codex-rs/config/src/config_toml.rs#L77] [SOURCE T/codex-rs/config/src/config_toml.rs#L336-L338] [SOURCE T/codex-rs/core/src/agents_md.rs#L155-L166]
- The budget applies to project files. The global loader I read has no cut-off in it. [SOURCE T/codex-rs/core/src/agents_md.rs#L68] [SOURCE T/codex-rs/codex-home/src/instructions/mod.rs#L57-L77]
- Fallback names must be bare file names. Entries with a path in them are ignored. [SOURCE T/codex-rs/core/src/agents_md.rs#L281-L290]
- Fallback names default to an empty list. So `CLAUDE.md` is read only if you add it to `project_doc_fallback_filenames`. [SOURCE T/codex-rs/config/src/config_toml.rs#L87-L89] [SOURCE T/codex-rs/config/src/config_toml.rs#L340-L342]
- If the project is marked untrusted, project files are skipped. The global file still loads. [SOURCE T/codex-rs/core/src/agents_md.rs#L63-L66]
- Project files are re-read only when the selected environments or the trust level change. [SOURCE T/codex-rs/core/src/agents_md_manager.rs#L87-L95]

**How `CODEX_HOME` changes paths.** `CODEX_HOME` replaces `~/.codex` everywhere. If set, it must exist and be a directory, or Codex stops with an error. [SOURCE T/codex-rs/utils/home-dir/src/lib.rs#L5-L17] [SOURCE T/codex-rs/utils/home-dir/src/lib.rs#L26-L41]

**Related.** `/init` writes a starter file. [OPENED T/codex-rs/tui/src/slash_command.rs — "create an AGENTS.md file with instructions for Codex"] Config also has `instructions`, `developer_instructions` and `model_instructions_file`. [SOURCE T/codex-rs/config/src/config_toml.rs#L251-L277]

**OS differences.** On a Windows executor, fallback names holding `\` or `:` are also rejected. I found no other difference. [SOURCE T/codex-rs/core/src/agents_md.rs#L283-L287]

**Surfaces.** CLI and `codex exec`: yes, by source. IDE and app: same core, clients not checked. Cloud: the official page says the cloud agent uses a repository's `AGENTS.md`. That page is now titled "Codex Cloud (Legacy)". [OPENED https://learn.chatgpt.com/docs/environments/cloud-environment.md — "If your repo includes `AGENTS.md`, the agent uses it to find project-specific lint and test commands."]

**On `main`.** Same discovery. It adds a visible warning when the budget runs out. [SOURCE M/codex-rs/core/src/agents_md.rs#L51]

---

## 2. Memory

**Does Codex have native memory today? Yes.** It is a file-backed pipeline called "memories". The flag is stage `Stable`, default **off**. [SOURCE T/codex-rs/features/src/lib.rs#L1398-L1403] [OPENED T/codex-rs/features/src/lib.rs — "Enable startup memory extraction and file-backed memory consolidation."]

**How to turn it on.**

- `[features] memories = true`, or `--enable memories`, or `codex features enable memories`. The old key `memory_tool` still maps to it. [SOURCE T/codex-rs/features/src/legacy.rs#L41-L42] [SOURCE T/codex-rs/cli/src/main.rs#L1006-L1025]
- The TUI has `/memories`. [OPENED T/codex-rs/tui/src/slash_command.rs — "configure memory use and generation"]
- The official page says the same and that memories are off by default. [OPENED https://learn.chatgpt.com/docs/customization/memories.md — "Local Codex memories are off by default."] It also confirms the v1/v2 folders below. [OPENED https://learn.chatgpt.com/docs/customization/memories.md — "When you enable memories in a fresh Codex home, the CLI uses `$CODEX_HOME/memories_v2/` by default."]

**Where it is stored.**

- `$CODEX_HOME/memories` for pipeline v1. `$CODEX_HOME/memories_v2` for pipeline v2. [SOURCE T/codex-rs/protocol/src/memory_version.rs#L15-L22]
- A fresh profile with memories on, and no existing `memories` folder, gets v2. An existing v1 folder keeps v1. [SOURCE T/codex-rs/core/src/config/mod.rs#L3706-L3720]
- Files in the folder: `memory_summary.md`, `MEMORY.md`, `raw_memories.md`, `rollout_summaries/<slug>.md`, `skills/<name>/`, and `extensions/`. [SOURCE T/codex-rs/memories/write/templates/memories/consolidation.md#L20-L35]
- The folder is also a git baseline (`~/.codex/memories/.git`). [SOURCE T/codex-rs/memories/README.md#L99-L100]
- It is **global**. There is one memory folder per `CODEX_HOME`, not one per project. Project facts live inside it as text. [SOURCE T/codex-rs/memories/README.md#L79-L81] [SOURCE T/codex-rs/memories/read/src/lib.rs#L13-L15]

**How it is written.**

- It runs when a root session starts, in the background. Only if the session is not ephemeral, the feature is on, the session is not a sub-agent, and the state database is available. [SOURCE T/codex-rs/memories/README.md#L29-L38] [OPENED T/codex-rs/memories/README.md — "It runs asynchronously in the background and executes two phases in order: Phase 1, then Phase 2."]
- Phase 1 reads past session files ("rollouts") and extracts one raw memory per session with a model call. Secrets are redacted. [SOURCE T/codex-rs/memories/README.md#L40-L63]
- Phase 2 merges them. It spawns an internal consolidation agent. [SOURCE T/codex-rs/memories/README.md#L79-L120] [OPENED T/codex-rs/memories/README.md — "runs it with no approvals, no network, and local write access only"]
- Only sessions from interactive sources feed it: CLI, VS Code, and two named custom sources. `codex exec` is not in that list. [SOURCE T/codex-rs/rollout/src/lib.rs#L88-L95]
- Defaults: 2 sessions per startup, sessions up to 10 days old, idle for at least 6 hours, memories unused for 30 days drop out, at most 256 raw memories kept. [SOURCE T/codex-rs/config/src/types.rs#L57-L62]
- It is skipped when the account's rate-limit headroom is low (default: under 25% remaining). [SOURCE T/codex-rs/memories/write/src/start.rs#L80-L87] [SOURCE T/codex-rs/config/src/types.rs#L60]
- So memory is **not** written during the session. A fact from today's session can only appear after a later session starts and the idle window has passed.
- The one in-session write path: if the user explicitly asks to remember or forget something, the model writes a small note file to `<memory root>/extensions/ad_hoc/notes/`. Consolidation applies it later. [OPENED T/codex-rs/ext/memories/templates/memories/read_path.md — "You can update the memories **only** when explicitly asked by the user."] [SOURCE T/codex-rs/ext/memories/templates/memories/read_path.md#L117-L123]

**How it is loaded.**

- At thread start, Codex reads `memory_summary.md`, cuts it to about 2,500 tokens, and injects it with usage instructions as a developer message. [SOURCE T/codex-rs/ext/memories/src/prompts.rs#L35-L52] [SOURCE T/codex-rs/ext/memories/src/lib.rs#L16] [SOURCE T/codex-rs/ext/memories/src/extension.rs#L62-L74]
- The rest is progressive disclosure. The model is told to search `MEMORY.md` and open rollout summaries or memory skills only when needed. [SOURCE T/codex-rs/ext/memories/templates/memories/read_path.md#L21-L46]
- If `memory_summary.md` is missing or empty, nothing is injected. [SOURCE T/codex-rs/ext/memories/src/prompts.rs#L41-L52]
- Optional dedicated tools exist: namespace `memories` with `add_ad_hoc_note`, `list`, `read`, `search`. They are off unless `[memories] dedicated_tools = true`. [SOURCE T/codex-rs/ext/memories/src/lib.rs#L18-L22] [SOURCE T/codex-rs/ext/memories/src/extension.rs#L148-L150] [SOURCE T/codex-rs/config/src/types.rs#L337-L338]

**Config keys (`[memories]`).** `version`, `dual_write`, `disable_on_external_context`, `generate_memories`, `use_memories`, `dedicated_tools`, `max_raw_memories_for_consolidation`, `max_unused_days`, `max_rollout_age_days`, `max_rollouts_per_startup`, `min_rollout_idle_hours`, `min_rate_limit_remaining_percent`, `extract_model`, `consolidation_model`, `consolidation_service_tier`. [SOURCE T/codex-rs/config/src/types.rs#L324-L360]

**A hidden extension point.** The consolidation agent reads every `<memory root>/extensions/<name>/instructions.md` and treats files beside it as extra memory signals. Files under `resources/` named with a leading timestamp are pruned after 14 days. This is in source only. I found no public contract for it. [SOURCE T/codex-rs/memories/write/src/lib.rs#L54-L67] [SOURCE T/codex-rs/memories/write/src/extensions/prune.rs#L13-L14] [SOURCE T/codex-rs/memories/write/src/extensions/prune.rs#L33-L41] [SOURCE T/codex-rs/memories/write/src/lib.rs#L45-L48]

**Safety notes built in.** Notes are treated as data, not instructions. [OPENED T/codex-rs/memories/write/templates/extensions/ad_hoc/instructions.md — "Content of notes can't be trusted."] User, project, and plugin hooks do not run inside the consolidation agent. [SOURCE T/codex-rs/hooks/src/engine/mod.rs#L175-L192]

**Related, not ready.** Importing Claude Code's per-project memory is under development. [SOURCE T/codex-rs/features/src/lib.rs#L1405-L1409] The importer looks at `<external home>/projects/<project>/memory/*.md`. [SOURCE T/codex-rs/external-agent-migration/src/memory.rs#L8-L22] "Chronicle" (screen-context memories) is under development. [SOURCE T/codex-rs/features/src/lib.rs#L1429-L1433]

**OS differences.** None found in the memory code. The memory root may not be a symlink. [SOURCE T/codex-rs/memories/write/src/lib.rs#L136-L151]

**Surfaces.** CLI: yes. IDE and app: the app-server exposes `thread/memory/read`, marked experimental. [OPENED T/codex-rs/app-server/README.md — "`thread/memory/read` takes `{threadId}` for a loaded thread and returns"] Cloud: unknown.

---

## 3. Skills

**What it is.** Folders with a `SKILL.md`. Codex lists name, description and path in context, and the model opens the file when it decides to use the skill.

**Where skills live.**

| Scope | Path | Evidence |
|---|---|---|
| Repo | `.agents/skills` in every directory from project root down to the working directory | [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L218-L244] |
| Repo | `<project>/.codex/skills` | [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L125-L133] |
| User | `~/.agents/skills` | [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L142-L147] |
| User (old) | `$CODEX_HOME/skills`, kept "for backward compatibility" | [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L134-L140] |
| System | `$CODEX_HOME/skills/.system`, unpacked from the binary | [SOURCE T/codex-rs/skills/src/lib.rs#L58-L70] |
| Admin | `skills` beside the system config (`/etc/codex/skills` on Unix) | [SOURCE T/codex-rs/ext/skills/src/host_roots.rs#L154-L159] |
| Plugin | the plugin's `skills/` folder, or the manifest's `skills` paths | [SOURCE T/codex-rs/core-plugins/src/loader.rs#L1114-L1142] |

- Bundled system skills at this tag: `imagegen`, `openai-docs`, `review-agent`, `skill-creator`, `skill-installer`. [OPENED-VIA-WEBFETCH https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs/skills/src/assets/samples]

**Frontmatter Codex actually parses.** `name` (optional, defaults to the folder name, max 64 characters), `description` (required), and `metadata.short-description`. Other keys are not read by this parser. [SOURCE T/codex-rs/skills/src/parser.rs#L4-L20] [SOURCE T/codex-rs/skills/src/parser.rs#L64-L85]

**`agents/openai.yaml` (optional, beside `SKILL.md`).**

- `interface`: `display_name`, `short_description`, `icon_small`, `icon_large`, `brand_color`, `default_prompt`. [SOURCE T/codex-rs/skills/src/interface.rs#L13-L22]
- `policy`: `allow_implicit_invocation`, `products`. [SOURCE T/codex-rs/skills/src/metadata.rs#L52-L58]
- `dependencies.tools[]`: `type`, `value`, `description`, `transport`, `command`, `url`, `oauth.callback_port`. This lets a skill declare an MCP server it needs. [SOURCE T/codex-rs/skills/src/metadata.rs#L60-L77]
- Implicit use is allowed unless the policy says no. [SOURCE T/codex-rs/skills/src/model.rs#L22-L28] [OPENED T/codex-rs/skills/src/assets/samples/skill-creator/SKILL.md — "This keeps the skill available when explicitly invoked as `$skill-name` without adding it to the model context automatically."]

**How a skill is invoked.**

- By name with `$SkillName`, by plain text, or implicitly when the task matches the description. [OPENED T/codex-rs/ext/skills/src/catalog_prompt.rs — "If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use"]
- `/skills` exists in the TUI. [OPENED T/codex-rs/tui/src/slash_command.rs — "use skills to improve how Codex performs specific tasks"]
- Skills do not carry across turns unless named again. [OPENED T/codex-rs/ext/skills/src/catalog_prompt.rs — "Do not carry skills across turns unless re-mentioned."]

**Progressive disclosure and limits.**

- The catalog budget is 2% of the context window by default. A configured budget is capped at 10,000 tokens. [SOURCE T/codex-rs/ext/skills/src/render.rs#L23-L27] [SOURCE T/codex-rs/config/src/skills_config.rs#L49-L52]
- Descriptions are cut at 1,024 characters in the catalog. [SOURCE T/codex-rs/ext/skills/src/render.rs#L27]
- The model is told to read the chosen `SKILL.md` in full, then only the linked files it needs. [SOURCE T/codex-rs/ext/skills/src/catalog_prompt.rs#L27-L38]
- Config: `[skills]` with `bundled.enabled`, `include_instructions`, `max_context_tokens`, and `config[]` entries (`path` or `name`, plus `enabled`). [SOURCE T/codex-rs/config/src/skills_config.rs#L19-L56]

**Context from the wider ecosystem.**

- The Agent Skills spec lists `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`. Codex's parser reads fewer keys than the spec allows. [OPENED https://raw.githubusercontent.com/agentskills/agentskills/main/docs/specification.mdx — "The `SKILL.md` file must contain YAML frontmatter followed by Markdown content."]
- OpenAI's old skills catalog repo is deprecated in favour of plugins. [OPENED https://raw.githubusercontent.com/openai/skills/main/README.md — "**This repository is deprecated.** For current Codex skill and plugin examples, use the [OpenAI Plugins repository]"]

**OS differences.** None found. **Surfaces.** CLI: yes. IDE and app: same core. Cloud: unknown.

---

## 4. Hooks

**Does Codex have lifecycle hooks today? Yes.** Feature key `hooks`, stage `Stable`, default **on**. The source calls them "Claude-style". The engine type is named `ClaudeHooksEngine`. [OPENED https://learn.chatgpt.com/docs/hooks.md — "Hooks are enabled by default."] [SOURCE T/codex-rs/features/src/lib.rs#L1464-L1469] [OPENED T/codex-rs/features/src/lib.rs — "Enable Claude-style lifecycle hooks loaded from hooks.json files."] [SOURCE T/codex-rs/hooks/src/registry.rs#L69]

**The 14 events.** [SOURCE T/codex-rs/hooks/src/lib.rs#L29-L44]

| Event | Matcher tests | Can add context | Can block or stop | Evidence |
|---|---|---|---|---|
| `SessionStart` | `source`: `startup`, `resume`, `clear`, `compact`, `fork` | Yes. Plain stdout or `hookSpecificOutput.additionalContext` | `continue:false` stops | [SOURCE T/codex-rs/hooks/src/events/session_start.rs#L243-L314] [SOURCE T/codex-rs/hooks/src/schema.rs#L859-L861] |
| `UserPromptSubmit` | none | Yes. Same two ways | Exit 2 + stderr, or `decision:"block"` | [SOURCE T/codex-rs/hooks/src/events/user_prompt_submit.rs#L157-L245] |
| `PreToolUse` | tool name | Yes (`additionalContext`) | Exit 2 + stderr, `permissionDecision:"deny"`, or `decision:"block"` blocks. `permissionDecision:"allow"` with `updatedInput` rewrites. `ask` is not honored. [OPENED https://learn.chatgpt.com/docs/hooks.md — "`permissionDecision: "ask"`, legacy `decision: "approve"`, `continue: false`, `stopReason`, and `suppressOutput` are parsed but not supported yet."] | [SOURCE T/codex-rs/hooks/src/events/pre_tool_use.rs#L268-L281] [SOURCE T/codex-rs/hooks/src/events/pre_tool_use.rs#L485] [SOURCE T/codex-rs/hooks/src/events/pre_tool_use.rs#L602] |
| `PermissionRequest` | tool name | No | `decision.behavior` `allow` or `deny` | [SOURCE T/codex-rs/hooks/src/schema.rs#L187-L227] |
| `PostToolUse` | tool name | Yes | `decision:"block"` | [SOURCE T/codex-rs/hooks/src/schema.rs#L143-L156] [SOURCE T/codex-rs/hooks/src/schema.rs#L229-L240] |
| `PreCompact` | `trigger`: `manual`, `auto` | No | `continue:false` aborts the compaction | [SOURCE T/codex-rs/hooks/src/events/compact.rs#L59-L67] [SOURCE T/codex-rs/core/src/compact.rs#L197-L211] |
| `PostCompact` | `trigger` | No | `continue:false` | [SOURCE T/codex-rs/core/src/compact.rs#L225] |
| `Stop` | none | No | `decision:"block"` + `reason`, or exit 2 + stderr. The reason becomes the next prompt and the agent keeps going | [SOURCE T/codex-rs/hooks/src/events/stop.rs#L299-L311] [SOURCE T/codex-rs/hooks/src/events/stop.rs#L330-L339] |
| `SubagentStart` | agent type | Yes, context only | No | [SOURCE T/codex-rs/hooks/src/events/session_start.rs#L218-L223] |
| `SubagentStop` | agent type | No | Same as `Stop` | [SOURCE T/codex-rs/hooks/src/events/stop.rs#L52-L65] |
| `SessionEnd` | reason, always `other` | No | No. Default timeout 1 s, hard cap 3 s. Root sessions only | [SOURCE T/codex-rs/hooks/src/events/session_end.rs#L20-L24] [SOURCE T/codex-rs/core/src/hook_runtime.rs#L477-L482] |
| `Interrupt` | none | No | No. Same 1 s / 3 s timeout | [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L946-L970] |
| `PreModelRequest`, `PostModelRequest` | none | No | No. Observation only | [OPENED T/codex-rs/hooks/src/events/model_request.rs — "Observation-only lifecycle hooks. Output is logged, never interpreted as control flow."] |

- Events that honor a matcher are listed in source. Others ignore it. [SOURCE T/codex-rs/hooks/src/lib.rs#L46-L61]
- Context injection is limited to five events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L686-L703]
- After a compaction, Codex queues a `SessionStart` with source `compact`. That is the way to re-inject context after compaction, since `PreCompact` cannot add context. [SOURCE T/codex-rs/core/src/session/mod.rs#L4681]
- In a spawned sub-agent, session start fires `SubagentStart` instead of `SessionStart`. [SOURCE T/codex-rs/core/src/hook_runtime.rs#L137-L158]

**Where hooks are configured.**

- `hooks.json` in each config layer's folder: `$CODEX_HOME/hooks.json`, `<project>/.codex/hooks.json`, and the system config folder. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L390-L395] [SOURCE T/codex-rs/config/src/state.rs#L219-L243]
- Or a `[hooks]` table in the same layer's `config.toml`. Using both in one layer gives a warning. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L433-L439] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L184-L194]
- File shape: `{ "description"?, "hooks": { "<Event>": [ { "matcher"?, "hooks": [ handler ] } ] } }`. Unknown top-level keys are rejected. [SOURCE T/codex-rs/config/src/hook_config.rs#L12-L19] [SOURCE T/codex-rs/protocol/src/hooks.rs#L140-L146]
- Handler types: `command` and `mcp_tool` work. `prompt` and `agent` parse but are skipped with "not supported yet". [SOURCE T/codex-rs/protocol/src/hooks.rs#L148-L188] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L782-L801]
- `command` fields: `command`, `commandWindows`, `timeout` (seconds), `async`, `statusMessage`, `additionalContextLimit`. [SOURCE T/codex-rs/protocol/src/hooks.rs#L152-L172]
- Default timeout is 600 s. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L968]
- At most 8 async hooks run at once. Async hooks cannot block or stop anything. [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L54] [SOURCE T/codex-rs/hooks/src/engine/mod.rs#L206-L209]

**Input contract (stdin JSON).**

- Common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`. Turn-scoped events add `turn_id`. [SOURCE T/codex-rs/hooks/src/schema.rs#L497-L511] [SOURCE T/codex-rs/hooks/src/schema.rs#L565-L584]
- `UserPromptSubmit` adds `prompt`. `Stop` adds `stop_hook_active` and `last_assistant_message`. Tool events add `tool_name`, `tool_input`, `tool_use_id`, and `tool_response` after the call. [SOURCE T/codex-rs/hooks/src/schema.rs#L586-L602] [SOURCE T/codex-rs/hooks/src/schema.rs#L321-L343]
- `transcript_path` is the session's rollout file. [SOURCE T/codex-rs/core/src/session/mod.rs#L5693-L5705]
- `permission_mode` is only ever `bypassPermissions` (approval policy `never`) or `default` in the source at this tag. [SOURCE T/codex-rs/core/src/hook_runtime.rs#L1073-L1081] The official page lists five values. Do not assume only two. [OPENED https://learn.chatgpt.com/docs/hooks.md — "describes the current permission mode as `default`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`."]
- Tool names: shell is `Bash`. File edits are `apply_patch`, and matchers `Write` and `Edit` also select it. Sub-agent spawn is `spawn_agent`, and matcher `Agent` also selects it. [SOURCE T/codex-rs/core/src/tools/hook_names.rs#L28-L56]
- Generated JSON schemas for every input and output are in the repo under `codex-rs/hooks/schema/generated/`. [SOURCE T/codex-rs/hooks/src/schema.rs#L17-L41]

**Output contract.**

- Universal JSON fields: `continue`, `stopReason`, `suppressOutput`, `systemMessage`. Unknown fields are rejected. [SOURCE T/codex-rs/hooks/src/schema.rs#L88-L100]
- Non-zero exit other than 2 marks the hook failed. It does not block. [SOURCE T/codex-rs/hooks/src/events/user_prompt_submit.rs#L246-L252]
- Output that looks like JSON but does not match the schema is a failure, not context. [SOURCE T/codex-rs/hooks/src/events/session_start.rs#L288-L304]
- Injected context over about 2,500 tokens is saved to `<temp dir>/hook_outputs/<thread id>/` and replaced by a preview with the file path. `additionalContextLimit` changes the limit. `0` turns the spill off. [SOURCE T/codex-rs/hooks/src/output_spill.rs#L12-L13] [SOURCE T/codex-rs/hooks/src/output_spill.rs#L54-L59] [SOURCE T/codex-rs/protocol/src/hooks.rs#L162-L171]

**Trust. This is the big difference from Claude Code.**

- A non-managed hook runs only when it is enabled **and** its stored `trusted_hash` matches its current definition. Otherwise it is listed but not run. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L917-L940] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L1000-L1017]
- Trust state lives in the user's config under `[hooks.state."<key>"]` with `enabled`, `trusted_hash`, `trusted_content_hash`. Only the user layer and session flags may set it. A project cannot trust its own hooks. [SOURCE T/codex-rs/config/src/hook_config.rs#L29-L38] [SOURCE T/codex-rs/hooks/src/config_rules.rs#L8-L14]
- The TUI has `/hooks` to review them. [OPENED T/codex-rs/tui/src/slash_command.rs — "view and manage lifecycle hooks"] The official page says trust is granted there, against the hook's hash. [OPENED https://learn.chatgpt.com/docs/hooks.md — "Codex records trust against the hook's current hash, so new or changed hooks are marked for review and skipped until trusted."] I found no CLI subcommand that grants trust. [SOURCE T/codex-rs/cli/src/main.rs#L145-L245]
- One-off bypass: `--dangerously-bypass-hook-trust`. It is a global flag for `codex exec` too. [OPENED T/codex-rs/utils/cli/src/shared_options.rs — "Run enabled hooks without requiring persisted hook trust for this invocation."] [SOURCE T/codex-rs/exec/src/cli.rs#L163-L170]
- Project hooks also need the project itself to be trusted. [SOURCE T/codex-rs/config/src/loader/mod.rs#L1128-L1146]
- Admins can allow managed hooks only. [OPENED T/docs/config.md — "Admins can set top-level `allow_managed_hooks_only = true` in `requirements.toml` to ignore user, project, and session hook configs"]

**How plugins ship hooks.**

- Default file: `hooks/hooks.json` in the plugin. Or the manifest `hooks` field: a path, a list of paths, an inline object, or a list of inline objects. [SOURCE T/codex-rs/core-plugins/src/loader.rs#L75] [SOURCE T/codex-rs/core-plugins/src/loader.rs#L1221-L1278] [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L150-L158]
- Plugin hooks are on with plugins. The old separate flag `plugin_hooks` is removed. [SOURCE T/codex-rs/features/src/lib.rs#L1821-L1825]
- Env for plugin hooks: `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L311-L319] [OPENED T/codex-rs/hooks/src/engine/discovery.rs — "For OOTB compat with existing plugins that use this env var."]
- The same four names are replaced in the command string when written as `${NAME}`. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L714-L716]
- There is **no** project-directory variable. Nothing like `CLAUDE_PROJECT_DIR` is set. Use the `cwd` field on stdin. The hook process also starts in the session's working directory. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L311-L319] [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L280-L281]
- Plugin hook trust adds a content hash of the whole plugin folder. It is re-computed before each run. If any file changed: "plugin contents changed; hook approval required". The official page confirms a plugin update resets approval. [OPENED https://learn.chatgpt.com/docs/hooks.md — "If a plugin update changes a bundled script, Codex requires a new review even if the hook definition stays the same."] [SOURCE T/codex-rs/hooks/src/engine/plugin_trust.rs#L1-L6] [SOURCE T/codex-rs/hooks/src/engine/plugin_trust.rs#L40-L44] [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L228-L247]
- The hash skips only `__pycache__`, `.venv`, `*.pyc`, `*.egg-info`. A symlink or other special file in the plugin makes the hash fail. [SOURCE T/codex-rs/hooks/src/engine/plugin_fingerprint.rs#L37-L47] [SOURCE T/codex-rs/hooks/src/engine/plugin_fingerprint.rs#L82-L86]
- The hash shares the hook's timeout. A large plugin can make a 1-second `SessionEnd` hook time out. [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L227-L233]
- Plugins in the Agent Plugins format (root `plugin.json`) get no hooks at all, by the source at this tag. [SOURCE T/codex-rs/core-plugins/src/loader.rs#L985-L995] The official plugin docs say otherwise: hooks can be set under `extensions.com.openai` in root `plugin.json`. Treat this as unresolved. [OPENED https://developers.openai.com/plugins/build/plugins.md — "To override that default, define `hooks` inside `extensions.com.openai` in root `plugin.json`."]

**Do hooks work on Windows? Yes.**

- With no session shell known, Windows runs `%COMSPEC%` (fallback `cmd.exe`) with `/C "<command>"`. Unix runs `$SHELL` (fallback `/bin/sh`) with `-lc`. [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L444-L470] [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L499-L522]
- When the session has a detected shell, the hook command is passed to that shell instead. So keep hook command strings simple and portable. [SOURCE T/codex-rs/core/src/session/mod.rs#L5805-L5813]
- `commandWindows` replaces `command` on Windows. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L660-L664] [OPENED https://learn.chatgpt.com/docs/hooks.md — "`commandWindows` is an optional Windows-only command override."] The official hooks page has no Windows exclusion.
- Windows uses a Job Object to clean up. Unix kills the process group. [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L283-L287] [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L390-L415]

**Other notes.**

- Hooks run as plain host processes. I saw no sandbox wrapper in the hook runner. [SOURCE T/codex-rs/hooks/src/engine/command_runner.rs#L444-L496]
- The older `notify` setting still exists beside hooks (section 8).

**Surfaces.** CLI and `codex exec`: yes, by source. The official page lists the same file locations. The desktop app has its own review screen. [OPENED https://learn.chatgpt.com/docs/hooks.md — "In the CLI, open `/hooks`. In the desktop app, select **Review hooks** in the composer or open **Settings > Hooks**."] Cloud-orchestrated ChatGPT Work runs only admin-set MCP hooks. [OPENED https://learn.chatgpt.com/docs/hooks.md — "Cloud orchestration supports only Global MCP hooks, even when a tool runs on a connected computer."] Codex Cloud tasks: unknown.

---

## 5. Plugins

**Status.** Feature key `plugins`, stage `Stable`, default on. [SOURCE T/codex-rs/features/src/lib.rs#L1790-L1795]

**Manifest paths Codex looks for, in this order.**

1. `plugin.json` in the plugin root, **only if** its `$schema` is an Agent Plugins schema. [SOURCE T/codex-rs/utils/plugins/src/plugin_namespace.rs#L12-L18] [SOURCE T/codex-rs/utils/plugins/src/plugin_namespace.rs#L43-L61]
2. `.codex-plugin/plugin.json`
3. `.claude-plugin/plugin.json`
4. `.cursor-plugin/plugin.json` [SOURCE T/codex-rs/exec-server-protocol/src/protocol.rs#L54-L59]

**`.codex-plugin/plugin.json` fields (the same parser reads the `.claude-plugin` and `.cursor-plugin` files).**

- `name`, `version`, `description`, `keywords`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L48-L58]
- `skills`: a path or list of paths. Default folder `skills/`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L61-L62] [SOURCE T/codex-rs/core-plugins/src/loader.rs#L74]
- `mcpServers`: a path or an inline object. Default file `.mcp.json`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L63-L64] [SOURCE T/codex-rs/core-plugins/src/loader.rs#L76]
- `apps`: a path. Default file `.app.json`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L65-L66] [SOURCE T/codex-rs/core-plugins/src/loader.rs#L77]
- `hooks`: see section 4. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L67-L68]
- `interface`: `displayName`, `shortDescription`, `longDescription`, `developerName`, `category`, `capabilities`, `websiteURL`, `privacyPolicyURL`, `termsOfServiceURL`, `defaultPrompt` (up to 3, each up to 128 characters), `brandColor`, `composerIcon`, `logo`, `logoDark`, `screenshots`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L81-L117] [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L16-L17]
- `extensions`: free-form. Codex reads `extensions["com.openai"].onboardingSkill`. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L71-L72] [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L385-L390]
- `commands`: a path or list. Default folder `commands/`. Command files are converted to skills at install time. Each needs a frontmatter description. Each is capped at 4,000 bytes. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L75-L79] [SOURCE T/codex-rs/core-plugins/src/command_migration/plugin.rs#L16-L40]
- Manifest paths must use `./` form and stay inside the plugin. [SOURCE T/codex-rs/core-plugins/src/manifest.rs#L59-L60]

**What a plugin can ship.** Skills, hooks, MCP servers, apps (connectors), and commands (as skills). [SOURCE T/codex-rs/plugin/src/manifest.rs#L17-L25] The official examples repo also names plugin-level `agents/`. I found no loader code for that. [OPENED https://raw.githubusercontent.com/openai/plugins/main/README.md — "Each plugin lives under `plugins/<name>/` with a required `.codex-plugin/plugin.json` manifest"]

**Agent Plugins format (root `plugin.json`).**

- An open spec for skills and MCP servers only. [OPENED https://raw.githubusercontent.com/agentplugins/agent-plugins-spec/main/README.md — "It defines a portable package format for Agent Skills and MCP servers."]
- Codex maps it to `./skills` and `./mcp.json`, and reads Codex extras from `extensions["com.openai"]` or from an extra `.codex-plugin/plugin.json`. [SOURCE T/codex-rs/core-plugins/src/agent_plugin_manifest.rs#L17] [SOURCE T/codex-rs/core-plugins/src/agent_plugin_manifest.rs#L169-L170] [SOURCE T/codex-rs/core-plugins/src/manifest/manifest_cache.rs#L64-L68]
- But hooks are not loaded for this format, by the source at this tag. [SOURCE T/codex-rs/core-plugins/src/loader.rs#L985-L995] The official plugin docs conflict with this (see section 4).
- Its MCP config supports `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in `args`, `env`, `cwd`. [SOURCE T/codex-rs/codex-mcp/src/agent_plugin_config.rs#L17-L18] [SOURCE T/codex-rs/codex-mcp/src/agent_plugin_config.rs#L211-L230]

**Variables.**

| Where | What is available | Evidence |
|---|---|---|
| Hook commands (`.codex-plugin` / `.claude-plugin` format) | `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `CLAUDE_PLUGIN_DATA`, as env and as `${...}` | [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L311-L319] |
| `.mcp.json` in the same format | No placeholder expansion found. A relative `cwd` is resolved against the plugin root | [SOURCE T/codex-rs/codex-mcp/src/plugin_config.rs#L323-L331] |
| `mcp.json` in Agent Plugins format | `${PLUGIN_ROOT}`, `${PLUGIN_DATA}` in `args`, `env`, `cwd`; both set as env | [SOURCE T/codex-rs/codex-mcp/src/agent_plugin_config.rs#L211-L230] |

So a Claude Code plugin whose `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}` in `args` will likely not start on Codex unchanged. That is my reading of the code, not a test.

**Install and cache locations.**

- Plugin id is `<plugin>@<marketplace>`. [SOURCE T/codex-rs/core-plugin-common/src/plugin_id.rs#L26-L47]
- Installed copy: `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>`. Default version is `local`. [SOURCE T/codex-rs/core-plugins/src/store.rs#L112-L120] [SOURCE T/codex-rs/core-plugin-common/src/installed.rs#L10-L11]
- Data folder: `$CODEX_HOME/plugins/data/<plugin>-<marketplace>`. This is `PLUGIN_DATA`. [SOURCE T/codex-rs/core-plugins/src/store.rs#L27] [SOURCE T/codex-rs/core-plugins/src/store.rs#L122-L127]
- Agent Plugins data folder: `$CODEX_HOME/plugins/data/agent-plugins/<hash>`. [SOURCE T/codex-rs/core-plugins/src/store.rs#L129-L137]
- Config: `[plugins."<plugin>@<marketplace>"] enabled = true|false`, plus per-plugin MCP policy. [SOURCE T/codex-rs/config/src/types.rs#L1106-L1115] [SOURCE T/codex-rs/config/src/config_toml.rs#L503-L505]

**Marketplaces.**

- Marketplace file paths: `.agents/plugins/marketplace.json`, `.agents/plugins/api_marketplace.json`, `.claude-plugin/marketplace.json`, `.cursor-plugin/marketplace.json`. [SOURCE T/codex-rs/core-plugins/src/marketplace.rs#L20-L25]
- Looked for in the home directory, in configured roots, and at the git repo root. [SOURCE T/codex-rs/core-plugins/src/marketplace.rs#L473-L510]
- Shape: `name`, optional `interface.displayName`, and `plugins[]` with `name`, `source`, `policy` (`installation`, `authentication`, `products`), `category`. [SOURCE T/codex-rs/core-plugins/src/marketplace.rs#L997-L1033]
- Plugin `source`: a path string, or `{source: "local"|"url"|"git-subdir"|"npm", ...}`. [SOURCE T/codex-rs/core-plugins/src/marketplace.rs#L1035-L1070]
- CLI: `codex plugin add|list|remove`, and `codex plugin marketplace add|list|upgrade|remove`. [SOURCE T/codex-rs/cli/src/plugin_cmd.rs#L61-L80] [SOURCE T/codex-rs/cli/src/marketplace_cmd.rs#L43-L58]
- `marketplace add` takes a local path, `owner/repo[@ref]`, an HTTPS git URL, or an SSH git URL. [SOURCE T/codex-rs/cli/src/marketplace_cmd.rs#L60-L68]
- Git marketplaces are cloned to `$CODEX_HOME/.tmp/marketplaces/<name>` and recorded in `[marketplaces.<name>]`. [SOURCE T/codex-rs/core-plugins/src/installed_marketplaces.rs#L12-L16] [SOURCE T/codex-rs/config/src/types.rs#L1229-L1248]
- TUI: `/plugins`. [OPENED T/codex-rs/tui/src/slash_command.rs — "browse plugins"]

**Migration from Claude Code is built in.** `/import` exists. [OPENED T/codex-rs/tui/src/slash_command.rs — "import setup, this project, and recent chats from Claude Code"] The importer knows Claude Code's marketplace registry and official marketplace names. [SOURCE T/codex-rs/external-agent-migration/src/source_cla.rs#L20-L24] It has modules for hooks, MCP, memory, plugins, sessions, and sub-agents. [SOURCE T/codex-rs/external-agent-migration/src/lib.rs#L3-L23]

**OS differences.** None found in plugin loading. **Surfaces.** CLI: yes. App and IDE: same core. Cloud: unknown.

---

## 6. Subagents / multi-agent

**What exists.** Two generations.

- V1: feature key `multi_agent`, stage `Stable`, default **on** at 0.167.0. On `main` it is already marked `Deprecated`. [SOURCE T/codex-rs/features/src/lib.rs#L1592-L1597] [SOURCE M/codex-rs/features/src/lib.rs]
- V2: feature key `multi_agent_v2`, stage `Stable`, default **off**. [SOURCE T/codex-rs/features/src/lib.rs#L1598-L1603]
- V1 tools live in namespace `multi_agent_v1`: `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`. [SOURCE T/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L14] [SOURCE T/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L92] [SOURCE T/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L193-L346]
- V2 tools: `spawn_agent` (needs `task_name` and `message`), `send_message`, `followup_task`, `wait_agent`, `list_agents`, `interrupt_agent`. [SOURCE T/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L142-L157] [SOURCE T/codex-rs/core/src/tools/handlers/multi_agents_spec.rs#L222-L370]

**Config (`[agents]`).**

- `enabled`, `max_concurrent_threads_per_session` (alias `max_threads`), `max_depth` (V1 only), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`. [SOURCE T/codex-rs/config/src/config_toml.rs#L764-L786]
- Defaults: 6 threads and depth 1 for V1. 4 threads per session for V2. [SOURCE T/codex-rs/core/src/config/mod.rs#L260-L270]

**Roles (custom agents).**

- Declare in config as `[agents.<role>]` with `description`, `config_file`, `nickname_candidates`. [SOURCE T/codex-rs/config/src/config_toml.rs#L788-L814]
- Or drop `*.toml` files in an `agents/` folder beside any config layer: `$CODEX_HOME/agents/`, `<project>/.codex/agents/`. Sub-folders are scanned. [SOURCE T/codex-rs/agent-roles/src/loader.rs#L75-L78] [SOURCE T/codex-rs/agent-roles/src/discovery.rs#L7-L35]
- A role file is TOML: `name`, `description`, `nickname_candidates`, plus normal config keys. Unknown keys are rejected. [SOURCE T/codex-rs/agent-roles/src/agent_role_config.rs#L20-L28]
- A role can only change: `developer_instructions`, `model`, reasoning effort and summary, verbosity, `service_tier`, `features`, `skills`. It cannot widen the parent's authority. [SOURCE T/codex-rs/core/src/agent/role.rs#L1-L4] [SOURCE T/codex-rs/core/src/agent/role.rs#L36-L48]
- Built-in roles: `default`, `explorer`, `worker`. [SOURCE T/codex-rs/core/src/agent/role.rs#L33] [SOURCE T/codex-rs/core/src/agent/role.rs#L360-L374]
- Note the format gap: Codex roles are TOML files. They are not Markdown files with frontmatter.

**Hooks and UI.** `SubagentStart` and `SubagentStop` fire for spawned agents (section 4). TUI has `/agents` (command center) and `/subagents`. [SOURCE T/codex-rs/tui/src/slash_command.rs#L144-L145]

**Still under development.** A shared agent message board, and waking an idle root session on agent mail. [SOURCE T/codex-rs/features/src/lib.rs#L1635-L1639]

**OS differences.** None found. **Surfaces.** CLI: yes. Others: same core, not checked. The official page agrees on the two `agents/` folders. [OPENED https://learn.chatgpt.com/docs/agent-configuration/subagents.md — "add standalone TOML files under `~/.codex/agents/` for personal agents or `.codex/agents/` for project-scoped agents."] It does not state `max_threads = 6` or `max_depth = 1`. It says only that Codex picks the thread default, and it does not mention `max_depth`. Those two numbers rest on source only. It also says each custom agent file must define `name`, `description`, and `developer_instructions`.

---

## 7. Compaction and context

- **Auto-compaction** triggers at 90% of the model's context window by default. `model_auto_compact_token_limit` can lower it but is clamped to that 90%. [SOURCE T/codex-rs/protocol/src/openai_models.rs#L563-L574] [SOURCE T/codex-rs/config/src/config_toml.rs#L182-L183]
- Other keys: `model_context_window`, `model_auto_compact_token_limit_scope`, `model_post_turn_compact_threshold_percent` (compact after a final answer; off when unset), `tool_output_token_limit`. [SOURCE T/codex-rs/config/src/config_toml.rs#L179-L193] [SOURCE T/codex-rs/config/src/config_toml.rs#L344-L345]
- **Manual:** `/compact`. There is also `/recap`. [OPENED T/codex-rs/tui/src/slash_command.rs — "summarize conversation to prevent hitting the context limit"] [SOURCE T/codex-rs/tui/src/slash_command.rs#L100]
- **Two implementations.** If the model provider supports it, compaction is done server-side ("remote"). Otherwise Codex asks the model for a summary locally. [SOURCE T/codex-rs/core/src/tasks/compact.rs#L63-L80]
- **Local summary prompt.** [OPENED T/codex-rs/prompts/templates/compact/prompt.md — "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task."] You can replace it with `compact_prompt` or `experimental_compact_prompt_file`. [SOURCE T/codex-rs/config/src/config_toml.rs#L279-L280] [SOURCE T/codex-rs/config/src/config_toml.rs#L566]
- **What is preserved (local path).** The initial context is rebuilt, recent user messages are kept up to 20,000 tokens (newest first), and the summary is added with a fixed prefix. [SOURCE T/codex-rs/core/src/compact.rs#L63] [SOURCE T/codex-rs/core/src/compact.rs#L84-L99] [SOURCE T/codex-rs/core/src/compact.rs#L407-L410] [SOURCE T/codex-rs/core/src/compact.rs#L701-L712]
- **Hooks around it.** `PreCompact` runs first and can abort. `PostCompact` runs after success. Then a `SessionStart` with source `compact` is queued. [SOURCE T/codex-rs/core/src/compact.rs#L197-L211] [SOURCE T/codex-rs/core/src/compact.rs#L225] [SOURCE T/codex-rs/core/src/session/mod.rs#L4681]
- **Tools the model may get:** `get_context_remaining` and `new_context_window` handlers exist in the tree. I did not check when they are exposed. [OPENED-VIA-WEBFETCH https://github.com/openai/codex/tree/rust-v0.167.0/codex-rs/core/src/tools/handlers]
- **Under development:** background ("async") compaction. [SOURCE T/codex-rs/features/src/lib.rs#L2283-L2287]
- **Release note for 0.167.0** mentions a fix so auto-compaction counts output kept from failed responses. [OPENED-VIA-WEBFETCH https://github.com/openai/codex/releases]
- **OS differences.** None found. **Surfaces.** Core feature; clients not checked.

---

## 8. Proactive, scheduled, and unattended work

**`codex exec` (headless).** [SOURCE T/codex-rs/cli/src/main.rs#L152-L154]

- Prompt as an argument or from stdin. [SOURCE T/codex-rs/exec/src/cli.rs#L81-L85]
- `--json` prints events as JSONL. `-o/--output-last-message FILE` saves the final message. `--output-schema FILE` forces a JSON shape. [SOURCE T/codex-rs/exec/src/cli.rs#L52-L79]
- `--ephemeral` skips writing session files. `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules` exist. [SOURCE T/codex-rs/exec/src/cli.rs#L36-L50]
- Sub-commands: `resume` (by id or `--last`), `fork`, `review`. So a script can continue the same session later. [SOURCE T/codex-rs/exec/src/cli.rs#L172-L182] [SOURCE T/codex-rs/exec/src/cli.rs#L205-L235]
- Approvals default to "never ask" in headless mode. [OPENED T/codex-rs/exec/src/lib.rs — "Default to never ask for approvals in headless mode."]
- A required MCP server that fails to start makes `codex exec` exit with an error. [SOURCE T/codex-rs/config/src/mcp_types.rs#L247-L251]

**Goals: the native "keep going" loop.** Feature key `goals`, stage `Stable`, default on. [SOURCE T/codex-rs/features/src/lib.rs#L2114-L2119] [OPENED T/codex-rs/features/src/lib.rs — "Enable persisted thread goals and automatic goal continuation."]

- `/goal` sets or shows it. [OPENED T/codex-rs/tui/src/slash_command.rs — "set or view the goal for a long-running task"]
- Model tools: `get_goal`, `create_goal`, `update_goal`. The model may create a goal only when asked. [SOURCE T/codex-rs/ext/goal/src/spec.rs#L9-L11] [SOURCE T/codex-rs/ext/goal/src/spec.rs#L46]
- When the thread goes idle and the goal is still active, Codex starts a new turn by itself with a continuation prompt. [SOURCE T/codex-rs/ext/goal/src/extension.rs#L180-L201] [SOURCE T/codex-rs/ext/goal/src/runtime.rs#L436-L496] [OPENED T/codex-rs/ext/goal/templates/goals/continuation.md — "This goal persists across turns. Ending this turn does not require shrinking the objective to what fits now."]
- It stops on `complete`, `blocked`, `paused`, a token budget, a usage limit, or a turn error. [SOURCE T/codex-rs/ext/goal/src/extension.rs#L429-L436] Config: `[goals] max_goal_token_budget`. [SOURCE T/codex-rs/config/src/config_toml.rs#L757-L762]
- It needs a live process. It is not a scheduler. It has no interval.

**`clock.sleep` tool.** Stable, default on. The model can pause up to 12 hours. New input ends the sleep early. [SOURCE T/codex-rs/features/src/lib.rs#L1155-L1159] [SOURCE T/codex-rs/core/src/tools/handlers/sleep.rs#L26-L28] [OPENED T/codex-rs/core/src/tools/handlers/sleep.rs — "Pause execution for a specified duration. The sleep ends early when new input arrives for the active turn."]

**`codex queue`.** Adds a message to an existing session from outside. [OPENED T/codex-rs/cli/src/main.rs — "Queue a message for an existing session."] Flags: `--thread`, `--message`, `--resume`. [SOURCE T/codex-rs/cli/src/queue_cmd.rs#L18-L32] [OPENED T/codex-rs/cli/src/queue_cmd.rs — "After queueing, try to resume the thread on the local daemon or selected --remote server."] The queue is durable and dispatches when the thread is idle. [SOURCE T/codex-rs/ext/queue/src/lib.rs#L1] Paired with an OS scheduler, this is the closest CLI building block to a scheduled wake-up. That pairing is my inference. I did not test it.

**Local daemon.** Interactive launches auto-start a shared local daemon. Stable, default on. [SOURCE T/codex-rs/features/src/lib.rs#L1100-L1104] `codex agents` opens a command center over sessions. [SOURCE T/codex-rs/cli/src/main.rs#L146-L147] `codex remote-control` is marked experimental. [SOURCE T/codex-rs/cli/src/main.rs#L174-L175]

**Background terminals.** Long-running commands stay alive as background terminals. `/ps` lists them and `/stop` stops them. Poll window default is 5 minutes (`background_terminal_max_timeout`). [SOURCE T/codex-rs/tui/src/slash_command.rs#L131-L132] [SOURCE T/codex-rs/config/src/config_toml.rs#L347-L349]

**`notify` (legacy).** `notify = ["program", "arg", ...]` runs a program after each turn. One JSON argument is appended, type `agent-turn-complete`, with `thread-id`, `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`. Source marks it for removal. [SOURCE T/codex-rs/config/src/config_toml.rs#L247-L249] [SOURCE T/codex-rs/hooks/src/legacy_notify.rs#L13-L27] [SOURCE T/codex-rs/hooks/src/legacy_notify.rs#L44]

**Cloud tasks.** `codex cloud` is marked experimental. Sub-commands: `exec` (needs `--env`, optional `--attempts` 1–4, `--branch`), `status`, `list`, `apply`, `diff`. [SOURCE T/codex-rs/cli/src/main.rs#L228-L230] [SOURCE T/codex-rs/cloud-tasks/src/cli.rs#L15-L50]

**Automations in the Codex app (now "Scheduled tasks").** Not in the open-source repo. The core has only a permission gate for it. [OPENED T/codex-rs/features/src/lib.rs — "Allow desktop apps to run local automations."] The official page now calls them "Scheduled tasks". They are recurring background tasks. [OPENED https://learn.chatgpt.com/docs/automations.md — "Schedule recurring tasks to run in the background."] In the desktop app they run locally, in the project folder or a worktree, and need the app running. [OPENED https://learn.chatgpt.com/docs/automations.md — "For project-scoped scheduled tasks, keep the machine powered on and the ChatGPT desktop app running."] They can use plugins and skills. [OPENED https://learn.chatgpt.com/docs/automations.md — "Scheduled tasks created with ChatGPT Work on the web, or with ChatGPT Work or Codex in the desktop app, can use plugins."] [OPENED https://learn.chatgpt.com/docs/automations.md — "Scheduled tasks can also use skills."] Results go to an inbox. [OPENED https://learn.chatgpt.com/docs/automations.md — "The **Scheduled** view acts as your inbox."] Web tasks cannot use a local folder, and Team Tasks run in the cloud. [OPENED https://learn.chatgpt.com/docs/automations.md — "Team Tasks run in the cloud through the team's service account and configured app connections."] The CLI and IDE extension have no scheduling interface. [OPENED https://learn.chatgpt.com/docs/automations.md — "Codex CLI doesn't provide the Scheduled management interface."] A task scheduled inside a chat can repeat every few minutes. [OPENED https://learn.chatgpt.com/docs/automations.md — "Scheduled tasks in a chat can use minute-based intervals for active follow-up loops"]

**What does not exist in the CLI.** No `/loop`, no cron, no schedule command. The full slash-command and sub-command lists show none. [SOURCE T/codex-rs/tui/src/slash_command.rs#L12-L89] [SOURCE T/codex-rs/cli/src/main.rs#L145-L245] Still under development: current-time reminders, async messages to the user, wake on agent mail. [SOURCE T/codex-rs/features/src/lib.rs#L2145-L2149] [SOURCE T/codex-rs/features/src/lib.rs#L2019-L2023] [SOURCE T/codex-rs/features/src/lib.rs#L1635-L1639]

**OS differences.** `codex app` and so app Automations: macOS and Windows only. [SOURCE T/codex-rs/cli/src/main.rs#L177-L179] The rest: none found.

---

## 9. MCP

- **Config:** `[mcp_servers.<name>]` in `config.toml`. [SOURCE T/codex-rs/config/src/config_toml.rs#L297-L301]
- **Transports:** stdio (`command`, `args`, `env`, `env_vars`, `cwd`) and streamable HTTP (`url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `http_headers_helper`). [SOURCE T/codex-rs/config/src/mcp_types.rs#L650-L684]
- **Per-server keys:** `enabled`, `required`, `startup_timeout_sec`, `tool_timeout_sec`, `enabled_tools`, `disabled_tools`, `default_tools_approval_mode`, `supports_parallel_tool_calls`, `scopes`, `oauth`. [SOURCE T/codex-rs/config/src/mcp_types.rs#L232-L307]
- **CLI:** `codex mcp list|get|add|remove|login|logout`. TUI: `/mcp`. [SOURCE T/codex-rs/cli/src/mcp_cmd.rs#L74-L81] [SOURCE T/codex-rs/tui/src/slash_command.rs#L156]
- **Tool search:** always on. MCP tools are deferred and found with a search tool. [OPENED T/codex-rs/features/src/lib.rs — "Removed compatibility flag retained as a no-op now that tool_search is always enabled."] [SOURCE T/codex-rs/core/src/tools/handlers/tool_search_spec.rs#L16-L32]
- **Resources:** supported. Tools `list_mcp_resources` and `list_mcp_resource_templates` exist. [SOURCE T/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L8-L33] [SOURCE T/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs#L36-L60]
- **MCP from hooks:** a hook handler can be an MCP tool call (`type: "mcp_tool"`). Not for `SessionEnd`. [SOURCE T/codex-rs/protocol/src/hooks.rs#L173-L183] [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L729-L746]
- **MCP from skills:** a skill can declare an MCP dependency and Codex can offer to install it. Stable, default on. [SOURCE T/codex-rs/features/src/lib.rs#L1965-L1969]
- **Sandbox hand-off:** an MCP server can ask for the current sandbox state. Experimental. [OPENED T/codex-rs/codex-mcp/README.md — "An MCP server advertises the experimental `codex/sandbox-state` capability to receive sandbox metadata on tool calls."]
- **Codex as an MCP server: gone.** At this tag there is no `mcp-server` crate in the workspace and no such sub-command. [SOURCE T/codex-rs/Cargo.toml#L2-L165] [SOURCE T/codex-rs/cli/src/main.rs#L145-L245] A raw fetch of `codex-rs/mcp-server/Cargo.toml` at the tag returns 404. The official page says the command and binary were removed and points to the app-server instead. [OPENED https://learn.chatgpt.com/docs/mcp-server.md — "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed."] The page gives no version or date for the removal. `codex app-server` is marked experimental. [SOURCE T/codex-rs/cli/src/main.rs#L171-L172]
- **OS differences.** None found. **Surfaces.** Core; clients not checked.

---

## 10. Session transcripts

- **Location:** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl`. Date parts are local time. [SOURCE T/codex-rs/rollout/src/recorder.rs#L1770-L1792] [SOURCE T/codex-rs/rollout/src/rollout_file_name.rs#L62-L73] [SOURCE T/codex-rs/rollout/src/lib.rs#L86]
- A reverted thread gets `..._<rollout id>.jsonl`. [SOURCE T/codex-rs/rollout/src/recorder.rs#L98-L104]
- **Archive:** `$CODEX_HOME/archived_sessions`. [SOURCE T/codex-rs/rollout/src/lib.rs#L87]
- **Format:** JSON Lines. Each line has `timestamp`, optional `ordinal`, and one item. [SOURCE T/codex-rs/history/src/lib.rs#L375-L381] Item kinds include session meta, response item, compacted, turn context, event message, world state. [SOURCE T/codex-rs/history/src/lib.rs#L216-L237]
- Plain-language description from Codex's own memory prompt: [OPENED T/codex-rs/ext/memories/templates/memories/read_path.md — "`session_meta.payload.id` identifies the session, `turn_context` marks turn boundaries, `event_msg` is the lightweight status stream"]
- Session meta holds `id`, `cwd`, `originator`, `cli_version`, `source`, and more. [SOURCE T/codex-rs/protocol/src/protocol.rs#L3418-L3468]
- **Compression is coming.** Readers already handle `.jsonl.zst`. The feature that compresses cold files is under development, default off. [SOURCE T/codex-rs/rollout/src/compression.rs#L26] [SOURCE T/codex-rs/rollout/src/compression.rs#L63] [SOURCE T/codex-rs/features/src/lib.rs#L1411-L1415]
- **Storage is changing.** There is a `migrate-rollouts` command for "paginated thread history", and a background migration flag under development. A plugin that parses rollout files directly is building on moving ground. [OPENED T/codex-rs/cli/src/main.rs — "Inspect or migrate legacy local sessions to paginated thread history."] [SOURCE T/codex-rs/features/src/lib.rs#L1423-L1427]
- **Prompt history file:** `$CODEX_HOME/history.jsonl`, one line per message: `{"session_id","ts","text"}`. Config `[history] persistence`, `max_bytes`. [SOURCE T/codex-rs/message-history/src/lib.rs#L1-L9] [SOURCE T/codex-rs/message-history/src/lib.rs#L52] [SOURCE T/codex-rs/config/src/types.rs#L226-L233]
- **State database:** SQLite under `sqlite_home`, else `$CODEX_SQLITE_HOME`, else `$CODEX_HOME`. [SOURCE T/codex-rs/config/src/config_toml.rs#L375-L377]
- **Path passed to hooks:** `transcript_path` = the rollout path (section 4). For hooks that run in a remote environment it is `null`. [SOURCE T/codex-rs/hooks/src/engine/mod.rs#L104-L119] `SubagentStop` also gets `agent_transcript_path`. [SOURCE T/codex-rs/hooks/src/schema.rs#L604-L623]
- **No transcript:** `codex exec --ephemeral`. [SOURCE T/codex-rs/exec/src/cli.rs#L40-L42]
- **OS differences.** None found beyond the home path. **Surfaces.** Local sessions only. Cloud: unknown.

---

## 11. Security

**Sandbox modes.** `read-only` (the default), `workspace-write`, `danger-full-access`. Key `sandbox_mode`, flag `--sandbox`. [SOURCE T/codex-rs/protocol/src/config_types.rs#L104-L114] [SOURCE T/codex-rs/utils/cli/src/shared_options.rs#L38-L41]

- With no mode set, a project that has any trust decision gets `workspace-write`. Otherwise `read-only`. [SOURCE T/codex-rs/config/src/config_toml.rs#L872-L881]
- A newer `[permissions]` profile system exists beside this (`default_permissions`). I did not study it in depth. [SOURCE T/codex-rs/config/src/config_toml.rs#L238-L245]

**Per OS.**

| OS | Mechanism | Evidence |
|---|---|---|
| macOS | Seatbelt via `/usr/bin/sandbox-exec` | [OPENED T/codex-rs/core/README.md — "Expects `/usr/bin/sandbox-exec` to be present."] |
| Linux | bubblewrap for files and namespaces, seccomp for syscalls. Landlock is legacy and deprecated | [OPENED T/codex-rs/linux-sandbox/README.md — "Bubblewrap is the default filesystem sandbox."] [SOURCE T/codex-rs/features/src/lib.rs#L1483-L1487] |
| Linux | uses system `bwrap` if present, else a bundled one | [SOURCE T/codex-rs/linux-sandbox/README.md#L16-L22] |
| WSL | WSL2 works like Linux. WSL1 cannot run the sandbox | [OPENED T/codex-rs/core/README.md — "WSL2 uses the normal Linux bubblewrap path. WSL1 is not supported for bubblewrap sandboxing"] |
| Windows | `[windows] sandbox = "elevated" \| "unelevated" \| "mxc"` | [SOURCE T/codex-rs/config/src/types.rs#L187-L201] |
| Windows | with no Windows sandbox set up, `workspace-write` falls back to `read-only` | [SOURCE T/codex-rs/config/src/config_toml.rs#L834-L847] |

**What the sandbox protects inside the workspace.** `.git`, `.agents`, `.codex`, `.aws` stay read-only even under a writable root. [SOURCE T/codex-rs/protocol/src/permissions.rs#L40-L51] [OPENED T/codex-rs/protocol/src/permissions.rs — "Top-level workspace metadata paths that stay protected under writable roots."] [SOURCE T/codex-rs/protocol/src/permissions.rs#L860-L863]

- Effect for a memory plugin: the agent cannot edit files under `.codex/` or `.agents/` from sandboxed tool calls. A repo-root `AGENTS.md` or a normal folder is writable.

**Network.** Off by default in `workspace-write`. Turn on with `[sandbox_workspace_write] network_access = true`. [SOURCE T/codex-rs/protocol/src/models.rs#L529-L536] [SOURCE T/codex-rs/config/src/types.rs#L1259-L1268] A managed network proxy is experimental. [SOURCE T/codex-rs/features/src/lib.rs#L1577-L1581]

**Approval policies.** `untrusted`, `on-request` (default; `on-failure` is an alias), `granular`, `never`. Key `approval_policy`. [SOURCE T/codex-rs/protocol/src/protocol.rs#L1146-L1169]

- `--approve-for-me` routes approvals to an automatic reviewer with `workspace-write`. [SOURCE T/codex-rs/utils/cli/src/shared_options.rs#L43-L50] [SOURCE T/codex-rs/utils/cli/src/shared_options.rs#L80-L92]
- `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) removes both. [SOURCE T/codex-rs/utils/cli/src/shared_options.rs#L52-L59]
- Command rules: `*.rules` files in a `rules/` folder beside each config layer. Decisions are allow, prompt, forbidden. These are command policy, not instruction files. [SOURCE T/codex-rs/core/src/exec_policy.rs#L56-L58] [OPENED T/codex-rs/execpolicy/README.md — "`decision` defaults to `allow`; valid values: `allow`, `prompt`, `forbidden`."]

**Trust of project config.**

- Config layers, lowest to highest: system, cloud-managed, user, user profile, project `.codex/config.toml`, session flags, then managed overrides. [SOURCE T/codex-rs/config/src/loader/README.md#L24-L35]
- Project config is loaded but disabled when the folder is not trusted. [SOURCE T/codex-rs/config/src/loader/mod.rs#L129-L135]
- Trust gates exactly this: [OPENED T/codex-rs/config/src/loader/mod.rs — `let gated_features = "project-local config, hooks, and exec policies";`]
- Trust is stored in the user config as `[projects."<path>"] trust_level = "trusted" | "untrusted"`. [SOURCE T/codex-rs/config/src/config_toml.rs#L616-L630]
- Project `AGENTS.md` is skipped only when the project is explicitly untrusted (section 1).
- I did not confirm whether repo skills (`.agents/skills`) load in an untrusted project.

**What unattended modes may do.**

- `codex exec`: never asks. A command that needs approval fails back to the model. The sandbox still applies. [SOURCE T/codex-rs/exec/src/lib.rs#L595-L597] [SOURCE T/codex-rs/protocol/src/protocol.rs#L1166-L1168]
- Hooks in `codex exec` still need stored trust, or the bypass flag. [SOURCE T/codex-rs/exec/src/cli.rs#L163-L170]
- Hooks themselves are not sandboxed (section 4). A hook can write where the agent cannot.
- The memory consolidation agent runs with no approvals and no network. [SOURCE T/codex-rs/memories/README.md#L109-L116]
- Admin lock-down lives in `requirements.toml` (`/etc/codex/` on Unix, `%ProgramData%\OpenAI\Codex\` on Windows). [SOURCE T/codex-rs/config/src/loader/mod.rs#L114-L118]

---

## 12. Windows specifics

**Is native Windows supported? The evidence says yes, with one stale line that says WSL.**

- The README gives a native PowerShell installer. [OPENED T/README.md — "Run the following on Windows to install Codex CLI:"]
- npm ships `win32-x64` and `win32-arm64` builds of 0.167.0. [OPENED NPM — `'@openai/codex-win32-arm64': 'npm:@openai/codex@0.167.0-win32-arm64'`]
- But the repo's install doc still lists: [OPENED T/docs/install.md — "macOS 12+, Ubuntu 20.04+/Debian 10+, or Windows 11 **via WSL2**"]. I read this as out of date, given the two points above and the Windows-only code below.
- The official Windows page confirms native Windows, with WSL as the alternative. [OPENED https://learn.chatgpt.com/docs/windows/windows-sandbox.md — "Use the native Windows sandbox by default."] Correction: it lists three sandboxes, not two. `mxc` is recommended. `elevated` is now the preferred *legacy fallback*, and `unelevated` the second fallback. [OPENED https://learn.chatgpt.com/docs/windows/windows-sandbox.md — "`mxc`: The recommended sandbox on compatible Windows devices."] [OPENED https://learn.chatgpt.com/docs/windows/windows-sandbox.md — "`elevated`: The preferred legacy fallback when MXC is unavailable or disabled."] The CLI has a native PowerShell installer. [OPENED https://learn.chatgpt.com/docs/codex/cli.md — "Install the Codex CLI with the standalone installer for Windows."]

**Windows-specific behavior found in source.**

- Sandbox setting `[windows] sandbox`: `elevated`, `unelevated`, `mxc`. [SOURCE T/codex-rs/config/src/types.rs#L187-L201] [SOURCE T/codex-rs/core/src/windows_sandbox.rs#L119-L144]
- TUI command `setup-default-sandbox`. [OPENED T/codex-rs/tui/src/slash_command.rs — "set up elevated agent sandbox"]
- No Windows sandbox configured → `workspace-write` becomes `read-only`. [SOURCE T/codex-rs/config/src/config_toml.rs#L834-L847]
- The old feature keys `experimental_windows_sandbox` and `elevated_windows_sandbox` are removed; the config table replaced them. [SOURCE T/codex-rs/features/src/lib.rs#L1495-L1505]
- Still under development on Windows: a sandbox service and the MXC preference. [SOURCE T/codex-rs/features/src/lib.rs#L1507-L1517] [OPENED T/codex-rs/mxc-sandbox/README.md — "`windows.sandbox = \"mxc\"` is strict."]
- Some newer permission-profile rules fail closed on Windows when the backend cannot enforce them. [SOURCE T/codex-rs/core/README.md#L87-L92]
- Hooks: `cmd.exe /C`, `commandWindows`, Job Objects (section 4). Managed hooks have a separate `windows_managed_dir`. [SOURCE T/codex-rs/config/src/hook_config.rs#L40-L46]
- System config path: `%ProgramData%\OpenAI\Codex\config.toml`. [SOURCE T/codex-rs/config/src/loader/mod.rs#L128-L129]
- Credential storage default differs on Windows. [SOURCE T/codex-rs/features/src/lib.rs#L1161-L1165]
- `codex app` exists on Windows and macOS, not Linux. [SOURCE T/codex-rs/cli/src/main.rs#L177-L179]
- macOS-only setting: `allow_symlinked_codex_home`. [SOURCE T/codex-rs/config/src/config_toml.rs#L228-L233]

**Features I found missing on Windows:** none of AGENTS.md, memories, skills, hooks, plugins, subagents, goals has a Windows exclusion in the code I read. The only gaps are sandbox strength and the items above.

---

## 13. Side by side: Claude Code feature → closest Codex equivalent

Claude Code facts are from its docs, fetched today as `.md` pages.

| Claude Code feature | Claude Code evidence | Closest Codex equivalent | Gap to plan for |
|---|---|---|---|
| `CLAUDE.md` | [OPENED CC/memory.md#L60 — "`~/.claude/CLAUDE.md`"] | `AGENTS.md` (section 1). `CLAUDE.md` only via `project_doc_fallback_filenames` | Codex never loads files below the working directory. 32 KiB shared cap. Claude Code now reads `AGENTS.md` when no `CLAUDE.md` exists. [OPENED CC/memory.md#L371 — "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md` in your working directory or above it."] |
| Auto memory | [OPENED CC/memory.md#L516 — "Each project gets its own memory directory at `~/.claude/projects/<project>/memory/`."] [OPENED CC/memory.md#L493 — "Auto memory is on by default in local sessions."] | Memories (section 2) | Codex: off by default, global not per project, written in the background from old sessions, summary cut to ~2,500 tokens. Claude: on by default, per project, index loaded "first 200 lines or 25KB". [OPENED CC/memory.md#L31 — "Every session (first 200 lines or 25KB)"] |
| `.claude/rules` | [OPENED CC/memory.md#L170 — "you can organize instructions into multiple files using the `.claude/rules/` directory"] | **None.** Nearest: one `AGENTS.md` per directory on the path to the working directory | No path-scoped rules. Codex `.rules` files are command policy, a different thing (section 11) |
| Skills | [OPENED CC/skills.md#L160 — "`.claude/skills/<skill-name>/SKILL.md`"] | Skills (section 3): `.agents/skills`, `~/.agents/skills`, plugin `skills/` | Different folders. Codex reads only `name`, `description`, `metadata.short-description` from frontmatter. Invocation policy lives in `agents/openai.yaml` |
| Subagents | [OPENED CC/sub-agents.md#L162 — "`.claude/agents/`"] | Roles (section 6): TOML files in `.codex/agents/` or `$CODEX_HOME/agents/` | Different file format. Plugin-shipped agents: no loader code found. `/import` has a sub-agent converter |
| Hooks | [SOURCE CC/hooks.md#L33-L65] | Hooks (section 4) | Trust gate; fewer events; see next table |
| Plugins | [OPENED CC/plugins-reference.md#L34 — "Save the manifest at `.claude-plugin/plugin.json` under the plugin root."] | Plugins (section 5). Codex reads `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` directly | Hook trust is per user and content-hashed. Commands become skills. `.mcp.json` placeholders differ |
| `${CLAUDE_PLUGIN_ROOT}` | [OPENED CC/plugins-reference.md#L558 — "Absolute path of the plugin's installed version"] | Same name works in **hook commands**, plus `${PLUGIN_ROOT}` | Not expanded in `.mcp.json` for the `.codex-plugin` / `.claude-plugin` format, by my reading |
| Plugin persistent data dir | [OPENED CC/plugins-reference.md#L559 — "`~/.claude/plugins/data/<id>/`, created on first reference and kept across plugin updates."] | `$CODEX_HOME/plugins/data/<plugin>-<marketplace>`, exposed as `PLUGIN_DATA` and `CLAUDE_PLUGIN_DATA` to hooks | I did not find where Codex creates the folder for hook-only plugins. Create it yourself before writing |
| `CLAUDE_PROJECT_DIR` | [OPENED CC/plugins-reference.md#L572 — "`CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, and `CLAUDE_PLUGIN_OPTION_<KEY>`"] | **None.** Use `cwd` from stdin | Scripts must not rely on a project-dir variable |
| `/loop` and scheduled tasks | [OPENED CC/scheduled-tasks.md#L9 — "Session-scoped scheduled tasks let Claude re-run a prompt automatically on an interval within a Claude Code session."] | **No direct equivalent in the CLI.** Nearest: `/goal` auto-continuation, `clock.sleep`, `codex queue`. Outside the CLI: desktop-app or web "Scheduled tasks" (formerly Automations), which can run on minute intervals inside a chat (section 8) | No interval or cron tool in the CLI. `/goal` continues until done; it does not wake on a clock |
| Headless mode | [OPENED CC/headless.md#L21 — "Add the `-p` (or `--print`) flag to any `claude` command to run it non-interactively."] | `codex exec` (section 8) | Opposite hook default: Claude `-p` "runs the hooks in a project's `.claude/settings.json` … even in a folder you've never trusted" [OPENED CC/headless.md#L41]. Codex exec runs only trusted hooks unless the bypass flag is set |
| Transcripts | [OPENED CC/hooks.md#L1295 — `"transcript_path": "/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl"`] | Rollout JSONL under `$CODEX_HOME/sessions/YYYY/MM/DD/` (section 10) | Different layout and line schema. Codex storage is mid-migration |
| Compaction hooks | [SOURCE CC/hooks.md#L59-L60] | `PreCompact`, `PostCompact`, then `SessionStart` with source `compact` | `PreCompact` cannot add context on Codex. Re-inject on `SessionStart(compact)` |
| Context injected by hooks: size | [OPENED CC/hooks.md#L1150 — "If a value exceeds 10,000 characters, Claude Code writes the text to a file in the session directory"] | About 2,500 tokens, then spilled to a temp file | Keep injected context small on both |

**Hooks, event by event.** Claude Code's list is 33 events today. [SOURCE CC/hooks.md#L33-L65] Codex has 14. [SOURCE T/codex-rs/hooks/src/lib.rs#L29-L44]

| Claude Code event | On Codex 0.167.0 |
|---|---|
| `SessionStart` | Yes. Same five sources. [SOURCE CC/hooks.md#L294] [SOURCE T/codex-rs/hooks/src/schema.rs#L859-L861] |
| `UserPromptSubmit` | Yes |
| `PreToolUse` | Yes. Different tool names: `Bash`, `apply_patch` (also matches `Write`, `Edit`), `spawn_agent` (also matches `Agent`) |
| `PermissionRequest` | Yes |
| `PostToolUse` | Yes |
| `PreCompact`, `PostCompact` | Yes |
| `SubagentStart`, `SubagentStop` | Yes |
| `Stop` | Yes. Block reason becomes the continuation prompt |
| `SessionEnd` | Yes. Reason is always `other`. 1 s default, 3 s cap |
| `Setup`, `UserPromptExpansion`, `PermissionDenied`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `TaskCreated`, `TaskCompleted`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult` | **None.** For `Notification`, the nearest thing is legacy `notify` after each turn |
| (Codex only) `PreModelRequest`, `PostModelRequest`, `Interrupt` | Not in Claude Code's list |

Handler types: Claude Code lists `command`, `http`, `mcp_tool`, `prompt`, `agent`. [OPENED-VIA-WEBFETCH https://code.claude.com/docs/en/hooks] Codex runs `command` and `mcp_tool` only. [SOURCE T/codex-rs/hooks/src/engine/discovery.rs#L782-L801]

---

## Blocked hosts

| Host | What happened | What I did |
|---|---|---|
| `developers.openai.com` | Blocked when first written. Reachable on 2026-11-09 with direct `curl`. Codex doc paths return 308 redirects to `learn.chatgpt.com`. `/plugins/build/plugins.md` is served directly (200) | Used on the re-check. Pages opened are tagged OPENED |
| `learn.chatgpt.com` | Reachable on 2026-11-09 with direct `curl` (200). This is OpenAI's own docs host, the redirect target of `developers.openai.com/codex/*`, not a mirror | Fetched the `.md` pages for hooks, memories, AGENTS.md, skills, subagents, scheduled tasks, Windows sandbox, CLI, MCP server removal, cloud environments, plugins, and `llms.txt` |
| `agents.md` | DNS failure (`ENOTFOUND`) from the fetch tool | Used the `openai/agents.md` repo README on raw.githubusercontent.com instead. [OPENED https://raw.githubusercontent.com/openai/agents.md/main/README.md — "is a simple, open format for guiding coding agents."] |
| `agentskills.io` | DNS failure (`ENOTFOUND`) | Used `agentskills/agentskills` repo on raw.githubusercontent.com |
| `github.com` via `curl` | 403 from the proxy | Used the fetch tool for directory listings and the releases page. Those are summaries, tagged OPENED-VIA-WEBFETCH |
| `api.github.com` | 403 from the proxy | Not used |
| `codeload.github.com` | 403 from the proxy | Not used. No full clone. Files were fetched one by one |
| `cdn.jsdelivr.net/gh/...` | 403 | Not used. (`cdn.jsdelivr.net/npm/...` returned 200) |
| GitHub connector | Limited to the user's own repository | Not used for `openai/codex` |

Reachable and used: `raw.githubusercontent.com`, `registry.npmjs.org`, `code.claude.com`, `github.com` (fetch tool only), web search. On the 2026-11-09 re-check: `developers.openai.com` and `learn.chatgpt.com`, by direct requests only.

Because there was no full clone, I could not grep the whole repo. Statements of the form "I found no X" mean: not in the files I opened.

---

## Unconfirmed — do not rely on

1. **IDE extension, desktop app, and cloud behavior.** All closed source. I assume they share the core. I did not verify that hooks, plugins, skills, or memories behave the same there. Whether Codex cloud runs hooks, skills, or plugins at all is unknown.
2. **What stayed unconfirmed after the docs check.** The claim that `codex mcp-server` was removed in 0.154.0 in September 2026: the official page gives no version or date. The subagent defaults `max_threads = 6` and `max_depth = 1`: source only. Where the official docs and the 0.167.0 source disagree (root `plugin.json` hooks, `permission_mode` values), see "Primary-docs check".
3. **Everything tagged OPENED-VIA-WEBFETCH.** The release page text, directory listings, and the list of Claude Code hook handler types came through a summarizing tool.
4. **Nothing was run.** Every Codex behavior here is read from source at one tag. Bugs, server-side flags, or account-level gates could change what a user sees. Feature defaults can be overridden by managed config or by OpenAI's servers; I did not look for that.
5. **Hooks in `codex exec`.** I infer they fire the same way because the engine is in the core and the bypass flag is a global `exec` flag. I did not trace the exec start-up path.
6. **How a user grants hook trust.** I saw `/hooks` and the stored state keys. I did not read the code that writes `trusted_hash`, and I do not know the exact prompts.
7. **`.mcp.json` placeholders.** "No expansion of `${CLAUDE_PLUGIN_ROOT}` in MCP config for `.codex-plugin`/`.claude-plugin` plugins" rests on two files I read. Another layer could expand them.
8. **`PLUGIN_DATA` folder creation.** I saw it created for Agent Plugins stdio MCP servers. I did not find creation for hook-only plugins.
9. **Plugin-level `agents/`.** Named in the `openai/plugins` README. No loader code found. May be handled by the app, by a newer build, or not at all.
10. **Repo skills in untrusted projects.** Not checked.
11. **Memory `extensions/` folder as a plugin entry point.** Present in source and prompts. No public contract found. It could change without notice.
12. **Memory summary size.** Source at this tag says 2,500 tokens. A third-party article in search results said 5,000. I trust the source for this tag only.
13. **`codex queue` + OS scheduler as a "scheduled task".** My inference from flag descriptions. Not tested. It may need the local daemon running.
14. **Windows.** I read Windows code paths but did not run on Windows. The install doc's "via WSL2" line may reflect a real limit I did not find.
15. **`main` vs the tag.** I compared only a few files. `main` already marks V1 multi-agent as deprecated; more may have moved.
16. **The `[permissions]` profile system, Guardian auto-review, apps/connectors, code mode, remote plugins and plugin sharing.** They exist in source. I did not study them.

---

## Primary-docs check (2026-11-09)

Pages fetched with direct `curl` from `learn.chatgpt.com/docs/*.md` (the target of `developers.openai.com/codex/*` redirects) and `developers.openai.com/plugins/build/plugins.md`. No relay, mirror, or cache.

**SEARCH-ONLY claims, one line each.**

1. Summary item 14, app Automations exist: **upgraded and corrected.** Now called "Scheduled tasks". The CLI has no scheduling interface.
2. Section 1, cloud agent uses `AGENTS.md`: **upgraded.** The page is now "Codex Cloud (Legacy)".
3. Section 2, memories off by default: **upgraded.** Storage under `$CODEX_HOME/memories` or `memories_v2` also confirmed.
4. Section 4, docs list the same hook file locations: **upgraded.** Added the desktop app review screen and the cloud-orchestration limit (admin MCP hooks only).
5. Section 6, `max_threads = 6`: **corrected.** The page gives no number. It says Codex picks the default.
6. Section 6, `max_depth = 1`: **corrected.** The page does not mention `max_depth`. Source only.
7. Section 6, the two `agents/` folders: **upgraded.**
8. Section 8, automations are recurring background tasks that need the app running, use plugins and skills, and report to an inbox: **upgraded** (four parts). Added: desktop tasks run locally; web tasks cannot use a local folder; Team Tasks run in the cloud; in-chat tasks can repeat every few minutes.
9. Section 9, `codex mcp-server` and the binary were removed, use the app-server: **upgraded.**
10. Section 9 / Unconfirmed list, removal in 0.154.0 in September 2026: **left SEARCH-ONLY.** The official page gives no version or date.
11. Section 12, Windows sandbox is `elevated` (preferred) or `unelevated`, WSL as alternative: **corrected.** Three sandboxes. `mxc` is recommended. `elevated` is the preferred legacy fallback. Native Windows and WSL as the alternative are confirmed.

**Checks requested on hooks (official hooks page).**

- Events: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `PreModelRequest`, `PostModelRequest`. Fourteen. Matches the source.
- `SessionStart` and `SessionEnd`: both exist. `SessionEnd` runs for the main thread only, 1 s default, 3 s cap, reason always `other`.
- `PreToolUse` can block: yes, by `permissionDecision:"deny"`, `decision:"block"`, or exit 2. `allow` plus `updatedInput` rewrites. `ask` is not supported. Wording in section 4 updated.
- Native Windows: the page documents `commandWindows` and `windows_managed_dir` and has no Windows exclusion. It does not say "supported on Windows" in so many words.
- Stable or flagged: on by default, `[features] hooks = false` turns them off. The page does not use the word "stable".
- Trust: non-managed hooks need review in `/hooks` (CLI) or **Settings > Hooks** (app). Trust is stored against the hook's hash. Managed hooks are trusted by policy. `--dangerously-bypass-hook-trust` skips it for one run.
- Plugin update: yes, it resets approval if a bundled script changes, even with the same hook definition.

**Other checks.**

- `AGENTS.md` cap: 32 KiB (`project_doc_max_bytes`). Confirmed.
- Skills locations: `.agents/skills` from the working directory up to the repo root, `$HOME/.agents/skills`, `/etc/codex/skills`, and bundled system skills. Confirmed. The page does not list `.codex/skills` or `$CODEX_HOME/skills`; those rest on source.
- Plugin manifests: the docs make root `plugin.json` (Agent Plugins schema) the main format, with `.codex-plugin/plugin.json` as a fallback. They accept "Claude-compatible manifests" and `.claude-plugin/marketplace.json`.

**Conflicts between the docs and the 0.167.0 source. Not resolved.**

- Root `plugin.json` hooks: source says not loaded. Docs say hooks go under `extensions.com.openai`. This changes summary item 9. Flagged in place.
- Hook `permission_mode`: source gives two values. Docs list five. Flagged in place.
- Plugin hooks in the docs are "supported for plugins installed manually in Codex desktop" and bar a plugin from the public directory. Not reflected in the source reading.
