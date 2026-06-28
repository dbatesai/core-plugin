---
name: configure-project
description: Bootstrap and health-check a CORE project for the current harness — confirm the install, validate the memory store, resolve workspace identity, report connector capability, and generate the harness instruction surface (AGENTS.md) when a contract exists. Use when setting up CORE on a folder under Codex, when a second harness joins a folder Claude Code already manages, or any time you want a one-shot "is this project wired correctly here?" check. Idempotent; report-only unless you pass --apply.
---

Base directory for this skill: this `SKILL.md`'s directory.

# `/configure-project`

A project store is harness-agnostic (DC-104): Claude Code and Codex co-exist on one folder. This skill is the one-shot setup-and-health check that confirms a given harness is wired correctly against that shared store. It's the Codex-side counterpart to Claude Code's startup mandate — but it runs on either harness.

It is **idempotent** and **report-only by default**. The only write it ever performs is generating `AGENTS.md`, and only when you pass `--apply` *and* a `CONTRACT.md` exists. Workspace identity is detected and reported, never mutated here (forking is `/core`'s job — startup performs it).

## When to reach for it

- Standing up CORE on a folder from Codex for the first time.
- A second harness (Codex) opening a folder Claude Code already manages — confirm it reads as a returning workspace, not a fork.
- A quick "is this project healthy here?" check: store validates, manifests present, identity resolves, instruction surface exists.
- After upgrading the plugin (say, v3.5 to v3.7), to confirm the store is still compatible. If identity reads `would-fork` or validation reports unknown-field warnings, run `/core` and let startup perform the migrations — this skill reports drift, it doesn't fix it.
- On Claude Code, as a printable receipt. Startup already runs the bootstrap there, so nothing is missing without this skill — but `/configure-project` gives you a one-shot report confirming what startup found, which is useful right after install.

## Run it

**Resolve the plugin root from this skill's path**, the same way the other CORE skills do: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/configure-project/SKILL.md` to get `<PLUGIN_ROOT>`. The script lives at `<PLUGIN_ROOT>/skills/core/scripts/configure-project.mjs`. Don't guess the base from an env var; the loaded path carries the resolution.

```bash
# CORE_ROOT = this skill's base dir minus the trailing /skills/configure-project
node "<PLUGIN_ROOT>/skills/core/scripts/configure-project.mjs" \
  --project "$(pwd)" \
  --core-root "<PLUGIN_ROOT>"
# add --harness codex|claude-code to override detection
# add --apply to actually generate AGENTS.md (requires a CONTRACT.md)
# add --json for the structured report instead of the receipt
```

If you cannot substitute `<PLUGIN_ROOT>`, fall back to `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}`. If neither resolves, say so plainly and stop — don't run `node` against an empty path.

## Read the receipt out loud, in plain voice

The script prints two tiers. **Echo both honestly — do not collapse them.**

- **Script-visible** — what the script checked from disk: install + manifests, store validation (units + tier), workspace identity, MCP servers *configured* (declared in config, **not** verified reachable), the optional overlay connector-map, AGENTS.md status, and capability-probe rows. These you can state as facts.
- **Session-live** — questions the script **cannot** answer because they're about the running session, not the filesystem: whether a configured connector is actually reachable and authed *right now*, the Codex `config.toml` server list (not parsed), and the live two-harness check (open the same folder from the other harness). Answer these from your own session knowledge where you can; flag the rest as open.

Never restate a session-live question as a script-asserted fact. "Configured in `~/.claude.json`" is not "available this session" — keep that line bright.

## What it does NOT do

- It does not ship connector name maps. Connector specifics are overlay-owned (see `references/external-sources/source-registration-framework.md`); the script only *reads* a project-local `connector-map.json` if an overlay provides one.
- It does not fork or register a workspace. If identity reads `would-fork`, run `/core` to perform the registration.
- It does not generate `AGENTS.md` without a `CONTRACT.md`. That's the common case today; it reports `skipped — no CONTRACT.md` and moves on.
