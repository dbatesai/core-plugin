# Install

## What you need

- The Claude desktop app.
- The the CORE plugin zip file (you've already got it if you're reading this).

## Install

1. Open Claude.
2. Click **Customize** in the top bar.
3. In the sidebar, click **Personal plugins**.
4. Click the **+** button → **Create plugin** → **Upload plugin**.
5. Drag the CORE plugin zip into the drop zone (or click **Browse files** and pick it).
6. Click **Upload**.

CORE will appear in your plugin list. Start a fresh session and type `/core` to use it.

## What you get

| Slash command | What it does |
|---|---|
| `/core` | The agent. Starts the session, loads your project context, and talks with you. |
| `/orient` | Quick thread-resume — load project context and print a readiness summary. |
| `/finalize` | Session close — write a session summary, update project state, run memory hygiene. |
| `/process-memory` | User-invoked memory hygiene pass — pulls inbox, graduates observations, validates units, regenerates indexes, compacts PROJECT.md when over the file cap. |
| `/vibecheck` | Capture the session's emotional truth as ASCII art. |
| `/organize-files` | Clean up version-qualifier chaos and stale content in any folder. |

## First session

Open a project folder in Claude and type `/core`. The agent reads any project context it can find (`PROJECT.md`, prior memory units) and prints a readiness summary. On a fresh project with no prior state, it'll interview you about scope and stakeholders before getting started.

After that, just talk. The agent captures what matters as you go.

## Updates

**From a zip:** when you get a new zip, repeat the install steps — upload the new zip and it replaces the previous version.

**From GitHub (auto-updates):** if you'd prefer Claude to pull updates directly, add the marketplace once and you won't need zip files again:

1. Open a Claude session.
2. Paste this and hit enter: `/plugin marketplace add dbatesai/core-plugin`
3. Then: `/plugin install core`

After that, `/plugin update core` gets you the latest version whenever one ships.

## Install on Codex

CORE ships a Codex-shaped plugin alongside the Claude Code plugin. The skill content is the same; the manifest at `plugins/core/.codex-plugin/plugin.json` and the marketplace at `.agents/plugins/marketplace.json` make the bundle self-installable on Codex CLI.

The Codex zip is marketplace-shaped: the bundle root is the marketplace, and the plugin lives at `plugins/core/` inside it.

From a zip:

1. Unzip the bundle to a stable path (e.g. `~/Plugins/core-marketplace/`).
2. Register the local marketplace and install the plugin:

   ```
   codex plugin marketplace add ~/Plugins/core-marketplace
   codex plugin add core@core
   codex plugin list
   ```

3. The list should show `core@core (installed, enabled)`.

Verify the install:

```
test -f ~/.codex/plugins/cache/core/core/<version>/.codex-plugin/plugin.json
test -f ~/.codex/plugins/cache/core/core/<version>/skills/core/SKILL.md
```

The plugin lands in Codex's plugin cache at `~/.codex/plugins/cache/core/core/<version>/`. Codex auto-discovers the bundled skills (`core`, `orient`, `finalize`, `process-memory`, `vibecheck`, `organize-files`) via the manifest's `skills:` pointer. Standalone skills you already have at `~/.codex/skills/` are not touched by the plugin install.

To update from a new zip: replace the unzipped bundle, bump the version inside `plugins/core/.codex-plugin/plugin.json` (or use a dev tag like `2.0.1-dev.YYYYMMDD`) for cache differentiation, and rerun `codex plugin add core@core`.

If a prior install used a different marketplace name (e.g. `local-core` from a hand-crafted shim), remove it first: `codex plugin remove core@local-core` then `codex plugin marketplace remove local-core`.

## Uninstall

Customize → Personal plugins → CORE → remove.

Your project-level data (`PROJECT.md`, `_memories/`, `_summaries/` inside each project folder) stays. So does the agent's cross-project memory at `~/.core/`. If you want those gone too, delete them manually.

## Troubleshooting

**`/core` isn't recognized.** Restart Claude. Plugins register at session start.

**The agent doesn't introduce itself by name.** It picks a name on first run. If it didn't, ask it to.

**Sub-skill name collisions.** If another plugin claims `/orient`, `/finalize`, `/process-memory`, `/vibecheck`, or `/organize-files`, registration may collide. Disable the other one or remove it.
