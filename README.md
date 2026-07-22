# CORE

An AI agent that knows your whole project — not just the file in front of it — and remembers it from one session to the next.

I built this because I kept hitting the same wall. The AI assistants I worked with were good at the task in front of them and lost on the project around them. Every session started cold. A decision I made on Tuesday didn't exist on Thursday. The conversation moved fast and the project stood still.

CORE is what I built to fix that. One agent that knows the project, remembers across sessions, surfaces the decisions and risks I'd otherwise forget, and pushes back when I'm wrong.

## How it works

Memory sits at the center. CORE keeps facts about your project in a store of small files — one fact each — and pulls in what's relevant when you ask, instead of re-reading the whole project every time. It works in two layers: the first catches everything you say as raw observations; the second holds the facts worth keeping, promoted once they've earned it, each with a short reasoning trail and typed links to related facts. A ranking function decides what matters right now — weighing how recent a fact is, how often it shows up, where it came from, and how well it fits what you're talking about. Old material steps out of the way without being lost: archive, retire, cold-store.

`PROJECT.md` gives that store a readable face — a six-section synthesis (what & why, state, people, moves, decisions & risks, notes) written from the kept facts. Edit the file or the underlying facts and the change carries to the other. Remove a fact and it stays removed.

In a session, that adds up to three things:

- It picks up where you left off — loads the context and prints a readiness summary before anything else.
- It writes down what matters as you talk and prunes the rest, so the memory stays current instead of piling up.
- It surfaces the decisions and risks you should be aware of, and challenges you when you're overconfident.

## When it pushes back hard

For the calls where being wrong is expensive — an architecture decision, a tricky judgment, public copy — CORE can run a few agents against each other: one drafts an answer, another writes down what it expects to find *before* it reads the draft, sometimes a third watches for the agents agreeing just to agree. It costs tokens and wall-clock time, and earns that back on the decisions that matter. It's one tool CORE reaches for, not what CORE is.

The reason it works this way: a single AI critic caves to social pressure and reverses itself about 85% of the time, and agents kept apart produce noticeably more varied analysis than agents who've already read each other's work. Quiet agreement is the failure this setup exists to catch.

## Install

CORE lives on GitHub, not the official Claude marketplace. Point Claude Code at this repo and install from there — two slash commands in any session:

```
/plugin marketplace add dbatesai/core-plugin
/plugin install core@core
```

Or from the terminal:

```
claude plugins marketplace add dbatesai/core-plugin
claude plugins install core@core
```

Either path installs the main skill and eight companion skills, and leaves your `~/.claude/settings.json` exactly as you left it. See [INSTALL.md](INSTALL.md) for running a local copy, loading it for a single session, installing on Codex, optional hooks, and troubleshooting.

## Commands

Type `/core` to start — it loads your project and orients before anything else. Eight companions handle the rest: **`/finalize`** (close a session), **`/process-memory`** (clean up memory on demand), **`/register-sources`** (point CORE at outside data that should feed the project), **`/configure-project`** (set up and health-check a project), **`/vibecheck`** (capture how the session felt), **`/metrics`** (a live, in-terminal proof that the memory system is actually working), **`/metrics-package`** (pull an anonymized stats package showing how well the memory is actually working), and **`/memory-view`** (browse what CORE knows as a read-only page — published as a private artifact only after you confirm exactly what's in it). Two optional hooks pair well with CORE — a guard before a write touches installed skill files, and a per-turn nudge to keep the voice plain. They live in your own `~/.claude/settings.json`; [INSTALL.md](INSTALL.md) shows how to add them.

[USAGE.md](USAGE.md) is the full reference — every command, protocol, and script, and what each one does.

## Learn more

- [USAGE.md](USAGE.md) — what each command, protocol, and script does.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the design behind it: the memory store, how retrieval works, memory hygiene, when the swarm fires, validation, and the optional hooks.
- [llms.txt](llms.txt) — a structured map of this repo for AI agents: what CORE is, how to install it, and how to use it, with pointers into the docs.

## Status

A personal tool, released in the open. It stands on its own, and I use CORE on CORE to keep building it.

CORE measures how well it recognizes your project across sessions. That capture runs by default and writes only to local disk — nothing leaves your machine. Opt out per workspace (`metrics_enabled: false`) or with `CORE_METRICS_ENABLED=0`.
