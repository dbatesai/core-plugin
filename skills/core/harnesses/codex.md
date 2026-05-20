---
name: harness-codex
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Codex CLI, including documented drops for capabilities Codex doesn't deliver.
---

# Harness adapter — Codex CLI

## detect-harness

Detect by:
- `~/.codex/` config directory present, OR
- `$CODEX_HOME` env var set, OR
- Skill discovered under `~/.agents/skills/` (Codex's user-scope skill path), OR
- Absence of Claude-Code-specific tools (`TaskCreate`, `SendMessage`, `TeamCreate`).

If any of these conditions hold, harness is Codex.

## spawn-subagent

Use Codex's subagent invocation surface. Custom agents can be defined at `~/.codex/agents/<name>/`. For ad-hoc exploration, invoke the general agent with the prompt verbatim. Subagent output returns inline.

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

Codex's `update_plan` takes a list of step objects with `{description, status}`. Map `plan-task` to a single `update_plan` call seeding all steps with status `"pending"`. Subsequent `complete-task` calls update specific steps.

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

Codex auto-loads `<project>/AGENTS.md` and `~/.codex/AGENTS.md` at session start (full file, no 200-line cap; default cap is 32 KiB per `project_doc_max_bytes`). Index entries should be one-liners per the hygiene mechanism; topic content lives in sub-files referenced from the index. The hygiene rule "index custody first" becomes more load-bearing on Codex because there's no auto-cap forcing brevity.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Codex's `read`, `write`, `apply_patch`, `shell` + `find`, `shell` + `rg`, `shell`, MCP-server or `shell` + `curl`, MCP-server (Brave / Firecrawl) respectively. No explicit mapping needed.
- The plugin manifest ships in Claude Code format (`plugin.json`). Codex install uses the skill content directly under `~/.agents/skills/core/`; the dual-manifest story is a follow-up.
- Voice baseline catalog ships empty initially. Build empirically if usage warrants.
