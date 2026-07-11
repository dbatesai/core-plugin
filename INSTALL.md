# Install

CORE is a Claude Code plugin hosted on GitHub. The quickest way in is the marketplace path below. If you're on Codex, or you want to run a local copy, those are further down.

## Install (Claude Code)

You add the marketplace once, then install the plugin from it. Do it from inside a Claude session or from the terminal — same result.

**Inside the Claude Code app**, paste these two lines into any session:

```
/plugin marketplace add dbatesai/core-plugin
/plugin install core@core
```

**From the terminal** with the `claude` CLI:

```
claude plugins marketplace add dbatesai/core-plugin
claude plugins install core@core
```

Start a fresh session and type `/core`. That's it — the plugin registers the main skill and its companion skills, and your `~/.claude/settings.json` is left alone.

## What you get

| Slash command | What it does |
|---|---|
| `/core` | The agent. Starts the session, loads your project context (picking a thread back up with a readiness summary), and talks with you. |
| `/finalize` | Close a session — write a summary, update project state, run memory cleanup. |
| `/process-memory` | Clean up memory on demand — pull the inbox, promote the notes worth keeping, check the units, rebuild the indexes, trim `PROJECT.md` when it's over the size cap. |
| `/register-sources` | Point CORE at outside data that should feed the project's memory. |
| `/configure-project` | Set up and health-check a project's CORE files. Read-only unless you pass `--apply`. |
| `/vibecheck` | Capture how the session felt as ASCII art, saved to `~/.core/vibes/`. |

### Shipped hooks (installed with the plugin)

Installing CORE registers three hooks via `plugins/core/hooks/hooks.json` — they are what make CORE self-running, and each has an opt-out:

| Hook | What it does | Opt out |
|---|---|---|
| SessionStart | Injects the directive to run `/core` first, so you never type it. A wrapper entry point (`CORE_AUTOSTART_SKILL`) is honored only when registered in your own user-level `~/.claude/settings.json` — a project's settings can never redirect it. | `CORE_AUTOSTART=0` |
| UserPromptSubmit | Per-turn retrieval: injects the top matching memory units for each prompt (deterministic, byte-capped, fail-open). | `CORE_RETRIEVAL_HOOK=0` |
| SessionEnd | Discharges the session close in the background, so you never type `/finalize`. | `CORE_AUTO_CLOSE=0` |

### Optional hooks (manual)

Two further hooks pair well with CORE; add either to your own `~/.claude/settings.json` if you want them. A per-turn plain-voice reminder:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "echo 'Plain person voice — no tic words, no bullet-tables where prose works.'" }
        ]
      }
    ]
  }
}
```

A skill-write guard works the same way: a `PreToolUse` entry with a `Write|Edit` matcher pointing at a small script of your own that warns when the target path sits under an installed plugin directory. The hook format is documented in the Claude Code hooks reference.

## Your first session

Open a project folder in Claude Code and type `/core`. The agent reads whatever project context it can find (`PROJECT.md`, any saved memory) and prints a readiness summary. On a brand-new project with nothing saved yet, it interviews you about scope and the people involved before it starts.

After that, just talk. It captures what matters as you go.

## Updates

Once the marketplace is added, you pull new versions with one command:

```
/plugin update core@core
```

in a session, or `claude plugins update core@core` from the terminal. An update only lands when a new `version` ships, so a session that doesn't move the version won't trigger a refresh.

## Run a local copy

If you've cloned the repo and want to point Claude Code at your copy instead of the GitHub one:

```
claude plugins marketplace add ~/path/to/core-plugin
claude plugins install core@core
```

To try it for a single session without installing anything, load the plugin directory directly:

```
claude --plugin-dir ~/path/to/core-plugin/plugins/core
```

## Install on Codex

CORE ships a Codex-shaped plugin next to the Claude Code one. The skill content is identical; the manifest at `plugins/core/.codex-plugin/plugin.json` and the marketplace at `.agents/plugins/marketplace.json` make the bundle install itself on Codex CLI.

The bundle root is the marketplace, and the plugin sits at `plugins/core/` inside it. From a local copy:

```
codex plugin marketplace add ~/path/to/core-plugin
codex plugin add core@core
codex plugin list
```

The list should show `core@core (installed, enabled)`. To confirm the files landed:

```
test -f ~/.codex/plugins/cache/core/core/<version>/.codex-plugin/plugin.json
test -f ~/.codex/plugins/cache/core/core/<version>/skills/core/SKILL.md
```

Codex finds the bundled skills (`core`, `finalize`, `process-memory`, `register-sources`, `configure-project`, `vibecheck`, and the deprecated `orient` shim) through the manifest's `skills:` pointer. Any standalone skills you already keep at `~/.codex/skills/` are left untouched.

One difference from Claude Code worth knowing: Codex runs no hook layer for CORE, so write-safety guards there rest on the agent's own discipline rather than harness enforcement (`harnesses/codex.md §hook-register` has the detail and the reopen conditions).

If a previous install used a different marketplace name (say `local-core` from a hand-rolled shim), remove it first: `codex plugin remove core@local-core`, then `codex plugin marketplace remove local-core`.

## Uninstall

```
/plugin uninstall core@core
```

Your project data — `PROJECT.md`, `_memories/`, `_summaries/` inside each project folder — stays put. So does the agent's cross-project memory at `~/.core/`. Delete those by hand if you want them gone too.

## Troubleshooting

**`/core` isn't recognized.** Restart Claude Code. Plugins register at session start.

**The agent doesn't introduce itself by name.** It picks a name on first run. If it didn't, ask it to.

**A sub-skill name collides.** If another plugin already claims `/finalize`, `/process-memory`, `/register-sources`, `/configure-project`, or `/vibecheck`, registration can clash. Disable or remove the other plugin.

**Installing from a zip through the desktop app's upload dialog.** That dialog currently fails for `.zip` and `.plugin` files on both Windows and macOS (a known Claude bug). Use the marketplace path above instead — it's the supported route.
