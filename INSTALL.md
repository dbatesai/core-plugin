# Install

## What you need

- The Claude desktop app.
- The `core-plugin-2.0.0.zip` file (you've already got it if you're reading this).

## Install

1. Open Claude.
2. Click **Customize** in the top bar.
3. In the sidebar, click **Personal plugins**.
4. Click the **+** button → **Create plugin** → **Upload plugin**.
5. Drag `core-plugin-2.0.0.zip` into the drop zone (or click **Browse files** and pick it).
6. Click **Upload**.

CORE will appear in your plugin list. Start a fresh session and type `/core` to use it.

## What you get

| Slash command | What it does |
|---|---|
| `/core` | The agent. Starts the session, loads your project context, and talks with you. |
| `/orient` | Quick thread-resume — load project context and print a readiness summary. |
| `/finalize` | Session close — write a handoff, update project state, run memory hygiene. |
| `/vibecheck` | Capture the session's emotional truth as ASCII art. |
| `/file-reorganize` | Clean up version-qualifier chaos and stale content in any folder. |

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

## Uninstall

Customize → Personal plugins → CORE → remove.

Your project-level data (`PROJECT.md`, `_memories/`, `_handoffs/` inside each project folder) stays. So does the agent's cross-project memory at `~/.core/`. If you want those gone too, delete them manually.

## Troubleshooting

**`/core` isn't recognized.** Restart Claude. Plugins register at session start.

**The agent doesn't introduce itself by name.** It picks a name on first run. If it didn't, ask it to.

**Sub-skill name collisions.** If another plugin claims `/orient`, `/finalize`, `/vibecheck`, or `/file-reorganize`, registration may collide. Disable the other one or remove it.
