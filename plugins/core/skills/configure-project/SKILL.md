---
name: configure-project
description: Bootstrap and health-check a CORE project for the current harness — confirm the install, validate the memory store, resolve workspace identity, report connector capability, and generate the harness instruction surface (AGENTS.md) when a contract exists. Use when setting up CORE on a folder under Codex, when a second harness joins a folder Claude Code already manages, or any time you want a one-shot "is this project wired correctly here?" check. Idempotent; report-only unless you pass --apply.
allowed-tools:
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/*.mjs *)
  - Bash(node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/*.mjs)
---

Base directory for this skill: this `SKILL.md`'s directory.

# `/configure-project`

A project store is harness-agnostic: Claude Code and Codex co-exist on one folder. This skill is the one-shot setup-and-health check that confirms a given harness is wired correctly against that shared store. It's the Codex-side counterpart to Claude Code's startup mandate — but it runs on either harness.

It is **idempotent** and **report-only by default**. The only write it ever performs is generating `AGENTS.md`, and only when you pass `--apply` *and* a `CONTRACT.md` exists. Workspace identity is detected and reported, never mutated here (forking is `/core`'s job — startup performs it).

## When to reach for it

- Standing up CORE on a folder from Codex for the first time.
- A second harness (Codex) opening a folder Claude Code already manages — confirm it reads as a returning workspace, not a fork.
- A quick "is this project healthy here?" check: store validates, manifests present, identity resolves, instruction surface exists.
- After upgrading the plugin (say, v3.5 to v3.7), to confirm the store is still compatible. If identity reads `would-fork` or validation reports unknown-field warnings, run `/core` and let startup perform the migrations — this skill reports drift, it doesn't fix it.
- On Claude Code, as a printable receipt. Startup already runs the bootstrap there, so nothing is missing without this skill — but `/configure-project` gives you a one-shot report confirming what startup found, which is useful right after install.

## Run it

**Where the scripts are.** `<scripts>` below is `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts` — type that path in full, one `node <scripts>/<name>.mjs …` per Bash call, nothing chained, no `cd`, no variable prefix, no redirect. (If the variable shows unexpanded, the harness didn't substitute it: take this skill's base directory, strip `/skills/configure-project`, append `/skills/core/scripts`.) If `node` answers `Cannot find module`, the install path is wrong or stale: say so, skip that step, and never run against a guessed path.

Run from the project directory; omitting `--project` uses the current directory on Bash and PowerShell. The script finds its own plugin root from where it lives:

```bash
node <scripts>/configure-project.mjs
```

Add `--harness codex|claude-code` to override detection, `--apply` to actually generate AGENTS.md (requires a CONTRACT.md), `--json` for the structured report instead of the receipt.

**`--permissions`** prints the one standing allow rule that lets every CORE script run without a prompt on later turns (the skill `allowed-tools` only covers the turn that invokes a CORE skill). It is written against the live install path with the version folder replaced by `*`, so it survives plugin updates, and it names the settings file it belongs in (`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`). It never writes that file: this script runs pre-approved by the skill's own `allowed-tools`, and a pre-approved command must not widen its own standing permissions — the user pastes the rule in. Read the rule back in plain words, including its limit: `*` also matches `..`, so the rule bounds the command text, not where a script may live — deny and ask rules, and any command gate the user runs, still stand above it.

## Read the receipt out loud, in plain voice

The script prints two tiers. **Echo both honestly — do not collapse them.**

- **Script-visible** — what the script checked from disk: install + manifests, store validation (units + tier), workspace identity, MCP servers *configured* (declared in config, **not** verified reachable), the optional overlay connector-map, AGENTS.md status, and capability-probe rows. These you can state as facts.
- **Session-live** — questions the script **cannot** answer because they're about the running session, not the filesystem: whether a configured connector is actually reachable and authed *right now*, the Codex `config.toml` server list (not parsed), and the live two-harness check (open the same folder from the other harness). Answer these from your own session knowledge where you can; flag the rest as open.

Never restate a session-live question as a script-asserted fact. "Configured in `~/.claude.json`" is not "available this session" — keep that line bright.

## What it does NOT do

- It does not ship connector name maps. Connector specifics are overlay-owned (see `references/external-sources/source-registration-framework.md`); the script only *reads* a project-local `connector-map.json` if an overlay provides one.
- It does not fork or register a workspace. If identity reads `would-fork`, run `/core` to perform the registration.
- It does not generate `AGENTS.md` without a `CONTRACT.md`. That's the common case today; it reports `skipped — no CONTRACT.md` and moves on.
