# Model Assignments

Single source of truth for which model runs at each pipeline stage. The main agent reads this before any dispatch that has model-tier flexibility. Per the v2 memory pipeline design (session 19w).

The principle: fastest model that doesn't sacrifice quality at each stage. No Opus when Haiku suffices. No Haiku when Sonnet's judgment matters.

---

## The matrix

| Pipeline stage | Execution | Model | Reasoning mode | Blocking? |
|---|---|---|---|---|
| Observation write (in-conversation) | Main agent direct | Inherited | Standard | n/a |
| External source — pull | Haiku subagent | Haiku | Standard | Background |
| External source — cheap filter | Same subagent as pull (in-memory) | Haiku | Standard | Background |
| External source — relevance + extraction | Sonnet subagent | Sonnet (default); Opus (multi-session context calls) | Standard (Sonnet); extended (Opus path) | Background → write |
| Graduation reasoning (clear trigger) | Sonnet subagent | Sonnet | Standard | Blocking at `/finalize`; background mid-session |
| Graduation reasoning (complex / multi-session) | Opus subagent | Opus | Extended | Blocking |
| Tier 3 retrieval (Explore) | Sonnet subagent | Sonnet | Standard | Blocking |
| Priority scoring | Script (Bash) | n/a | n/a | Fast |
| Index regeneration | Script (Bash) | n/a | n/a | Fast |
| Section mapping | Sonnet subagent | Sonnet | Standard | Blocking |
| PROJECT.md render (`/finalize` and on-demand) | Sonnet subagent | Sonnet | Standard | Blocking |
| PROJECT.md render (mid-session section update) | Sonnet subagent | Sonnet | Standard | Background |
| Hygiene archive/retire evaluation | Haiku subagent | Haiku | Standard | Background |
| Auto-memory `MEMORY.md` refresh | Haiku subagent | Haiku | Standard | Background |
| Retrieval quality analysis | Script (Bash) | n/a | n/a | Fast |
| Retrieval event logging | Main agent or subagent inline | n/a (file write) | n/a | Synchronous with retrieval |

---

## The decision gates

### Graduation gate — Sonnet vs Opus

When you're about to graduate an observation into a unit, classify the call before dispatching:

| Signal | Path |
|---|---|
| Explicit user cue ("this matters"), direct repeated references, in-conversation decision with one clear successor | **Sonnet, standard reasoning** |
| Multi-session pattern, ambiguous relationship to existing units, implications touch several units in non-obvious ways | **Opus, extended thinking** |
| You find yourself thinking "this might connect to several things and I'm not sure how" | **Opus** |
| Genuinely unsure which path applies | **Opus** |

Missed graduations on complex observations compound across sessions. When uncertain, Opus.

### External-source pull gate

Three layers. Each layer's job is to do less work than the next:

| Layer | Where | Model |
|---|---|---|
| 1. Source-side scoping | MCP query parameters informed by topic vocabulary | n/a (mechanical) |
| 2. In-memory cheap filter | Pull subagent context, keyword + topic-vocabulary scan | Haiku |
| 3. Relevance judgment + signal extraction | Relevance subagent | Sonnet (default); Opus when the candidate touches multi-session context |

Disk write only at Layer 3. The pull subagent must be initialized with project context — topic vocabulary, scope, keywords — before dispatch. Without context, Layer 1 collapses and Layer 2 carries more work than it should.

### Render and section mapping

Both run on Sonnet. The section-mapping subagent reviews the priority-ranked candidate set, applies §State / §Moves / §Decisions placement rules, and flags judgment calls. The render subagent composes the six sections from the section-mapped candidates, preserves user edits, and propagates removals back as `status: retired` per anti-resurrection.

Both blocking when triggered by `/finalize` or on-demand. The mid-session section update can run background — the user isn't waiting on it.

### Background vs blocking

A dispatch is **background** when the main agent doesn't need the result this turn — external pulls, hygiene archive evaluation, mid-session section updates, MEMORY.md refresh. **Blocking** when the user is waiting on the artifact — `/finalize` render, on-demand render, graduation called during the current conversation.

---

## Alias → model-ID resolution

The matrix uses tier aliases (`haiku`, `sonnet`, `opus`), not model IDs. Resolution depends on
the harness:

| Alias | Canonical model ID (snapshot 2026-06-09) |
|---|---|
| `haiku` | `claude-haiku-4-5` |
| `sonnet` | `claude-sonnet-4-6` |
| `opus` | `claude-opus-4-8` |

- **Claude Code resolves the bare aliases natively** in its dispatch `model` parameter — pass
  the alias through; it tracks the current generation without a doc change here.
- **Harnesses without alias support** (Codex and any non-Anthropic-native dispatcher) need a
  concrete ID. Resolve the alias against the harness's live model list at dispatch time; fall
  back to the snapshot column only when no live lookup exists. The snapshot is dated because
  model generations move — when a dispatch 404s on a snapshot ID, the snapshot is stale: query
  the provider's models endpoint, use the newest ID in the tier, and update this table.
- **If a tier doesn't exist on the harness**, step UP one tier rather than down — the matrix
  assigns the cheapest model that doesn't sacrifice quality, so substituting downward breaks
  the assignment's premise.

---

## How to use this doc

Before any dispatch:

1. Identify the pipeline stage from the matrix.
2. If the stage has a decision gate (graduation, external pull), classify the call.
3. Dispatch with the explicit `model` parameter (`haiku`, `sonnet`, or `opus`) and `run_in_background` matching the blocking column.
4. Narrate the choice in plain voice when it's interesting — "Sonnet on this graduation — clear cue, single successor unit." No need to narrate every Haiku index regen.

When this doc and a protocol file disagree, the protocol file is what executes. Update both before merging the change.
