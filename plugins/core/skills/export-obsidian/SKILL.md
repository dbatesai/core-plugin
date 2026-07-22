---
name: export-obsidian
description: Decorate the current project's memory store with real Obsidian [[wikilinks]] so the user can visually explore what CORE knows — graph view, backlinks, note browsing — directly in the live store, in a tool they already have. Use whenever the user wants to SEE or BROWSE their memory store visually — "let me see what you know", "open this in Obsidian", "can I browse the graph", "show me the knowledge graph" — including when they describe the outcome without naming the tool ("I want to click around and see how everything connects"). Do NOT use for the anonymized statistics package (that's /metrics-package), for the live in-terminal health check (/metrics), or for anything that touches BBLens/managed data directly — this is a CORE-project-local, dev-machine-only mechanism.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
---

# `/export-obsidian`

Decorate the project's `_memories/` store in place with a marker-delimited, auto-regenerated `[[wikilink]]` block per unit, derived from that unit's own `edges:` frontmatter — so the store IS the Obsidian vault. Point Obsidian directly at `_memories/` and open it as a vault; there is no separate export folder to go stale. The point is visual: the user sees graph view, backlinks, and note browsing over what the agent actually knows, in the real, live files — seeing what the agent knows, not just being told, is what builds confidence in it.

**The script is the only writer of the generated block.** `scripts/decorate-graph.mjs` (in the core skill's `scripts/` directory) computes the block for every unit from one atomic snapshot of the store, and only rewrites a file when the computed block actually differs from what's on disk. The block sits between `<!-- CORE:BEGIN_EDGES -->` and `<!-- CORE:END_EDGES -->` markers with an in-block warning — never hand-edit inside that block; it is fully regenerated on the next run and anything written there is overwritten. Everything outside the markers is the user's own authored content and is never touched.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics-package` and `/process-memory` do: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/export-obsidian/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Run

1. **Resolve the project.** Default to the current project directory. If the user names a different registered workspace, resolve it the same way other skills do (via `~/.core/index.json`) rather than guess a path.

2. **Run the script:**

```bash
node "${CORE_ROOT}/skills/core/scripts/decorate-graph.mjs" <project-dir>
```

3. **Verify before claiming.** The script prints how many units it updated (or that none needed a change) and the snapshot id. If any file is reported under a marker-malformed refusal, name it plainly to the user rather than silently skipping it — that unit's markers need manual repair before it can be decorated. Then relay, in plain language: that opening `_memories/` as an Obsidian vault (Obsidian → Open folder as vault → pick the project's `_memories/` directory) shows the graph, live, directly from the real store.

## What this does and does not guarantee

- **In-place, not export.** This writes directly into `_memories/` — there is exactly one copy of the data, always current. Nothing gets written to a separate export directory.
- **No retired facts resurface.** A retired/archived unit is excluded from the snapshot's active population entirely (both by status filtering and by `archive/` being excluded from the underlying store walk), so it's never decorated and never linked to.
- **Real `[[wikilinks]]`**, resolved by Obsidian on the unit id (the filename minus `.md`) — these survive a rename tracked by Obsidian itself, unlike a relative markdown path link.
- **Idempotent and fail-closed.** A unit is only rewritten when its computed block actually changed. A unit whose markers are duplicated, orphaned, or out of order is refused and left byte-identical rather than guessed at — that's a real signal something touched the block by hand and needs a look, not a silent auto-fix.
- **This is dev-machine-only.** Running this and opening the result in Obsidian both happen on the user's own machine against their own project. Never run this against BBLens or any other managed/residency-controlled data path — that boundary is the overlay's to manage, not this skill's.

## Self-healing rails

- **No `_memories/` in the target directory:** the script exits with a usage message — say so plainly and confirm the project directory is right rather than retry blindly.
- **A unit's markers are malformed:** the script refuses that one file and reports it; tell the user which file and that it needs a manual look (likely something edited inside the generated block) rather than trying to force a fix.
- **Zero units changed:** report it honestly — this usually means the store is already fully decorated from a prior run, not that something's broken.
