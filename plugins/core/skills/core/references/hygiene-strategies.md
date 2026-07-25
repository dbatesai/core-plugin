# CORE Memory Hygiene

Memory hygiene is how CORE keeps its knowledge useful. Without it, the memory grows, contradictions accumulate, orphaned entries drain retrieval quality, and session logs pile up unchecked. Run it every 3–5 sessions, after any session that spawned 3+ agents, or when entries start visibly contradicting each other.

Phase numbers in this file are the walk order for a full hygiene pass. The canonical mapping from the former dream-cycle phases to current mechanisms lives in `protocols/hygiene.md` §"Dream cycle absorption" — when the two files disagree on a phase number or scope, that table wins.

## Phase 1: Memory Inventory

Check the indexes before reading anything else. For each memory store (`~/.claude/projects/*/memory/`, `~/.claude/memory/`), compare what's indexed against what's on disk. Orphan files get index entries or move to `archived/`; indexed entries pointing at missing files get removed. A wrong map silently breaks everything downstream.

Then catalog what exists: file types, names, last-modified dates, topic coverage. Surface over-grown indexes (per-project `MEMORY.md` is auto-injected up to 200 lines) and split topic content into sub-files so the index stays index-only.

## Phase 2: Semantic Distillation

For each memory entry, assess four things:
- **Still accurate?** Read the relevant code or files to verify.
- **Still relevant?** Useful for future sessions, or only for a completed task?
- **Redundant?** Another entry covering the same ground?
- **Needs updating?** Mostly right but outdated in detail?

Then act using one of these verbs, which map to the canonical model in `protocols/hygiene.md`: **graduate** (observation proved true across sessions → a permanent unit), **merge** (duplicate entries → one entry), **archive** (was useful, no longer relevant → `_memories/archive/` with a note; never autonomous on a user-authored unit), **retire** (wrong, superseded, or now captured in code/docs → frontmatter `status: retired`, **body preserved** for forensic value, anti-resurrection rule applies — you do not silently remove the unit), **update** (mostly right, needs correction). Literal file deletion is only ever for orphan **index entries** or non-unit scratch files — never a canonical unit; a unit that's "wrong" gets retired, not deleted.

Also review the `agent_notes` field in each workspace's `workspace.json` (older manifests carry it as `dm_notes` — same field). More than ~10 one-liner self-corrections → consolidate into a brief paragraph summarizing recurring patterns.

## Phase 3: Reconciliation

### 3a — Memory Contradictions

List the contradiction explicitly ("Memory A says X, Memory B says Y"), read current state to find the right answer, then resolve. If both are partially correct, write a new entry capturing the nuanced truth.

### 3b — Archive Reconciliation

Entries get archived to keep PROJECT.md lean — but archived entries can become relevant again as new work references them. This phase surfaces re-emergent ones.

For each archive file not modified recently, extract decision/risk/assumption IDs and grep the current read surface (PROJECT.md, recent session summaries, protocols, skill references) for references beyond each entry's own stub line. Surface candidates above the match threshold to the user, who decides: promote the stub back to §D&R, reject, or suppress for N cycles.

Suppression state persists at `~/.core/swarm-effectiveness/archive-reconciliation-state.json`. Log all outcomes in the hygiene retrospective.

**Calibration defaults** — starting points to tune after a few cycles, not fixed rules: 14-day recency gate (skip files modified too recently), ≥3 match threshold (below this is noise), top-10 candidates per cycle.

Example: a decision unit archived three months back keeps showing up in protocols and session summaries as new work references it. Sub-protocol 3b surfaces it; the user decides whether to un-archive and surface in §D&R or suppress for a few cycles.

### 3c — File-Cap Reconciliation

The legacy auto-MIGRATE classifier (path-(a)-vs-(b) re-decision) is **retired v1 machinery** — superseded by the file-cap monitoring in `protocols/hygiene.md`. There is no MIGRATE count and no path choice anymore. Instead: monitor the synthesis files (`PROJECT.md`, `IMPROVEMENT_LOG.md`, any project-flagged synthesis file) against the Read-tool soft target, and when one is over, proactively compact it per `hygiene.md §"file-cap monitoring and proactive compaction"` — archive/retire the units behind the over-cap section, rotate the log, leave grep stubs where a compaction migrates content. Surface the volume to the user (how much was compacted, from where to where) so the work stays visible; the user doesn't re-decide a strategy, they just see what happened.

**Calibration default** — trigger at ~80% of the Read-tool cap (the `compact-project.mjs --check` soft target). Tune per project if a synthesis file runs hot.

### 3d — Edge-Integrity Sweep

Units get renamed, archived, or deleted; typed edges that pointed at them become danglers that silently fail at retrieval time. Walk `<project>/_memories/*.md` frontmatter, collect all `edges:` entries, verify each target ID exists in the vault. External targets (quoted strings like `"Park et al. 2023"`) are exempt from dangle detection.

The rule that matters: for structural edge types (`supersedes`, `depends-on`, `conflicts-with`) on any unit, surface the dangler for user review — never auto-remove. For informational types (`cites`, `references-person`, `references-topic`), auto-remove and log. After any merge or rename, rewrite inverse edges pointing at the old ID. A light wikilink pass promotes `[[wikilink-id]]` body references to typed `cites` frontmatter edges.

### 3e — Session Log Prune

Session logs in `<project>/_sessions/` are ephemeral by design and grow without bound unless pruned. A log is eligible if all three conditions hold: older than 90 days, no unit's `sources:` or `cites:` edge references it, no session summary references it.

The citation check is what decides. If a session log got cited by a unit, someone reached back for it — preserve it. Age and summary-reference checks filter the rest. Log every deletion in the retrospective; clean up empty directories.

What this phase never touches: session summaries, outputs, swarm-effectiveness reports, hygiene retrospectives, or any cited session log.

## Phase 4: Pattern Synthesis

Look across surviving entries for meta-patterns — recurring themes, consistent user feedback, project patterns no single entry captures but the collection implies. Write a new entry if a genuine meta-pattern emerges.

**Retrieval trip-wire check.** Read the per-project retrieval log at `<project>/_sessions/<YYYY-MM-DD>/retrieval-log.jsonl` (or run `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project>` for the aggregated view). Check the four standing trip-wires:

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
2. A retrospective at `~/.core/hygiene-cycles/<YYYY-MM-DD>.md`
3. Updated index files reflecting any additions or removals
4. If 3b ran: refreshed `archive-reconciliation-state.json` + Phase 3b section in retrospective
5. If 3b promoted any stubs: corresponding PROJECT.md §D&R edits, gated on secondary confirmation
