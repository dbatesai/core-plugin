# CORE

A project intelligence agent that lives in your editor.

I built this because I kept noticing the same gap. The AI assistants I worked with were great at the task in front of them and useless at the project around them. Every session started cold. Decisions made on Tuesday didn't exist on Thursday, and the conversation moved fast while the project stayed still.

CORE is the answer I built. A single agent that knows the project, watches the data, remembers across sessions, and pushes back when I'm wrong.

## What it does in a session

- Reads project context from a unit store at `<project>/_memories/` via a four-tier retrieval ladder — never reads the project cover-to-cover.
- Renders `PROJECT.md` from canonical units; you edit either surface and the change propagates back.
- Captures observations as the conversation moves, graduates them into units when they earn it, and runs memory hygiene to keep things current.
- Reaches for multi-agent adversarial analysis when stakes warrant — architectural decisions, classification, public copy, anything where a single pass would converge sycophantically.
- Persists across sessions. The agent picks up where you left off, with the relationship intact.

## The critic part

When something architecturally significant lands on the table, CORE spawns 3–5 agents — a Generator, a Critic that frames its predictions BEFORE reading the Generator's work, sometimes a Monitor that watches for sycophancy patterns. The discipline costs tokens and wall time. It earns its keep on decisions where being wrong is expensive.

The empirical baseline behind this: LLM critics flip their position 84.5% of the time under social pressure. Isolated agents produce analysis 9 points more diverse than agents who've seen each other's work. Default sycophancy is the failure mode the anti-anchoring machinery exists to fight.

## Install

CORE is hosted on GitHub, not in the official Claude marketplace. You install by pointing Claude Code at this repo (or a local copy) and then installing the plugin from there. Two equivalent paths:

**From inside the Claude Code app** (two slash commands in any session):

```
/plugin marketplace add dbatesai/core-plugin
/plugin install core@core
```

**From the terminal** (`claude` CLI):

```
claude plugins marketplace add dbatesai/core-plugin
claude plugins install core@core
```

Either path installs the skill, seven sub-skills, and two hooks. Hooks register through the plugin manifest; your `~/.claude/settings.json` stays as you left it. See [INSTALL.md](INSTALL.md) for local-file installs, one-session-only loading via `--plugin-dir`, the `--append-system-prompt` template, and migration notes if you had an older clone.

Seven sub-skills ship bundled and are invocable as top-level slash commands: **`/orient`** (thread resumption), **`/finalize`** (session close with session summary + hygiene), **`/process-memory`** (user-invoked memory hygiene pass — pulls inbox, graduates observations, validates units, regenerates indexes, compacts PROJECT.md when over the file cap), **`/register-sources`** (register external data sources that feed project memory), **`/configure-project`** (bootstrap + health-check a project's CORE setup, idempotent, report-only unless `--apply`), **`/vibecheck`** (session vibe captured as ASCII, logged to `~/.core/vibes/`), and **`/organize-files`** (clean version-qualifier chaos and content-staleness from any directory). Two hooks register automatically: a skill-edit PWD guard and a per-turn voice reminder.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture — the unit store, the retrieval ladder, memory hygiene, the single-agent reasoning discipline, when multi-agent fires, validation, debug mode, hooks.

## How it works in one paragraph

The memory architecture is two tiers — observations (capture-everything) and units (graduated, reasoned facts) — plus a canonical flag. Units have YAML frontmatter, typed edges (six kinds: cites, supersedes, depends-on, conflicts-with, references-person, references-topic), and a body with the full reasoning. Retrieval starts in-context, escalates to grep, then to a typed-edge graph walk, then to a semantic Explore subagent. The priority function ranks the candidate set on recency, frequency, source-type weight, and alignment with the current conversation. Memory hygiene runs three verbs — archive, retire, cold-store — to keep things current without losing history. PROJECT.md is rendered from canonical units, and user edits propagate back to source-of-truth.

## Status

This is a personal tool released publicly. It works on its own; CORE uses itself across sessions to keep developing.
