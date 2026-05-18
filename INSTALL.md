# Install

## Prerequisites

- Claude Code (desktop app, CLI, or VS Code extension) — CORE is a Claude Code plugin.
- macOS or Linux. The hooks use bash and Python 3.
- A project directory you'll work in.

## Install

CORE is packaged as a single-plugin marketplace, hosted on GitHub. It's not in the official Claude plugin marketplace — you point Claude Code at the CORE repo (or a local copy of it) and install from there. Two equivalent paths: the Claude Code app via slash command, or the terminal via the `claude` CLI. Pick whichever fits how you work.

After either path, open a fresh Claude Code session and type `/core` to start.

### Option A — In the Claude Code app (slash commands)

In any Claude Code session, run these two slash commands:

```
/plugin marketplace add dbatesai/core-plugin
/plugin install core@core
```

The first command registers the CORE repo as a plugin source on your machine. The second installs the `core` plugin from it. Everything registers automatically — the main `/core` skill, four sub-skills (`/orient`, `/finalize`, `/vibecheck`, `/file-reorganize`), and two hooks (skill-edit PWD guard, voice reminder). Your `~/.claude/settings.json` is not modified.

If you've already downloaded the repo (clone or zip) and want to install from local files instead of GitHub, point the first command at the local path:

```
/plugin marketplace add /path/to/your/downloaded/core-plugin
/plugin install core@core
```

### Option B — From the terminal (CLI)

Same commands, just through the `claude` CLI instead of slash commands:

```
claude plugins marketplace add dbatesai/core-plugin
claude plugins install core@core
```

Local-path version:

```
claude plugins marketplace add /path/to/your/downloaded/core-plugin
claude plugins install core@core
```

### Option C — One session only (no permanent install)

If you just want to try CORE in one session without installing:

```
claude --plugin-dir /path/to/core-plugin
# or with a downloaded zip:
claude --plugin-dir core-plugin.zip
# or directly from a URL:
claude --plugin-url https://github.com/dbatesai/core-plugin/archive/main.zip
```

These flags load the plugin for the current session only — nothing persists after you exit.

## What gets installed

CORE ships with four bundled sub-skills, two hooks, and the main `/core` skill.

| Sub-skill | Slash command | What it does |
|---|---|---|
| `orient/` | `/orient` | Thread-resumption — load project context, print a readiness receipt |
| `finalize/` | `/finalize` | Session close — reconcile state, write handoff, render PROJECT.md, run hygiene |
| `vibecheck/` | `/vibecheck` | Session vibe capture — emotional truth as ASCII, logged to `~/.core/vibes/` |
| `file-reorganize/` | `/file-reorganize` | Clean version-qualifier chaos and content-staleness from any project directory |

| Hook | When | What |
|---|---|---|
| `pwd-guard.py` | PreToolUse on Write/Edit | Reminds the agent to declare `intent: skill-edit` when writing to CORE skill-product surfaces |
| `voice-reminder.sh` | UserPromptSubmit | Injects the plain-voice imperative each turn — counters the Claude Code coding-assistant baseline |

## First session

In any project directory, open Claude Code and type:

```
/core
```

The agent runs the startup protocol — reads `PROJECT.md` if it exists, walks the retrieval ladder over `<project>/_memories/`, applies elapsed-time signals, and prints a readiness summary in plain voice. On a fresh project with no prior state, the agent interviews you about scope, success criteria, and stakeholders, then scaffolds the unit store from your answers.

After that, just talk. The agent captures observations as you go.

## The `--append-system-prompt` template

The Claude Code coding-assistant baseline bleeds through past about 80K context tokens and pulls everything toward documentation-template voice. To push back, install CORE with this template appended to the system prompt:

```
--append-system-prompt "Plain person voice is a critical imperative. Write how a person talks, not how a document template looks."
```

This applies the imperative globally, separately from the voice header inside the skill. It's belt-and-suspenders against the baseline drift. Downstream consumers (skill-wrappers, etc.) should set this in their install too.

## Uninstall / update

To uninstall:

```
claude plugins uninstall core
```

The project-level unit store at `<project>/_memories/` and PROJECT.md stay — they're yours. Operational meta at `~/.core/` also stays unless you remove it explicitly.

To update:

```
claude plugins marketplace update core
claude plugins update core
```

The skill is forward-compatible with existing `_memories/` content (the unit format is the contract; the skill operates on whatever units are there).

## If you previously installed manually

If you previously installed by cloning `dbatesai/core-skill` directly into `~/.claude/skills/core/`, you can keep doing that — `dbatesai/core-skill` is staying as a clone-install skill. The new `dbatesai/core-plugin` repo is the plugin-packaged version of the same content, for users who'd rather install via the plugin commands above than manage clones and symlinks.

To switch from clone-install to plugin-install:

```
# Remove the old clone + the four sibling symlinks (if you set them up)
rm -rf ~/.claude/skills/core
rm -f ~/.claude/skills/orient ~/.claude/skills/finalize ~/.claude/skills/vibecheck ~/.claude/skills/file-reorganize

# Then install via the plugin commands above:
claude plugins marketplace add dbatesai/core-plugin
claude plugins install core@core
```

Your project-level data (`_memories/`, `PROJECT.md`, `_handoffs/`, etc.) is untouched — only the skill product moves.

## Where things live

| Path | What |
|---|---|
| `~/.claude/plugins/cache/core/core/<version>/skills/` | The skill product — `core/`, `orient/`, `finalize/`, `vibecheck/`, `file-reorganize/`. |
| `~/.core/` | Cross-project operational meta — `dm-profile.md`, `index.json`, `topics.md`, `state-cache.json`. |
| `<project>/_memories/` | The unit store for one project — canonical project context. |
| `<project>/PROJECT.md` | Rendered project synthesis. The user-editable surface. |
| `<project>/_handoffs/` | Narrative session logs. Written at `/finalize`. |

## Troubleshooting

**The agent doesn't introduce itself by name.** Check `~/.core/dm-profile.md` exists and has a name. If not, the agent should pick one on first run; if it didn't, ask it to.

**Voice drifts toward coding-assistant style.** Check that `--append-system-prompt` is set, and that the voice-reminder hook is registered (it should be, automatically, via the plugin).

**Retrieval returns too much or too little.** The validation regime at `<project>/_memories/_validation/tests/` measures this. Run the bundled `validate.py` (under `<plugin-install-path>/skills/core/scripts/validate.py`) against your project root to see precision/recall on the seed corpus. If drift is real, add tests and tune priority weights at `<project>/_memories/_lib/priority.py`.

**Sub-skill naming collisions.** `/orient`, `/finalize`, `/vibecheck`, and `/file-reorganize` are common names — if another plugin or skill claims any of these, registration may collide. Inspect with `claude plugins list` and adjust as needed.
