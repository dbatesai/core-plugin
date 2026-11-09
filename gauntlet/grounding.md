# Grounding — what was read, and what it showed

Date: 2026-11-09. CORE version read: 3.20.1, commit `79b526b`.

Every claim below has one of three kinds of proof:

- **`file:line`** — a file in this checkout.
- **`[cmd]`** — a command run in this session; the output is quoted or summarized.
- **a URL** — with a grade. `OPENED` means a reader fetched that page this session. `SEARCH-ONLY` means only a search-engine extract was seen. `THIRD-PARTY` means the page is not the vendor's own.

Nothing here comes from model memory. Where a fact could not be checked, it is listed in Part 6.

The long evidence files sit beside this one. This file is the digest.

| File | What it holds |
|---|---|
| `source-runtime.md` | One CORE 3.20.1 session, step by step, with sizes |
| `source-evaluation.md` | How CORE tests and measures itself today |
| `source-changelog.md` | Release history and the defect record |
| `research-claude-code.md` | What Claude Code does natively |
| `research-codex.md` | What OpenAI Codex does natively |
| `research-antigravity.md` | What Google Antigravity does natively |
| `research-memory-layers-a.md` | mem0, Letta, Zep / Graphiti |
| `research-memory-layers-b.md` | claude-mem, basic-memory, cognee, memU, MCP memory server, Anthropic memory tool |
| `research-competitors.md` | Project-partner and task-tracker competitors |
| `research-literature.md` | Published research and engineering writing |

---

## Part 1 — What this run could and could not reach

**1.1 No plugin cache install here.** `~/.claude/plugins/` holds only synced first-party plugins. There is no `cache/…/core/` folder. `[cmd: find ~/.claude/plugins -maxdepth 4]`

**1.2 No workspace `PROJECT.md` and no memory store here.** `find / -name PROJECT.md` returned nothing. No `_memories/`, `.core/`, or `_core/` folder exists outside test fixtures. `[cmd]`

**1.3 The marketplace checkout is here.** It is the working directory: `ARCHITECTURE.md`, `USAGE.md`, `CHANGELOG.md`, `plugins/core/`, `tests/`. 400 tracked files. `[cmd: git ls-files | wc -l]`

**1.4 The network was refused at first, then worked.** The environment's policy is "limited" with package managers allowed and no extra hosts. `[cmd: get_environment]` In the first minutes of the session the proxy refused `arxiv.org`, `developers.openai.com`, `antigravity.google`, `docs.letta.com`, and `research.trychroma.com` (HTTP 403 on connect). `[cmd: curl status probes, 19:59 UTC]` At 20:34 UTC the same five URLs returned 200. `[cmd: same probe]` So the refusal was a start-up condition.

**1.5 Consequence.** The defect history was checked against the shipped source and the changelog, not against the workspace that first saw it. The research readers were briefed while the hosts were refused, then sent a correction. Each research file has a "Blocked hosts" section saying what it actually reached, and every claim carries a grade: `OPENED`, `SEARCH-ONLY`, or `THIRD-PARTY`. Read the grade before trusting the claim.

---

## Part 2 — CORE 3.20.1 as built

### 2.1 Size

| Measure | Value | Proof |
|---|---|---|
| Shipped scripts | 100 `.mjs` files, 34,313 lines, 1.72 MB | `[cmd: git ls-files plugins/core \| grep .mjs \| xargs cat \| wc -lc]` |
| Shipped prose | 40 `.md` files, 6,426 lines, 607 KB | same, `.md` |
| Test code | 180 files under `tests/scripts/`, 41,307 lines | `[cmd]` |
| Skills | 8 (`core`, `finalize`, `refocus`, `process-memory`, `register-sources`, `configure-project`, `metrics`, `memory-view`) | `[cmd: ls plugins/core/skills]` |
| Environment switches | 35 distinct `CORE_*` names | `[cmd: grep -rhoE "CORE_[A-Z][A-Z0-9_]+" … \| sort -u \| wc -l]` |
| Releases | 46 between 2026-05-20 and 2026-10-17 — about one every three days | `[cmd: grep -c "^## \[[0-9]" CHANGELOG.md]`, `CHANGELOG.md:10–915` |
| npm dependencies | none; no `package.json` | `[cmd: find . -name package.json]` |

### 2.2 What the model must read before the first task

`SKILL.md` tells the agent to read `protocols/startup.md` "in full" at every session start (`plugins/core/skills/core/SKILL.md:18–22`). That file is 88,068 bytes. With `SKILL.md` (23,503), `protocols/harness.md` (6,968) and the Claude Code adapter (8,384), the mandatory startup read is about 127 KB — roughly 32,000 tokens at four bytes per token, before any project content. `protocols/data-storage.md` (76,700 bytes) must be read "before writing any unit, observation, or render" (`SKILL.md:88`). `[cmd: wc -c]`

### 2.3 Hooks

Claude Code gets three: `SessionStart`, `UserPromptSubmit`, `SessionEnd` (`plugins/core/hooks/hooks.json:3–35`). Codex gets one: `UserPromptSubmit` (`plugins/core/hooks/hooks-codex.json:3`). Every hook runs `node`.

- The session-start hook injects one directive telling the agent to invoke `/core` first (`hooks/session-start-hook.mjs:90–92`). It reads the user's `~/.claude/settings.json` to authorize a wrapper skill (`:64–76`).
- The per-prompt hook injects the top 3 matching memory summaries, capped at 2,048 bytes (`hooks/retrieve-context-hook.mjs:55–56`). When the match is thin it can add up to 160 candidate lines (`:16–20`). It swallows every error to exit 0 by design (`:33–34`).
- The session-end hook records a lifecycle receipt with no model call (`skills/finalize/SKILL.md:128`).

### 2.4 Harness support today

Two harnesses are known to the code: `['claude-code', 'codex']` (`scripts/contract-format.mjs:26`). There is no Antigravity adapter and no mention of Antigravity anywhere in `plugins/core` `[cmd: grep -ri antigravity plugins/core → no match]`.

CORE already has the shape of a ladder-down. `protocols/harness.md:9–17` defines "drops": a capability one harness cannot deliver is named in its adapter, with a fallback, and must never be skipped silently. The Codex adapter names five drops: `notify-user`, `schedule`, automatic session start, automatic close, and pre-execution blocking (`harnesses/codex.md:75–110`). The Claude Code adapter claims "No drops" (`harnesses/claude-code.md:88`).

Harness detection today is by guesswork from the environment: "`~/.claude/` config directory present, OR `${CLAUDE_PLUGIN_ROOT}` env var present, OR" tool availability (`harnesses/claude-code.md:10–15`), and for Codex, among others, "Absence of Claude-Code-specific tools" (`harnesses/codex.md:35`). Both config folders can exist on one machine.

### 2.5 The memory model

- Two tiers. Observations are "capture-everything" (`protocols/data-storage.md:99`); units are graduated facts with typed edges (`:158–189`).
- A useful write test already exists: "would this fact, sitting in context six weeks from now, change what the agent says or builds?" (`data-storage.md:101`), with a keep-list and a discard-list (`:103–110`).
- Five authority levels, user instruction first, harness memory last (`data-storage.md:81–87`).
- The anti-resurrection rule: a fact the user removed stays removed (`ARCHITECTURE.md:79`, `data-storage.md:448`).
- Retrieval is a four-tier ladder: in-context, BM25 with one-hop expansion, typed-edge graph walk, reasoning over shards (`data-storage.md:353–361`). Ranking uses a four-signal weighted formula with fixed starting weights (`:410–426`).
- `PROJECT.md` is rendered from units, and user edits to it are detected by hash and carried back (`ARCHITECTURE.md:69–83`).
- The action-status rule separates what is owed, what was attempted, and what supports the claim (`data-storage.md:193–208`).

### 2.6 Generated text inside hand-edited files

Startup runs `decorate-graph.mjs` and `maintenance-run.mjs` "for real, unconditionally, every session, on every returning workspace" (`protocols/startup.md:272–281`). Decoration "regenerates the `[[wikilink]]` block in every active unit" (`startup.md:293`).

Because CORE writes generated blocks into the same files a person edits, it needs machinery to tell its own writes from the user's: a per-project state cache of hashes, a `last_written_by` stamp, a classifier that hashes only the content outside marker lines, an ordering rule ("This runs AFTER edit-detection above, never before"), a writer-side refusal, a creation-time stamp command, and two adoption ceremonies for older stores (`startup.md:255–295`).

### 2.7 What CORE already knows about its own failure patterns

`docs/regression-guards.md:11–17` names five repeating defect shapes. Number 3 is "Instruments report healthy while recording nothing". Its guard column reads "per-instrument tests; add as found" — there is no structural fix, only a growing list of point tests.

`docs/change-review-prompt.md:17` records the project's own lesson: "obligations that live only in prose get executed ~40% of the time. Guarantees belong in scripts/hooks, or the prose must honestly mark itself best-effort." No measurement behind the 40% figure was found in the repository `[cmd: grep "40%" → this line only]`.

### 2.8 Evaluation assets that exist today

- `tests/prose-evals/prose-eval.mjs` is a deterministic rubric checker. A scenario fixture plants obligations, earlier threads, forbidden claims, and a prompt-injection marker; the checker fails any output that lost an obligation, followed the injection, blew its word cap, or claimed completion the evidence cannot support (`prose-eval.mjs:1–28`, `tests/prose-evals/fixtures/refocus-scenario.json`). Its header states the judgment half "is scored by a blind reviewer using the same fixtures" and that "the checker never knows which candidate it is scoring" (`:6–8`, `:26–27`).
- Retrieval gold sets with `expected` and `forbidden` ids (`tests/fixtures/tier-safety-store/_tests-goldset.json`), and fixture stores built to catch poison, retired, crowding, and distractor memories (`tests/fixtures/*/_memories/`).
- `/metrics self-test` authors a blind question round, freezes it, and scores retrieval against it (`USAGE.md:70`, `:110`).
- CI runs `node --test` on Node 24, syntax-checks every script, and checks the manifests agree (`.github/workflows/ci.yml:17–120`).

Full detail: `source-evaluation.md`.

### 2.9 The trust list

`~/.core/projects.json` is the list of enabled projects: a JSON array whose entries carry a `path` string (`scripts/project-state.mjs:84-97`). Only `index-registry.mjs` writes it (`scripts/index-registry.mjs:2-4`). The home folder for it comes from the OS account record, not `$HOME` (`scripts/trusted-home.mjs:25-31`).

---

## Part 3 — The five reported defects, checked against source

The brief said to verify each before relying on it. Results:

### 3.1 Scripts ignore `CLAUDE_CONFIG_DIR` — CONFIRMED, with one correction

`CLAUDE_CONFIG_DIR` appears nowhere in `plugins/core` `[cmd: grep -rn CLAUDE_CONFIG_DIR → one hit, a comment in tests/smoke]`.

Five shipped scripts build a `~/.claude/projects/…` path from the home directory:

| Script | Line | Path it builds |
|---|---|---|
| `scripts/read-transcript.mjs` | 76 | the session transcript folder |
| `scripts/audit-memory-boundary.mjs` | 59 | the harness `MEMORY.md` |
| `scripts/check-context-integrity.mjs` | 66 | the harness `MEMORY.md` |
| `scripts/capability/auto-memory-injection-probe.mjs` | 56 | the harness `MEMORY.md` |
| `hooks/session-start-hook.mjs` | 67 | the user's `settings.json` |

The correction: only one of them builds a *transcript* path. The other consumers named in the brief — retrieval-skip, turn classification, metrics detectors — import that one resolver (`analyze-retrieval-skip.mjs:39`, `classify-turns.mjs:37`, `metrics-detectors.mjs:29`), so one wrong path blinds all of them.

What each prints when the real data sits under a second config tree `[cmd: each script run with CLAUDE_CONFIG_DIR and HOME pointed at separate temp folders]`:

| Script | Output | Exit |
|---|---|---|
| `audit-memory-boundary.mjs` | `0 native-only candidate(s) / 0 sampled of 0 native entries` | 0 |
| `analyze-retrieval-skip.mjs --json` | `"status": "UNKNOWN", "reason": "transcript unavailable…"` | 0 |
| `classify-turns.mjs --json` | `"status": "UNAVAILABLE"` | 0 |
| `metrics-detectors.mjs --json` | `"status": "UNAVAILABLE"` | 0 |

So the boundary audit literally reports a clean zero (`audit-memory-boundary.mjs:146` turns a missing file into an empty string). The other three say UNKNOWN or UNAVAILABLE in their JSON but exit 0, so any caller that checks the exit code sees success.

### 3.2 The capability probe says NOT-YET for memory that is loaded — CONFIRMED

With a valid `MEMORY.md` placed only under the `CLAUDE_CONFIG_DIR` tree, `capability-probe.mjs --startup --json` returned `auto-memory-injection: NOT-YET` with evidence "MEMORY.md not found for mapped cwd", looking under `$HOME/.claude/…`. Three rows returned UNKNOWN in the same run: `target-surface-collab-files`, `memory-visible-in-agent-context`, `memory-accessed`. `[cmd]`

The cause is in the probe's own header: it is a "file-present + structure-marker check; it does NOT prove the agent actually loaded the content into context" (`capability/auto-memory-injection-probe.mjs:7–8`). It infers a session fact from a path it computed, instead of observing the session.

### 3.3 `read-transcript` prints nothing and exits 0 — CONFIRMED, and wider than reported

`node read-transcript.mjs --transcript /nonexistent/path.jsonl --harness claude-code` printed nothing and exited 0. `[cmd]` The file has no command-line entry at all `[cmd: grep "process.argv\|isCliEntry" → no match]`. It does this for *any* arguments, not only a missing path. Its library function is documented as "Fail-open: never throws on a missing/unreadable transcript" (`read-transcript.mjs:266–268`).

### 3.4 Startup decoration re-owes a render — CONFIRMED and reproduced

The chain, link by link:

1. Startup runs `decorate-graph.mjs` "for real, unconditionally, every session, on every returning workspace" (`protocols/startup.md:272–277`). It writes a generated link block inside the unit files themselves (`scripts/unit-vocab.mjs:92–93` defines the markers).
2. A close records a signature of the store. The signature is a hash of the **whole content** of every unit file, generated block included (`scripts/generate-summary-index.mjs:177–187`).
3. The close detector compares the live signature with the recorded one. On a mismatch under a `closed` marker it returns `owed: ['render-project-md']`, reason `store-changed` (`scripts/close-pass.mjs:215–228`, `:242–244`).

Reproduced on a copy of `tests/fixtures/nested-store` `[cmd]`: a clean close read `closed`. Then `decorate-graph.mjs` alone was run — "updated 1/8 unit(s): dc-new.md". The next `close-pass.mjs detect` printed `{"state":"owed","owed":["render-project-md"],"reason":"store-changed"}`. Nothing but CORE's own upkeep had touched the store.

One thing the brief's wording could suggest but the source does not show: the file-level edit detector (`lifecycle-detect.mjs`) did **not** misread the decoration as a user edit. It reported all files `clean` afterwards, because decoration stamps its own write. The churn is in the close signature, not in edit detection. `[cmd]`

### 3.5 False close markers, and the pass that wrote nothing

**"Closed" over an empty ledger — CONFIRMED and reproduced.** `close-pass.mjs begin` followed directly by `close-pass.mjs finish`, with no operation recorded, printed "close marked closed; lock released" and exited 0. The marker file then read `"status":"closed"` with `"ops":{}`. `detect` on that same file returned all four operations owed, reason `closed-but-incomplete`. `[cmd]` One file carries two records of one state — a status word and an operations ledger — and `finishClose` writes the word without reading the ledger (`close-pass.mjs:143–178`). The detector's own comment admits the gap: "What `closed` alone can't rule out is the child exiting cleanly … WITHOUT ever following that protocol" (`:222–223`).

**"Owed" for a render CORE itself caused — CONFIRMED.** This is 3.4.

**The unattended pass that claimed five writes and wrote none — MECHANISM CONFIRMED, incident not reproduced.** The incident needs a live model run in the workspace that saw it, and that workspace is not here. What the source shows: `backfill-memory.mjs mark --session <id>` stamps a session as memory-processed and takes no evidence that anything was written (`backfill-memory.mjs:77–84`, `:140–146`). Its header says the stamp is for "once the agent has actually read its transcript and captured what it warranted", and "The judgment work between those two calls belongs to the agent, not this script" (`:9–12`). So a pass can report writes and mark the session done while the disk is unchanged, and no step compares the claim with the files.

### 3.6 Is it one class?

Yes, and CORE's own documents say so (2.7). Six mechanisms produce it in this codebase:

1. **A computed path stands in for an observed fact.** The script works out where the harness "must" keep a file and reads there (3.1, 3.2).
2. **Missing input becomes an empty value.** A file that is not there is read as an empty string or an empty list, and the count of zero is reported as a finding (3.1 boundary audit).
3. **"Unknown" travels as data but "success" travels as the exit code.** The JSON says UNKNOWN; the process says 0 (3.1, 3.3).
4. **Two records of one state.** A status word and a ledger describe the same close and can disagree (3.5).
5. **A claim stands in for a check.** The agent says it wrote something; a script stamps "done" without looking at the disk (3.5).
6. **CORE's own writes look like change.** Generated text lives inside the files being watched, so upkeep trips the watcher (3.4).

---

## Part 4 — What the harnesses already do

### 4.1 Claude Code — read from the vendor's own documentation this session

All URLs below were OPENED this session with `curl` from `code.claude.com/docs/en/<page>.md`. Fuller notes: `research-claude-code.md`.

**Instruction files**

- Claude Code now reads `AGENTS.md` natively when a project has no `CLAUDE.md`: "a repository already set up for other coding agents works without adding a `CLAUDE.md`, an import, or a setting." It needs v2.1.277 or later. `@path` imports inside `AGENTS.md` are expanded. — `memory.md` §AGENTS.md
- Instruction files are reloaded after compaction; the `InstructionsLoaded` hook reports each file loaded, with `load_reason` values including `session_start`, `include`, and `compact`. — `hooks.md` §InstructionsLoaded
- Size guidance: "target under 200 lines per CLAUDE.md file. Longer files consume more context and reduce adherence." — `memory.md` §Write effective instructions

**Auto memory**

- On by default in local sessions. Stored at `~/.claude/projects/<project>/memory/`, one directory per git repository. "Auto memory is machine-local… Files are not shared across machines or cloud environments." — `memory.md` §Storage location
- It already saves project facts: type `project` is "ongoing work, deadlines, and decisions that Claude can't derive from the code or git history". — `memory.md` §Auto memory
- Load limit: "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation." — `memory.md` §How it works
- The location can be moved with the `autoMemoryDirectory` setting; "The value must be an absolute path or start with `~/`." A second config tree is selected with `CLAUDE_CONFIG_DIR`. — `memory.md` §Storage location
- Not loaded into subagents. — `memory.md` §How it works

**Hooks**

- Every hook receives `session_id`, `transcript_path`, and `cwd` on stdin. A hook never has to compute where the transcript is. — `hooks.md` §Common input fields
- Events that exist today include `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`, `FileChanged`, `CwdChanged`, and about twenty more. — `hooks.md` §Hook events
- `SessionStart` fires with a `source` of `startup`, `resume`, `clear`, `compact`, or `fork`. Only `command` and `mcp_tool` hook types are allowed there. — `hooks.md` §SessionStart
- `UserPromptSubmit` can add context with plain stdout or `additionalContext`; default timeout 30 seconds; a timed-out hook's output is discarded and "the prompt still reaches Claude without that context". It also fires on scheduled-task firings and background-subagent reports. — `hooks.md` §UserPromptSubmit
- `PreCompact`: "Claude Code uses its stdout as instructions for the compaction summary." — `hooks.md` §PreCompact output
- `SessionEnd` hooks "have a default timeout of 1.5 seconds", and "Timeouts set on plugin-provided hooks don't raise the budget." — `hooks.md` §SessionEnd
- A hook with `args` runs in "exec form": the executable is spawned directly with no shell. Without `args` it runs through `sh -c` on macOS and Linux, Git Bash on Windows, "or PowerShell when Git Bash isn't installed". — `hooks.md` §Exec form and shell form

**Plugins**

- A plugin can ship skills, commands, agents, hooks, MCP servers, LSP servers, executables in `bin/`, default settings, themes and output styles, channels, and monitors. — `plugins/components.md`
- Path variables are "substituted in skill, command, and agent content, in hook and monitor commands": `${CLAUDE_PLUGIN_ROOT}` (changes on every update; "Don't write state there"), `${CLAUDE_PLUGIN_DATA}` ("a directory that survives updates"), `${CLAUDE_PROJECT_DIR}`. — `plugins/components.md` §Reference plugin paths and store data
- `userConfig` in the manifest asks the user for settings in a dialog and passes them to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`. Monitors do not receive them. — `plugins/components.md` §Ask the user for configuration values, §Monitors
- **Monitors.** "A monitor is a shell command that runs in the background for the whole session. What it prints reaches Claude as notifications." They "don't start in non-interactive mode with the `-p` flag" and run "outside the sandbox". — `plugins/components.md` §Monitors
- Mods are JavaScript or TypeScript handlers that run inside Claude Code and can draw panes. "A mod is code that runs with your permissions." CLI, Desktop, and VS Code only. — `plugins/mods/overview.md`

**Loops and schedules**

- `/loop` re-runs a prompt or a skill on an interval while the session is open; with no interval Claude picks the delay each time, from one minute to one hour. Recurring tasks "automatically expire 7 days after creation". Tools: `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup`. — `scheduled-tasks.md`
- Three scheduling options exist: cloud routines (fresh clone, no local files, minimum one hour), Desktop scheduled tasks (local files, survive restarts), and `/loop` (session only). — `scheduled-tasks.md` §Compare scheduling options
- `/goal` keeps a session working until a condition holds, judged after each turn by a separate model. — `goal.md`

**Measurement and audit, built in**

- **`claude plugin eval`** runs a suite of cases against a plugin and scores them. It runs each case with the plugin and again without it: "a case's runs are repeated with no plugin loaded, and you get two scores, `WITH` and `W/OUT`. Their difference, `Δ`, is what the plugin contributed." Three runs per arm by default. Needs v2.1.269 or later. — `plugin-evals.md`
- Grader types: `regex`, `tool_used`, `tool_order`, `file_exists` (free), and `llm` and `baseline` (a judge model; `llm` passes on "at least two of three votes"; `baseline` compares against "the reference transcript at `baseline_file`"). "There are no custom-code graders." — `plugin-evals.md` §Grader types
- Runs are isolated: temporary home, "only your plugin loaded"; "Your user settings, hooks, `CLAUDE.md` files, MCP servers, other installed plugins, memory, and skills are absent." "The case definitions are hidden from the agent." — `plugin-evals.md` §How runs are isolated
- MCP servers can be mocked per tool with files under `evals/mocks/<server>/<tool>.md`. — `plugin-evals.md` §Mock MCP servers
- Write, Edit, and Bash need an explicit `--allow-tools` grant. With Bash granted, "Native Windows has no [sandbox] backend, so run shell-granting suites under WSL2". — `plugin-evals.md` §Grant tools
- Exit codes are defined for CI; the with-minus-without delta "never changes the exit code". — `plugin-evals.md` §Run evals in CI
- **`claude plugin details <name>`** prints the plugin's always-on token cost and per-skill on-invoke cost. — `plugins/measure.md`
- **`claude plugin validate <path> --strict`** checks manifests, skills, agents, and commands and exits non-zero for CI. — `plugins/cli-reference.md` §plugin validate
- **`/doctor prompt-audit`** has Claude check instruction files and skills for "references to files or commands that don't exist, and files that contradict each other". Needs v2.1.283. — `memory.md` §Audit your instruction files
- `/skill-doctor` flags skills that are listed but never invoked. — `plugins/measure.md` §Find skills that never run

**Unattended runs**

- "Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, even in a folder you've never trusted." — `headless.md`

**Skills**

- Skills follow the Agent Skills open standard. The combined description and `when_to_use` text is cut at 1,536 characters in the listing. "Keep `SKILL.md` under 500 lines." — `skills.md`

### 4.2 Codex — from source at tag `rust-v0.167.0` and the official docs

Detail and every citation: `research-codex.md`. Source was read file by file; the official docs at `learn.chatgpt.com` were checked afterwards (that file's "Primary-docs check" section). Nothing was run.

- **Hooks exist, are stable, and are on by default.** Fourteen events, including `SessionStart`, `UserPromptSubmit`, `PreToolUse` (can block), `PreCompact`, `PostCompact`, `Stop`, and `SessionEnd`. [codex §4]
- **Context injection** works from `SessionStart` and `UserPromptSubmit` (plain stdout or `additionalContext`), not from `PreCompact`. After compaction a `SessionStart` with source `compact` fires, which is the way to re-inject. [codex §4]
- **Hook commands are shell strings.** No `args` exec form. `commandWindows` overrides the command on Windows. Hooks run outside the agent's sandbox. [codex §4]
- **Trust.** A hook runs only after the user approves it in `/hooks`. Plugin hook approval is tied to a hash of every file in the plugin folder, so a plugin update that changes a file resets approval. Headless runs need `--dangerously-bypass-hook-trust`. [codex §4, primary-docs check]
- **Plugins** load `.codex-plugin/plugin.json` and also Claude-layout `.claude-plugin/plugin.json`. Hook commands get `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`. There is no project-directory variable; use `cwd` from stdin. [codex §4–5]
- **Memories** exist but are off by default, global, and built in the background. [codex §2]
- **No `/loop` or cron in the CLI.** `/goal`, a sleep tool, and `codex queue` exist. Scheduled tasks live in the desktop app and web, not the CLI. [codex §8, primary-docs check]
- **Subagent roles** are TOML files; their tool access cannot be narrowed below the parent's. [codex §6]
- **Native Windows** is supported. Without a Windows sandbox set up, a writable sandbox falls back to read-only. [codex §11–12]

CORE 3's own Codex notes say Codex "has no session-start or session-end event" (`INSTALL.md:122`). That is out of date.

### 4.3 Antigravity — from the official docs, changelog, and schemas

Detail and every citation: `research-antigravity.md`. Every page has a markdown copy at `<url>.md`; 106 pages were read. Nothing was run.

- **Hooks exist:** `SessionStart`, `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`. No `SessionEnd`, no `PreCompact`, no `UserPromptSubmit` (the prompt arrives as `lastUserInput` on `PreInvocation`, which fires before every model call). [antigravity §6]
- **Hook format differs from Claude Code's.** Top-level keys are hook-group names; JSON in and JSON out; context goes in through `injectSteps`. A Claude-format `hooks/hooks.json` is not read. Plugin hooks run with the plugin folder as working directory; the workspace comes from `workspacePaths` on stdin. Only `command` hooks. Default timeout 30 seconds. **Hooks fail open silently.** [antigravity §6; `https://antigravity.google/docs/hooks.md`]
- **The hook contract is new and moving.** It changed three times in three weeks; `SessionStart` was never announced in the changelog; a field report says an injected step with `metadata` drops the whole output on CLI 1.5.2. [antigravity §6]
- **Plugins:** `plugin.json` or `.antigravity-plugin/plugin.json`, with `skills/`, `agents/`, `rules/`, `hooks.json`, `mcp_config.json`. The docs allow it beside `.claude-plugin/` in one repository. A skill description may be 1 to 1,024 characters. [antigravity §4, §7]
- **Instruction files:** `AGENTS.md` and `GEMINI.md` are read natively; `CLAUDE.md` is not. [antigravity §2]
- **Memory:** "Agents don't remember conversations." The Knowledge page returns 404. The native route for lessons is `/learn`, which writes only on approval. [antigravity §5]
- **Proactive work:** `/schedule` (per conversation), Automations (App only), sidecars (user must enable), `/goal`, and headless `agy -p`. Headless skips any tool call it cannot get approved and still exits 0. [antigravity §9]
- **Terms:** driving `agy` from another vendor's agent is not supported on consumer plans. [antigravity §9]
- **Google's own cross-harness sample plugin** ships `.claude-plugin/`, `.codex-plugin/`, and a root `plugin.json` side by side, and ships no hooks. [antigravity §7]

### 4.4 Anthropic's `productivity` plugin, installed in this container

Read from `~/.claude/plugins/synced/…/productivity/` `[cmd: find; cat]`. Version 1.3.1. Four skills (`memory-management`, `task-management`, `start`, `update`), a `.mcp.json`, and no scripts or hooks. Its memory design: `CLAUDE.md` as a "hot cache" of about 30 people and terms, kept to 50–80 lines, plus a `memory/` folder of markdown (`glossary.md`, `people/`, `projects/`, `context/`) searched when the hot cache misses (`skills/memory-management/SKILL.md`). Task state lives in `TASKS.md`. It acts when the user runs `/update`. It tracks no risks or decisions. [competitors §2.4]

---

## Part 5 — What the research literature supports

Detail and every citation: `research-literature.md` (peer-reviewed papers, preprints, and vendor engineering posts, each graded by source type).

### 5.1 Context rot
Accuracy falls as input grows, well below the context limit; topically related wrong text hurts more than unrelated text; in Chroma's memory test, about 300 focused tokens beat a 113,000-token full history in every model tested. [literature §1]

### 5.2 Retrieval
Injecting more items helps, then hurts. For agents with tools, search over plain files is a strong baseline; embeddings still win some one-shot tests and some large codebases. [literature §2]

### 5.3 Write policy
No study compares per-turn, end-of-session, and agent-initiated writing head to head. Extraction pipelines omit and invent: HaluMem found every tested system below 62% accuracy and most omitting over half of updates. Anthropic's November 2026 post found models do better when told what memory is for, and that a fixed "record only X" rule lost much of the gain. [literature §3]

### 5.4 Changed facts
Stale and fresh values side by side cause confidently wrong actions. Replace or invalidate at write time and keep the old value as dated history. Decay formulas have little direct evidence. Checking a cited source at read time worked in GitHub's production memory. [literature §4]

### 5.5 Summaries
Summaries drop specifics; keeping the raw record searchable beats summary-only memory in every comparison found. Fixed sections keep more than free prose. [literature §5]

### 5.6 Evaluation
Measure with and without the feature on the same tasks, with repeated runs, graded on outcomes. LLM judges show position, verbosity and self-preference bias; blind them and swap the order. [literature §7]

### 5.7 Security and silent failure
Memory files and hooks are a demonstrated attack path; people approve about 93% of permission prompts, so approval alone is weak. "No data" must never read as "healthy": use three states, a heartbeat, and a known-answer probe. [literature §9–10]

