# CORE

An AI agent that knows your whole project — not just the file in front of it — and remembers it from one session to the next.

I built this because I kept hitting the same wall. The AI assistants I worked with were good at the task in front of them and lost on the project around them. Every session started cold. A decision I made on Tuesday didn't exist on Thursday. The conversation moved fast and the project stood still.

CORE is what I built to fix that. One agent that knows the project, watches the data, remembers across sessions, and pushes back when I'm wrong.

## What it does in a session

- Pulls in the context it needs from a store of saved facts in `<project>/_memories/`, instead of re-reading the whole project every time.
- Keeps `PROJECT.md` written from those facts. You can edit either one — the file or the underlying facts — and the change carries back to the other.
- Writes down what you say as you say it, turns the parts worth keeping into permanent notes, and prunes the rest so the memory stays current instead of piling up.
- Brings in a small team of agents to argue a question out when the stakes are high — an architecture call, a tricky judgment, public copy, anything where one quick answer tends to agree with itself.
- Picks up where you left off next session, the working relationship intact.

## The arguing part

When something big lands on the table, CORE runs a few agents against each other: one drafts an answer, another writes down what it expects to find *before* it reads the draft, and sometimes a third watches for the agents quietly agreeing just to agree. It costs tokens and wall-clock time. It earns that back on the decisions where being wrong is expensive.

The reason it works this way: when you lean on a single AI critic, it caves to social pressure and reverses itself about 85% of the time. Agents kept apart produce noticeably more varied analysis than agents who've already read each other's work. Quiet agreement is the failure this setup exists to catch.

## Install

CORE lives on GitHub, not in the official Claude marketplace. You install it by pointing Claude Code at this repo (or a local copy) and installing the plugin from there. Two paths, same result.

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

Either path installs the main skill, seven sub-skills, and two hooks. The hooks come in through the plugin manifest, so your `~/.claude/settings.json` stays exactly as you left it. See [INSTALL.md](INSTALL.md) for running a local copy, loading it for a single session with `--plugin-dir`, installing on Codex, and troubleshooting.

The seven sub-skills are slash commands you can run on their own: **`/orient`** (pick a thread back up), **`/finalize`** (close a session — writes a summary and runs memory cleanup), **`/process-memory`** (clean up memory on demand — pull the inbox, promote the notes worth keeping, check the units, rebuild the indexes, trim `PROJECT.md` when it's over the size cap), **`/register-sources`** (point CORE at outside data that should feed the project's memory), **`/configure-project`** (set up and health-check a project's CORE files — read-only unless you pass `--apply`), **`/vibecheck`** (capture how the session felt as ASCII art, saved to `~/.core/vibes/`), and **`/organize-files`** (clean up version-name sprawl and stale files in any folder). The two hooks register on their own: a guard that reminds you before a write touches installed skill files, and a per-turn nudge to keep the voice plain.

## Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) walks through the whole design — the memory store, how retrieval works, memory cleanup, how the agent reasons on its own, when it brings in the swarm, validation, debug mode, and the hooks.

## How the memory works, briefly

Memory comes in two layers. The first catches everything you say as raw observations. The second holds the facts worth keeping — promoted from those observations once they've earned it, each with a short reasoning trail and typed links to related facts (six kinds: cites, supersedes, depends-on, conflicts-with, references-person, references-topic). When CORE needs something, it looks in what's already loaded first, then searches the files by keyword, then walks the links between facts, and only spins up a deeper semantic search if those come up short. A ranking function decides what's most relevant right now, weighing how recent a fact is, how often it shows up, where it came from, and how well it matches what you're talking about. Cleanup runs in three moves — archive, retire, cold-store — so old material steps out of the way without being lost. `PROJECT.md` is written from the kept facts, and anything you edit there flows back to the source.

## Status

A personal tool, released in the open. It stands on its own, and I use CORE on CORE to keep building it.
