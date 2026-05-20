---
name: harness-claude-code
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Claude Code (CLI or Desktop).
---

# Harness adapter — Claude Code

## detect-harness

Detect by:
- `~/.claude/` config directory present, OR
- `${CLAUDE_PLUGIN_ROOT}` env var present, OR
- Availability of Claude-Code-specific tools (`TaskCreate`, `SendMessage`, `TeamCreate`, `CronCreate`).

If any of these conditions hold, harness is Claude Code.

## spawn-subagent

Use the `Agent` tool. Pick `subagent_type="Explore"` for semantic reasoning over the unit store, `subagent_type="general-purpose"` for open-ended investigation, or a specialized agent name (e.g., `feature-dev:code-explorer`) when one matches. Pass the prompt verbatim. Subagent output returns as a tool result.

## spawn-team

`TeamCreate` with `team_name=<name>` and one entry per agent in `agents`. Each entry carries its prompt (including `agents/base-protocol.md` + the role definition). Per CORE's anti-anchoring discipline, each agent's prompt explicitly says "write your initial frame before reading other agents' output." TeamCreate returns when all agents complete.

## send-message

`SendMessage` with `to=<agent_name>` and `content=<message>`. Real-time delivery; the receiving agent sees the message on its next turn.

## await-completion

Implicit — agents poll their inbox via `SendMessage` listings each turn. The Validator role waits for the Editor's "Changes complete" SendMessage explicitly (see `agents/roles.md` §Validator). For team-wide completion, the orchestrating agent reads each agent's final output via `SendMessage` or team result.

## plan-task

`TaskCreate` per step. Use `addBlocks` / `addBlockedBy` parameters for sequential dependencies. `TaskList` reads current state; `TaskUpdate` mutates.

## complete-task

`TaskUpdate(taskId=id, status="completed")`.

## notify-user

- **Low:** in-conversation message only.
- **Medium:** `osascript` shell command for sound + banner via `Bash` tool.
- **High:** `PushNotification` tool for push/SMS escalation. ntfy/Discord fallback via `~/.claude/hooks/` configured per user.

## schedule

- **Recurring:** `CronCreate` with a 5-field cron expression in UTC. Minimum 1-hour interval per the Claude Code platform constraint.
- **One-shot delayed self-invocation:** `ScheduleWakeup` with delay in seconds.

## hook-register

Edit `~/.claude/settings.json` (global) or `<project>/.claude/settings.json` (project). Add an entry to the `hooks.<event>` array referencing a script path. PreToolUse hooks can block; PostToolUse hooks observe; SessionStart/SessionEnd run at lifecycle boundaries. The plugin ships hooks at `hooks/hooks.json` under `${CLAUDE_PLUGIN_ROOT}`.

## read-auto-memory

Read `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` (first 200 lines auto-injected at session start; rest available on-demand). Cross-project index at `~/.claude/memory/memory.md`.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Claude Code's `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch` respectively. No explicit mapping needed.
- No drops on Claude Code — this is the harness CORE was designed against; every verb resolves cleanly.
