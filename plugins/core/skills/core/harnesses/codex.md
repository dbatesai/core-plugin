---
name: harness-codex
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Codex CLI, including documented drops for capabilities Codex doesn't deliver.
---

# Harness adapter — Codex CLI

## detect-harness

Detect by:
- `~/.codex/` config directory present, OR
- `$CODEX_HOME` env var set, OR
- Skill discovered under a Codex user-scope skill path (`~/.codex/skills/`, `~/.agents/skills/`, or a plugin cache under `~/.codex/plugins/cache/`), OR
- Absence of Claude-Code-specific tools (`TaskCreate`, `SendMessage`, `TeamCreate`).

If any of these conditions hold, harness is Codex.

## spawn-subagent

Use Codex's subagent invocation surface. Custom agents can be defined at `~/.codex/agents/<name>/`. For ad-hoc exploration, invoke the general agent with the prompt verbatim. Subagent output returns inline.

**Schema note (unvalidated):** the concrete tool is `spawn_agent` (see the nickname note below), but its parameter schema is not verified against a live Codex CLI install. Before the first spawn of a session, inspect the installed Codex tool definition for the actual tool name, required params, and result shape. The verb-level intent is stable — pass the brief verbatim as the prompt, read the result inline — even if field names moved. Treat any parameter shape written here as a starting hypothesis, not a contract, until a live install validates it.

Codex's `spawn_agent` tool may return its own generated nickname (e.g., `Dalton`, `Bohr`) for the subagent invocation. That nickname is at the tool-instance layer — Codex's bookkeeping — not the CORE identity layer. The CORE identity lives in the brief, the log filename, and what the agent calls itself in its own narrative. Ignore the returned nickname for CORE purposes; the file-scratchpad filename is the authoritative identity surface.

## spawn-team

Codex has no team primitive. Use the **file-scratchpad pattern**:

1. Create the scratchpad directory: `<project>/_sessions/<date>/<name>/`.
2. For each agent in `agents`, write a brief at `<scratchpad>/<agent-name>-brief.md` containing base-protocol + role + the team-wide context.
3. Spawn each agent in sequence (or in parallel via Codex's subagent feature). Each agent reads its own brief PLUS any prior agents' output logs in the scratchpad before producing its own.
4. Each agent writes its output to `<scratchpad>/<agent-name>-log.md`.
5. The orchestrating agent reads all logs and synthesizes.

Anti-anchoring discipline: the Critic's brief explicitly says "write your initial frame to `<scratchpad>/<critic-name>-frame.md` BEFORE reading any generator output." This is the file-system equivalent of the in-prompt instruction the Claude Code adapter uses. Trust the agent to honor it.

## send-message

Append to a file: `<scratchpad>/<from>-to-<to>-<UTC-timestamp>.md` with the message body. The recipient agent reads its inbox (files starting with `*-to-<self>-*.md` newer than its last read) on each turn.

## await-completion

Poll the scratchpad. The completion signal is the presence of `<scratchpad>/<from>-complete.md` (or a `status: complete` line in the agent's log file). Implicit polling cadence: every turn, the waiting agent checks before proceeding.

## plan-task

Codex's `update_plan` takes an ordered list of step objects shaped `{step, status}` — step text plus a status, with no identifier field. Verify against the installed Codex CLI's tool schema before the first call; this surface is not stable across Codex releases. Map `plan-task` to a single `update_plan` call seeding all steps with status `"pending"`. Subsequent `complete-task` calls update specific steps. If the schema doesn't match, inspect the Codex tool definition and adapt — the verb-level intent (seed all steps as pending, mutate one to completed on each tick) is stable; only the field names move.

## complete-task

Call `update_plan` with the same plan, mutating one entry to status `"completed"`. The entry shape carries no identifier, so address the entry by its `step` text (or, if two steps share text, by its position in the list) — not by an `id` field. Codex re-renders the plan on each call.

## notify-user

**DROPPED** on Codex. In-conversation alerts only — the agent surfaces the message in its turn output and the user sees it when reading the session. No mid-turn notifications, no shell-out to ntfy/osascript. CORE on Codex is a synchronous, in-conversation-only product.

## schedule

**DROPPED** on Codex. CORE on Codex is synchronous and user-driven; no scheduled work runs in the background. Protocols that would normally schedule something (e.g., "check the deploy in 30 minutes") instead surface a "run this manually next time" reminder in conversation. If a user genuinely wants scheduled CORE work, they're on Claude Code.

## automatic session start

**DROPPED** on Codex. `hooks/hooks-codex.json` registers `UserPromptSubmit` only — there is no `SessionStart`-equivalent door, so nothing invokes `startup.md` on its own. Everything `startup.md` performs (the returning-workspace load, the decoration + index-refresh backstop, the startup catch-up below, the readiness summary) happens **only when the user explicitly types `/core`**. `/configure-project` is a health check on the install and the store; it does not run startup and does not discharge owed close work.

Read every "runs unconditionally, every session" line in `startup.md` as "runs unconditionally, every session that starts with `/core`" when the harness is Codex. Re-open this drop if a live Codex install validates a session-start-equivalent event, or if a once-per-session guard is wired into the `UserPromptSubmit` door.

## close-pass (self-managed session close)

**Automatic close DROPPED** on Codex. On Claude Code a `SessionEnd` hook enqueues a deterministic, zero-model close for the exact session that ended (`close-pass.mjs process-request` — lifecycle receipt only, no model calls, no PROJECT.md or unit writes). Codex has no validated `SessionEnd`-equivalent hook that can spawn a surviving background process (see `hook-register` below), so no close fires on its own.

What Codex has instead, and its exact bound: the user runs `/finalize` explicitly, or the next session that begins with `/core` runs the catch-up path (`startup.md §"Startup catch-up"`) — `close-pass.mjs detect` finds an owed or partial close and discharges the remainder before readiness. The per-op marker, single-flight lock, and three-state detection are harness-agnostic and behave identically; only the trigger differs. Because that trigger is an explicit `/core`, a Codex session that never types it leaves the owed close undischarged for as long as the user keeps not typing it. Say that plainly rather than describing Codex close as equivalent-with-later-timing. Re-open this drop if a live Codex install validates a `SessionEnd`-equivalent hook that can spawn a detached process.

## hook-register

**DROPPED for pre-execution blocking** on Codex — pre-execution blocking semantics are not documented for this harness and have not been validated on a live install.

Codex's public docs detail thread-lifecycle and turn-lifecycle contributor hooks but do not detail pre-execution blocking semantics. The skill-edit PWD guard (and any other hook expected to block a tool call before execution) becomes agent-self-discipline on Codex — the agent reads the PWD requirement from `protocols/data-storage.md` and complies; no harness-level enforcement.

Re-open this drop once a live Codex CLI install validates whether Codex hooks can:
1. Block pre-execution.
2. Inject context like Claude Code's `additionalContext`.
3. Run at the events CORE needs (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit).

**What Codex registers.** Per the official Codex contract ([plugin hook contract](https://developers.openai.com/codex/plugins/build#bundled-mcp-servers-and-lifecycle-hooks), [Stop event contract](https://developers.openai.com/codex/hooks#stop)), Codex supports two turn-scoped events — `UserPromptSubmit` and `Stop` — both carrying `session_id` and a Codex-native `turn_id`; plugin-bundled hooks receive `PLUGIN_ROOT`/`PLUGIN_DATA` env vars (`CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` as compatibility aliases); a plugin registers hooks via an explicit `"hooks"` manifest field or Codex's automatic `./hooks/hooks.json` discovery.

CORE ships `hooks/hooks-codex.json` — registered via `.codex-plugin/plugin.json`'s explicit `"hooks"` field, deliberately not relying on the automatic-discovery default, because that default resolves to the same path as Claude Code's `hooks/hooks.json` and would risk Codex picking up Claude-only hook files. It wires exactly one door: `UserPromptSubmit` → `retrieve-context-hook-codex.mjs` (per-turn retrieval). The wrapper is thin — pure JS, no shell env-var-prefix tricks, which don't work on Windows — and sets `CORE_HOOK_HARNESS=codex` explicitly before delegating to the shared `retrieve-context-hook.mjs` implementation. Harness identity is never inferred from ambient env vars for hooks reached through this wrapper (`CODEX_SESSION_ID`/`CODEX_PLUGIN_ROOT` are undocumented, unreliable signals) — the wrapper sets it explicitly and authoritatively.

**The bound on that registration.** One turn-scoped door is all Codex gets: no session-start door, no session-end door, and no pre-execution block. Whether the registered door fires end to end is an installed-behavior question, answered per candidate by running the packaged plugin on a real Codex CLI and reading the receipts (`retrieve-context:delivered:ok` with a native session identity). A proof at one commit does not carry to the next; re-run it against whatever candidate is current.

## read-auto-memory

Codex can inject memory-like context at session start when `features.memories = true` (experimental). When it does, the context is gated by `no_memories_if_mcp_or_web_search = true` and may be suppressed depending on session configuration. Treat any injected memory as harness-local recall — scratch cache, not project truth. Verify project-specific claims against the CORE unit store before acting. Startup probe, concretely: pick one fact you'd expect injected (the most recent session's one-line summary, or a canary-tagged line if one exists) and check whether it is already in your context *without reading any file*. Present → injection occurred; treat it as scratch cache. Absent → treat injection as not-occurred this session and rely on the CORE unit store alone; do not read the memory file to simulate injection.

Startup context also comes from `<project>/AGENTS.md` and `~/.codex/AGENTS.md`; treat those as instruction surfaces, not project memory. Project facts live in `<project>/PROJECT.md` and `<project>/_memories/`.

Codex assistant memory under `~/.codex/memories/` is harness-local recall, level 5 in the five-level authority ordering at `protocols/data-storage.md §"Authority ordering"`. Codex memory writes are not part of normal CORE project curation. Write project observations to `<project>/_memories/observations/...`. Codex memory is the explicit-save surface; mechanics live in `save-recall-note` below. CORE does not encode trigger phrases for when to invoke it — that's install-level configuration in the user's `AGENTS.md`.

## save-recall-note

Write the provided content as one ad hoc note to:

```
~/.codex/memories/extensions/ad_hoc/notes/<timestamp>-<slug>.md
```

- `<timestamp>` is UTC ISO-8601 compact form, e.g. `20260521T173801Z`
- `<slug>` is a short kebab-case description, e.g. `core-codex-probe-observations`

Do not edit any existing Codex memory file or index. Codex's own memory system manages those.

The verb writes only to the Codex recall surface. If the content is also project-canonical (a real observation about the project, not a workflow hint), write a CORE observation to `<project>/_memories/observations/<YYYY-MM>/` separately as part of normal autonomous curation per `protocols/data-storage.md`. The two writes are not duplicates — the Codex note is recall-shaped (workflow hint), the CORE observation is project-shaped (graduates into units under hygiene).

After writing, acknowledge the save to the user in plain voice — name the path.

What belongs on this surface:
- Cross-session workflow lessons
- User preferences for assistant behavior
- Harness-specific empirical findings
- Pointers to canonical project artifacts
- Short summaries of prior session outcomes useful as warm-start hints

What does NOT (per the same recall-vs-project-store split):
- Project facts of record (those go to `PROJECT.md` and `_memories/`)
- Decision units, risk units, person units
- Anything the agent infers should be retired (anti-resurrection applies to recall too)

## configure-project

Codex has no startup-mandate hook the way Claude Code does. `/configure-project` is the install-and-store health check, not a replacement for startup: it does not load the workspace, run catch-up, or print readiness — type `/core` for that. What it does do: resolve `CORE_ROOT`, confirm the manifests + skill dir + this adapter are present, runs the workspace fork-check in detect-only mode (a path already registered is a *returning* workspace regardless of which harness registered it — Codex opening a Claude-managed folder is not a fork), validates the `_memories/` store, reports configured-vs-session-live connector capability, runs the capability probe, and generates `AGENTS.md` from `CONTRACT.md` when one exists.

Run it as the setup step on a folder, or any time you want a "is this project wired correctly under Codex?" check:

```bash
# Derive PLUGIN_ROOT from the loaded SKILL.md path (the `${CLAUDE_PLUGIN_ROOT}`
# rule below). The script self-resolves CORE_ROOT too, but pass --core-root for safety.
# Run from the project directory and OMIT --project — the script defaults to the
# process cwd. ($(pwd) is bash-only: PowerShell evaluates it to a PathInfo object
# and the argument breaks silently.)
node "<PLUGIN_ROOT>/skills/core/scripts/configure-project.mjs" --core-root "<PLUGIN_ROOT>" --harness codex
# Not in the project directory? Pass --project with an absolute literal path.
# --apply to actually write AGENTS.md (needs a CONTRACT.md); --json for the structured report
```

It is idempotent and report-only unless `--apply` is passed. Echo both tiers of the receipt honestly — the script-visible rows are facts; the session-live rows (is a configured connector reachable+authed *this session*? the `~/.codex/config.toml` server list, which the script does not parse; the live two-harness check) are questions only the running session can answer. Never restate a session-live question as a script-asserted fact. Full behavioral contract: `skills/configure-project/SKILL.md`.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Codex's `read`, `write`, `apply_patch`, `shell` + `find`, `shell` + `rg`, `shell`, MCP-server or `shell` + `curl`, MCP-server (Brave / Firecrawl) respectively. No explicit mapping needed.
- The plugin ships dual manifests (`.claude-plugin/plugin.json` for Claude Code, `.codex-plugin/plugin.json` for Codex) in the same repo; Codex installs the bundle into `~/.codex/plugins/cache/<marketplace>/core/<version>/` via `codex plugin marketplace add` + `codex plugin add`. Skill content under `skills/core/` is shared between both harnesses. The manifests are intentionally asymmetric: the Claude manifest carries `build` (startup's readiness line reads it — single source of truth), the Codex manifest carries `skills` and `interface` (Codex marketplace requirements with no Claude Code equivalent). Name/version/license/author must always agree — this repo's CI enforces it on every change, via a test that lives outside the shipped `plugins/core/` tree (a source-repo guarantee, not an installed file).
- Voice baseline catalog ships empty initially. Build empirically if usage warrants.

### Known RTK collisions on Codex

- **File existence test:** `rtk test -f <path>` collides with the shell `test` builtin and produces noisy usage output. Use `rtk sh -c '[ -f <path> ]'` instead.
- **Grep with directory exclusion:** `rtk grep --exclude-dir=...` is not supported. Use `rg -g '!<dir>/**'` (or `rtk sh -c 'rg -g ...'`) instead.
- **`rtk find` flag passthrough is incomplete.** Standard `find` flags like `-print` and other GNU-find extensions don't always pass through cleanly. When you need specific find behavior, fall back to `rtk sh -c 'find ...'` so the find binary sees its flags directly.

These are RTK-specific, not Codex-specific — but they're worth listing here because Codex sessions tend to use shell more heavily than Claude Code sessions and hit these patterns more often.

### `${CLAUDE_PLUGIN_ROOT}` is not set on Codex

Codex doesn't set `${CLAUDE_PLUGIN_ROOT}`. Companion skills that need to invoke scripts in the sibling core skill (`/finalize`, `/process-memory`) must derive the path from the loaded SKILL.md location rather than relying on the env var.

The mechanical rule mirrors the protocol-resolution rule used in `skills/finalize/SKILL.md` and `skills/process-memory/SKILL.md`: take the absolute path you loaded SKILL.md from, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`, and invoke that. Concretely:

- Claude Code marketplace install: `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs` works because the env var is set.
- Codex plugin-cache install: derive the path from the loaded `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/<wrapper>/SKILL.md`, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`.

Don't construct paths against a guessed plugin base. The loaded path carries the resolution.
