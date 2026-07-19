---
name: harness-claude-code
description: Concrete tool mapping for each abstract adapter verb when CORE runs inside Claude Code (CLI or Desktop).
---

# Harness adapter — Claude Code

## detect-harness

Detect by:
- `~/.claude/` config directory present, OR
- `${CLAUDE_PLUGIN_ROOT}` env var present, OR
- Availability of Claude-Code-specific tools — the orchestration surface (`TaskCreate`, `SendMessage`, `TeamCreate`, `Monitor`), the scheduling surface (`ScheduleWakeup`, `CronCreate`), and dynamic multi-agent (`Workflow`). Any one is a positive signal; several may be deferred behind `ToolSearch` rather than top-level, so absence of a single tool is not disqualifying.

If any of these conditions hold, harness is Claude Code.

## spawn-subagent

Use the `Agent` tool. Pick `subagent_type` by task:
- `Explore` — semantic reasoning / broad fan-out search over the unit store (Tier 3 retrieval).
- `Plan` — implementation-plan design without writing code.
- `general-purpose` — open-ended multi-step investigation.
- A specialized agent when one matches: `feature-dev:code-explorer` (trace a feature), `feature-dev:code-architect` (design a feature), `feature-dev:code-reviewer` / `pr-review-toolkit:*` (review), `code-simplifier`.

Pass the prompt verbatim (include `agents/base-protocol.md` + any role definition). Subagent output returns as a tool result. For an agent that mutates files in parallel with others, add `isolation: "worktree"` so it works in its own git worktree and parallel edits don't collide (it's auto-cleaned if unchanged) — expensive, so only when there's real write contention.

## spawn-team

Two native substrates; pick by which adversarial phase you're running. The anti-convergence discipline itself stays in core prose (`protocols/analysis.md`) — neither substrate enforces it, so this adapter only maps the *execution*, never the reasoning rules.

- **Isolated fan-out (Phase 1 independent framing + Phase 2 cross-pollination):** the `Workflow` tool. `agent(prompt, {schema})` is one-shot (prompt→validated result); `parallel(thunks)` / `pipeline(...)` run genuinely fresh-context agents concurrently. Fresh context is isolation-*positive* but not a guarantee — a script author can still leak Generator output into a Critic prompt — so **Critic-frames-first stays doctrine in `analysis.md`, not something Workflow gives you for free.** Workflow is **user-gated** (the user must opt in), so treat it as an opportunistic optimization, never CORE's assumed substrate; fall back to `TeamCreate` or the file-scratchpad pattern when it's unavailable.
- **Multi-round adversarial pressure (Phase 3 persuasion-log + mind-changes accumulation):** `TeamCreate` with `team_name=<name>` and one entry per agent in `agents`, each carrying its prompt (`agents/base-protocol.md` + role). `Workflow.agent()` *cannot* do this — it's one-shot with no inter-agent turns — so Phase 3 needs Teams + `SendMessage` + `Monitor`. Each agent's prompt explicitly says "write your initial frame before reading other agents' output." `TeamCreate` returns when all agents complete.

For parallel file-mutating team agents, the same `isolation: "worktree"` guidance as spawn-subagent applies (Workflow exposes it via `isolation: 'worktree'` per-`agent()`).

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

- **Dynamic-cadence self-re-entry (the default for collab loops and any backing-off poll):** `ScheduleWakeup` with `delaySeconds`. Prefer this over `/loop` for anything with a *variable* cadence — `/loop` is fixed-interval and flattens a dynamic ladder (e.g. collab's fast→slow back-off), so it wastes turns when idle and reacts late when busy. **Wire the wake to an idempotent command, never a one-shot side-effecting one:** a wake re-fires the *full* command, so it must be safe to run repeatedly (e.g. the collab tick script, which is idempotent by design — re-running recomputes state). Pass the same continuation prompt back each fire; stop scheduling when the loop's exit condition is met.
- **Fixed-interval recurring:** `/loop <interval> <command>` when the cadence genuinely is fixed and the command is idempotent. Use `CronCreate` (5-field UTC cron, ≥1-hour interval per the platform constraint) only for cross-session recurring schedules that must survive the session ending.
- **Parity note (DC-75):** `schedule` is a *drop* on Codex (no native scheduler) — Codex uses supervised re-entry at the computed cadence, and collab's portable cadence-compute + supervised re-entry is the cross-harness baseline. ScheduleWakeup is a Claude-Code optimization layered on that portable policy, not a replacement for it.

## hook-register

Edit `~/.claude/settings.json` (global) or `<project>/.claude/settings.json` (project). Add an entry to the `hooks.<event>` array referencing a script path. PreToolUse hooks can block; PostToolUse hooks observe; SessionStart/SessionEnd run at lifecycle boundaries. The plugin ships hooks at `hooks/hooks.json` under `${CLAUDE_PLUGIN_ROOT}`.

**Post-answer outcome close (Hale audit, 2026-07-17).** `Stop` fires once, right after Claude's response completes — a genuine post-answer event, distinct from `SessionEnd` (once per session) and from inferring closure off the next `UserPromptSubmit` (sequencing, not observation). `hooks/answer-close-hook.mjs` is registered on `Stop` and closes the per-turn retrieval hook's pending outcome using the harness's own `prompt_id` (Claude Code v2.1.196+ — the common-fields `prompt_id` uniquely identifies the turn) as the real `answer_turn_id`, never an alias of `retrieval_id`. Falls back to a freshly-generated id, still never aliased, on older builds without `prompt_id`. See `harnesses/codex.md §hook-register` for why this stays Claude-Code-only for now.

## read-auto-memory

Read `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` (first 200 lines auto-injected at session start; rest available on-demand). Cross-project index at `~/.claude/memory/memory.md`.

Per `dc-86-harness-local-memory-recall`, this is harness-local recall — level 5 in the five-level authority ordering at `protocols/data-storage.md §"Authority ordering"`. Treat as scratch cache: useful for warm-start hints, never authoritative. Verify project-specific claims against `<project>/_memories/` before acting.

## save-recall-note

Claude Code's auto-memory is rebuilt from synthesis on each bootstrap rather than written-to directly, so explicit "save a recall note for next session" has a different shape than Codex's ad-hoc-notes surface. Two options on Claude Code, depending on what the content actually is:

- **Workflow hint / cross-session preference** → append to `~/.claude/memory/<topic>.md` (cross-project) or `~/.claude/projects/<encoded-cwd>/memory/<file>.md` (project-scoped). These survive bootstrap because the auto-memory loader reads them directly.
- **Project-canonical observation** → write to `<project>/_memories/observations/<YYYY-MM>/` via the autonomous-curation path in `protocols/data-storage.md`. That's where project facts of record live; auto-memory rebuilds from synthesis to reference them.

If the content is both (a workflow hint AND a project fact), do both writes — they aren't duplicates, they serve different surfaces. See `harnesses/codex.md §save-recall-note` for the same dual-write discipline.

What belongs on the recall surface vs. the project store mirrors DC-86: workflow lessons, harness/install preferences, warm-start hints → recall; decisions, risks, project state → project store.

## Notes

- Universal verbs (`read`, `write`, `edit`, `glob`, `grep`, `shell`, `web-fetch`, `web-search`) resolve via inference to Claude Code's `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebFetch`, `WebSearch` respectively. No explicit mapping needed.
- No drops on Claude Code — this is the harness CORE was designed against; every verb resolves cleanly.
