# CORE Retrieval Protocol (v2.0)

How the agent (and Explore subagents acting on its behalf) gets information from the project's memory into context, per the standing architecture: native tools first, a flat unit store, and the committed priority function.

---

## The four tiers

The agent checks these in order and stops as soon as the answer is sufficient. Escalation saves tokens — cheaper tiers run first.

### Tier 0 — Already loaded

At session start, `<project>/PROJECT.md` and `~/.core/agent-profile.md` are read. Files Read this session are in context. If the answer is there, no further retrieval happens. This is free.

**When to escalate:** The question references a fact or unit not visible in PROJECT.md or recently-read files.

### Tier 1 — Lexical

**Preferred: the shipped product retriever.** `retrieve-context.mjs` ranks every active unit — nested trees included — by title/topics overlap ∪ body BM25 (magnitudes preserved, per-arm normalized), then one-hop edge expansion; the per-turn hook injects its top matches automatically. For an explicit query: `node retrieve-context.mjs <store> "<query>" [--top N]`, or `node bm25.mjs <store> rank "<query>"` for the body arm alone. Every result carries its authority tier (canonical vs raw observation).

**Manual fallback:** `Grep` over `<project>/_memories/` for keywords, topic tags, or frontmatter fields. Optionally `Glob` to narrow file lists. Read the matched files. Sub-second on directory trees of hundreds-to-thousands of units.

**Standard patterns:**

- Find units by topic: `Grep "topics:.*memory-architecture" _memories/`
- Find units mentioning a person: `Grep "references-person" _memories/ | xargs grep "<name>"`
- Find units of a type: `Grep "^type: decision" _memories/`
- Find units citing a specific id: `Grep "target: dc-67-no-mcp" _memories/`

**When to escalate:** Word search returns a candidate or set of candidates but the question is about how they relate, or about a chain of reasoning that spans multiple units.

### Tier 2 — Typed-edge walk

**Preferred:** run `graph-walk.mjs` from the plugin:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/graph-walk.mjs <seed-unit-path> \
    --format json
```

This returns a scored, hop-ordered candidate list. Read the top results. Fall back to manual traversal only if the script isn't reachable in the current harness context.

**Manual fallback:** Start from an anchor unit (typically discovered via Tier 1). Read its frontmatter `edges:` list. Follow edges of relevant types up to **2-3 hops maximum**. Build a visited-set in scratchpad to prevent cycles. Stop following a branch when its terminal candidate fails the prune threshold (below).

**Hop caps:**

- Default: 2 hops
- Maximum without explicit reason: 3 hops
- 4+ hops = a signal that the graph is too sparse for this query OR the question is semantic and should escalate to Tier 3

**Edge types to follow:** All committed edge types (the committed base set plus later additions — see `VALID_EDGE_TYPES` in `check-units.mjs`) are walkable in Tier 2. Body `[[wikilinks]]` are followed only at the seed step (one hop into the body), not transitively.

#### Score-gated termination

When following an edge to a candidate unit:

1. Read the candidate's frontmatter
2. Compute the **R·S proxy** — recency times source-type weight — using `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs:scoreProxyRS(unit)` (priority logic ships with the plugin, not per-project)
3. If R·S < **0.3**, prune this branch — do NOT continue walking from this candidate
4. If R·S ≥ 0.3, the candidate enters the result set; recursion continues from this candidate

Why R·S as the proxy: full priority needs session-intent topics for the alignment signal, which the walker doesn't always have. R·S is the durability floor — a unit that's old AND low source-weight cannot be near the top of any retrieval order regardless of alignment, so the walk safely prunes it.

**Why 0.3:** Matches the synthesis-prescribed termination threshold. R alone hits 0.5 at 42 days for τ=60 (e.g., a session-log unit with source weight 0.3 has R·S = 0.5 · 0.3 = 0.15 at 42 days — pruned). A 6-month-old PROJECT.md decision has R·S = exp(-180/60) · 1.0 = 0.05 — also pruned. A 14-day-old PROJECT.md decision has R·S = exp(-14/60) · 1.0 = 0.79 — kept.

#### Walk termination summary

A branch terminates when ANY of these are true:

- Hop count reaches the cap (2 default, 3 max)
- Candidate has already been visited (cycle)
- Candidate's R·S proxy < 0.3
- Candidate is **invalidated** — its `t_invalid` is in the past, so the fact no longer holds in the world. Suppressed from the candidate set the same way a retired unit is, and the branch stops there (a superseded fact's successor is reachable directly via the supersedes edge). Record these in the retrieval event's `stale_suppressed_count`. `graph-walk.mjs` does this by default; `--include-invalid` walks cold history for an `--as-of`-style reconstruction.
- Candidate has no edges of the followed types
- Total result set exceeds budget (default 15 units; tune per query)

**When to escalate to Tier 3:** The walk completes but the question is conceptual (semantic match needed, not literal-string match) and the Tier 1+2 result set doesn't synthesize an answer.

### Tier 3 — Reasoning escalation (shortlist first, subagent second)

**Step 1 — reason over exhaustive bounded shards.** The per-turn hook automatically injects this escalation when Tier 1 returns no lexical context. When Tier 1 returns context that still does not answer the question, the active model must escalate here itself; a model-free hook cannot judge semantic sufficiency. Start at shard zero:

```bash
node "${CORE_ROOT}/skills/core/scripts/select-relevant-units.mjs" <project> "<the question>" --shard 0 --shard-size 80
```

The first line reports `Reasoning shard X/Y`, `units_scanned`, and `units_total`. Run every shard from `0` through `Y-1`; do not stop after the first plausible candidate. The order is recall-oriented: the shipped full-body product ranking comes first, followed by every unmatched active unit in deterministic id order, so the union of all shards covers the entire active corpus exactly once. Reason with world knowledge over each shard's id/topics/summary rows, Read the genuinely relevant units in full, then answer. This keeps query-time code model-free while using the already-active Claude/Codex model for the value-to-instance bridge (for example, "heritage" → El Primero). Log Tier 3 only after the reasoning pass actually runs; the hook's directive alone remains an honest Tier 1 no-hit.

**Step 2 — Explore subagent (when the shortlist read doesn't resolve it).** Spawn an Explore subagent (or general-purpose subagent) with a natural-language prompt: *"Read through `<project>/_memories/` and find everything relevant to <question>. The user wants to understand <goal>. Return a synthesis with citations to the specific files you used."*

The subagent runs its own Read + Grep + reasoning loop. It can follow edges or do lexical searches as needed. It returns a structured answer with file-path citations.

The LLM reasoning inside the subagent IS the semantic layer. No precomputed embeddings. No vector store. The subagent handles synonymy, polysemy, negation, and context-dependent meaning in ways a vector similarity score cannot.

**Degraded mode — no subagent tool available:** Some harnesses defer or omit the Agent/subagent tool, and it can be unavailable at retrieval time. Don't silently skip Tier 3 — run the same semantic pass inline: the agent performs an expanded Grep + Read loop over all topic-matched units (start from the Tier 1 lexical hits, widen the search terms with synonyms and adjacent vocabulary, read each candidate in full) and synthesizes the answer itself with file-path citations. Log the event with `tier_reached: 3` and `result: "degraded"` — or `result: "miss"` if nothing was found, since the event schema requires `miss` on an empty Tier 3 result — so retrieval-quality analysis can tell a true subagent pass from the inline fallback.

**Cost discipline:** Tier 3 invocations cost tokens. Reserve for questions Tier 1+2 actually failed on. Every Tier 3 event — hit or miss — lands in the per-project retrieval log (`<project>/_sessions/<YYYY-MM-DD>/retrieval-log.jsonl`) per the §Logging section below. The hygiene trip-wire check reads that log via `analyze-retrieval-quality.mjs` and detects repeated failures across sessions (per infrastructure trip-wire #3: documented repeated Explore-miss pattern earns a vector store).

---

## Logging — always on

Every Tier 1+ retrieval event writes one JSONL record to `<project>/_sessions/<YYYY-MM-DD>/retrieval-log.jsonl`. The log is operational telemetry — the corpus is what makes retrieval-quality analysis possible across sessions.

Two writers share the producer helper. The per-turn hook (`hooks/retrieve-context-hook.mjs`, registered on UserPromptSubmit) is the canonical product emitter — it writes one `per-turn-hook` event per prompt automatically. Retrievals you run yourself beyond the hook (an explicit graph walk, a Tier-3 escalation) get their entry from you, through the same helper:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/record-retrieval-event.mjs <project> --event-json '<json>'
```

Substitute the harness-resolved plugin root (`CORE_ROOT` or `CODEX_PLUGIN_ROOT`) when `CLAUDE_PLUGIN_ROOT` is not the active install root. The helper validates the row, then writes it through `log-event.mjs` to the `_sessions` JSONL — the sole event substrate. Per-event schema:

```jsonl
{
  "kind": "retrieval",
  "trigger": "session-start | mid-conversation | subagent | refresh-context",
  "intent_topics": ["topic-1", "topic-2"],
  "tier_reached": 2,
  "escalation_path": [1, 2],
  "units_retrieved": [
    {"id": "dc-12-routing-rewrite", "score": 0.87, "tier": 1},
    {"id": "dc-09-router-design-review", "score": 0.72, "tier": 2}
  ],
  "dip_back_count": 1,
  "candidate_count": 8,
  "selected_count": 2,
  "edge_count": 3,
  "retired_suppressed_count": 1,
  "stale_suppressed_count": 0,
  "native_memory_suppressed_count": 0,
  "context_pack_token_estimate": 620,
  "retrieval_id": "retrieval-unique-id"
}
```

- `tier_reached`: highest tier that fired in this event.
- `escalation_path`: the sequence of tiers attempted, in order.
- `dip_back_count`: how many additional retrieval calls happened *after* this one in the same response turn. Implicit usefulness signal — if you retrieved a unit and immediately needed to dip back for more context, that unit was less useful than the score predicted.
- `candidate_count` / `selected_count`: how much candidate material surfaced vs. entered the context pack.
- `retired_suppressed_count`, `stale_suppressed_count`, `native_memory_suppressed_count`: suppression signals that prove irrelevant or wrong-surface memory did not enter the pack.
- `context_pack_token_estimate`: estimated payload size after selection and suppression.
- `retrieval_id`: immutable correlation id. It lets a later, evidence-qualified answer outcome join to exactly one retrieval without rewriting the original event.

There is no automatic outcome writer. The pipeline that closed every turn with
`usefulness: "unknown"` rows was removed — an unknown-only corpus answers
nothing, and certifying that an answer happened is not evidence that a memory
helped. The hindsight relevance grade (the maintenance-run path over captured
turns) is the mechanical grader.

Historical outcome rows remain readable: the closed vocabulary (`useful`,
`partial`, `noisy`, `miss`, `unknown`) and the evidence-authority ladder
(`user-confirmed` strongest, then `objective-task-success`,
`corrective-retry`, `agent-attribution`, `unobservable`) live in
`outcome-vocab.mjs` for the analyzers that fold existing rows. A writer for
genuinely observable evidence (a user confirming a memory helped; an objective
task result) gets built when a live caller for it exists — not before.

For Tier 2 walks, log the seed unit and the result set together as one event (one JSONL line). For Tier 3 misses (Explore returned no relevant answer), set `units_retrieved: []`, `tier_reached: 3`, and add `"result": "miss"`. The infrastructure trip-wire — repeated Tier 3 misses on similar queries — now runs per-project against this log via `scripts/analyze-retrieval-quality.mjs`.

### Reading the corpus

The analyzer ships in the plugin:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs <project> [--since-days N | --all] [--json]
```

Default window is 30 days. Output: tier distribution, top dip-back units (precision proxy), top escalation topics (recall proxy). `/process-memory` calls this script and surface anomalies in plain language.

---

## Quick reference

| Need | Tier | Tool |
|---|---|---|
| Fact from current session context | 0 | (already loaded) |
| Fact stored in a known unit | 1 | `Grep` + `Read` |
| Chain of related decisions | 2 | typed-edge walk + `Read` |
| Conceptual / fuzzy question | 3 | Explore subagent — inline Grep+Read fallback when no subagent tool, logged `result: "degraded"` |
| Walk terminated unexpectedly | — | Check R·S proxy; if < 0.3 the branch was pruned (correct behavior) |
| Tier 3 fired more than once on similar queries | — | Trip-wire signal; memory hygiene will flag |
