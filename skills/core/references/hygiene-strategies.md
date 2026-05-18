# CORE Memory Hygiene: Semantic Distillation Protocol

The memory hygiene is CORE's memory curation mechanism. It reviews accumulated memory, session logs, and project notes to consolidate knowledge, resolve contradictions, and promote validated insights to permanent storage.

## Two-Tier Data Lifecycle

The memory hygiene is **Tier 2** of CORE's two-tier data lifecycle:

- **Tier 1: Auto-Memory** — Fires every session automatically. Captures immediate learnings, user feedback, and session-level decisions.
- **Tier 2: Memory Hygiene** — Runs every 3-5 sessions (this document). Curates, distills, and consolidates accumulated knowledge.

## When to Run

- After significant sessions (3+ agents, complex findings)
- When memory files exceed ~20 entries
- When the DM detects contradictions between memory entries
- Periodically (every 3-5 sessions) as maintenance
- When explicitly requested by the user

## The Four Phases

### Phase 1: Memory Inventory

Read all memory files in the project's memory directory (`~/.claude/projects/*/memory/`) and any cross-project store (e.g., `~/.claude/memory/`):

1. **Index custody (do this first).** For each store, list every memory file on disk and compare to the store's index file (`MEMORY.md`, `memory.md`, etc.). Any orphan file (on disk but not indexed) gets an index entry added or moved to `archived/` if no longer relevant. Any indexed entry pointing at a missing file gets removed from the index. The store's index must accurately reflect what exists; otherwise retrieval fails silently and the rest of the memory hygiene operates on a wrong map.
2. List every memory file with its type, name, and last-modified date.
3. Read each file's content.
4. Catalog: what topics are covered, what's recent, what's potentially stale.

If an index has grown too large to load eagerly (the cross-project `memory.md` reads in full per the PreToolUse hook; the per-project `MEMORY.md` is auto-injected up to 200 lines), surface the over-growth and split topic content into sub-files or sub-folders so the index stays index-only.

### Phase 2: Semantic Distillation

For each memory entry, assess:
- **Still accurate?** — Does this match the current state of the codebase/project? Read relevant files to verify.
- **Still relevant?** — Is this information useful for future sessions, or was it only relevant to a completed task?
- **Redundant?** — Does another memory entry cover the same ground? If so, merge into the stronger entry.
- **Needs updating?** — Has the underlying fact changed since this was written?

Actions:
- **Promote**: Transient observations that proved true across multiple sessions → upgrade to permanent project knowledge
- **Merge**: Duplicate or overlapping entries → consolidate into one comprehensive entry
- **Archive**: Information that was useful but is no longer relevant → move to an `archived/` subdirectory with a note about why
- **Delete**: Information that turned out to be wrong or is now captured in code/docs → remove
- **Update**: Information that's mostly right but needs correction → edit in place

**Workspace field curation:** Also review the `dm_notes` field in each workspace's `workspace.json`. If it contains more than ~10 one-line self-correction entries, consolidate them into a brief paragraph summarizing recurring briefing patterns, then remove the individual entries. The field should remain readable and useful — not a growing wall of one-liners.

### Phase 3: Reconciliation

Phase 3 resolves disagreements between sources: between memory entries (sub-protocol 3a), and between archived facts and current state (sub-protocol 3b). Both share the "reconcile two things that disagree" theme; one for memory-vs-memory, one for archive-vs-current-state.

#### Sub-protocol 3a — Memory Contradiction Resolution

Identify pairs of memory entries that contradict each other:
1. List the contradiction explicitly: "Memory A says X, Memory B says Y"
2. Investigate which is correct by reading current project state
3. Resolve: update or remove the incorrect entry
4. If both are partially correct, create a new entry that captures the nuanced truth

#### Sub-protocol 3b — Archive Reconciliation Audit

**Why this exists.** DC-42/46 compaction migrates older entries from `PROJECT.md` / `IMPROVEMENT_LOG.md` to archive files (`DECISIONS.md`, `PROJECT-ARCHIVE.md`, `IMPROVEMENT_LOG-ARCHIVE.md`). Per the archive-exclusion rule in `startup.md` Phase 3A, those archives are never read at bootstrap — preserving DC-19's read-side singularity. The gap: an entry archived many sessions ago can become load-bearing again as new protocol text and §Moves items reference it; the DM treats those references as dangling because the fact is invisible. Sub-protocol 3b periodically reconciles. The audit does **not** read archives at bootstrap (DC-42 holds), does **not** auto-promote (user approval gated), and is **separate** from BM-DC46-7's volume-threshold trigger (that's `MIGRATE`-count, this is content-relevance). Cross-ref: safeguard for the DC-19 read-side singularity invariant under DC-42/46 compaction architecture.

##### Step 1 — Discover archives

Scan project root for the three known archive files:

- `<project>/DECISIONS.md`
- `<project>/PROJECT-ARCHIVE.md`
- `<project>/IMPROVEMENT_LOG-ARCHIVE.md`

For each found file, capture `last_modified`. **Recency gate:** if `last_modified` is within the last **14 days**, skip the file — recently-archived entries haven't had time to become re-emergent. If no archive files exist (new project), 3b is a no-op and writes a one-line "no archives present" entry to the retrospective.

##### Step 2 — Extract candidate IDs

Per file shape:

- `DECISIONS.md` / `PROJECT-ARCHIVE.md`: regex `(DC|DEC|R|I|A|F|KU)-[A-Za-z0-9]+(?:\.\d+)?` captures decision/risk/finding/assumption IDs (e.g., `DC-11..15`, `R-5`, `F9`, `KU-DC47-B`).
- `IMPROVEMENT_LOG-ARCHIVE.md`: regex matches `Session [a-z]\b` plus dated headers `\b\d{4}-\d{2}-\d{2}[a-z]?\b`.

Dedupe within each file. Emit `{archive_file, candidate_id, archived_at}` tuples.

##### Step 3 — Grep current state for candidates

For each candidate ID, count occurrences across the current read surface:

| Read surface | Path |
|---|---|
| Project synthesis | `<project>/PROJECT.md` |
| Recent handoffs | `<project>/_handoffs/*.md` (last 5 by mtime) |
| Skill protocols | `~/.claude/skills/core/protocols/*.md` |
| Skill references | `~/.claude/skills/core/references/*.md` |
| Skill entry | `~/.claude/skills/core/SKILL.md` |
| Recent session logs | `<project>/_sessions/<latest-date>/*.md` |

**Exclude self-references:** the stub line in `PROJECT.md §D&R` for the archived entry (per DC-48's stub-every pattern) is itself a match. Subtract one from the PROJECT.md count if the stub line is present. The audit asks *"is this entry referenced beyond its own stub?"* not *"does the stub exist?"*

##### Step 4 — Surface re-emergent candidates

Compute a match count per ID across all read surfaces. **Threshold: ≥3 matches** (excluding the stub line). Sort descending. **Cap output at top 10 candidates** per cycle.

For each surfaced candidate, present to the user:

```
DC-N (archived <YYYY-MM-DD>, file: DECISIONS.md) — <match_count> current references:

  - <project>/PROJECT.md §State line 23 — "per DC-N, ..."
  - protocols/data-storage.md:142 — "see DC-N for..."
  - _handoffs/handoff-2026-05-13e.md:34 — "DC-N reasoning..."

Archive entry (first 300 chars):
  > <verbatim from archive>

Promote stub back to §D&R? [y / N / show-full / skip-3-cycles]
```

User responses:

- **`y`** — DM drafts a one-line stub for `PROJECT.md §D&R` matching the DC-48 stub-every pattern, presents the proposed text, writes only on explicit secondary confirmation.
- **`N`** — log the rejection. The candidate is soft-suppressed for one cycle. If its match count climbs by ≥2 within the next 3–5 sessions, it re-surfaces. (Avoids re-asking the same question every cycle.)
- **`show-full`** — DM displays the full archive entry, then re-asks `y / N / skip-3-cycles`.
- **`skip-3-cycles`** — explicit user direction to suppress for 3 memory hygienes (~9–15 sessions). For genuinely-retired entries the user knows are intentionally referenced.

There is no `skip-forever` — every audit cycle is cheap, and the user-control invariant prefers re-asking over silently forgetting.

Suppression state persists in `~/.core/swarm-effectiveness/archive-reconciliation-state.json` (sibling to BM-DC46-7's per-compaction reports — same dir, different file). Schema:

```json
{
  "version": 1,
  "suppressions": [
    {
      "archive_file": "DECISIONS.md",
      "candidate_id": "DC-24",
      "user_decision": "skip-3-cycles",
      "decided_at": "2026-05-13T23:55:00Z",
      "expires_after_cycles": 3,
      "cycles_elapsed_at_decision": 0,
      "last_match_count": 5
    },
    {
      "archive_file": "DECISIONS.md",
      "candidate_id": "DC-11..15",
      "user_decision": "N",
      "decided_at": "2026-05-13T23:55:00Z",
      "soft_suppress_until_match_count_delta": 2,
      "last_match_count": 4
    }
  ]
}
```

##### Step 5 — Record retrospective

Append a Phase 3b section to the memory-hygiene retrospective at `~/.core/memory-hygienes/<YYYY-MM-DD>.md`:

```markdown
## Phase 3b: Archive Reconciliation

**Archives scanned:**
- DECISIONS.md (last modified 2026-05-13, 78 days ago)
- PROJECT-ARCHIVE.md (last modified 2026-05-13, 0 days ago) — SKIPPED (recency gate)
- IMPROVEMENT_LOG-ARCHIVE.md (last modified 2026-05-11, 2 days ago) — SKIPPED (recency gate)

**Candidate IDs extracted:** DECISIONS.md → 29 IDs (DC-1 … DC-41, DEC-001/002/004)

**Re-emergent candidates (≥3 matches):**
- DC-19 — 7 matches → user: y (promoted)
- DC-24 — 5 matches → user: skip-3-cycles
- DC-11..15 — 4 matches (compound ID) → user: N
- DC-41 — 3 matches → user: y (promoted)

**Suppression state updated:** archive-reconciliation-state.json refreshed.

**Threshold tuning observation:** (e.g., "8 candidates surfaced; user rejected 6 — consider raising threshold from 3 to 5.")
```

##### Step 6 — Self-improvement signal

After 2–3 memory hygienes, the retrospective accumulates enough data to tune:

- **Match threshold** (default ≥3). If most surfaced candidates get rejected, raise it. If the user grumbles about missed re-emergent entries, lower it.
- **Recency gate** (default 14d). If recent archives carry hot references, shrink to 7d.
- **Top-N cap** (default 10). Tune if cycles regularly produce more than 10 high-match candidates.

Phase 4 (Pattern Synthesis) reads the last 3 retrospectives and surfaces tuning recommendations to the user.

##### Relationship to BM-DC46-7 / Sub-protocol 3c

BM-DC46-7 is the volume-threshold half: per-compaction effectiveness reports at `~/.core/swarm-effectiveness/auto-compaction-<workspace-id>-<date>.md`, plus the memory-hygiene path-(a)→(b) re-decision trigger if cumulative `MIGRATE` count >5 since last review. The volume-audit machinery lives in **sub-protocol 3c** below. Sub-protocol 3b is the **content-relevance** half — same Phase 3 home, sibling not successor:

| Concern | BM-DC46-7 / Sub-protocol 3c (volume) | Sub-protocol 3b (relevance) |
|---|---|---|
| Audit type | `MIGRATE`-count threshold | Cross-reference count |
| Trigger | Per-compaction (Step 4.7 / Phase 0.7) + memory hygiene | Dream cycle only |
| Re-decision target | Path (a) → (b) re-decision | Per-entry stub re-promotion |
| Write artifact | `auto-compaction-*.md` reports | `archive-reconciliation-state.json` + retrospective Phase 3b |

#### Sub-protocol 3c — Auto-Compaction Volume Audit (BM-DC46-7 memory-hygiene integration)

**Why this exists.** Per DC-46 path (a), auto-MIGRATE runs autonomously at `/finalize` Step 4.7 and `startup.md` Phase 0.7. The autonomy is bounded by a periodic re-decision trigger: if the archive accumulates entries faster than the user expected, the framework should surface that and offer path (b) (per-session-first-MIGRATE gate) as a switch. The trigger is fired by memory hygiene, not by the user's memory.

##### Step 1 — Find auto-compaction reports

Scan `~/.core/swarm-effectiveness/auto-compaction-*.md` files written since the previous memory hygiene:

- `since_timestamp = <last memory hygiene's run_at>` (from `~/.core/memory-hygienes/<previous>.md`); if no previous cycle exists, use `now - 30d` as a conservative default.
- List every `auto-compaction-<workspace-id>-<YYYY-MM-DD>.md` with mtime > `since_timestamp`.

##### Step 2 — Aggregate cumulative MIGRATE entries

For each report, extract the `Entries migrated` list and accumulate by workspace:

```
{
  "core-framework": [
    {"file": "PROJECT.md", "first_line": "DC-21: Architecture principles…", "archive": "DECISIONS.md", "session": "2026-05-25"},
    {"file": "IMPROVEMENT_LOG.md", "first_line": "2026-04-12 — Initial backlog audit", "archive": "IMPROVEMENT_LOG-ARCHIVE.md", "session": "2026-05-27"},
    ...
  ]
}
```

##### Step 3 — Threshold check

For each workspace with cumulative `MIGRATE` count > **5 entries** since the previous memory hygiene, fire the re-decision surface:

```
**Auto-MIGRATE re-decision trigger for workspace `core-framework`**

Since the previous memory hygiene, auto-compaction moved N entries:
  - PROJECT.md §D&R → DECISIONS.md: DC-21 (2026-05-25), DC-22 (2026-05-25), DC-24 (2026-05-27), …
  - IMPROVEMENT_LOG.md → IMPROVEMENT_LOG-ARCHIVE.md: 2026-04-12, 2026-04-15, …

DC-46 selected path (a) (autonomous-with-visibility) on 2026-05-13.

Continue with path (a), or switch to path (b) (per-session-first-MIGRATE gate)?
  - [y] Stay on (a) — autonomous is working, archive growth acceptable.
  - [b] Switch to (b) — require explicit approval before each MIGRATE next session.
  - [skip-1-cycle] Re-ask next memory hygiene.
```

Threshold (default 5) is tunable per BM-DC46-7's self-improvement learning. The threshold itself can be tuned after 2–3 memory hygienes of operation.

##### Step 4 — Tuning observations

Beyond the threshold check, scan the reports for:

- **Per-file ratio drift.** Compare measured `per_file_ratio` across reports for the same file. If drift > 0.05 within 3 cycles, propose ratio re-baseline.
- **Threshold edge cases.** If a file repeatedly compacts (3+ times per cycle) without crossing 5 entries, the threshold may be too aggressive for that file shape.
- **Reactive trigger fires.** Any `trigger: reactive_error` entry means proactive layers failed for that file. Investigate the root cause; do not treat it as routine.

##### Step 5 — Record in retrospective

Append a Phase 3c section to `~/.core/memory-hygienes/<YYYY-MM-DD>.md`:

```markdown
## Phase 3c: Auto-Compaction Volume Audit

**Reports scanned:** 4 (`auto-compaction-core-framework-2026-05-{18,22,25,27}.md`)
**Cumulative MIGRATE entries since last cycle:** 7 across `core-framework`
**Re-decision surfaced:** YES — user response: y (stay on path (a))

**Per-file ratio observations:**
- PROJECT.md: 0.337 → 0.339 (stable)
- IMPROVEMENT_LOG.md: unmeasured → 0.31 (new baseline persisted)

**Reactive trigger fires:** 0
**Tuning recommendations:** none this cycle.
```

#### Sub-protocol 3d — Edge-Integrity Sweep (`_memories/` memory model, DC-68)

**Why this exists.** The v2.0 memory model (DC-68) stores typed edges in unit-file frontmatter at `<project>/_memories/`. When a target unit is renamed, archived, or deleted, its forward/inverse edges become **dangling** — pointing at an id that no longer resolves. Tier 2 retrieval (typed-edge walk per DC-67) treats danglers as dead ends and silently drops them; over time, dangling edges erode the graph. Sub-protocol 3d periodically reconciles. It respects the user-control invariant: structural-type dangles on user-authored units surface for review, never autoremoved; informational-type dangles on agent-ephemeral units are removed autonomously with logging.

##### Step 1 — Scan unit frontmatter for edges

Walk `<project>/_memories/*.md`. For each unit, parse YAML frontmatter and collect every `edges:` entry of form `{type, target}`. Emit tuples `(source_unit_id, edge_type, target_id)`.

Skip files matching `_*.md` and `README.md` — those are vault-control files, not units.

##### Step 2 — Verify edge targets exist

Build a set of all valid unit ids by scanning `_memories/*.md` frontmatter `id:` fields (or filename stems if id is absent). For each edge tuple, check whether `target_id` is in the valid-id set OR matches a quoted-string external target (e.g., `"Park et al. 2023 (arxiv.org/abs/2304.03442)"`) — external targets are exempt from dangle detection. Edges whose target is neither in the valid-id set nor a quoted external are **dangling**.

##### Step 3 — Classify and act per edge type

| Edge type | Target dangling, source is user-authored unit | Target dangling, source is agent-ephemeral |
|---|---|---|
| `supersedes` / `superseded-by` | **Surface** for user review (structural; erasure may need attention) | Auto-remove with log |
| `depends-on` / `depended-on-by` | **Surface** for user review | Auto-remove with log |
| `conflicts-with` | **Surface** for user review | Auto-remove with log |
| `cites` / `cited-by` | Auto-remove with log (informational) | Auto-remove with log |
| `references-person` | Auto-remove with log | Auto-remove with log |
| `references-topic` | Auto-remove with log | Auto-remove with log |

**What counts as user-authored vs. agent-ephemeral:** Every unit in `<project>/_memories/` is treated as user-authored by default (the DM writes them but the user has full edit + delete authority — same protection as PROJECT.md). Unit files marked with `status: agent-ephemeral` in frontmatter (reserved for future use) would be the only exception.

##### Step 4 — Surface for user review

Emit a Phase 3d block in the retrospective for each structural dangler:

```markdown
**Structural dangle:** `<source-unit>` has `<edge-type>: <missing-target>`.
Target file not found in `_memories/`. Decide:
  (a) restore target file from git / archive / handoff
  (b) rewrite edge to point at the canonical successor (give id)
  (c) remove the edge — relationship no longer applies
```

DM reads user response on next session and applies. Until then, the edge stays in place (silent dead-end is preferable to silent removal).

##### Step 5 — Auto-remove informational danglers + log

For each auto-removable dangler, rewrite the source unit's frontmatter to drop that edge entry. Append a one-line removal log to `~/.core/memory-hygienes/<YYYY-MM-DD>.md` Phase 3d section:

```markdown
- Removed `cites: <missing-target>` from `<source-unit>.md` (target not in vault, informational edge)
```

##### Step 6 — Update inverse edges on rename / merge / archive

When sub-protocol 3a (memory contradiction) or 3c (compaction) merges or renames a unit, this sweep is the cleanup pass: rewrite every inverse edge that pointed at the old id to point at the new canonical id. Counts go in the Phase 3d retrospective block.

##### Step 7 — Wikilink reconciliation (light pass)

Grep unit bodies for `[[<wikilink-id>]]` references. If `<wikilink-id>` resolves to a valid unit and the source unit's frontmatter `edges:` has no entry of type `cites` pointing at that target, promote it: add `{type: cites, target: <wikilink-id>}` to the source's edges. This is the memory-hygiene promotion of organic body wikilinks to typed structural edges (per DC-68). One-line log entry per promotion.

---

#### Sub-protocol 3e — Auto-prune of session logs (DC-68 agent-ephemeral hygiene)

**Why this exists.** `<project>/_sessions/<date>/` accumulates per-agent operational logs from every swarm run. These are agent-ephemeral by design — they preserve what happened during a swarm but rarely get re-read after the swarm's outputs and handoff are written. Over time they grow without bound. Per DC-68, agent-ephemeral surfaces are eligible for autonomous prune by the memory hygiene within reporting bounds. The user-control invariant is preserved by construction: session logs are agent-authored, not user-authored, so autonomous removal does not violate "never silently delete user content."

##### Step 1 — Discover candidates

List every file under `<project>/_sessions/*/`. For each, capture `mtime` and the parent directory date. Eligibility filter — a file is **prune-eligible** only if ALL THREE are true:

1. **Older than 90 days** — `now - mtime > 90 days`
2. **No unit cites it** — Grep `_memories/*.md` for the session file's path or basename in any `sources:` or `cites:` edge target. Zero matches = no citations.
3. **No handoff references it** — Grep `<project>/_handoffs/*.md` for the session date directory name OR the specific session log filename. Zero matches = unreferenced by any handoff.

If any of the three conditions fails, the file stays.

##### Step 2 — Prune and log

For each eligible file:

1. Capture file path and mtime for the log entry
2. Delete the file (`rm`)
3. Append a one-line entry to the Phase 3e block in `~/.core/memory-hygienes/<YYYY-MM-DD>.md`:

```markdown
- Pruned `_sessions/2026-01-15/forge-log.md` (mtime 2026-01-15, age 123 days, no unit cites, no handoff reference)
```

##### Step 3 — Empty directory cleanup

After pruning, check whether any `_sessions/<date>/` directory is now empty. If so, `rmdir` it. Log the directory removal as a separate line:

```markdown
- Removed empty directory `_sessions/2026-01-15/` (all files pruned)
```

##### Step 4 — Effectiveness report

Append a summary to the Phase 3e block:

```markdown
**Session-log prune summary:**
- Candidates considered: 47
- Pruned: 12 files across 3 directories
- Kept: 35 (5 cited by units, 8 referenced in handoffs, 22 < 90 days old)
- Disk freed: ~340 KB
```

The summary makes the autonomous deletion legible to the user in retrospective form. If the user wants to halt or tune the autonomous behavior, they edit memory-hygiene.md or set a project-level config flag (future, when configuration surface exists).

##### What this protocol does NOT prune

- **Handoffs** (`<project>/_handoffs/*.md`) — user-facing narrative, never autonomously pruned. The user may prune handoffs manually; the memory hygiene does not.
- **Outputs** (`<project>/_outputs/`) — swarm deliverables, never autonomously pruned. These are durable artifacts.
- **Swarm-effectiveness reports** (`~/.core/swarm-effectiveness/*.md`) — retrospective records the memory hygiene itself reads (per sub-protocol 3c and the trip-wire check). Never autonomously pruned by this protocol.
- **Dream-cycle retrospectives** (`~/.core/memory-hygienes/*.md`) — historical record of this same protocol's actions. Never autonomously pruned.
- **Any session log that's been cited by a unit** — the citation is evidence the log carries information the agent reached back for; preserve it.

---

### Phase 4: Pattern Synthesis

Look across all surviving memory entries for meta-patterns:
- What themes recur across sessions?
- What feedback has the user given consistently?
- What project patterns have emerged?
- Are there insights that no single memory captures but the collection implies?

If a new meta-pattern is identified, create a new memory entry to capture it.

#### Retrieval trip-wire check (v2.0 memory model, DC-67/68/69)

Read `~/.core/retrieval-metrics.jsonl`. Each line is one retrieval event in the format:

```json
{"unit_id": "<id>", "tier": 1|2|3, "timestamp": "<ISO8601>", "query": "<query string>", "result": "hit"|"miss"}
```

The file is written by the agent during retrieval (Tier 1 lexical, Tier 2 graph walk, Tier 3 Explore subagent). Each successful retrieval appends one line; misses append `"result": "miss"`. Per DC-67, four trip-wires can earn the next-step infrastructure later if they fire across consecutive memory hygienes:

| Trip-wire | Condition | Next-step infra if it fires twice consecutively |
|---|---|---|
| Lexical latency | Corpus > 50K files AND repeated Grep latency > 500ms in logs | Sidecar ripgrep daemon behind MCP |
| Graph walk latency | Tier 2 walks repeatedly > 2s | First: generate `adjacency.json` at memory-hygiene time. Then: graph engine behind MCP. |
| Semantic miss pattern | Repeated Tier 3 misses on similar query patterns across multiple sessions | Vector store behind MCP |
| Concurrent-writer conflict | Second writer enters system AND direct-write conflicts arise | Event-log + materializer |

**Per Anvil J4 (DC-67):** one cycle of a trip-wire firing is a signal; two consecutive cycles is grounds to propose a new DC committing to the infrastructure step.

Action: emit a `Phase 4: trip-wire-check` block in the retrospective listing every trip-wire's current status. If any fired this cycle AND fired in the previous cycle's retrospective, surface a DC proposal to the user with the trip-wire's specific evidence.

### Phase 5: Agent Refresh

Review agent files for agents that participated in recent swarms. Agent files live at `~/.core/agents/<kebab-case-name>.md` — the filename matches the agent's name as used in swarm briefings (e.g., an agent introduced as "Adversarial Consistency Auditor" maps to `adversarial-consistency-auditor.md`).

1. For each agent that was used, check if the execution produced notable observations about its effectiveness — from swarm effectiveness reports or the DM's own observations.
2. If patterns emerge across uses, update the agent's Identity, Analytical Lens, or Blind Spots to reflect what was learned.
3. Retire any agent that has consistently underperformed or whose niche is now covered by a better-designed agent. When retiring: move the file to `~/.core/agents/retired/` rather than deleting it — the configuration retains reference value. Annotate any `~/.core/task-configs/` entries that reference the retired agent so the DM knows to substitute during future swarm composition.

This does not require a full audit of all agents — only those that participated in sessions since the last memory hygiene.

---

## Output

The memory hygiene produces:
1. Updated memory files (modified, merged, archived, or deleted)
2. A memory hygiene retrospective at `~/.core/memory-hygienes/<YYYY-MM-DD>.md` documenting all changes (per the data-storage protocol's Self-Evolution Artifacts table)
3. Updated MEMORY.md index reflecting any additions/removals
4. If sub-protocol 3b ran: refreshed `~/.core/swarm-effectiveness/archive-reconciliation-state.json` (suppression state), plus a Phase 3b section in the retrospective
5. If sub-protocol 3b promoted any stubs: corresponding edits to `<project>/PROJECT.md §D&R` (gated on the secondary `y` confirmation per Step 4)
