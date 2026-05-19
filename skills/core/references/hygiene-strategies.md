# CORE Memory Hygiene

Memory hygiene is how CORE keeps its knowledge useful. Without it, the memory grows, contradictions accumulate, orphaned entries drain retrieval quality, and session logs pile up unchecked. Run it every 3–5 sessions, after any session that spawned 3+ agents, or when entries start visibly contradicting each other.

## Phase 1: Memory Inventory

Check the indexes before reading anything else. For each memory store (`~/.claude/projects/*/memory/`, `~/.claude/memory/`), compare what's indexed against what's on disk. Orphan files get index entries or move to `archived/`; indexed entries pointing at missing files get removed. A wrong map silently breaks everything downstream.

Then catalog what exists: file types, names, last-modified dates, topic coverage. Surface over-grown indexes (per-project `MEMORY.md` is auto-injected up to 200 lines) and split topic content into sub-files so the index stays index-only.

## Phase 2: Semantic Distillation

For each memory entry, assess four things:
- **Still accurate?** Read the relevant code or files to verify.
- **Still relevant?** Useful for future sessions, or only for a completed task?
- **Redundant?** Another entry covering the same ground?
- **Needs updating?** Mostly right but outdated in detail?

Then act using one of five verbs: **promote** (observation proved true across sessions → permanent knowledge), **merge** (duplicate entries → one entry), **archive** (was useful, no longer relevant → `archived/` with a note), **delete** (wrong, or now in code/docs), **update** (mostly right, needs correction).

Also review the `dm_notes` field in each workspace's `workspace.json`. More than ~10 one-liner self-corrections → consolidate into a brief paragraph summarizing recurring patterns.

## Phase 3: Reconciliation

### 3a — Memory Contradictions

List the contradiction explicitly ("Memory A says X, Memory B says Y"), read current state to find the right answer, then resolve. If both are partially correct, write a new entry capturing the nuanced truth.

### 3b — Archive Reconciliation

Entries get archived to keep PROJECT.md lean — but archived entries can become load-bearing again as new work references them. This phase surfaces re-emergent ones.

For each archive file not modified recently, extract decision/risk/assumption IDs and grep the current read surface (PROJECT.md, recent handoffs, protocols, skill references) for references beyond each entry's own stub line. Surface candidates above the match threshold to the user, who decides: promote the stub back to §D&R, reject, or suppress for N cycles.

Suppression state persists at `~/.core/swarm-effectiveness/archive-reconciliation-state.json`. Log all outcomes in the hygiene retrospective.

**Calibration defaults** — starting points to tune after a few cycles, not fixed rules: 14-day recency gate (skip files modified too recently), ≥3 match threshold (below this is noise), top-10 candidates per cycle.

Example: a decision unit archived three months back keeps showing up in protocols and handoffs as new work references it. Sub-protocol 3b surfaces it; the user decides whether to un-archive and surface in §D&R or suppress for a few cycles.

### 3c — Compaction Volume

Auto-MIGRATE runs autonomously per DC-46, but if it's archiving faster than expected, the user should see it and have the option to revisit the path (a) vs (b) choice. Count MIGRATE entries per workspace since the previous hygiene; surface the re-decision prompt when the count crosses the threshold.

**Calibration default** — 5 MIGRATE entries per cycle per workspace. If the user consistently stays on path (a) without complaint at higher counts, raise it. If they want earlier re-decisions, lower it.

### 3d — Edge-Integrity Sweep

Units get renamed, archived, or deleted; typed edges that pointed at them become danglers that silently fail at retrieval time. Walk `<project>/_memories/*.md` frontmatter, collect all `edges:` entries, verify each target ID exists in the vault. External targets (quoted strings like `"Park et al. 2023"`) are exempt from dangle detection.

The load-bearing rule: for structural edge types (`supersedes`, `depends-on`, `conflicts-with`) on any unit, surface the dangler for user review — never auto-remove. For informational types (`cites`, `references-person`, `references-topic`), auto-remove and log. After any merge or rename, rewrite inverse edges pointing at the old ID. A light wikilink pass promotes `[[wikilink-id]]` body references to typed `cites` frontmatter edges.

### 3e — Session Log Prune

Session logs in `<project>/_sessions/` are ephemeral by design and grow without bound unless pruned. A log is eligible if all three conditions hold: older than 90 days, no unit's `sources:` or `cites:` edge references it, no handoff references it.

The citation check is the load-bearing condition. If a session log got cited by a unit, someone reached back for it — preserve it. Age and handoff-reference checks filter the rest. Log every deletion in the retrospective; clean up empty directories.

What this phase never touches: handoffs, outputs, swarm-effectiveness reports, hygiene retrospectives, or any cited session log.

## Phase 4: Pattern Synthesis

Look across surviving entries for meta-patterns — recurring themes, consistent user feedback, project patterns no single entry captures but the collection implies. Write a new entry if a genuine meta-pattern emerges.

**Retrieval trip-wire check.** Read `~/.core/retrieval-metrics.jsonl`. Check four trip-wires per DC-67:

| Trip-wire | Condition | Next-step infra if fires twice consecutively |
|---|---|---|
| Lexical latency | Corpus > 50K files AND Grep > 500ms repeatedly | Sidecar ripgrep daemon behind MCP |
| Graph walk latency | Tier 2 walks > 2s repeatedly | First: generate `adjacency.json` at hygiene time. Then: graph engine behind MCP. |
| Semantic miss pattern | Repeated Tier 3 misses on similar queries across sessions | Vector store behind MCP |
| Concurrent-writer conflict | Second writer enters system AND direct-write conflicts arise | Event-log + materializer |

One firing cycle is a signal; two consecutive cycles is grounds to propose a DC for the next-step infrastructure. Log each trip-wire's current status in the hygiene retrospective.

## Phase 5: Agent Refresh

Review agents that participated in recent swarms. Files at `~/.core/agents/<kebab-case-name>.md`. Check swarm effectiveness reports for patterns; update Identity, Analytical Lens, or Blind Spots for agents with consistent behavior. Retire underperformers to `~/.core/agents/retired/` rather than deleting — the config retains reference value. Annotate any `task-configs/` entries pointing at retired agents.

## Output

Every hygiene run produces:
1. Updated memory files (modified, merged, archived, deleted)
2. A retrospective at `~/.core/memory-hygienes/<YYYY-MM-DD>.md`
3. Updated index files reflecting any additions or removals
4. If 3b ran: refreshed `archive-reconciliation-state.json` + Phase 3b section in retrospective
5. If 3b promoted any stubs: corresponding PROJECT.md §D&R edits, gated on secondary confirmation
