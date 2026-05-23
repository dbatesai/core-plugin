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

Codex's `update_plan` takes a list of step objects keyed by a step identifier with a `status` field (current shape: `{step, status}` — verify against the installed Codex CLI's tool schema, since this surface has churned across May 2026 GA). Map `plan-task` to a single `update_plan` call seeding all steps with status `"pending"`. Subsequent `complete-task` calls update specific steps. If the schema doesn't match, inspect the Codex tool definition and adapt — the verb-level intent (seed all steps as pending, mutate one to completed on each tick) is stable; only the field names move.

## complete-task

Call `update_plan` with the same plan, mutating the step at id `id` to status `"completed"`. Codex re-renders the plan on each call.

## notify-user

**DROPPED** on Codex. In-conversation alerts only — the agent surfaces the message in its turn output and the user sees it when reading the session. No mid-turn notifications, no shell-out to ntfy/osascript. CORE on Codex is a synchronous, in-conversation-only product.

## schedule

**DROPPED** on Codex. CORE on Codex is synchronous and user-driven; no scheduled work runs in the background. Protocols that would normally schedule something (e.g., "check the deploy in 30 minutes") instead surface a "run this manually next time" reminder in conversation. If a user genuinely wants scheduled CORE work, they're on Claude Code.

## hook-register

**DROPPED for pre-execution blocking** on Codex pending empirical validation.

Codex hooks went GA in May 2026. The public docs detail thread-lifecycle and turn-lifecycle contributor hooks but do not detail pre-execution blocking semantics. The skill-edit PWD guard (and any other hook expected to block a tool call before execution) becomes agent-self-discipline on Codex — the agent reads the PWD requirement from `protocols/data-storage.md` and complies; no harness-level enforcement.

Re-open this drop once a live Codex CLI install validates whether Codex hooks can:
1. Block pre-execution.
2. Inject context like Claude Code's `additionalContext`.
3. Run at the events CORE needs (PreToolUse, PostToolUse, SessionStart, SessionEnd, UserPromptSubmit).

## read-auto-memory

Codex does not have a Claude-style per-project `MEMORY.md` auto-memory cache.

Startup context comes from `<project>/AGENTS.md` and `~/.codex/AGENTS.md`; treat those as instruction surfaces, not project memory. They may contain stable rules and pointers, but project facts still live in `<project>/PROJECT.md` and `<project>/_memories/`.

Codex assistant memory under `~/.codex/memories/` is harness-local recall. Treat it like scratch cache: useful for hints, never authoritative. Verify project-specific claims against the CORE unit store before acting. Per `dc-86-harness-local-memory-recall`, this is surface 4 in the five-level authority ordering at `protocols/data-storage.md §"Authority ordering"`.

Codex memory writes are not part of normal CORE project curation. Write project observations to `<project>/_memories/observations/...`. Codex memory is the explicit-save surface; mechanics live in `save-recall-note` below. CORE does not encode trigger phrases for when to invoke it — that's install-level configuration in the user's `AGENTS.md`.

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

What belongs on this surface (per DC-86):
- Cross-session workflow lessons
- User preferences for assistant behavior
- Harness-specific empirical findings
- Pointers to canonical project artifacts
- Short summaries of prior session outcomes useful as warm-start hints

What does NOT (also per DC-86):
- Project facts of record (those go to `PROJECT.md` and `_memories/`)
- Decision units, risk units, person units
- Anything the agent infers should be retired (anti-resurrection applies to recall too)

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Codex's `read`, `write`, `apply_patch`, `shell` + `find`, `shell` + `rg`, `shell`, MCP-server or `shell` + `curl`, MCP-server (Brave / Firecrawl) respectively. No explicit mapping needed.
- The plugin ships dual manifests (`.claude-plugin/plugin.json` for Claude Code, `.codex-plugin/plugin.json` for Codex) in the same repo; Codex installs the bundle into `~/.codex/plugins/cache/<marketplace>/core/<version>/` via `codex plugin marketplace add` + `codex plugin add`. Skill content under `skills/core/` is shared between both harnesses.
- Voice baseline catalog ships empty initially. Build empirically if usage warrants.

### Known RTK collisions on Codex

- **File existence test:** `rtk test -f <path>` collides with the shell `test` builtin and produces noisy usage output. Use `rtk sh -c '[ -f <path> ]'` instead.
- **Grep with directory exclusion:** `rtk grep --exclude-dir=...` is not supported. Use `rg -g '!<dir>/**'` (or `rtk sh -c 'rg -g ...'`) instead.
- **`rtk find` flag passthrough is incomplete.** Standard `find` flags like `-print` and other GNU-find extensions don't always pass through cleanly. When you need specific find behavior, fall back to `rtk sh -c 'find ...'` so the find binary sees its flags directly.

These are RTK-specific, not Codex-specific — but they're worth listing here because Codex sessions tend to use shell more heavily than Claude Code sessions and hit these patterns more often.

### Nested `codex exec` and AGENTS.md discipline

When a Codex slash command spawns nested `codex exec` calls inside its own shell flow (CORE's `/finalize` and `/process-memory` do this when running scripts), the nested call inherits the caller's environment but may not always surface the project's `AGENTS.md` instructions to the inner agent — including project-level RTK guidance. The Round-4 probe surfaced this: outer probe runs honored RTK; CORE-on-Codex shell calls inside the same session did not consistently.

If you're authoring a slash-command flow that spawns nested `codex exec`, do not assume the inner invocation has inherited the project's command discipline. Pass project conventions explicitly into the nested prompt — name the RTK requirement, name any project-specific shell rules — rather than relying on AGENTS.md inheritance.

### `${CLAUDE_PLUGIN_ROOT}` is not set on Codex

Codex doesn't set `${CLAUDE_PLUGIN_ROOT}`. Companion skills that need to invoke scripts in the sibling core skill (`/finalize`, `/process-memory`) must derive the path from the loaded SKILL.md location rather than relying on the env var.

The mechanical rule mirrors the protocol-resolution rule used in `skills/orient/SKILL.md` and `skills/finalize/SKILL.md`: take the absolute path you loaded SKILL.md from, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`, and invoke that. Concretely:

- Claude Code marketplace install: `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs` works because the env var is set.
- Codex plugin-cache install: derive the path from the loaded `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/<wrapper>/SKILL.md`, replace `/skills/<wrapper>/SKILL.md` with `/skills/core/scripts/<script>.mjs`.

Don't construct paths against a guessed plugin base. The loaded path carries the resolution.
