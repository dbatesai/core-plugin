# Harness Adapter Contract

CORE runs on multiple LLM-agent harnesses. The skill content is harness-agnostic; per-harness adapter files at `harnesses/<name>.md` resolve abstract verbs to concrete tool calls. This file defines the contract.

## How adapters work

At session start, the agent runs `detect-harness()` (see below) to identify which harness it's running in, then reads the matching `harnesses/<name>.md` adapter file. The adapter resolves each abstract verb in this contract to the concrete tool calls the agent should use. Drops — operations one harness can't deliver — are named explicitly in the adapter with their rationale.

## Universal verbs (no adapter entry needed)

These operations resolve via inference; the agent picks the right tool per harness without an explicit mapping.

- `read(path)` — read the file at `path`
- `write(path, content)` — write `content` to `path`
- `edit(path, old, new)` — replace `old` with `new` in `path`
- `glob(pattern)` — list files matching `pattern`
- `grep(pattern, scope)` — search for `pattern` within `scope`
- `shell(command)` — execute `command` in a shell
- `web-fetch(url)` — pull the contents of `url`
- `web-search(query)` — search the web for `query`

## Adapter verbs (per-harness mapping required)

These operations have meaningfully different semantics across harnesses. Each adapter file documents the concrete mapping for its harness.

### spawn-subagent(prompt)

Spawn a single subagent for focused exploration or reasoning over the unit store. The subagent runs to completion and returns a result.

### spawn-team(name, agents)

Spawn a multi-agent team (Critic, Generator, Validator, etc.) for adversarial analysis. The orchestrating agent dispatches each role and synthesizes their output.

### send-message(to, content)

Send a message from one agent to another during a multi-agent run. The recipient sees the message on its next turn.

### await-completion(from, signal)

Wait for another agent's completion before proceeding. The agent blocks (or polls) until the signal fires.

### plan-task(subject, steps)

Open a structured task tracking surface with an ordered list of steps. Each step has a description and status.

### complete-task(id)

Mark a tracked task as complete.

### notify-user(level, message)

Surface a notification to the user. Levels: `low` (banner only), `medium` (banner + sound), `high` (push/SMS/escalation).

### schedule(when, prompt)

Invoke self or another agent at a future time. Single-shot or recurring.

### hook-register(event, handler)

Install a harness hook for pre- or post-action events. The handler runs at the specified lifecycle point.

### read-auto-memory()

Read the harness's auto-injected memory index. Source-of-truth for project-scoped memory the harness loads at session start.

### detect-harness()

Identify which harness the current session is running in. Returns one of: `claude-code`, `codex`, or future harness names. Called at session start before any adapter-verb resolution.

## How to use this contract

Skill prose references the abstract verb names (e.g., "spawn a team of critic + generator"). The agent resolves the verb against the loaded harness adapter and executes the concrete tool call. Universal verbs need no resolution — inference handles them.

When extending CORE with a new feature that requires harness-specific machinery, name the verb here first, then add the per-harness mapping in each adapter file. If a verb cannot be mapped on a harness, name the drop with rationale in that adapter.
