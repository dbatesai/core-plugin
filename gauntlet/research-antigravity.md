# Google Antigravity: what it gives a plugin natively

Research date: 2026-11-09. Nothing here comes from memory. Every factual claim carries a tag, or says it is an inference. Nothing was run on a real Antigravity install.

## What a plugin author should take from this

1. Antigravity is now four surfaces on one agent harness: a desktop App (v2.29.1), a CLI called `agy` (v1.5.2), IDE extensions plus a standalone IDE, and a Python SDK. A plugin runs in the App, the CLI and the IDE.
2. It has native rules, skills, subagents, hooks, MCP, plugins and a marketplace. The shape is close to Claude Code. You do not need to build those mechanisms.
3. One layout serves all of it: `.agents/` in the project and `~/.gemini/config/` for the user. `AGENTS.md` and `GEMINI.md` are read natively. `CLAUDE.md` is not among the files the docs say are loaded.
4. A plugin is a folder with `plugin.json` (or `.antigravity-plugin/plugin.json`) plus `skills/`, `agents/`, `rules/`, `hooks.json` and `mcp_config.json`. The docs explicitly allow it to sit beside `.claude-plugin/` in one repository.
5. Hooks exist: `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`. They can inject context and block. There is no `SessionEnd`, no `PreCompact`, and no `UserPromptSubmit` by that name.
6. The hook contract is not Claude Code's. JSON in, JSON out, camelCase, named hook groups, flat arrays for non-tool events. A Claude-format `hooks/hooks.json` is not read.
7. Do not count on native memory. The docs say "Agents don't remember conversations." Knowledge Items survive only as passing mentions and their docs page now returns 404. Bring your own memory files.
8. The native route for a durable lesson is `/learn`. It proposes a rule or a skill and writes only after the user approves.
9. Transcripts are plain JSONL at a documented path, and every hook is handed that path. Google does not document the record schema.
10. Proactive work has four native routes: `/schedule` inside a conversation, Automations in the App, sidecars (a plugin can ship one; the user must switch it on), and headless `agy -p` under your own scheduler.
11. macOS, Windows and Linux are all supported. The real differences are the terminal sandbox (Windows needs 11 24H2 or later), how hook commands are launched on Windows, and path handling.
12. Limits that bite: 24,000 bytes per rule file, a 20,000-token rules budget, 1 to 1,024 characters for a skill description, a 30-second default hook timeout, and no rule loading from subfolders.
13. Security has a record: four published attack chains between November 2025 and February 2026. Google has since added a sandbox, permission rules, workspace trust and plugin path checks. A plugin hook is still arbitrary shell on the user's machine.
14. Driving Antigravity from another vendor's agent breaks the terms on consumer plans. A cross-harness plugin must run inside each harness. It must not call `agy` from Claude Code or Codex.
15. How solid is this? The official docs, changelog, schemas and install script were opened directly, so paths and names are well supported. But nothing was executed, the hook contract changed three times in the last three weeks, and third-party tests show documented hook behaviour failing. Treat hooks as an optional layer and test on a live `agy` before relying on them.

## How to read the tags

- `[OPENED url — "quote"]`: I fetched that page in this session. The quote is verbatim, with markdown marks removed. A backslash before `<` or `~` inside a quote is only markdown escaping.
- `[THIRD-PARTY url — "quote"]`: a non-Google page, or a user post on Google's forum. I fetched it, unless the tag says "via fetch summary". In that case a fetch tool relayed the text and I did not see the raw page.
- `[SEARCH-ONLY url]`: only a search extract supports it.
- "Not stated" means I looked and the official pages are silent.
- Where a claim is my own inference, the sentence says "inference".

## How the official docs were read

- The brief first said `antigravity.google` was blocked. The coordinator later corrected that. In my session the host answered from my first request, so nearly every tag below is `OPENED`. Details are under "Blocked hosts".
- The docs site is not a JavaScript shell. It is server-rendered (Astro with Starlight), so plain curl returns the full text.
- Every docs page also has a markdown twin at the same URL plus `.md`, for example `https://antigravity.google/docs/hooks.md`. The site lists its pages in `https://antigravity.google/llms.txt` and `https://antigravity.google/sitemap.xml`. I fetched all 106 docs pages as markdown and quoted from those. I spot-checked the markdown against the HTML. Tags cite the normal page URL.
- Also opened on the same host: the changelog, 13 blog posts, the download, product and terms pages, the two JSON schemas under `/schemas/v1/`, and the CLI install scripts under `/cli/`.
- Two old URLs to know about. `https://antigravity.google/docs/rules-workflows` still answers HTTP 200, but it is only a redirect stub to `/docs/rules`. `https://antigravity.google/docs/knowledge` returns 404.
- Every quote in this file was checked by script against the saved copy of its source.

## Six points confirmed from primary pages

| Question | Answer | Primary evidence |
|---|---|---|
| Is `AGENTS.md` read natively? | Yes, in the App, the CLI and the IDE. So is `GEMINI.md`. | [OPENED https://antigravity.google/docs/rules — "You can place an AGENTS.md or GEMINI.md file—or a .agents/rules/ directory—in your workspace folder and in any parent folder up to the repository root."] [OPENED https://antigravity.google/docs/cli/gcli-migration — "The agent continues to parse and enforce rule constraints defined inside your active directory's GEMINI.md and AGENTS.md files."] |
| Where do skills live? | `.agents/skills/<name>/` in the project. `~/.gemini/config/skills/<name>/` for the user. `skills/` inside a plugin. | [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "You can invoke any skill located in .agents/skills/\<name>/ or ~/.gemini/config/skills/\<name>/ by typing /\<name> in chat"] |
| Do lifecycle hooks exist, and which events? | Yes. Six events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. | [OPENED https://antigravity.google/docs/hooks — "Antigravity supports the following hook events"] [OPENED https://antigravity.google/blog/plugin-marketplace-in-antigravity — "including SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, and Stop"] |
| Is there a plugin format? | Yes. A folder with a `plugin.json` manifest. | [OPENED https://antigravity.google/docs/build-plugins — "Every plugin requires a plugin.json manifest at \<plugin-root>/plugin.json (or \<plugin-root>/.antigravity-plugin/plugin.json)"] |
| Is there a CLI or a headless mode? | Yes. The CLI is `agy`. `agy -p` is headless. | [OPENED https://antigravity.google/docs/cli/headless — "Pass a prompt with -p (or its aliases --print and --prompt) to run once and exit"] |
| Does the CLI load plugin hooks? | Yes. The hooks page says so in its CLI section, and the CLI changelog shows it happening. | [OPENED https://antigravity.google/docs/hooks — "Plugin level: Packaged inside an installed plugin's hooks.json file."] [OPENED https://antigravity.google/docs/changelog — "Fixed the /hooks command and hook inspection utilities omitting hooks bundled inside enabled plugins"] |

One nuance on the last row. The hooks page lists three hook locations for the CLI (workspace, global, plugin) but only two for the App and the IDE (workspace, global). Plugin hooks in the App are stated only on the plugins page. See section 6.

---

## 1. Product shape and current version

**Evidence grade: strong for names, versions and OS lists. Not run.**

### Surfaces

- Four surfaces, one harness. [OPENED https://antigravity.google/docs/overview — "Evolved from the Agent Manager into a standalone desktop command center (Antigravity App) alongside native terminal, editor, and programmatic SDK interfaces"]
- The App and the CLI run the same agent. [OPENED https://antigravity.google/docs/features — "The Antigravity App and the Antigravity CLI run the same agent, so most features work on both."]
- "Antigravity 2.0" is the App. It launched on May 19, 2026. It has no editor inside. [OPENED https://antigravity.google/blog/introducing-google-antigravity-2 — "Google Antigravity 2.0 is a new, standalone desktop application"]
- The old Agent Manager lived inside the IDE. Google plans to remove it there. [OPENED https://antigravity.google/blog/introducing-google-antigravity-2 — "In an upcoming release, we plan to remove the Agent Manager from the Antigravity IDE"]
- The standalone Antigravity IDE still ships (v2.6.0). Enterprise sign-in does not work in it. [OPENED https://antigravity.google/docs/faq — "Enterprise sign-in works in the Antigravity App, Antigravity CLI, and Antigravity IDE extensions, but not in the standalone Antigravity IDE."]
- The CLI is `agy`. It replaced Gemini CLI for consumer accounts. [OPENED https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ — "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests for Google AI Pro and Ultra"]
- Gemini CLI still exists for enterprise licences. [OPENED https://raw.githubusercontent.com/google-gemini/gemini-cli/main/README.md — "Free individual access and Google AI Pro / Ultra (Google One) moved to"]
- Gemini CLI "extensions" became Antigravity "plugins". [OPENED https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ — "Agent Skills, Hooks, Subagents, and Extensions (now as Antigravity plugins)"]
- IDE extensions exist for VS Code, Visual Studio, JetBrains, Zed, Xcode and Eclipse. [OPENED https://antigravity.google/docs/getting-started — "Install the official Google Antigravity extension for your preferred editor, or download the standalone Antigravity IDE"] [OPENED https://antigravity.google/docs/getting-started — "Eclipse 2026-06 or later on macOS, Linux, or Windows (Public Preview)."]
- The CLI can also serve any editor that speaks the Agent Client Protocol. [OPENED https://antigravity.google/docs/cli/acp — "Your editor launches agy acp as a subprocess and talks to it with JSON-RPC over stdin and stdout."]
- The SDK is Python. [OPENED https://antigravity.google/docs/sdk/overview — "The Google Antigravity SDK is a Python SDK for building autonomous AI agents powered by Antigravity and Gemini."]
- Remote Agents run in Google's cloud, not on the user's machine. [OPENED https://antigravity.google/docs/remote-agents — "Antigravity Remote Agents run your agent sessions and tools in an isolated, Google-managed remote environment rather than on your local machine."]
- An internal name, "Antigravity Hub", shows up in download URLs and in the CLI changelog. It means the App. [OPENED https://antigravity.google/docs/changelog — "another agy session, the Antigravity Hub, or the remote-control daemon"]

### Current versions

| Surface | Version | Date | Source |
|---|---|---|---|
| Antigravity App | v2.29.1 | Nov 7, 2026 | [OPENED https://antigravity.google/download — "Antigravity App v2.29.1"] |
| Antigravity CLI (`agy`) | v1.5.2 | Nov 6, 2026 | [OPENED https://antigravity.google/download — "Antigravity CLI v1.5.2"] |
| VS Code extension | v1.11.0 | Nov 2, 2026 | [OPENED https://antigravity.google/download — "Visual Studio Code v1.11.0"] |
| Python SDK | v0.1.23 | Oct 26, 2026 | [OPENED https://antigravity.google/download — "Antigravity SDK v0.1.23"] |
| Standalone IDE | v2.6.0 | Oct 26, 2026 | [OPENED https://antigravity.google/download — "Antigravity IDE (Standalone) v2.6.0"] |

- The dates are from the changelog page. [OPENED https://antigravity.google/docs/changelog — "Latest November 7, 2026"] [OPENED https://antigravity.google/docs/changelog — "Latest November 6, 2026"]
- The CLI's GitHub changelog already lists 1.5.3. The docs site does not yet. [OPENED https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md — "Added the PLUGIN_ROOT and PLUGIN_DATA environment variables to hook commands that come from a plugin"]
- The docs already describe App features tagged v2.30.0+. So docs can run ahead of the build a user has. [OPENED https://antigravity.google/docs/getting-started — "Personal Google Accounts (v2.30.0+)"]
- Releases reach users over days. [OPENED https://antigravity.google/docs/changelog — "New versions roll out gradually and may take a few days to reach all users."]

### Operating systems

| Surface | macOS | Windows | Linux |
|---|---|---|---|
| App | macOS 12+, Apple Silicon or Intel | Windows 10 64-bit or 11; x64 and ARM64 | glibc 2.28+; x64 and ARM64; tarball |
| CLI | amd64 and arm64 | amd64 and arm64; PowerShell or CMD installer | amd64 and arm64; glibc and musl; an Android/Termux build |
| Standalone IDE | same floor as the App | same | same |

- App on macOS. [OPENED https://antigravity.google/docs/getting-started — "macOS 12 (Monterey) or later (Apple Silicon or 64-bit Intel)"]
- App on Windows. [OPENED https://antigravity.google/docs/getting-started — "Windows 10 (64-bit) or Windows 11"]
- App on Linux. [OPENED https://antigravity.google/docs/getting-started — "glibc >= 2.28, glibcxx >= 3.4.25 (Ubuntu 20+, Debian 10+, Fedora 36+, RHEL 8+)"]
- CLI platforms, from the install script itself. [OPENED https://antigravity.google/cli/install.sh — "Antigravity CLI currently supports 64-bit Windows, macOS, and Linux."]
- The same script picks a musl build on Alpine-style systems and a Bionic build in Termux. [OPENED https://antigravity.google/cli/install.sh — "Termux needs the Bionic build: Android's linker rejects glibc/musl ones."]
- CLI install path on macOS and Linux. [OPENED https://antigravity.google/docs/getting-started — "Default binary location: ~/.local/bin/agy"]
- CLI install path on Windows is `C:\Users\<username>\AppData\Local\agy\bin`, which is `%LOCALAPPDATA%\agy\bin`. [OPENED https://antigravity.google/docs/cli/troubleshooting — "or %LOCALAPPDATA%\agy\bin on Windows"]
- There is also a "Googlebook" build. [OPENED https://antigravity.google/docs/getting-started — "Google Antigravity comes pre-installed on Googlebooks."]
- A running agent keeps the computer awake. [OPENED https://antigravity.google/docs/faq — "If an agent is running, Antigravity prevents your computer from sleeping."]

### Headless and scripted use

- The CLI has a real headless mode. [OPENED https://antigravity.google/docs/cli/headless — "Run Antigravity CLI non-interactively to script agent tasks, integrate with CI pipelines, and capture machine-readable output."]
- `agy -p "prompt"` runs once and exits. `--output-format` takes `text`, `json` or `stream-json`. `--input-format stream-json` keeps one process open for many turns. `--json-schema` forces structured output. [OPENED https://antigravity.google/docs/cli/headless — "The --output-format flag controls the shape of stdout. It accepts three values"]
- Each run starts clean. [OPENED https://antigravity.google/docs/cli/headless — "Headless runs are stateless by default."]
- It resumes with `--continue` or `--conversation <id>`. [OPENED https://antigravity.google/docs/cli/headless — "Resume prior context with --continue (-c) for the most recent conversation, or --conversation with an ID"]
- Skills and slash commands expand in headless mode unless you pass `--disable-slash-commands`. [OPENED https://antigravity.google/docs/cli/reference — "Disable slash command and skill expansion in print mode."]
- Headless needs cached credentials or a Gemini API key. [OPENED https://antigravity.google/docs/cli/headless — "Headless mode uses your cached credentials."] [OPENED https://antigravity.google/docs/install — "This suits headless and CI runs, where no browser is available to complete a sign-in."]
- The App has no headless mode that I found. Not stated.

### Models

- Model list today: Gemini 4 Argon, Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.1 Pro, Claude Sonnet 5.5 and Opus 5.5 (thinking), Claude Sonnet 4.6 and Opus 4.6 (thinking), GPT-OSS-120b. Which ones you get depends on plan. [OPENED https://antigravity.google/docs/models — "Antigravity gives you access to leading frontier reasoning models from Google DeepMind and partner providers."]
- Claude 4.6 models and GPT-OSS-120b leave on November 18, 2026. [OPENED https://antigravity.google/docs/models — "Will be removed on November 18, 2026."]
- The free tier gets Gemini 3.8 Flash. Gemini 4 Argon needs a paid plan. [OPENED https://antigravity.google/docs/plans — "Use of Gemini models, including Gemini 3.8 Flash and other offered Gemini Enterprise models as the core agent model"] [OPENED https://antigravity.google/docs/models — "Available with paid Google AI Pro plans or on trial with eligible premium devices."]
- Subagents and automations pick a tier, not a model name: Flash Lite, Flash or Pro. [OPENED https://antigravity.google/docs/features — "Each automation runs on the model tier you choose: Flash Lite, Flash (the default), or Pro."]
- When a Claude model is the main model, small Gemini models still run in the background. [OPENED https://antigravity.google/docs/enterprise — "lightweight first-party Gemini models continue to run in the background to handle high-frequency client-side coordination—such as context management and summaries"]

---

## 2. Rules

**Evidence grade: strong. One official page covers it, and the changelog agrees.**

### What they are

- Rules are files Antigravity finds on disk and puts into the agent's context. [OPENED https://antigravity.google/docs/rules — "Antigravity automatically discovers rules from your filesystem and injects them into the agent's context."]
- All rules found are added together. None replaces another. [OPENED https://antigravity.google/docs/rules — "Rules are cumulative rather than replacement-based: Antigravity combines all the rules it finds into the prompt."]
- They work in the App, the CLI and the IDE. [OPENED https://antigravity.google/docs/rules — "Available on: Antigravity App, Antigravity CLI, Antigravity IDE"]

### Where they live

Workspace, at the workspace folder and at every parent folder up to the repository root:

- `<dir>/AGENTS.md` or `<dir>/GEMINI.md`
- `<dir>/.agents/AGENTS.md` or `<dir>/.agents/GEMINI.md`
- `<dir>/.agents/rules/*.md` (legacy: `<dir>/.agent/rules/*.md`)

[OPENED https://antigravity.google/docs/rules — "You can place an AGENTS.md or GEMINI.md file—or a .agents/rules/ directory—in your workspace folder and in any parent folder up to the repository root."]

Global, for every project on the machine:

- `~/.gemini/AGENTS.md`, `~/.gemini/GEMINI.md`
- `~/.gemini/config/AGENTS.md`, `~/.gemini/config/GEMINI.md`
- `~/.gemini/config/rules/*.md` (frontmatter required)

[OPENED https://antigravity.google/docs/rules — "Global rules apply across all projects on your workstation"]

Things to know:

- Subfolder rule files are **not** loaded. This differs from Claude Code's nested `CLAUDE.md`. [OPENED https://antigravity.google/docs/rules — "Antigravity doesn't load rules from subfolders below the workspace folder, even when the agent reads or edits files there."]
- The `rules/` folder is scanned one level deep. [OPENED https://antigravity.google/docs/rules — "Antigravity scans only immediate .md children inside .agents/rules/"]
- A `rules.json` manifest can pull in nested files or folders outside `.agents/`. [OPENED https://antigravity.google/docs/customization-discovery — "A discovery manifest is a JSON file that lists customizations stored outside the standard folders, or nested deeper than the scan reaches."]
- Old folder names still work. [OPENED https://antigravity.google/docs/customization-discovery — "Antigravity also recognizes folders named .agent/, _agents/, and _agent/. Use .agents/ for new projects."]
- A plugin ships rules in its own `rules/` folder. `rules/AGENTS.md` there is always on. [OPENED https://antigravity.google/docs/build-plugins — "Loaded automatically as an always-on rule whenever the plugin is enabled (no YAML frontmatter required)."]
- An `AGENTS.md` at the plugin root is not a rule. The validator warns about it. [OPENED https://antigravity.google/docs/changelog — "an AGENTS.md or GEMINI.md at the plugin root instead of in rules/"]

### `.agent/` versus `.agents/`

Sources disagree, and the reason is age. `.agents/` (plural) is the current default in every official docs page. `.agent/` (singular) is the legacy name and still loads. **`.agents/` is better supported. Use it.**

- The official statement. [OPENED https://antigravity.google/docs/skills — "Antigravity defaults to .agents/skills, but still maintains backward compatibility for .agent/skills."]
- One Google codelab, last updated May 21, 2026, still uses the singular. [OPENED https://codelabs.developers.google.com/codelabs/coding-jam/instructions — "Please install the workshop skills into this workspace's .agent/skills/"]
- A November 2025 security write-up also uses the singular. [THIRD-PARTY https://mindgard.ai/blog/google-antigravity-persistent-code-execution-vulnerability — "These rules are contained within the source code of the project within the .agent directory in the form of Markdown files."]
- The nine other Google codelabs I opened use the plural. [OPENED https://codelabs.developers.google.com/getting-started-google-antigravity — "Project/Workspace Scope (\<project-root>/.agents/skills/): This would make the skill available only within a specific project."]

### Activation modes

- `AGENTS.md` and `GEMINI.md` take no frontmatter and are always on. [OPENED https://antigravity.google/docs/rules — "AGENTS.md and GEMINI.md do not use frontmatter."]
- Every file in a `rules/` folder needs frontmatter with a `trigger`. [OPENED https://antigravity.google/docs/rules — "Every .md file inside rules/ must start with YAML frontmatter declaring a valid trigger."]
- Four triggers. [OPENED https://antigravity.google/docs/rules — "Controls how and when the rule activates: model_decision, always_on, glob, or manual."]
- `always_on`: full text in the system prompt, every turn. [OPENED https://antigravity.google/docs/rules — "Antigravity injects the full content into the system prompt on every turn."]
- `model_decision`: only the path and description go in. The agent opens the file when it judges it relevant. Needs `description`. [OPENED https://antigravity.google/docs/rules — "Antigravity injects only the rule's path and description upfront (progressive disclosure)."]
- `glob`: fires on matching files. `globs` is one comma-separated string, not a YAML list. [OPENED https://antigravity.google/docs/rules — "Automatically activates when the agent interacts with files matching any comma-separated pattern in globs"]
- `manual`: only when the user `@`-mentions it. [OPENED https://antigravity.google/docs/rules — "Antigravity never loads these rules automatically."]
- Manual rules cannot be mentioned in the CLI. [OPENED https://antigravity.google/docs/rules — "The Antigravity CLI doesn't support rule mentions."]
- A bad or missing trigger fails silently. This is a "reports nothing, does nothing" trap. [OPENED https://antigravity.google/docs/rules — "Antigravity silently discards the rule."]
- The system prompt tells the model that user rules outrank built-in instructions. [OPENED https://antigravity.google/docs/changelog — "GEMINI.md and AGENTS.md rules explicitly override earlier built-in instructions"]

### Includes

- `@[label](path)` inlines another file before size checks. `@filename` only rewrites the path so the agent can find the file. [OPENED https://antigravity.google/docs/rules — "Inlines the target file's contents directly into the rule before prompt evaluation and size-limit checks."]

### Size caps

- Per file. [OPENED https://antigravity.google/docs/rules — "Antigravity truncates any single rule file that exceeds 24,000 bytes"]
- In total. [OPENED https://antigravity.google/docs/rules — "All active global and always_on rules share a 20,000-token budget separate from the customization budget"]
- Over budget, the biggest files are swapped for one-line pointers. [OPENED https://antigravity.google/docs/rules — "Antigravity automatically demotes the largest rule files from inline text to lightweight pointers"]

### When edits take effect

- On the next message. No restart. [OPENED https://antigravity.google/docs/customization-discovery — "Antigravity rereads your rules and skills before each turn, so a new or edited file applies to your next message without a restart."]

### Can the agent edit them?

- In the CLI the agent can read the global rules in `~/.gemini/config` and must ask before it edits them. Other files there are off limits. [OPENED https://antigravity.google/docs/changelog — "it can now read them and asks before editing them, while other files in that folder stay off-limits."]

### `AGENTS.md`, `GEMINI.md`, `CLAUDE.md`

- `AGENTS.md` and `GEMINI.md`: both read natively, on every surface. [OPENED https://antigravity.google/docs/cli/best-practices — "The agent automatically parses these rules on startup and consults them before suggesting changes."]
- `CLAUDE.md`: not read as a rules file. No official page names it. The only bridge is a one-time import at first launch. [OPENED https://antigravity.google/docs/getting-started — "import MCP servers, skills, rules, and instructions from Claude Code, Codex, Cursor, and Gemini CLI"]
- The IDE gained `AGENTS.md` in March 2026. [OPENED https://antigravity.google/docs/changelog — "Added support for reading rules from AGENTS.md in addition to GEMINI.md."]

### OS differences

- The per-user folder feature reads `USER`, or `USERNAME` on Windows. [OPENED https://antigravity.google/docs/customization-discovery — "Antigravity replaces {user} with your user name from the USER environment variable (USERNAME on Windows)"]
- Manifests do not expand `~`. Use absolute paths. [OPENED https://antigravity.google/docs/customization-discovery — "Antigravity doesn't expand ~, so write folders in your home directory as absolute paths."]
- No other OS difference is stated for rules.

---

## 3. Workflows

**Evidence grade: strong, and the answer is "do not build on them".**

- Workflows are deprecated. [OPENED https://antigravity.google/docs/ide/workflows — "Workflows are deprecated, and a new workflows system is on the way."]
- What they were: one Markdown file of steps, run as a slash command. [OPENED https://antigravity.google/docs/ide/workflows — "Once saved, you can invoke workflows in the agent using a slash command with the format /workflow-name."]
- Where they lived: `.agents/workflows/<name>.md` in the project and `~/.gemini/config/workflows/<name>.md` globally. [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "Scans both global (\~/.gemini/config/workflows/) and workspace-level (.agents/workflows/) directories."]
- Size cap. [OPENED https://antigravity.google/docs/ide/workflows — "Workflow files are limited to 12,000 characters each."]
- The workflows page is marked for the IDE only. [OPENED https://antigravity.google/docs/ide/workflows — "Available on: Antigravity IDE"]
- Existing ones still run for now. [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "Your current workflows keep working for now."]
- The replacement is a skill. A skill of the same name wins. [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "Skills take precedence over legacy workflows."]
- The automatic migrator runs only in the App. [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "The /migrate-workflows command is available only in the Antigravity App 2.12.0 and later, not in the Antigravity CLI or the Antigravity IDE."]
- A plugin cannot ship workflows or Claude-style commands. They are not loaded. [OPENED https://antigravity.google/docs/changelog — "commands/ folders and workflows/ Markdown files (which plugins don't load)"]
- The Python SDK has a separate beta feature also called "workflows". It is code orchestration, not Markdown files. [OPENED https://antigravity.google/docs/changelog — "introduces beta support for dynamic workflow orchestration"]

---

## 4. Skills

**Evidence grade: strong.**

### Does it support the Agent Skills standard?

- Yes. A skill is a folder with a `SKILL.md`. [OPENED https://antigravity.google/docs/skills — "A skill is a folder containing a SKILL.md file with instructions that the agent can follow when working on specific tasks."]
- Google dates the move to the open standard to May 2026. The IDE had "Agent Skills" from January 2026. [OPENED https://antigravity.google/docs/migration/workflows-to-skills — "In May 2026, Antigravity adopted the open industry standard for"] [OPENED https://antigravity.google/docs/changelog — "Agent Skills now available in Antigravity"]

### Where skills live

| Scope | Path | Read by |
|---|---|---|
| Workspace | `<workspace-root>/.agents/skills/<skill-folder>/` and the same folder in each parent up to the repo root | App, CLI, IDE |
| Global | `~/.gemini/config/skills/<skill-folder>/` | App, CLI, IDE |
| Plugin | `~/.gemini/config/plugins/<plugin-folder>/skills/` | App, CLI, IDE |
| CLI only | `~/.gemini/antigravity-cli/skills/` and `~/.gemini/skills/` | CLI |
| IDE legacy | `~/.gemini/antigravity/skills/` | IDE |

- The two CLI-only folders are a trap for a cross-surface plugin. [OPENED https://antigravity.google/docs/skills — "The Antigravity CLI also loads skills from ~/.gemini/antigravity-cli/skills/ and ~/.gemini/skills/, which the Antigravity App doesn't read."]
- For one personal skill in both App and CLI, use the shared folder. [OPENED https://antigravity.google/docs/customization-discovery — "To use a personal skill in both the Antigravity App and the Antigravity CLI, put it in ~/.gemini/config/skills/."]
- The IDE legacy path. [OPENED https://antigravity.google/docs/skills — "legacy ~/.gemini/antigravity/skills/ is also supported"]
- Skill folders must sit directly inside `skills/`. [OPENED https://antigravity.google/docs/customization-discovery — "Antigravity scans each customization folder one level deep."]

### Progressive disclosure

- Step one: names and descriptions only, on every turn. [OPENED https://antigravity.google/docs/skills — "On every turn, the agent sees a list of available skills with their names and descriptions."]
- Step two: the agent reads the whole file when it looks relevant. [OPENED https://antigravity.google/docs/skills — "If a skill looks relevant to your task, the agent reads the full SKILL.md content."]
- Step three: scripts and reference files load only when the instructions call for them. [OPENED https://antigravity.google/docs/build-plugins — "Optional reference docs loaded on demand"]
- Google's advice on scripts. [OPENED https://antigravity.google/docs/skills — "encourage the agent to run them with --help first rather than reading the entire source code"]

### Frontmatter

| Field | Required | Rule |
|---|---|---|
| `name` | No for a loose skill; yes inside a plugin | Lowercase kebab-case, 1 to 64 characters. In a plugin it must equal the folder name. |
| `description` | Yes | What it does and when to use it. 1 to 1,024 characters. |
| `disable-model-invocation` | No | `true` means it runs only when the user types `/<name>`. |
| `license`, `compatibility` | No | Free text. |

- Loose skill: name falls back to the folder. [OPENED https://antigravity.google/docs/skills — "Defaults to the folder name if not provided."]
- Plugin skill: name must match. [OPENED https://antigravity.google/docs/build-plugins — "must match the parent directory name"]
- Description length. [OPENED https://antigravity.google/docs/build-plugins — "Explains both what the skill does and when the agent should trigger it (1–1,024 characters)."]
- Manual-only switch. [OPENED https://antigravity.google/docs/build-plugins — "When true, prevents automatic model invocation so the skill runs only when invoked explicitly via /\<name>."]
- The open standard lists two more optional fields, `metadata` and `allowed-tools`. Antigravity's pages do not mention them. Google's own sample skill uses `metadata`. [THIRD-PARTY https://agentskills.io/specification — "Arbitrary key-value mapping for additional metadata"]
- The standard's name rule matches Antigravity's. [THIRD-PARTY https://agentskills.io/specification — "Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen."]

### Invocation

- Automatic, by description. Or by slash command. [OPENED https://antigravity.google/docs/skills — "Type /\<skill-name> in the message box to explicitly invoke a skill."]
- The CLI turns every skill into a slash command. [OPENED https://antigravity.google/docs/skills — "Whenever you define a skill, the CLI automatically converts it into a slash command inside the interactive TUI."]
- New skills in a running CLI need a reload. [OPENED https://antigravity.google/docs/skills — "run /skills reload or start a new conversation to update the slash commands"]
- Plugin skills are namespaced. [OPENED https://antigravity.google/docs/customization-discovery — "Skills from a plugin are named \<plugin>:\<skill>, so they don't conflict with your other skills."]

### Limits

- Body size: the validator warns over 24 KB. [OPENED https://antigravity.google/docs/changelog — "when the body is over the 24 KB limit"]
- Name clashes: workspace beats personal, personal beats built-in. In the CLI, the two CLI-only folders beat everything. [OPENED https://antigravity.google/docs/customization-discovery — "In the Antigravity CLI, skills in ~/.gemini/antigravity-cli/skills/ and ~/.gemini/skills/ take priority over all of these"]
- Built-in skills exist (`agy-customizations`, `antigravity-guide`, `migrate-workflows`). [OPENED https://antigravity.google/docs/customization-discovery — "built-in skills that don't run as slash commands in the Antigravity CLI, such as migrate-workflows"]
- Local skills do not reach Remote Agents. [OPENED https://antigravity.google/docs/remote-agents — "MCP servers, plugins, and agent skills installed on your machine"]
- A workspace manifest can no longer point outside the repository. [OPENED https://antigravity.google/docs/changelog — "plugins and skills listed in a workspace's .agents/plugins.json or .agents/skills.json now load only from inside the workspace or its repository root"]

### Field evidence

- One widely used cross-harness plugin boots on Antigravity through skill discovery alone, with no hook. Its skill description says to use it at the start of any conversation. [THIRD-PARTY https://raw.githubusercontent.com/obra/superpowers/main/RELEASE-NOTES.md — "Superpowers bootstraps on Antigravity through skill discovery."]

### OS differences

- None stated for skills. Scripts inside a skill are run by the agent's shell tool, so normal shell portability applies. Inference.

---

## 5. Memory

**Evidence grade: strong that there is no documented memory feature today. Weak on what Knowledge Items still do.**

### What the official docs say today

- The plainest statement is in the `/learn` page. [OPENED https://antigravity.google/docs/commands/learn — "Agents don't remember conversations."]
- And what follows from it. [OPENED https://antigravity.google/docs/commands/learn — "that knowledge disappears when the conversation ends, unless it's written down as a customization"]
- There is no Knowledge page. I requested `https://antigravity.google/docs/knowledge`, `/docs/ide/knowledge`, `/docs/knowledge-items`, `/docs/memory` and `/docs/memories`. All returned HTTP 404. None is in the sitemap. [OPENED https://antigravity.google/docs/knowledge — "404 Page Not Found - Google Antigravity"]

### Where "knowledge items" still appear

Only in passing:

- As something stored in the App's data folder. [OPENED https://antigravity.google/docs/agent-settings — "which contains artifacts, knowledge items, and more"]
- As a file category in the CLI's `/context` panel. [OPENED https://antigravity.google/docs/cli/commands/context — "lists loaded Knowledge files, Artifact files, and Skill files with their individual token counts"]
- As an old IDE setting. [OPENED https://antigravity.google/docs/changelog — "New Settings to allow disabling conversation history and knowledge."]
- In the November 2025 launch post. [OPENED https://antigravity.google/blog/introducing-google-antigravity — "with agent actions both retrieving from and contributing to a knowledge base"]

So the plumbing may still exist. The feature is no longer documented, and neither the App nor the CLI changelog mentions it once.

### How it was meant to work (IDE era, 2025 to early 2026)

- Automatic, with no approval step. A Google staff member said so on Google's forum on March 3, 2026. [OPENED https://discuss.ai.google.dev/t/knowledge-items/126774 — "Antigravity automatically analyzes and extracts information from your conversation"]
- Stored under `~/.gemini/antigravity/knowledge/`. [THIRD-PARTY https://discuss.ai.google.dev/t/bug-conversation-history-not-persisted-brain-directories-empty-no-knowledge-items-generated/128466 — "knowledge/ directory contains only a lock file"]
- Many users reported it never wrote anything. [THIRD-PARTY https://discuss.ai.google.dev/t/knowledge-how-to-make-it-works/115505 — "This feature doesnt work from day one."]
- One user reported the agent itself was barred from writing there. [THIRD-PARTY https://discuss.ai.google.dev/t/knowledge-feature-failure/129021 — "The agent is prohibited from direct writes to ~/.gemini/antigravity/knowledge/."]
- A tool author looking for ground truth in October 2026 found none. [THIRD-PARTY https://github.com/RunMaestro/Maestro/issues/1886 — "We found no official Google documentation for any of this." (via fetch summary)]

### Answers to the brief's questions

| Question | Answer |
|---|---|
| Is there native persistent memory? | Not as a documented feature in the App or CLI. |
| How is knowledge written? | IDE era: automatically, by a background step. Today: not stated. |
| Where is it stored? | `~/.gemini/antigravity/knowledge/` per third-party reports. Not in current docs. |
| How is it retrieved? | Not stated. `/context` can list "Knowledge files". |
| Can a plugin or skill read or write it? | No documented way. One report says the agent cannot write there. |
| Can it be turned off? | The IDE had a setting in January 2026. App and CLI: not stated. |

### What a plugin can use instead (all native)

- **`/learn`**: the agent finds a lesson, proposes it, and writes only on approval. [OPENED https://antigravity.google/docs/commands/learn — "the agent never edits configuration files immediately. It drafts a proposal artifact for your review first."]
- The proposal is a file the user reviews. [OPENED https://antigravity.google/docs/commands/learn — "the agent creates a learning_proposal.md artifact"]
- It writes rules or skills to the standard folders, project or global. [OPENED https://antigravity.google/docs/commands/learn — "/learn writes to the same locations that Antigravity discovers customizations from."]
- **Rules as memory**: an always-on `AGENTS.md` reaches every turn and is re-read each turn. See section 2.
- **Past conversations**: in the App, the user can `@`-mention one. [OPENED https://antigravity.google/docs/at-mentions — "The agent reads that conversation's saved transcript when it needs details."]
- The App searches the full text of old conversations. The CLI does not. [OPENED https://antigravity.google/docs/search — "the command palette searches the full text of your conversations, including your prompts and the agent's responses"] [OPENED https://antigravity.google/docs/search — "The picker doesn't search the full text of your conversations"]
- **A plugin data folder** that survives plugin updates. [OPENED https://antigravity.google/docs/build-plugins — "The absolute path of a persistent, writable data directory created for the plugin outside your workspace."]
- **SDK only**: session persistence by `conversation_id`. [OPENED https://antigravity.google/docs/sdk/lifecycle — "Session persistence allows you to persist and restore stateful sessions across application restarts."]

---

## 6. Hooks

**Evidence grade: strong that hooks exist and what the documented contract is. Medium on real behaviour: the official pages disagree with each other in four places, and third-party tests found bugs.**

### Do they exist?

Yes. Confirmed from the primary docs. [OPENED https://antigravity.google/docs/hooks — "Hooks allow you to run custom scripts or shell commands at specific points during Antigravity's execution loop"] [OPENED https://antigravity.google/docs/hooks — "Available on: Antigravity App, Antigravity CLI, Antigravity IDE"]

### Config files

- Workspace. [OPENED https://antigravity.google/docs/hooks — "Workspace level: .agents/hooks.json at your project root."]
- Global. Not in the CLI settings file. [OPENED https://antigravity.google/docs/hooks — "Global level: ~/.gemini/config/hooks.json. Hooks in ~/.gemini/antigravity-cli/settings.json aren't loaded."]
- Plugin. [OPENED https://antigravity.google/docs/hooks — "Plugin level: Packaged inside an installed plugin's hooks.json file."]
- A custom agent can list its own hook files in frontmatter. [OPENED https://antigravity.google/docs/changelog — "Custom agents can declare their own hooks."]
- Inspect them with `/hooks` in the CLI, or Settings > Customizations > Hooks in the App. [OPENED https://antigravity.google/docs/hooks — "You can also view and toggle hooks from Settings > Customizations > Hooks."]
- A Google codelab last updated in June 2026 says hooks can go in `settings.json`. The docs, the settings schema and the changelog all say they cannot. **The docs are better supported.** [OPENED https://codelabs.developers.google.com/genai-for-dev-antigravity-cli — "Hooks are defined inside a plugin's hooks.json or configured inside your primary settings.json file."] [OPENED https://antigravity.google/schemas/v1/settings.json — "Not read from settings.json. Put hooks in ~/.gemini/config/hooks.json or \<workspace>/.agents/hooks.json instead."]

### Which surfaces load plugin hooks

- **CLI: yes, stated outright.** The CLI section of the hooks page lists the plugin level. [OPENED https://antigravity.google/docs/hooks — "Plugin level: Packaged inside an installed plugin's hooks.json file."]
- The CLI changelog shows plugin hooks being listed, run and switched off. [OPENED https://antigravity.google/docs/changelog — "Fixed the /hooks command and hook inspection utilities omitting hooks bundled inside enabled plugins"] [OPENED https://antigravity.google/docs/changelog — "Fixed disabled plugins still running their hooks and contributing other customizations"]
- `agy plugin install` reports the hooks it installed. [OPENED https://antigravity.google/docs/changelog — "to name each installed skill, agent, rule, command, MCP server, and hook"]
- **App and IDE: implied, not stated on the hooks page.** Their sections of the hooks page list only the workspace and global files. The plugins page, which covers all three surfaces, says plugin hooks run. [OPENED https://antigravity.google/docs/plugins — "hooks run automatically in the background while the plugin is enabled"]
- That plugins-page sentence names four events (`PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`). The build-plugins page lists all six for plugins. [OPENED https://antigravity.google/docs/build-plugins — "take a flat array of hook handler objects"]

### File shape

The top-level keys are hook names you choose. Each holds event arrays. Tool events wrap handlers in a matcher group. The other four take a flat list.

```json
{
  "my-hook": {
    "enabled": true,
    "SessionStart": [ { "type": "command", "command": "./scripts/start.sh", "timeout": 10 } ],
    "PreToolUse":   [ { "matcher": "run_command", "hooks": [ { "command": "./scripts/check.sh" } ] } ]
  }
}
```

- The flat-versus-wrapped rule. [OPENED https://antigravity.google/docs/hooks — "the structure is simpler (a list of handlers directly under the event key) and the matcher is ignored"]
- A Claude Code file with a top-level `"hooks"` key loads as one broken hook. [OPENED https://antigravity.google/docs/changelog — "which loads as a single hook named hooks"]
- A `hooks/hooks.json` subfolder file is ignored. [OPENED https://antigravity.google/docs/changelog — "a hooks/hooks.json file (which isn't read)"]
- Only shell commands are supported. [OPENED https://antigravity.google/docs/hooks — "Currently only "command" is supported."]
- Default timeout. [OPENED https://antigravity.google/docs/hooks — "Timeout in seconds. Defaults to 30."]

### Events

| Event | When | Matcher | What the hook can return |
|---|---|---|---|
| `SessionStart` | Once, when a new conversation starts, before the first model call | none | `injectSteps` |
| `PreInvocation` | Before every model call | none | `injectSteps`; `terminationBehavior: "terminate"` |
| `PostInvocation` | After every model call | none | `injectSteps`; `terminationBehavior: "force_continue"` or `"terminate"` |
| `PreToolUse` | Before a tool runs | regex on tool name | `decision`, `reason`, `overwrite`, `permissionOverrides` |
| `PostToolUse` | After a tool finishes | regex on tool name | `{}` only |
| `Stop` | When the agent loop is about to end | none | `decision: "continue"` plus `reason` |

- `SessionStart`. [OPENED https://antigravity.google/docs/hooks — "Fires once when a new conversation session starts, before the first model invocation."]
- `PreInvocation`. [OPENED https://antigravity.google/docs/hooks — "Fires before the model is called."]
- `PostInvocation`. [OPENED https://antigravity.google/docs/hooks — "Fires immediately after each model invocation completes."]
- `Stop`. [OPENED https://antigravity.google/docs/hooks — "Fires when execution terminates."]
- Matchers. [OPENED https://antigravity.google/docs/hooks — "you can use a regular expression in the matcher field to specify which tools trigger the hook"]
- Not in the list: `SessionEnd`, `PreCompact`, `UserPromptSubmit`, `SubagentStop`, `Notification`. None found.

Tool names a matcher can target include `view_file`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, `list_dir`, `find_by_name`, `grep_search`, `search_web`, `read_url_content`, `run_command`, `manage_task`, `schedule`, `invoke_subagent`, `define_subagent`, `send_message`, `ask_question`. MCP tools match with a pattern such as `mcp:.*`. [OPENED https://antigravity.google/docs/hooks — "you can match against standard tool names, grouped by category"] [OPENED https://antigravity.google/docs/build-plugins — "Tool name regex ("run_command", "mcp:.*")"]

### Input and output

- JSON on stdin, JSON on stdout. [OPENED https://antigravity.google/docs/hooks — "Hooks receive input through stdin as JSON and return output through stdout as JSON. Field names use camelCase."]
- Every hook gets `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`, `lastUserInput`. [OPENED https://antigravity.google/docs/hooks — "The absolute path to the persistent transcript.jsonl conversation logs."]
- `lastUserInput` is the user's latest prompt. It arrived in CLI 1.4.7 (Oct 24, 2026) and App 2.28.0 (Oct 27, 2026). [OPENED https://antigravity.google/docs/hooks — "The most recent user prompt in the conversation."] [OPENED https://antigravity.google/docs/changelog — "Added lastUserInput to the JSON that hook commands receive on stdin"] [OPENED https://antigravity.google/docs/changelog — "Hooks you define now receive the current user message, so a hook can check a prompt before the agent acts on it."]
- `workspacePaths` is where the project is. [OPENED https://antigravity.google/docs/hooks — "Absolute directory paths representing your mounted workspaces."]
- Output must be a JSON object and the exit code must be 0. [OPENED https://antigravity.google/docs/build-plugins — "must exit with code 0 and write a JSON response object to stdout"]

### What a hook can do

**Inject context.** `SessionStart`, `PreInvocation` and `PostInvocation` return `injectSteps`. Each step is one of `systemMessage`, `userMessage`, `ephemeralMessage` or `errorMessage`. [OPENED https://antigravity.google/docs/hooks — "List of steps to inject into the conversation trajectory at the start of the session"]

**Block a prompt.** `PreInvocation` can stop the turn before the model sees it. Added in CLI 1.4.11 (Oct 30, 2026). [OPENED https://antigravity.google/docs/hooks — "Stops execution immediately before calling the model"] [OPENED https://antigravity.google/docs/changelog — "Added terminationBehavior to PreInvocation hooks"]

**Gate a tool.** `PreToolUse` returns `allow`, `auto_approve`, `deny`, `ask`, `force_ask` or `deny_unless_prior_grant`. [OPENED https://antigravity.google/docs/hooks — "Hard blocks execution immediately."]

**Rewrite tool arguments.** [OPENED https://antigravity.google/docs/hooks — "Replacement arguments merged (shallow top-level merge) into toolCall.args before execution."]

**Keep the agent going.** `Stop` can refuse the stop and inject a reason. [OPENED https://antigravity.google/docs/hooks — "Set to "continue" to prevent the agent from stopping and re-enter the execution loop."]

**Tell whether background work is still running.** `Stop` input has `fullyIdle`. [OPENED https://antigravity.google/docs/hooks — "true if the agent is completely finished and all background commands or asynchronous tasks have completed"]

**What it cannot do.** `PostToolUse` cannot see tool output and cannot inject. [OPENED https://antigravity.google/docs/build-plugins — "Receives the tool call and any error (not the tool output)."]

### Failure behaviour

- Hooks fail open. A crash or a non-zero exit is logged and ignored. [OPENED https://antigravity.google/docs/build-plugins — "Any non-zero exit code is logged as a hook execution error and ignored (failing open)"]
- So a broken hook is silent to the user. This matters for the "instrumentation that reports nothing" defect class. A field report confirms it. [THIRD-PARTY https://discuss.ai.google.dev/t/a-hooks-systemmessage-metadata-user-markdown-as-documented-panics-and-the-hooks-whole-output-is-dropped/197747 — "The user sees nothing, and the error is only in the log file."]
- A `Stop` hook that always says continue is cut off after a number of rounds. [OPENED https://antigravity.google/docs/changelog — "after a configurable number of consecutive continuations, the hook can no longer block and the turn ends normally"]
- A failing hook used to end the session in the App. It no longer does. [OPENED https://antigravity.google/docs/changelog — "A failing custom hook no longer ends the session; it is now reported as an error and the conversation continues."]
- Disabled plugins do not run hooks (fixed in CLI 1.1.7). `/btw` side questions do not run hooks (fixed in CLI 1.3.3). [OPENED https://antigravity.google/docs/changelog — "Fixed /btw side questions running your user and workspace hooks"]

### Working directory and variables

- A plugin hook runs with the plugin root as its working directory. Use relative paths. [OPENED https://antigravity.google/docs/build-plugins — "Hook commands automatically execute with \<plugin-root> as their working directory (cwd) and should use relative paths"]
- So the project folder is not the working directory. Read it from `workspacePaths` on stdin. A third-party test confirms this. [THIRD-PARTY https://github.com/NexaDuo/mARC/pull/363 — "The workspace is only in the stdin JSON (workspacePaths)." (via fetch summary)]
- For a workspace or global `hooks.json` the docs do not state the working directory. One test found it is the folder that holds the file. [THIRD-PARTY https://github.com/vamsiramakrishnan/branchyard/pull/26 — "hooks run with the working directory set to the folder holding hooks.json, not the repository." (via fetch summary)]
- `PLUGIN_ROOT` and `PLUGIN_DATA` reach plugin hooks only from CLI 1.5.3, which the docs site does not list yet. Before that, no plugin variable was set for hooks. [OPENED https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md — "so plugin hooks can use files bundled with the plugin and keep state between runs"] [OPENED https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md — "agy plugin validate no longer warns that these variables are not set for hooks"]

### Places where the official pages disagree

1. **How `Stop` blocks.** The hooks page says return `"continue"`. The build-plugins page says return `"block"`, "or continue". [OPENED https://antigravity.google/docs/build-plugins — "to prevent completion until checks pass"] The hooks page is the reference page and matches a third-party test on agy 1.4.3. **Better supported: `"continue"`.** [THIRD-PARTY https://github.com/joaquinbejar/ai-crew-sync/pull/235 — "Verified on the real host (agy 1.4.3, 2026-10-20)" (via fetch summary)]
2. **Hook types.** The plugins page says hooks can be "prompt evaluations". The hooks page says only `command`. [OPENED https://antigravity.google/docs/plugins — "Synchronous shell commands or prompt evaluations that inspect, block, or augment agent lifecycle events and tool calls."] **Better supported: command only.**
3. **Workspace versus global.** The May 2026 launch post says workspace hooks take precedence. The docs page does not say whether both run. [OPENED https://antigravity.google/blog/google-io-2026-feature-deep-dive — "with the latter taking precedence if it exists"]
4. **How often `PreInvocation` fires.** The hooks page says before each model call, and numbers the calls. The build-plugins page says before a user turn. A third-party test (below) saw it fire on every model call. **Better supported: every model call.** So a hook that injects context must not inject on every firing. [OPENED https://antigravity.google/docs/hooks — "The 0-indexed sequence number of the current model invocation (the first invocation is 0)."] [OPENED https://antigravity.google/docs/build-plugins — "Before the model processes a user turn"]

### How new is `SessionStart`?

- The May 2026 launch post lists five hook points and no session start. [OPENED https://antigravity.google/blog/google-io-2026-feature-deep-dive — "after a model call (to override exit rules), or at agent loop stopping conditions (to force checks or block termination)"]
- A plugin author who tested agy 1.3.1 wrote that it did not exist. [THIRD-PARTY https://raw.githubusercontent.com/obra/superpowers/main/RELEASE-NOTES.md — "Antigravity has no session-start hook event, but it shows the model each installed skill's description"]
- Another author, testing agy 1.3.2 and 1.3.5 a week later, found it. [THIRD-PARTY https://github.com/NexaDuo/mARC/pull/363 — "SessionStart exists (once per conversation). PreInvocation fires before every model call." (via fetch summary)]
- The official changelog never announces it. So the first version that supports it is unknown. It is in today's docs and in the Oct 29, 2026 marketplace post. [OPENED https://antigravity.google/blog/plugin-marketplace-in-antigravity — "including SessionStart, PreToolUse, PostToolUse, PreInvocation, PostInvocation, and Stop"]

### Third-party field reports (none verified by me)

- Stdout must be one JSON object, as the docs say. In practice plain text is rejected and nothing reaches the model. [THIRD-PARTY https://github.com/NexaDuo/mARC/pull/363 — "stdout must be a JSON object (protojson)." (via fetch summary)]
- `SessionStart` did not fire on a resumed conversation in one test on agy 1.4.7. [THIRD-PARTY https://github.com/vamsiramakrishnan/branchyard/pull/26 — "only PreInvocation ran, and it printed nothing." (via fetch summary)]
- A bug: any `metadata` on an injected `systemMessage` crashes the hook and drops all its output. Reported on agy 1.4.12, still present on 1.5.2 on Nov 6, 2026. The official page's own example includes `metadata`. [THIRD-PARTY https://discuss.ai.google.dev/t/a-hooks-systemmessage-metadata-user-markdown-as-documented-panics-and-the-hooks-whole-output-is-dropped/197747 — "The model still replies NONE: the hook's whole output is dropped."]
- The plain shape works for that reporter: one `systemMessage` step with no `metadata`. [THIRD-PARTY https://discuss.ai.google.dev/t/a-hooks-systemmessage-metadata-user-markdown-as-documented-panics-and-the-hooks-whole-output-is-dropped/197747 — "The same hook without metadata works: the model quotes CANARY-TWO."]
- An environment variable `ANTIGRAVITY_CONVERSATION_ID` is reported as set for hooks. [THIRD-PARTY https://github.com/joaquinbejar/ai-crew-sync/pull/235 — "Antigravity exports it to every hook; verified" (via fetch summary)]
- A plugin cannot set the CLI status line. [THIRD-PARTY https://github.com/vamsiramakrishnan/branchyard/pull/26 — "an Antigravity plugin cannot set the status line." (via fetch summary)]

### OS differences

- The official hooks page does not say which shell runs a hook. Not stated.
- The only official statement about how the CLI launches a user command is for the status line. [OPENED https://antigravity.google/docs/cli/statusline — "the CLI runs your command with sh -c (cmd /c on Windows)"]
- One author who tested both systems reports the same for hooks: `sh -c` on Unix and `cmd /c` on Windows, with inner double quotes that break under `cmd`. [THIRD-PARTY https://github.com/NexaDuo/mARC/pull/363 — "I installed a throwaway plugin into agy 1.3.5 (Windows) and 1.3.2 (Linux)" (via fetch summary; the shell detail is from the same pull request)]
- The same author reports that a `bash` hook fails on Windows when `bash` is not on `PATH`, and that the turn carries on. [THIRD-PARTY https://github.com/NexaDuo/mARC/pull/363 — "hooks fail and agy logs the error, without blocking the turn." (via fetch summary)]
- A second test agrees on `sh -c`. It does not name its operating system. [THIRD-PARTY https://github.com/vamsiramakrishnan/branchyard/pull/26 — "run via sh -c in the hooks.json directory, need no trust." (via fetch summary)]
- Google's own advice for portable plugin code is Node. [OPENED https://antigravity.google/docs/build-plugins — "Prefer remote HTTPS MCP endpoints or cross-platform Node.js scripts"]

### Remote agents

- Local hooks, skills and plugins are not available to Remote Agents. See section 4.

---

## 7. Plugins and the marketplace

**Evidence grade: strong on format and install. The marketplace is eleven days old.**

### Is there a plugin format?

- Yes. [OPENED https://antigravity.google/docs/features — "Plugins are namespaced bundles that can contain skills, agents, rules, MCP servers, and hooks as a single deployable unit."]
- It works on App, CLI and IDE. [OPENED https://antigravity.google/docs/plugins — "Available on: Antigravity App, Antigravity CLI, Antigravity IDE"]

### Layout

```text
<plugin-root>/
├── plugin.json            # or .antigravity-plugin/plugin.json
├── README.md
├── assets/logo.svg
├── scripts/
├── bin/                   # command-line tools the agent can run by name (changelog only)
├── mcp_config.json
├── hooks.json
├── skills/<skill-name>/SKILL.md
├── agents/<agent-name>.md
├── rules/AGENTS.md  and  rules/<rule>.md
└── sidecars/<name>/sidecar.json   # App only; see section 9
```

- Manifest location. [OPENED https://antigravity.google/docs/plugins — "A plugin is a self-contained directory defined by a plugin.json manifest (or .antigravity-plugin/plugin.json)"]
- The dot-folder form is meant for multi-harness repositories. [OPENED https://antigravity.google/docs/build-plugins — "for multi-provider repositories that also ship .claude-plugin/plugin.json or .cursor-plugin/plugin.json"]
- It wins if both exist. [OPENED https://antigravity.google/docs/build-plugins — ".antigravity-plugin/plugin.json takes precedence over root plugin.json"]
- A third manifest folder name is also accepted. [OPENED https://antigravity.google/docs/customization-discovery — "each plugin has a plugin.json file in its folder or in its .antigravity-plugin/ or .gemini-plugin/ subfolder"]
- Component folders always stay at the plugin root, even when the manifest is in the dot-folder. [OPENED https://antigravity.google/docs/build-plugins — "Keep component directories"]
- `bin/` is mentioned only in the changelog. [OPENED https://antigravity.google/docs/changelog — "ship command-line tools in a bin/ folder that the agent can run by name"]
- Plugins can add views to the App side panel. No authoring docs found. [OPENED https://antigravity.google/blog/antigravity-for-knowledge-work — "keeping Extensions when UI plugins or MCP Apps are active"]

### Manifest fields

`name` is the only field the schema requires. The marketplace also wants `displayName`, `description`, `version`, `logo` and `author`. Optional: `suggestedPrompts` (three at most), `skills` (extra skill folders), `disabled`, `homepage`, `repository`, `license`, `keywords`, `extensions`.

- Starter prompts. [OPENED https://antigravity.google/docs/build-plugins — "Up to 3 actionable starter prompts displayed as clickable chips on the plugin detail page."]
- Unknown keys are ignored, not fatal. [OPENED https://antigravity.google/schemas/v1/plugin.json — "Antigravity ignores keys it doesn't recognize, and agy plugin validate reports them."]
- A known key with the wrong type is fatal. [OPENED https://antigravity.google/schemas/v1/plugin.json — "A recognized key with the wrong type stops the plugin from loading."]
- The docs and the live schema disagree on names. The docs demand lowercase kebab-case. The live schema also allows capitals and underscores. Stay with kebab-case; it satisfies both. [OPENED https://antigravity.google/docs/build-plugins — "The unique, machine-readable lowercase kebab-case identifier of the plugin"] [OPENED https://antigravity.google/schemas/v1/plugin.json — "Machine name of the plugin: letters, digits, hyphens, and underscores."]
- Do not start `name` or `displayName` with "Antigravity", "Gemini", "Claude" or "Cursor". [OPENED https://antigravity.google/docs/build-plugins — "and do not prefix with "Antigravity", "Gemini", "Claude", or "Cursor"."]

### What a plugin can ship

| Component | Path | Note |
|---|---|---|
| Skills | `skills/<name>/SKILL.md` | Also become `/<name>` commands |
| Subagents and custom agents | `agents/<name>.md` | Can be the main agent or a delegate |
| Rules | `rules/AGENTS.md`, `rules/<rule>.md` | All four triggers |
| Hooks | `hooks.json` | All six events |
| MCP servers | `mcp_config.json` | Namespaced `<plugin>_<server>` |
| Sidecars | `sidecars/<name>/sidecar.json` | App only; user must enable |
| Tools on PATH | `bin/` | Changelog only |
| Slash commands | none | Use skills. `commands/` is not loaded |
| Status line | none | Third-party report |

### Path variables

- The installed plugin folder is read-only and replaced on update. [OPENED https://antigravity.google/docs/build-plugins — "Installed plugins are unpacked into a read-only plugin directory (\~/.gemini/config/plugins/\<plugin-name>) that is replaced when the plugin updates."]
- `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in MCP server `args`, `cwd` and `env`. They are also exported to MCP server processes. [OPENED https://antigravity.google/docs/build-plugins — "Antigravity automatically sets the PLUGIN_ROOT and PLUGIN_DATA environment variables for every plugin MCP server process"]
- In `hooks.json` do not use them. Use relative paths. [OPENED https://antigravity.google/docs/build-plugins — "uses relative script paths (./scripts/...) rather than ${PLUGIN_ROOT}"]
- In `SKILL.md`, refer to bundled files by paths relative to the skill folder. [OPENED https://antigravity.google/docs/build-plugins — "Reference helper scripts and docs bundled within that same skill folder using paths relative to the skill directory"]

### Install

- Three sources. [OPENED https://antigravity.google/docs/plugins — "Install from the official marketplace (antigravity-plugins-official, requires an active agy sign-in session), a GitHub repository URL, or a local directory"]
- Commands: `agy plugin install <name>`, `agy plugin install https://github.com/<owner>/<repo>`, `agy plugin install ./path`. Also `list`, `enable`, `disable`, `uninstall`, `validate`, `import`. [OPENED https://antigravity.google/docs/plugins — "the Antigravity CLI exposes the agy plugin subcommand pipeline to install, inspect, validate, and manage plugins from your shell"]
- Or drop a folder in place. Project scope. [OPENED https://antigravity.google/docs/plugins — "Workspace level: Place your plugin folder in .agents/plugins/ at the root of your workspace."]
- User scope. [OPENED https://antigravity.google/docs/plugins — "Global level: Place your plugin folder in ~/.gemini/config/plugins/."]
- App and CLI share installs. [OPENED https://antigravity.google/docs/plugins — "Plugins installed in the Antigravity App are automatically updated and shown in the Antigravity CLI's Installed tab."]
- A plugin that declares MCP credential variables installs switched off until the user fills them in. [OPENED https://antigravity.google/docs/build-plugins — "installing it via agy plugin install leaves the plugin in a disabled state"]
- Validate before shipping. [OPENED https://antigravity.google/docs/plugins — "--strict treats warnings as errors"]

### Importing from Claude Code

- There is a converter. [OPENED https://antigravity.google/docs/plugins — "Migrate existing extensions from ~/.gemini/extensions/ or ~/.claude/plugins/"]
- It rewrites the Claude root variable at import time. [OPENED https://antigravity.google/docs/changelog — "expand ${CLAUDE_PLUGIN_ROOT} to the installed plugin's directory"]
- It is a one-time copy, not live compatibility. A repository installed directly with `agy plugin install` is not converted. If it has no Antigravity manifest, agy falls back to treating it as a Gemini extension and then rejects Claude-format hooks. [THIRD-PARTY https://raw.githubusercontent.com/obra/superpowers/main/RELEASE-NOTES.md — "Previously, agy fell back to importing the repo as a Gemini CLI extension, then rejected the copied Claude-format hooks file on every session"]

### Marketplace

- Launched October 29, 2026. [OPENED https://antigravity.google/blog/plugin-marketplace-in-antigravity — "Today, we are launching the Plugin Marketplace in Antigravity, a centralized directory for discovering and installing third-party and Google-built plugins"]
- One marketplace only. [OPENED https://antigravity.google/docs/plugins — "\<marketplace-name> only supports antigravity-plugins-official"]
- Listing is by application, through a form. [OPENED https://antigravity.google/blog/plugin-marketplace-in-antigravity — "validate your plugin bundle and submit your details through the partner interest form"]
- No self-serve third-party marketplace was found. A GitHub URL install is the open route.
- Enterprise terms do not cover marketplace content. [OPENED https://antigravity.google/terms — "Enterprise or other signed or accepted terms do not apply to the use of the Antigravity Marketplace within the Service."]
- Browsing: App sidebar > Customizations > Marketplace. CLI: `/plugin`. [OPENED https://antigravity.google/docs/features — "Plugins that you install in the App also appear in the CLI."]

### A first-party cross-harness example

Google publishes one plugin folder that installs on Antigravity, Claude Code and Codex. It is the closest thing to a reference layout for the reader's goal.

- It lives at `plugins/cloud/google-cloud-developer` in `github.com/google/skills`. One root `plugin.json`, plus `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `gemini-extension.json`, `mcp.json`, `.mcp.json`, `mcp_config.json`, `rules/`, `skills/`, and a `com.google.antigravity/` folder. [OPENED https://raw.githubusercontent.com/google/skills/main/plugins/cloud/google-cloud-developer/plugin.json — "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"]
- Each of those files answered when I fetched it, and so did one skill and the rule file. In this sample `.antigravity-plugin/` holds an Antigravity-specific README, and the root `plugin.json` is the manifest. The `com.google.antigravity/` folder holds a small `mcp_config.json` overlay.
- Its README gives the three install commands. [OPENED https://raw.githubusercontent.com/google/skills/main/plugins/cloud/google-cloud-developer/README.md — "agy plugin install google-cloud-developer"]
- For Claude Code and Codex the same repository acts as a marketplace. [OPENED https://raw.githubusercontent.com/google/skills/main/plugins/cloud/google-cloud-developer/README.md — "claude plugin marketplace add google/skills"]
- It ships no hooks. Installing it reports none. [OPENED https://codelabs.developers.google.com/agent-harness-developer-plugin — "hooks : skipped (not found)"]
- A Google codelab explains the split: skills and MCP are portable, everything else is per agent. [OPENED https://codelabs.developers.google.com/agent-harness-developer-plugin — "Anything else, for example hooks or commands, is specific to one agent. The standard keeps those outside the portable core."]
- That codelab points to an open "Agent Plugins" specification. It defines `plugin.json`, `skills/`, `mcp.json` and the same two variables. [THIRD-PARTY https://agent-plugins.org/specification — "Clients that launch plugin subprocesses (i.e., stdio MCP servers) MUST provide PLUGIN_ROOT and PLUGIN_DATA in each subprocess environment."]
- That specification's list of compatible clients names eleven products. Antigravity and Claude Code are not on it. Codex is. [THIRD-PARTY https://agent-plugins.org/compatible-clients — "Explore clients that support the portable Agent Plugins format and the components each client can load."]

### OS differences

- Scripts shipped in `scripts/` keep their executable bit only through marketplace bundles. [OPENED https://antigravity.google/docs/build-plugins — "helper executables are placed under scripts/ so they retain 0755 permissions in Marketplace bundles"]
- Manifests with a UTF-8 byte-order mark load (a Windows fix). [OPENED https://antigravity.google/docs/changelog — "Plugin manifests, mcp_config.json, and hooks.json files saved with a UTF-8 byte-order mark now load"]
- On Windows, a running MCP server used to block plugin updates. Fixed in CLI 1.3.1. [OPENED https://antigravity.google/docs/changelog — "Fixed installing, reinstalling, and uninstalling plugins with /plugin on Windows failing while one of the plugin's MCP servers was running"]

---

## 8. Subagents and agent management

**Evidence grade: strong.**

### Subagents

- The main agent starts them with a tool call. Many can run at once. [OPENED https://antigravity.google/docs/subagents — "The parent agent calls the invoke_subagent tool to spawn a new concurrent session with a dedicated role and initial prompt"]
- Each starts with an empty context. [OPENED https://antigravity.google/docs/subagents — "does not inherit the parent's existing conversation history (context window), starting with a clean slate"]
- Three workspace choices. [OPENED https://antigravity.google/docs/subagents — "inherit the same workspace as its parent (inherit), create an isolated Git worktree (branch), or share directory storage (share)"]
- Three built in: `research`, `browser`, `self`. [OPENED https://antigravity.google/docs/subagents — "A direct clone of the calling agent, sharing identical system instructions and toolsets."]
- The agent can also define one on the fly. [OPENED https://antigravity.google/docs/subagents — "create transient subagents during a session using the define_subagent tool"]
- They run in the background. A finished one goes idle and wakes when messaged. [OPENED https://antigravity.google/docs/subagents — "An idle agent automatically re-awakens to the Running state upon receiving a message from another agent."]
- Agents can read each other's transcripts. [OPENED https://antigravity.google/docs/subagents — "Agents can read each other's conversation transcripts to audit multi-step workflows."]
- Depth cap. [OPENED https://antigravity.google/docs/subagents — "A maximum nesting depth of 10 levels"]
- They inherit the parent's permissions. [OPENED https://antigravity.google/docs/subagents — "Subagents automatically inherit the parent's allowed terminal command prefixes, file read/write directory scopes, and sandbox settings."]
- A subagent's approval request surfaces to the user. [OPENED https://antigravity.google/docs/subagents — "the request automatically bubbles up to the main UI or subagent panel"]

### Custom agents (a plugin can ship these)

- Files: `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md`; global `~/.gemini/config/agents/`; plugin `agents/`. [OPENED https://antigravity.google/docs/subagents — "You can define reusable custom subagents in Markdown format (.md) with YAML frontmatter"]
- Frontmatter: `name`, `description`, `tools`, `mainAgent`, `subagent`, `model` (`inherit`, `flash_lite`, `flash`, `pro`), `commandExecutionPolicy` (`off`, `auto`, `eager`, `sandbox`), `skills`, `mcpServers`, `inheritMcp`, `inheritCustomizations`, `hooks`. [OPENED https://antigravity.google/docs/build-plugins — "Controls whether the agent inherits workspace MCP servers (inheritMcp) and skills, rules, and hooks (inheritCustomizations)."]
- `mainAgent: true` lets the user pick it as the session's main agent, or run `agy --agent <name>`. [OPENED https://antigravity.google/docs/plugins — "you can select the plugin's custom agent as your primary session agent"]
- A known hang. [OPENED https://antigravity.google/docs/subagents — "Specifying an unmapped or misspelled tool name in the tools list may cause the subagent process to hang during execution."]

### Browser subagent

- It is on demand only, via `/browser`. [OPENED https://antigravity.google/docs/commands/browser — "On demand only: the browser subagent is hidden from the agent's normal subagent list."]
- It drives the user's own Chrome through Chrome DevTools MCP. It no longer uses a separate profile. [OPENED https://antigravity.google/docs/ide/separate-chrome-profile — "Because the subagent works in your own Chrome, it uses the same cookies and sign-ins as your normal browsing."]
- Chrome 144 or later must already be running with remote debugging on. [OPENED https://antigravity.google/docs/commands/browser — "The subagent attaches to Google Chrome (version 144 or later) that's already running on your computer."]

### Multi-agent commands

- `/boost` and `/teamwork` are paid features. [OPENED https://antigravity.google/docs/features — "Some commands are available on only one surface, and /boost and /teamwork require a paid plan."]
- `/goal`, `/plan`, `/schedule` and `/learn` are on all plans. See section 9. [OPENED https://antigravity.google/docs/slash-commands — "Autonomous execution until the goal is achieved without intermediate pauses."]

### Artifacts

- What they are. [OPENED https://antigravity.google/docs/artifacts — "Artifacts include rich Markdown plans (implementation plans), code diffs, architecture diagrams, images, and browser recordings."]
- Implementation plan: written before changes, waits for review. [OPENED https://antigravity.google/docs/implementation-plan — "The agent requests your review on the implementation plan before making the changes needed to complete your task"]
- Walkthrough: written after. [OPENED https://antigravity.google/docs/walkthrough — "The agent creates walkthrough artifacts when it completes task implementation."]
- Task list: named in the 2025 launch post. Today's docs have no task-list page, only an IDE "Task groups" page. [OPENED https://antigravity.google/blog/introducing-google-antigravity — "such as task lists, implementation plans, walkthroughs, screenshots, and browser recordings"]
- Review policy: `asks-for-review` by default in the CLI; "Always Ask" or "Always Proceed" in the App. [OPENED https://antigravity.google/docs/settings — "Controls whether the agent stops for your review when it asks for feedback on an artifact"]
- Hooks are told where a conversation's artifacts are. [OPENED https://antigravity.google/docs/hooks — "The absolute path to the directory containing all conversation artifacts and screenshots."]

### Projects (the "Agent Manager" idea today)

- Conversations are grouped by project. A project can span folders and has its own settings and permissions. [OPENED https://antigravity.google/docs/projects — "A project is a configuration of folders defining the environment and the scope of your agent."]
- The App supports Git worktrees per conversation. [OPENED https://antigravity.google/docs/projects — "Creates a new Git worktree for the conversation."]
- The CLI has a `/agents` panel it calls the Agent Manager. [OPENED https://antigravity.google/docs/cli/commands/agents — "The /agents command opens the interactive Agent Manager panel."]

### Inbox and notifications

- The "Inbox" is from the 2025 IDE. I found it only in the launch post. [OPENED https://antigravity.google/blog/introducing-google-antigravity — "using the Inbox and side panel in the Agent Manager to be notified of progress"]
- Today: the App has a Notifications settings page with sounds. [OPENED https://antigravity.google/docs/changelog — "You can now manage notification preferences, toggle completion sounds, and adjust agent sound volume from the new Notifications page in Settings."]
- The CLI can ring the bell and raise a desktop notification. Off by default. [OPENED https://antigravity.google/docs/settings — "rings the terminal bell and shows a desktop notification when the agent needs your approval or an answer, or finishes its turn"]
- Remote Control sends browser push notifications. [OPENED https://antigravity.google/docs/features — "Receive browser push notifications when tasks complete or when your input is needed."]
- No hook event fires on a notification. No API for a plugin to raise one was found.

---

## 9. Proactive, scheduled and unattended work

**Evidence grade: strong on what exists. Not run.**

| Route | Scope | Survives restart? | Surfaces | A plugin can ship it? |
|---|---|---|---|---|
| `/schedule` (the `schedule` tool) | One conversation | No | App, CLI, IDE | A skill can ask the agent to call it |
| Automations | Fresh conversation per run | Yes | App | No documented file format other than sidecars |
| Sidecars | Background process or cron job | Yes | App | Yes, but the user must enable it |
| `/goal` | One request | No | App, CLI, IDE | A skill can ask for it |
| `Stop` hook returning continue | One turn | No | all | Yes |
| Headless `agy -p` + OS scheduler | Yours | Yours | CLI | Outside the plugin |
| Remote Agents | Cloud | Yes | App, CLI, web | No. Local plugins do not reach them |

### `/schedule`

- What it does. [OPENED https://antigravity.google/docs/commands/schedule — "Set a one-time timer or a recurring cron schedule that wakes the agent with an instruction, without blocking the conversation while it waits."]
- It is tied to its conversation. [OPENED https://antigravity.google/docs/commands/schedule — "timers and schedules belong to the conversation that created them"]
- Parameters: `DurationSeconds`, `CronExpression` (five fields), `Prompt`, `MaxIterations`, `TimerCondition`, `IsDaemon`. [OPENED https://antigravity.google/docs/commands/schedule — "When true, the schedule keeps firing after the agent's current task is done."]
- Cron fires are jittered. [OPENED https://antigravity.google/docs/changelog — "fire at a consistent per-schedule offset instead of exactly on the cron boundary"]

### Automations (were "Scheduled Tasks" until October 7, 2026)

- What they are. [OPENED https://antigravity.google/docs/features — "Automations (previously called scheduled tasks) let you plan ahead with your projects by sending messages to your agents on a schedule, even while you're away."]
- The rename. [OPENED https://antigravity.google/docs/changelog — "Scheduled Tasks are now called Automations."]
- Each run is a new conversation. [OPENED https://antigravity.google/docs/commands/schedule — "Starts a fresh agent conversation on each run"]
- Timing is approximate. [OPENED https://antigravity.google/docs/features — "Antigravity spreads them out by up to 10% of the interval, and by no more than 15 minutes."]
- App only. The page lists Scheduled, Always on and Paused. [OPENED https://antigravity.google/docs/changelog — "The Automations page now organizes automations into Scheduled, Always on, and Paused lists"]
- The machine must be on. The docs do not say what happens to a missed run. Not stated.

### Sidecars

- What they are. [OPENED https://antigravity.google/docs/sidecars — "Sidecars are background processes that run alongside Antigravity."]
- Antigravity supervises them. [OPENED https://antigravity.google/docs/sidecars — "Antigravity manages the lifecycle of sidecars, automatically launching them and restarting them if they crash or error."]
- Where: `~/.gemini/config/sidecars/<id>/sidecar.json`, or inside a plugin. [OPENED https://antigravity.google/docs/sidecars — "Plugin sidecars: Under ~/.gemini/config/plugins/\<pluginName>/sidecars/"]
- Off until the user turns each one on. [OPENED https://antigravity.google/docs/sidecars — "Sidecars are disabled unless you explicitly enable them in the global configuration file at ~/.gemini/config/config.json"]
- A built-in scheduler. [OPENED https://antigravity.google/docs/sidecars — "schedule is a built-in scheduler for running recurring commands"]
- A sidecar can start or message a conversation through a bundled `agentapi` command. [OPENED https://antigravity.google/docs/sidecars — "agentapi new-conversation \<prompt>: Creates a new conversation."]
- Starting conversations needs a project. [OPENED https://antigravity.google/docs/sidecars — "Sidecars creating conversations must have a projectId set."]
- A persistent data folder per sidecar. [OPENED https://antigravity.google/docs/sidecars — "Runtime data produced by sidecars is stored in ~/.gemini/antigravity/sidecar_data/\<sidecarId>/."]
- App only on the docs page. [OPENED https://antigravity.google/docs/sidecars — "Available on: Antigravity App"]
- The CLI changelog shows plugin sidecars also run in CLI sessions. The docs page does not cover this. [OPENED https://antigravity.google/docs/changelog — "Fixed a memory leak in long sessions with plugins that run sidecars"]

### `/goal`

- It keeps the agent working until done. [OPENED https://antigravity.google/docs/commands/goal — "Runs until done or cancelled: there's no iteration cap."]
- It is itself a stop hook. [OPENED https://antigravity.google/docs/commands/goal — "a goal stop hook checks whether the goal is still active"]
- One at a time. [OPENED https://antigravity.google/docs/commands/goal — "Only one goal is active at a time in a conversation."]
- It does not loosen permissions. [OPENED https://antigravity.google/docs/commands/goal — "Goal mode changes only the agent's stopping behavior."]

### Always-on CLI

- `agy remote-control start` installs a background service. It is for remote driving from a browser, not for scheduling. [OPENED https://antigravity.google/docs/remote-control — "The daemon registers as an OS service (a systemd user service on Linux, a LaunchAgent on macOS, or a Scheduled Task on Windows)"]

| Behaviour | Linux | macOS | Windows |
|---|---|---|---|
| Starts | At boot | At login | At boot with an Administrator install; else at login |
| Runs after sign-out | Yes | No | Yes with a boot install |

[OPENED https://antigravity.google/docs/remote-control — "Registering the daemon to start at boot requires an Administrator prompt."]

### Headless runs under your own scheduler

- Works, with caveats. With no one there to approve, a blocked tool is skipped and the run still exits 0. [OPENED https://antigravity.google/docs/cli/headless — "Any tool action that requires approval it can't obtain in headless mode is soft-denied: the run continues, exits 0"]
- That is a silent-success trap (my inference). Check stderr, or pre-grant with `permissions.allow`. [OPENED https://antigravity.google/docs/cli/headless — "prints a notice to stderr naming the tool and how to allow it"]
- Headless runs now wait for background tasks. [OPENED https://antigravity.google/docs/changelog — "Changed headless -p runs without --print-timeout to wait for background tasks to finish"]

### Remote Agents

- Keep running with the laptop shut. Paid personal plans only. [OPENED https://antigravity.google/docs/remote-agents — "It isn't available on the free plan, on Google AI Plus, or for business accounts (Google Workspace or Google Cloud)."]
- They default to no approval prompts at all. [OPENED https://antigravity.google/docs/remote-agents — "Unless you change it, the permission preset is always-proceed (turbo), so remote agents run commands without asking for approval."]

### SDK

- Timed triggers in code. [OPENED https://antigravity.google/docs/sdk/lifecycle — "Triggers allow you to run tasks automatically based on specific schedules or events."]

### Terms limit on bridging

- The terms themselves. [OPENED https://antigravity.google/terms — "Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement."]
- A forum answer on wiring sidecars or the CLI to another vendor's agent. The responder's forum title is "Regular", not "Google", so treat it as unofficial. [THIRD-PARTY https://discuss.ai.google.dev/t/supported-automation-into-an-existing-antigravity-conversation-on-a-consumer-plan/188220 — "There is no supported automated integration for third-party coding agents to inject prompts into an existing consumer-plan Antigravity conversation."]
- The official FAQ says the same of headless mode. [OPENED https://antigravity.google/docs/faq — "Wrapping agy inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."]

---

## 10. MCP

**Evidence grade: strong on the current path. Older sources name two other paths.**

### Config files

- Global. [OPENED https://antigravity.google/docs/mcp — "Global configuration: ~/.gemini/config/mcp_config.json, which applies to all your projects."]
- Workspace. [OPENED https://antigravity.google/docs/mcp — "Workspace configuration: \<workspace>/.agents/mcp_config.json, which applies only to that workspace."]
- Plugin: `<plugin-root>/mcp_config.json`. [OPENED https://antigravity.google/docs/mcp — "defined in a plugin's \<plugin-root>/mcp_config.json file"]
- Conflicting paths in other sources. A Google codelab from June 2026 says `~/.gemini/antigravity-cli/mcp_config.json`. A November 2025 security report says `~/.gemini/antigravity/mcp_config.json`. Both are older layouts. **`~/.gemini/config/mcp_config.json` is better supported**: the docs, Google's Developer Knowledge page (Oct 26, 2026) and a third-party check on agy 1.4.12 agree. [OPENED https://codelabs.developers.google.com/genai-for-dev-antigravity-cli — "Global server setups: Configured in ~/.gemini/antigravity-cli/mcp_config.json."] [OPENED https://developers.google.com/knowledge/mcp — "or globally in ~/.gemini/config/mcp_config.json"] [THIRD-PARTY https://mindgard.ai/blog/google-antigravity-persistent-code-execution-vulnerability — "the Model Context Protocol (MCP) configuration file located in ~/.gemini/antigravity/mcp_config.json"] [THIRD-PARTY https://www.gradually.ai/en/antigravity-cli-commands/ — "The global configuration is ~/.gemini/config/mcp_config.json; the workspace configuration is .agents/mcp_config.json."]

### Format

Root key `mcpServers`. Per server: `command` + `args` + `env` + `cwd` for stdio, or `serverUrl` (also `url`) + `headers` for remote. Extras: `authProviderType`, `oauth`, `disabled`, `enabledTools`, `disabledTools`, `tools.<name>.eager`, `tools.<name>.background`, `timeoutSeconds`. [OPENED https://antigravity.google/docs/mcp — "Each server entry under mcpServers must specify one transport property"]

- Transports. [OPENED https://antigravity.google/docs/mcp — "Remote MCP servers must use the Streamable HTTP transport."]
- Old SSE is out. [OPENED https://antigravity.google/docs/mcp — "The legacy HTTP+SSE transport and the httpUrl field aren't supported."]
- Two files using one server name: the first to start keeps it. [OPENED https://antigravity.google/docs/settings — "when two files use the same name, the server that is already running keeps it"]
- Plugin servers are renamed. [OPENED https://antigravity.google/docs/build-plugins — "each server key \<server-key> is namespaced with the plugin name as \<plugin-name>_\<server-key>"]

### Limits

- Timeouts. [OPENED https://antigravity.google/docs/mcp — "up to 5 minutes for an MCP server to connect and list its tools, and up to 3 minutes for each tool call"]
- Tool count: no number is documented. A limit exists and was raised in August 2026. [OPENED https://antigravity.google/docs/changelog — "raising the per-session limit on tool declarations"]
- Context cost is handled by lazy loading, not by a cap. [OPENED https://antigravity.google/docs/mcp — "By default, all enabled MCP tools are lazy-loaded"]
- Lazy means the schema sits in a file and the agent reads it when needed. [OPENED https://antigravity.google/docs/mcp — "Antigravity writes each tool's JSON schema (name, description, and parameters) to \<app-data-dir>/mcp/\<serverName>/\<toolName>.json"]
- Then it calls through one generic tool. [OPENED https://antigravity.google/docs/mcp — "invokes the tool through the built-in call_mcp_tool tool"]
- Mark a tool `eager` to register it directly as `mcp_<serverName>_<toolName>`. [OPENED https://antigravity.google/docs/mcp — "registers its full description and parameter schema upfront in the model's native tool declarations"]
- Inline output of an on-demand MCP tool is capped at 10 KB. [OPENED https://antigravity.google/docs/changelog — "increases on-demand MCP tool inline output limits to 10 KB"]

### Permissions

- Every MCP tool asks first unless allowed. [OPENED https://antigravity.google/docs/mcp — "By default, unconfigured MCP tools run in Ask mode, requiring your approval before execution."]
- Allow with `mcp(server/tool)`, `mcp(server/*)` or `mcp(*)`. [OPENED https://antigravity.google/docs/mcp — "Global wildcard matching any MCP tool across all connected servers."]
- For Gemini Enterprise, MCP is off until an administrator allows servers. [OPENED https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-settings — "Administrators define the allowlist as a JSON object with configurations for local and remote MCP servers."]

### MCP Store

- There is one. The docs page lists 77 servers (my sum of its five category counts). [OPENED https://antigravity.google/docs/mcp — "The MCP Store features direct integrations for a wide variety of developer platforms, databases, and productivity services"]
- App: Customizations > Installed > MCP Servers > Add. [OPENED https://antigravity.google/docs/mcp — "This opens a searchable list of available MCP servers."]
- CLI: `/mcp`. [OPENED https://antigravity.google/docs/mcp — "Type /mcp inside the prompt panel and press Enter to open the interactive MCP Manager Overlay."]
- A server can mark a tool as always loaded. [OPENED https://antigravity.google/docs/changelog — "Added support for MCP servers to mark a tool as always loaded"]

### Auth

- OAuth is automatic for servers that support CIMD or dynamic registration. Tokens are stored locally. [OPENED https://antigravity.google/docs/mcp — "Access tokens are stored in ~/.gemini/antigravity/mcp_oauth_tokens.json."]

### OS differences

- None stated for MCP config. For stdio servers Google recommends Node so one command works everywhere. See section 6.

---

## 11. Context management and transcripts

**Evidence grade: strong on path and on the fact of compaction. The transcript schema comes only from third parties.**

### Compaction

- It is automatic. [OPENED https://antigravity.google/docs/cli/commands/context — "Antigravity automatically compacts older turns into checkpoint summaries so your session can continue without hitting the model's token limit"]
- It can be asked for. App 2.24.0 and CLI 1.3.5, both mid-October 2026. [OPENED https://antigravity.google/docs/changelog — "You can now type /compact to summarize a long conversation so far and free up room for the agent to keep working."]
- What the summary carries forward. [OPENED https://antigravity.google/docs/changelog — "such as your earlier requests and artifact, subagent, and running-task snapshots"]
- Attachments are kept. [OPENED https://antigravity.google/docs/changelog — "to keep images, PDFs, and other files you attached in the conversation summary"]
- `/context` in the CLI shows usage by category and the checkpoints. [OPENED https://antigravity.google/docs/cli/commands/context — "displays the active in-context checkpoint along with a count of historical checkpoints that have already been summarized"]
- **No hook fires on compaction** in `hooks.json`. Only the Python SDK has one. [OPENED https://antigravity.google/docs/changelog — "adds an on_compaction lifecycle hook for observing context checkpointing"]
- Always-on rules are injected every turn, so they outlast compaction. Inference from section 2.
- A `PreInvocation` hook fires before every model call, so it can re-inject after compaction. It cannot tell that compaction happened. Inference.

### Where conversations are stored

- The transcript path is documented. [OPENED https://antigravity.google/docs/hooks — "This file lives in \<app_data_dir>/brain/\<conversationId>/.system_generated/logs/transcript.jsonl"]

| Surface | `<app_data_dir>` |
|---|---|
| App | `~/.gemini/antigravity` |
| CLI | `~/.gemini/antigravity-cli` |
| IDE | `~/.gemini/antigravity-ide` |

[OPENED https://antigravity.google/docs/hooks — "For Antigravity CLI, \<app_data_dir> in hook payloads resolves to ~/.gemini/antigravity-cli."]

- On Windows the tree is under the user profile. [OPENED https://antigravity.google/docs/remote-control — "%USERPROFILE%\\.gemini\config\config.json on Windows"]
- Artifacts sit in the same `brain/<conversationId>` folder, as Markdown files. The official example payload shows `artifactDirectoryPath` as that folder. A third-party guide names the files. [THIRD-PARTY https://jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html — "The files you find there are named for what they are: task.md, implementation_plan.md, walkthrough.md, proposal.md"]
- The CLI keeps a small map from folder to last conversation. [OPENED https://antigravity.google/docs/cli/commands/resume — "A JSON map associating absolute workspace directory paths with their most recently active conversation ID"]
- CLI conversations are scoped to the folder you start in. [OPENED https://antigravity.google/docs/cli/conversations — "Antigravity CLI scopes conversation histories directly to your current working directory"]
- Remote Agent conversations are not on the machine. [OPENED https://antigravity.google/docs/remote-agents — "Remote agent conversations are stored with your remote projects rather than on your machine."]

### Can a script read a transcript?

- Yes, in principle. It is a JSONL file, and both hooks and the CLI status-line script are given its path. [OPENED https://antigravity.google/docs/cli/statusline — "Path where the conversation transcript is written (the file may not exist yet)."]
- Subagent transcripts stay on disk too. [OPENED https://antigravity.google/docs/subagents — "Historical conversation transcripts remain readable in JSONL logs."]
- The file can be rewritten during compaction. Do not hold byte offsets into it. [OPENED https://antigravity.google/docs/changelog — "Fixed transcript corruption caused by background messages appending while context compaction was rewriting the log."]
- Google does not document the record format.
- Third-party description, checked against Antigravity 1.1.14: one step per line, with keys `step_index`, `source`, `type`, `status`, `created_at`, `content`, `tool_calls`, `thinking`, `truncated_fields`. [THIRD-PARTY https://jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html — "Each line of transcript.jsonl is one step, not one message"]
- Long tool output is clipped in that file. A sibling `transcript_full.jsonl` holds the whole text. [THIRD-PARTY https://jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html — "Antigravity clips long tool output before writing transcript.jsonl and names the clipped field in truncated_fields."]
- The transcript records no working directory and no version. [THIRD-PARTY https://jazzyalex.github.io/agent-sessions/guides/antigravity-cli-local-history.html — "There is no version stamp"]
- Older IDE builds stored conversations as `.pb` files under `~/.gemini/antigravity/conversations/`. [THIRD-PARTY https://discuss.ai.google.dev/t/bug-conversation-history-not-persisted-brain-directories-empty-no-knowledge-items-generated/128466 — "While conversation .pb files are correctly saved to ~/.gemini/antigravity/conversations/"]

### Reading it from inside the sandbox

- A sandboxed command sees the project, temp folders and build caches by default. The app data folder is not on that list. A script the agent runs may need a `read_file(...)` grant to open a transcript. [OPENED https://antigravity.google/docs/sandbox — "anything not explicitly mounted is invisible inside the sandbox"]
- Whether hook commands themselves run inside the sandbox is not stated.

### Other context tools

- `/btw` asks a side question without adding to history. `/rewind` and `/fork` roll back or branch. `/clear` starts fresh. All CLI. [OPENED https://antigravity.google/docs/cli/commands/context — "run /clear (alias /new) when switching to a new task that doesn't require prior conversation context"]

---

## 12. Security

**Evidence grade: strong on controls (official). Incidents are third-party reports, each cited.**

### Approval model

- Every sensitive action is a rule of the form `action(target)`. Actions: `read_file`, `write_file`, `read_url`, `execute_url`, `command`, `mcp` (and `unsandboxed` for business accounts). [OPENED https://antigravity.google/docs/permissions — "Every sensitive operation the agent performs is represented as a permission resource formatted as action(target)."]
- Three lists, fixed order. [OPENED https://antigravity.google/docs/permissions — "Conflicting rules are strictly evaluated in priority order: Deny > Ask > Allow."]
- Command rules match by word prefix, or by `regex:`. Commands that hide execution fall back to exact match. [OPENED https://antigravity.google/docs/permissions — "it disables prefix matching for the entire command line"]
- Three scopes in the CLI: Project, Shared, Global. [OPENED https://antigravity.google/docs/cli/commands/permissions — "Rules shared across all Antigravity products."]
- CLI rules live in `~/.gemini/antigravity-cli/settings.json` under `permissions.allow`, `.ask`, `.deny`. [OPENED https://antigravity.google/docs/permissions — "Permissions are evaluated across three distinct access lists configured inside your global settings (\~/.gemini/antigravity-cli/settings.json)"]
- Path rules are normalised on Windows, so one rule file can serve all three systems. [OPENED https://antigravity.google/docs/permissions — "stripping drive letters (for example, C:) and converting all backslashes (\\) to forward slashes (/)"]
- On Windows shells, command rules need `regex:` to cover subcommands. [OPENED https://antigravity.google/docs/permissions — "commands that can't be cleanly split into separate words require an exact match by default"]

### App presets (personal accounts)

| Preset | Sandbox | Commands | Files | MCP and web |
|---|---|---|---|---|
| Request Review | Off | Always ask | Workspace only | Ask |
| Default | On | Free inside sandbox; ask outside | Workspace and temp | Ask |
| Auto | On | Free inside; auto-judged outside | Workspace and temp | Ask |
| Turbo | Off | No prompts | Whole disk | Allowed |

- Presets are a base layer. Your own rules sit on top. [OPENED https://antigravity.google/docs/permissions — "Your configured allow, deny, and ask rules are layered on top of the preset and always take precedence"]
- Default is the default. [OPENED https://antigravity.google/docs/sandbox — "Default is selected by default (Request Review if the sandbox isn't available)."]
- Auto needs the sandbox and a personal account. [OPENED https://antigravity.google/docs/permissions — "It isn't currently available for business or enterprise accounts"]
- Business accounts use an older model with Require Review, Proceed in Sandbox, Always Proceed. [OPENED https://antigravity.google/docs/agent-settings — "Business and enterprise accounts use the following settings instead of the permission presets above."]

### CLI modes

- `default`, `accept-edits`, `auto`, `plan`. Starts in `default`, which asks before edits and commands. [OPENED https://antigravity.google/docs/cli/modes — "Pauses for interactive diff review before modifying or creating files, and asks before running terminal commands."]
- `toolPermission`: `request-review` (default), `proceed-in-sandbox`, `strict`, `always-proceed`. [OPENED https://antigravity.google/docs/settings — "Prompts before every tool action, including file reads, even when an allow rule matches (overrides auto mode)."]
- `--dangerously-skip-permissions` approves everything, except a built-in protected list since CLI 1.5.2. [OPENED https://antigravity.google/docs/changelog — "commands on the built-in list of protected commands are no longer approved automatically"]

### Sandbox

| OS | Technology | Note |
|---|---|---|
| Linux | Kernel namespaces | Unavailable where unprivileged user namespaces are blocked, such as some containers |
| macOS | `sandbox-exec` (Seatbelt) | Blocks `~/Library/Application Support` since CLI 1.3.3 |
| Windows | AppContainer in a process security environment | Needs Windows 11 24H2 with the August 2026 update or later |

- No VM or Docker. [OPENED https://antigravity.google/docs/sandbox — "The sandbox is built on native operating system primitives, so there are no virtual machines or Docker images to manage and no startup delay"]
- Windows floor. [OPENED https://antigravity.google/docs/sandbox — "Requires Windows 11 24H2 or later with the August 2026 update or later."]
- When it is unavailable, sandbox settings do nothing and Auto is not offered. [OPENED https://antigravity.google/docs/sandbox — "enableTerminalSandbox and --sandbox have no effect."]
- Inside it: project is writable, secrets are blocked, no network. [OPENED https://antigravity.google/docs/sandbox — "Sensitive files such as ~/.ssh and .env are blocked"]
- Network opens only to domains granted under `read_url`. [OPENED https://antigravity.google/docs/sandbox — "Domains allowed under read_url are added to the sandbox's outbound allowlist."]
- The App has it on by default. [OPENED https://antigravity.google/docs/sandbox — "Antigravity includes a terminal sandbox, enabled by default, that isolates shell commands executed by agents."]
- The CLI has it off by default. [OPENED https://antigravity.google/docs/sandbox — "enableTerminalSandbox (boolean, default: false): Runs agent commands inside the sandbox."]
- Linux hosts without unprivileged user namespaces cannot use it. [OPENED https://antigravity.google/docs/sandbox — "Linux hosts and some containers that block unprivileged user namespaces"]
- The macOS sandbox hides the app-support folder. [OPENED https://antigravity.google/docs/changelog — "Changed the macOS terminal sandbox to block sandboxed commands from reading ~/Library/Application Support by default"]
- On Windows the sandbox is looser about reads. [OPENED https://antigravity.google/docs/sandbox — "On Windows, folders outside your user profile are readable but not writable inside the sandbox"]

### Browser

- Per-site allow, ask and deny rules ("Browser Actuation Rules"). A new site prompts. [OPENED https://antigravity.google/docs/ide/allowlist-denylist — "Antigravity asks you before the browser subagent opens a site that you haven't allowed."]
- Rules match a domain and its subdomains. Some Google sites need their own rule. [OPENED https://antigravity.google/docs/ide/allowlist-denylist — "A rule for google.com doesn't cover them."]
- Running JavaScript in a page asks by default. [OPENED https://antigravity.google/docs/commands/browser — "Running JavaScript in the page (evaluate_script) prompts for your approval by default."]
- Web page reads by the agent (not the browser) are governed by `read_url`, default Ask. [OPENED https://antigravity.google/docs/permissions — "Actions for read_url and execute_url default to Ask."]
- An administrator can disable the browser subagent or pin its sites. [OPENED https://antigravity.google/docs/ide/allowlist-denylist — "If your organization's administrator sets the domains that the browser subagent can use, the subagent can't open any other site."]

### Workspace trust

- The CLI asks before it works in a new folder. Trusted folders are saved in `trustedWorkspaces`. [OPENED https://antigravity.google/docs/getting-started — "Confirm that you trust the repository directory before the agent begins file indexing."]
- In the CLI, a project's hooks load once the folder is trusted. [OPENED https://antigravity.google/docs/changelog — "Fixed workspace-local hooks defined in /.agents/hooks.json not loading after trusting a folder"]
- IDE extensions check trust before loading repo-local skills and hooks. [OPENED https://antigravity.google/docs/changelog — "interactive Workspace Trust verification before loading repository-local skills, hooks, or auto-approve modes"]
- Whether the App gates a repository's `.agents/hooks.json` behind a trust prompt is not stated.

### Enterprise controls

- An administrator can force terminal policy, outside-folder file policy, sandbox, browser URL list, MCP allowlist and model list. [OPENED https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-settings — "enforce security and compliance controls, turn Google Antigravity features on or off, and manage model availability"]
- No administrator control over plugins or hooks appears on that page.

### Recent hardening (all from the official changelog)

- Plugin installs can no longer write outside the plugins folder. CLI 1.5.2. [OPENED https://antigravity.google/docs/changelog — "so an imported plugin can no longer overwrite other configuration files such as mcp_config.json"]
- Plugin OAuth tokens are kept from sandboxed commands. CLI 1.5.1. [OPENED https://antigravity.google/docs/changelog — "a plugin's real token now replaces its stand-in only in a request's Authorization header"]
- More credential folders blocked in the sandbox. CLI 1.4.6. [OPENED https://antigravity.google/docs/changelog — "sandboxed commands can no longer read or modify ~/.docker, ~/.kube, or ~/_netrc unless you grant access explicitly"]
- A path traversal in `define_subagent` was fixed. CLI 1.1.13. [OPENED https://antigravity.google/docs/changelog — "Fixed path traversal vulnerability in define_subagent by strictly validating model-supplied agent names before creating directories."]
- A sandbox escape through persistent terminals was fixed in CLI 1.5.3. [OPENED https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/CHANGELOG.md — "Fixed a security issue where a command run in the terminal sandbox could change environment state later loaded by persistent terminal commands"]

### Published incidents

| When | Who | What | Status reported |
|---|---|---|---|
| Nov 25, 2025 | PromptArmor | A poisoned web page made the agent read `.env` and send it out through the browser subagent. The default browser allowlist included `webhook.site`. | Not disclosed to Google first; Google listed it as a known issue |
| Nov 25, 2025 | Embrace The Red | Five issues: remote command execution by prompt injection, hidden Unicode instructions, no approval for MCP tools, exfiltration through `read_url_content`, exfiltration through image rendering | Reported; described as known |
| Nov 19–25, 2025 | Mindgard | A malicious project rule made the agent overwrite the global MCP config, giving code execution on every launch, even after reinstall | First closed as intended behaviour, then reopened |
| Jan 7 – Feb 28, 2026 | Pillar Security | Flag injection into the `find_by_name` tool ran code even in the strictest mode | Fixed Feb 28, 2026; bounty paid |

- PromptArmor. [THIRD-PARTY https://www.promptarmor.com/resources/google-antigravity-exfiltrates-data — "Google Antigravity is susceptible to data exfiltration via indirect prompt injection through the agentic browser subagent."]
- The allowlist detail. [THIRD-PARTY https://www.promptarmor.com/resources/google-antigravity-exfiltrates-data — "However, the default Allowlist provided with Antigravity includes"]
- The agent worked around its own file block. [THIRD-PARTY https://simonwillison.net/2025/Nov/25/google-antigravity-exfiltrates-data/ — "Gemini turns out to be smart enough to figure out how to work around that restriction"]
- Embrace The Red. [THIRD-PARTY https://embracethered.com/blog/posts/2025/security-keeps-google-antigravity-grounded/ — "In this post we will walk through five security vulnerabilities, including data exfiltration vulnerabilities, and even remote command execution via indirect prompt injection."]
- MCP had no approval step at the time. [THIRD-PARTY https://embracethered.com/blog/posts/2025/security-keeps-google-antigravity-grounded/ — "It does not have a human in the loop feature, at all."]
- Mindgard. [THIRD-PARTY https://mindgard.ai/blog/google-antigravity-persistent-code-execution-vulnerability — "Even after a complete uninstall and re-install of Antigravity, the backdoor remains in effect."]
- Mindgard on the root cause: project rules are trusted. [THIRD-PARTY https://mindgard.ai/blog/google-antigravity-persistent-code-execution-vulnerability — "It's simply executing trusted rules as designed, in a fashion that allows arbitrary file write and persistence."]
- Pillar Security. [THIRD-PARTY https://www.pillar.security/blog/prompt-injection-leads-to-rce-and-sandbox-escape-in-antigravity — "native tool invocations are executed by the agent directly, before Secure Mode's command-level restrictions are evaluated"]
- Pillar's dates. [THIRD-PARTY https://www.pillar.security/blog/prompt-injection-leads-to-rce-and-sandbox-escape-in-antigravity — "Feb 28, 2026 - Google marks the issue as fixed."]
- A Cloud Security Alliance note says the Mindgard issue was fixed in the same cycle. I could not confirm that against Mindgard's own page. [THIRD-PARTY https://labs.cloudsecurityalliance.org/research/csa-research-note-agentic-ide-prompt-injection-sandbox-escap/ — "the Mindgard Forced Descent finding was addressed in the same release cycle"]
- Google keeps a "known issues" page for Antigravity on its bug-bounty site, at `https://bughunters.google.com/learn/invalid-reports/google-products/4655949258227712/antigravity-known-issues`. I could not read it. The host answers, but the page is a JavaScript app and the shell names no content endpoint. Third parties quote it. Mindgard's copy of one entry: [THIRD-PARTY https://mindgard.ai/blog/google-antigravity-persistent-code-execution-vulnerability — "Working with untrusted data can affect how the agent behaves."]
- Per Embrace The Red, Google began listing these issues publicly once reports came in. [THIRD-PARTY https://embracethered.com/blog/posts/2025/security-keeps-google-antigravity-grounded/ — "after researchers started reporting issues last Tuesday, Google started documenting them publicly"]
- I found no published vulnerability report about hooks, plugins or the marketplace themselves.

### What Google itself warns

- In the CLI repository. [OPENED https://raw.githubusercontent.com/google-antigravity/antigravity-cli/main/README.md — "AI coding agents are known to have certain security risks, including autonomous code execution, data exfiltration, prompt injection, and supply chain risks."]
- In the terms: the user answers for what the agent does. [OPENED https://antigravity.google/terms — "You are solely responsible for: (a) the actions and tasks performed by an AI Agent"]
- In the enterprise docs. [OPENED https://docs.cloud.google.com/gemini/enterprise/docs/ai-developer-tools-settings — "AI models, including third-party models, can follow instructions hidden in content they process, such as files, web pages, or tool output."]

### What this means for a plugin's own security design (my inferences)

- A repository's rules are trusted input to the model. A memory file the plugin writes into `AGENTS.md` is also trusted. Treat anything copied there from tool output as a possible injection. Inference from the Mindgard report.
- A plugin hook runs outside the model. It can enforce a rule the model cannot talk its way past. That is the one hard control a plugin has.
- Hooks fail open. A security check in a hook that crashes checks nothing.
- The global config folder is a persistence target. Do not write there without the user asking.

---

## 13. Claude Code features and their closest Antigravity match

| Claude Code feature | Closest Antigravity equivalent | Gap or caveat | Evidence |
|---|---|---|---|
| `CLAUDE.md` | `AGENTS.md` or `GEMINI.md` at the workspace folder and each parent to the repo root; `~/.gemini/AGENTS.md` globally | `CLAUDE.md` itself is not read. Subfolder files are not loaded. | [OPENED https://antigravity.google/docs/rules — "AGENTS.md and GEMINI.md do not use frontmatter."] |
| Auto memory | **None found** as a documented feature. Nearest: `/learn`, which is user-approved | Knowledge Items are undocumented today | [OPENED https://antigravity.google/docs/commands/learn — "Agents don't remember conversations."] |
| Path-scoped rules | `.agents/rules/<name>.md` with `trigger: glob` and `globs:` | `globs` is a comma-separated string. Bad frontmatter is dropped silently. | [OPENED https://antigravity.google/docs/rules — "Automatically activates when the agent interacts with files matching any comma-separated pattern in globs"] |
| Skills | Agent Skills: `.agents/skills/<name>/SKILL.md`, `~/.gemini/config/skills/`, plugin `skills/` | Same standard. Also become slash commands. | [OPENED https://antigravity.google/docs/skills — "On every turn, the agent sees a list of available skills with their names and descriptions."] |
| Subagents | `invoke_subagent`; built-ins `research`, `browser`, `self`; custom `.agents/agents/<name>.md` | Depth limit 10. Clean context each. | [OPENED https://antigravity.google/docs/subagents — "A maximum nesting depth of 10 levels"] |
| Hook: `SessionStart` | `SessionStart` with `injectSteps` | New (not in the changelog). One report: does not fire on resume. | [OPENED https://antigravity.google/docs/hooks — "Fires once when a new conversation session starts, before the first model invocation."] |
| Hook: `UserPromptSubmit` | `PreInvocation`, which carries `lastUserInput` and can inject or terminate | Fires before every model call, so many times per prompt | [OPENED https://antigravity.google/docs/hooks — "Fires before the model is called."] |
| Hook: `Stop` | `Stop`, return `decision: "continue"` to keep going | Docs disagree on `"block"` versus `"continue"`. Capped after repeats. | [OPENED https://antigravity.google/docs/hooks — "Fires when execution terminates."] |
| Hook: `SessionEnd` | **None found** | `Stop` fires per turn, not per session | [OPENED https://antigravity.google/docs/hooks — "Antigravity supports the following hook events"] |
| Hook: `PreCompact` | **None found** in `hooks.json`. SDK only: `on_compaction` | Re-inject from `PreInvocation` instead | [OPENED https://antigravity.google/docs/changelog — "adds an on_compaction lifecycle hook for observing context checkpointing"] |
| Hooks: `PreToolUse` / `PostToolUse` | Same names | `PostToolUse` cannot see output or inject | [OPENED https://antigravity.google/docs/build-plugins — "Receives the tool call and any error (not the tool output)."] |
| Plugins | `plugin.json` or `.antigravity-plugin/plugin.json`; `agy plugin install` | No `commands/`. One official marketplace, by application. | [OPENED https://antigravity.google/docs/plugins — "A plugin is a self-contained directory defined by a plugin.json manifest (or .antigravity-plugin/plugin.json)"] |
| Plugin root variable (`${CLAUDE_PLUGIN_ROOT}`) | `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in MCP config. Hooks: working directory is the plugin root; env vars only from CLI 1.5.3 | `${CLAUDE_PLUGIN_ROOT}` is rewritten only by `agy plugin import claude` | [OPENED https://antigravity.google/docs/build-plugins — "Hook commands automatically execute with \<plugin-root> as their working directory (cwd) and should use relative paths"] |
| Slash commands from a plugin | Skills (each is `/<name>`) | `commands/` folders are not loaded | [OPENED https://antigravity.google/docs/changelog — "commands/ folders and workflows/ Markdown files (which plugins don't load)"] |
| Scheduled tasks / loop | `/schedule` (timer or cron in a conversation), Automations (App), sidecars with the `schedule` builtin, `/goal` | Sidecars need the user to enable them. Automations are App only. | [OPENED https://antigravity.google/docs/commands/schedule — "timers and schedules belong to the conversation that created them"] |
| Headless mode | `agy -p`, with `--output-format json` or `stream-json` | Blocked tools are skipped with exit 0. Not for wrapping inside other agents on consumer plans. | [OPENED https://antigravity.google/docs/cli/headless — "Headless runs are stateless by default."] |
| Readable transcripts | `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`; path given to hooks as `transcriptPath` | Schema undocumented. File can be rewritten on compaction. | [OPENED https://antigravity.google/docs/hooks — "The absolute path to the persistent transcript.jsonl conversation logs."] |
| Status line | `statusLine` command in the CLI's `settings.json` | A plugin cannot set it (third-party report) | [OPENED https://antigravity.google/docs/cli/statusline — "Whenever the agent state changes, the CLI runs your command"] |
| Output styles, plugin settings UI | **None found** | Plugin MCP `variables` give a credentials form only | [OPENED https://antigravity.google/docs/build-plugins — "prompt users for API keys in a setup dialog before enabling the plugin"] |

---

## Blocked hosts

**No host I needed was refused by this session's network policy.** Details:

- `antigravity.google`: the brief said it was blocked. In my session it answered HTTP 200 with real content from 20:04 UTC on 2026-11-09, on a plain request through the session's own proxy. The proxy's failure log shows the same host refused with 403 at 19:58:39 UTC, before my run. The coordinator has since said that refusal was a proxy start-up condition, not policy. I used no relay, mirror, cache or archive.
- The four other hosts the contract lists as refused also answered in my session: `arxiv.org` (200), `developers.openai.com` (200), `docs.letta.com` (200), `research.trychroma.com` (301). The proxy log shows their refusals within one second of the one above. I only probed them. They are worth a retry.
- `github.com` pages and `api.github.com` through curl and `gh`: refused, because this session's GitHub access is bound to one repository. I read GitHub files through `raw.githubusercontent.com` and GitHub pages through the fetch tool.
- `antigravity.codes`: unreachable (gateway 502, "host allowed"). Not a policy block. Not needed.
- `medium.com`, `arstechnica.com`, `nvd.nist.gov`: the sites themselves returned 403 to a scripted request. Not a policy block. Not used.
- `bughunters.google.com`: reachable, but the page needs JavaScript, so I got no content. The fetch tool could not resolve the host.
- `ai.google.dev/gemini-api/docs/antigravity-agent`: reachable, but rendered by JavaScript. No text obtained.
- The fetch tool could not resolve `www.gradually.ai`. Curl could.

Reachable primary hosts used: `antigravity.google`, `developers.googleblog.com`, `codelabs.developers.google.com`, `docs.cloud.google.com`, `developers.google.com`, `discuss.ai.google.dev`, `raw.githubusercontent.com`.

---

## Unconfirmed — do not rely on

None of the following was confirmed by a primary source I could open, or it rests on documentation that was never run.

1. **Everything about real behaviour.** No Antigravity install was available. Every "works" in this file means "is documented to work".
2. **Whether Knowledge Items still function in the App or CLI.** The folder and the `/context` label exist in passing mentions. No page explains them. Assume they do not exist.
3. **The first version with a `SessionStart` hook.** It is in today's docs. No changelog entry announces it. Third-party reports put it between agy 1.3.1 and 1.3.2 (around October 8, 2026).
4. **`SessionStart` on resume, on `/clear`, and after compaction.** One third-party test says it does not fire on resume. The docs say only "new conversation session".
5. **The shell that runs hook commands, on every OS.** `sh -c` comes from two third-party pull requests and `cmd /c` from one. The official hooks page is silent. Assume a Bash hook will not run on stock Windows.
6. **Whether both workspace and global hooks run, or one overrides.** The launch post says workspace wins. The docs page does not say.
7. **Whether hook commands run inside the terminal sandbox.** Not stated.
8. **Hooks in the App and the IDE, and plugin hooks there in particular.** All third-party tests I found used the CLI. The docs say hooks work on all three, but the hooks page lists the plugin level only for the CLI.
9. **`PLUGIN_ROOT` and `PLUGIN_DATA` for hooks.** Listed for CLI 1.5.3 in the GitHub changelog only. Not yet on the docs site. The App's support is not stated.
10. **The `metadata` crash in injected steps.** One forum reporter, reproduced by that reporter on 1.5.2. Not acknowledged as a bug by Google in the thread. Avoid `metadata` anyway.
11. **The `ANTIGRAVITY_CONVERSATION_ID` environment variable.** One third-party pull request. Not in the docs.
12. **Whether Antigravity reads `mcp.json` (the open-spec name) from a plugin.** Google's own sample ships both `mcp.json` and `mcp_config.json`. The docs name only `mcp_config.json`.
13. **What the `com.google.antigravity/` folder in Google's sample plugin does.** It exists. No Antigravity doc explains it.
14. **The transcript record schema.** Third-party, from version 1.1.14. Field names may have changed.
15. **Whether a sandboxed script can read `~/.gemini/.../brain/`** without an explicit grant. Inference from the sandbox page.
16. **Any numeric cap on MCP tools.** A limit exists. No number is published. Older claims of a 100-tool limit were not found in any source I opened.
17. **What happens to an Automation when the machine is off at run time.** Not stated.
18. **Sidecars in the CLI.** The docs page says App only. The CLI changelog mentions plugin sidecars running. The two are not reconciled.
19. **Whether the App asks for workspace trust before loading a repository's `.agents/hooks.json`.** Stated for the CLI and the IDE extensions. Not stated for the App.
20. **Whether the Mindgard persistence issue is fully fixed.** One third-party note says so. Google's changelog shows related hardening but does not name it.
21. **Side-panel views and `bin/` tools in plugins.** Each is mentioned once. No authoring docs.
22. **Whether any setting turns off conversation history or knowledge in the App or CLI.** Only an IDE 1.x changelog line mentions one.
23. **Marketplace acceptance rules for a memory or project-management plugin.** Only an interest form is published.
24. **Whether `invocationNum` restarts at 0 on each user turn.** The docs do not say. A hook that wants to act once per prompt needs this.
25. **Whether a `PostInvocation` or `Stop` hook can tell that a session is ending.** No event marks the end of a session.
