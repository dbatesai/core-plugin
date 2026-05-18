# CORE Retrieval Protocol (v2.0)

How the DM (and Explore subagents acting on its behalf) gets information from the project's memory into context. Per DC-67/68/69. Backing research at `_outputs/2026-05-16/memory-layer-research/SYNTHESIS.md` (in CORE's source-data repo).

---

## The four tiers

The DM checks these in order and stops as soon as the answer is sufficient. Escalation saves tokens — cheaper tiers run first.

### Tier 0 — Already loaded

At session start, `<project>/PROJECT.md` and `~/.core/dm-profile.md` are read. Files Read this session are in context. If the answer is there, no further retrieval happens. This is free.

**When to escalate:** The question references a fact or unit not visible in PROJECT.md or recently-read files.

### Tier 1 — Lexical (Grep)

`Grep` over `<project>/_memories/` for keywords, topic tags, or frontmatter fields. Optionally `Glob` to narrow file lists. Read the matched files. Sub-second on directory trees of hundreds-to-thousands of units.

**Standard patterns:**

- Find units by topic: `Grep "topics:.*memory-architecture" _memories/`
- Find units mentioning a person: `Grep "references-person" _memories/ | xargs grep "<name>"`
- Find units of a type: `Grep "^type: decision" _memories/`
- Find units citing a specific id: `Grep "target: dc-67-no-mcp" _memories/`

**When to escalate:** Word search returns a candidate or set of candidates but the question is about how they relate, or about a chain of reasoning that spans multiple units.

### Tier 2 — Typed-edge walk

Start from an anchor unit (typically discovered via Tier 1). Read its frontmatter `edges:` list. Follow edges of relevant types up to **2-3 hops maximum**. Build a visited-set in scratchpad to prevent cycles. Stop following a branch when its terminal candidate fails the prune threshold (below).

**Hop caps:**

- Default: 2 hops
- Maximum without explicit reason: 3 hops
- 4+ hops = a signal that the graph is too sparse for this query OR the question is semantic and should escalate to Tier 3

**Edge types to follow:** All six committed types per DC-68 are walkable in Tier 2. Body `[[wikilinks]]` are followed only at the seed step (one hop into the body), not transitively.

#### Score-gated termination (DC-69)

When following an edge to a candidate unit:

1. Read the candidate's frontmatter
2. Compute the **R·S proxy** — recency times source-type weight — using `~/.claude/skills/core/scripts/priority.py:score_proxy_RS(unit)` (DC-77 — priority logic ships with the plugin, not per-project)
3. If R·S < **0.3**, prune this branch — do NOT continue walking from this candidate
4. If R·S ≥ 0.3, the candidate enters the result set; recursion continues from this candidate

Why R·S as the proxy: full priority needs session-intent topics for the alignment signal, which the walker doesn't always have. R·S is the durability floor — a unit that's old AND low source-weight cannot be near the top of any retrieval order regardless of alignment, so the walk safely prunes it.

**Why 0.3:** Matches the synthesis-prescribed termination threshold. R alone hits 0.5 at 42 days for τ=60 (e.g., a session-log unit with source weight 0.3 has R·S = 0.5 · 0.3 = 0.15 at 42 days — pruned). A 6-month-old PROJECT.md decision has R·S = exp(-180/60) · 1.0 = 0.05 — also pruned. A 14-day-old PROJECT.md decision has R·S = exp(-14/60) · 1.0 = 0.79 — kept.

#### Walk termination summary

A branch terminates when ANY of these are true:

- Hop count reaches the cap (2 default, 3 max)
- Candidate has already been visited (cycle)
- Candidate's R·S proxy < 0.3
- Candidate has no edges of the followed types
- Total result set exceeds budget (default 15 units; tune per query)

**When to escalate to Tier 3:** The walk completes but the question is conceptual (semantic match needed, not literal-string match) and the Tier 1+2 result set doesn't synthesize an answer.

### Tier 3 — Semantic via Explore subagent

Spawn an Explore subagent (or general-purpose subagent) with a natural-language prompt: *"Read through `<project>/_memories/` and find everything relevant to <question>. The user wants to understand <goal>. Return a synthesis with citations to the specific files you used."*

The subagent runs its own Read + Grep + reasoning loop. It can follow edges or do lexical searches as needed. It returns a structured answer with file-path citations.

The LLM reasoning inside the subagent IS the semantic layer. No precomputed embeddings. No vector store. The subagent handles synonymy, polysemy, negation, and context-dependent meaning in ways a vector similarity score cannot.

**Cost discipline:** Tier 3 invocations cost tokens. Reserve for questions Tier 1+2 actually failed on. If a Tier 3 invocation succeeds where Tier 1+2 failed, log the query pattern to `~/.core/retrieval-metrics.jsonl` so the memory hygiene's trip-wire check can detect repeated failures across sessions (per DC-67 trip-wire #3: documented repeated Explore-miss pattern earns a vector store).

---

## After retrieval — update scoring slots

Every successful retrieval (Tier 1, 2, or 3) updates the retrieved unit's frontmatter:

- `last_accessed: <today>` — set to current date
- `access_count: <int + 1>` — increment

This feeds the priority function's recency (R) and frequency (F) signals for next time. The update is a cheap mid-session write to the unit file.

---

## Logging

Each retrieval event appends one line to `~/.core/retrieval-metrics.jsonl`:

```json
{"unit_id": "dc-67-no-mcp", "tier": 1, "timestamp": "2026-05-17T19:42:11Z", "query": "no mcp memory server"}
```

For Tier 2 walks: log the seed unit and the result set as separate lines, all with the same `query` field, so the memory hygiene can reconstruct walk effectiveness.

For Tier 3 misses (subagent returned no relevant answer): append with `"result": "miss"`. Tier 1/2 misses don't get logged — the trip-wire only fires on Tier 3 patterns.

---

## Quick reference

| Need | Tier | Tool |
|---|---|---|
| Fact from current session context | 0 | (already loaded) |
| Fact stored in a known unit | 1 | `Grep` + `Read` |
| Chain of related decisions | 2 | typed-edge walk + `Read` |
| Conceptual / fuzzy question | 3 | Explore subagent |
| Walk terminated unexpectedly | — | Check R·S proxy; if < 0.3 the branch was pruned (correct behavior) |
| Tier 3 fired more than once on similar queries | — | Trip-wire signal; memory hygiene will flag |
