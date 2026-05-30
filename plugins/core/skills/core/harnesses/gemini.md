---
name: harness-gemini
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Gemini (Antigravity SDK), including documented drops for capabilities Gemini doesn't deliver.
Status: draft — unverified
---

# Harness adapter — Gemini (Antigravity SDK)

## detect-harness

Detect by:
- `~/.gemini/` config directory present, OR
- Availability of Gemini-specific Antigravity SDK tools (`invoke_subagent`, `send_message`, `manage_subagents`, `manage_task`).

If any of these conditions hold, harness is Gemini.

## spawn-subagent

Use the `invoke_subagent` tool. Pass the specific role and prompt verbatim. Subagents execute in the background, and output returns via a system message containing the subagent's result when it completes or sends a message.

## spawn-team

Gemini natively supports concurrent team invocation via `invoke_subagent`'s `Subagents` array. Pass multiple subagent configurations (Critic, Generator, Validator, etc.) in a single call. Anti-anchoring discipline still applies: the prompt must explicitly instruct each agent to write its initial frame before relying on other agents' outputs. Output synthesis is performed by the parent agent upon receiving messages or completion signals from the subagents.

## send-message

Use the `send_message` tool to communicate with another agent by its conversation ID (returned by `invoke_subagent`). Real-time delivery; the receiving agent is automatically woken up to process the message.

## await-completion

Implicit. Antigravity execution blocks (goes to sleep) when no tools are called, and uses "reactive wakeup" to automatically resume when a subagent sends a message or completes. No explicit polling loops are required.

## plan-task

Create an artifact at `<appDataDir>/brain/<conversation-id>/task.md`. This file acts as the structured task tracking surface with ordered steps and statuses.

## complete-task

Update the `<appDataDir>/brain/<conversation-id>/task.md` artifact using `replace_file_content` or `multi_replace_file_content` to mark steps as completed.

## notify-user

In-conversation text only. Directly output visible text to communicate with the user.

## schedule

Use the `schedule` tool. Supports both recurring cron expressions and one-shot duration timers. Executed as background tasks that send notifications to the agent upon triggering.

## hook-register

**DROPPED** on Gemini.

Antigravity does not currently expose user-configurable `PreToolUse` or `PostToolUse` lifecycle hooks in the same way Claude Code does. The skill-edit PWD guard and other pre-execution blocks must be handled via agent self-discipline.

## read-auto-memory

Gemini does not use an auto-injected `MEMORY.md` file at session start. Context relies on chronological conversation history and explicit reads.

To recover past context, the agent must read the transcript log at `<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` or read the workspace synthesis files (`<project>/PROJECT.md`, `<project>/_memories/`). Auto-memory essentially degrades to reading standard context.

## save-recall-note

Write the provided content to:

```
<appDataDir>/brain/<conversation-id>/scratch/<timestamp>-<slug>.md
```

This uses Gemini's persistent scratch directory intended for temporary scripts and one-off data files.

If the content is also project-canonical, write a CORE observation to `<project>/_memories/observations/<YYYY-MM>/` separately, per `protocols/data-storage.md`.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Gemini's native tools.
- Path derivation rules must be used for companion skills (e.g. `/orient`, `/finalize`), since no `$GEMINI_PLUGIN_ROOT` environment variable is automatically exposed to bash tools. Paths derive from the loaded `SKILL.md` absolute path.
