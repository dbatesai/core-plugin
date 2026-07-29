# Model Assignments

Which reasoning tier runs at each pipeline stage. The main agent reads this before any dispatch that has model-tier flexibility.

The principle: fastest model that doesn't sacrifice quality at each stage. No Opus when Haiku suffices. No Haiku when Sonnet's judgment matters.

**The tier is the portable contract; the model IDs are harness policy.** The matrix assigns a qualitative effort level — `haiku` (mechanical), `sonnet` (judgment), `opus` (hardest calls) — and that assignment holds on any harness. The alias table below resolves those tiers to Anthropic model IDs, which is Claude-harness policy and not cross-harness truth. A harness serving a different provider maps each tier to its own nearest equivalent; it does not resolve an Anthropic ID.

---

## The matrix

| Pipeline stage | Execution | Model | Reasoning mode | Blocking? |
|---|---|---|---|---|
| Observation write (in-conversation) | Main agent direct | Inherited | Standard | n/a |
| External source — pull | Haiku subagent | Haiku | Standard | Background |
| External source — cheap filter | Same subagent as pull (in-memory) | Haiku | Standard | Background |
| External source — relevance + extraction | Sonnet subagent | Sonnet (default); Opus (multi-session context calls) | Standard (Sonnet); extended (Opus path) | Background → write |
| Graduation reasoning (clear trigger) | Sonnet subagent | Sonnet | Standard | Blocking at `/process-memory`; background mid-session |
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

A dispatch is **background** when the main agent doesn't need the result this turn — external pulls, hygiene archive evaluation, mid-session section updates, MEMORY.md refresh. **Blocking** when the user is waiting on the artifact — `/finalize` render, on-demand render, a graduation the user asked for in the current conversation.

---

## Alias → model resolution (harness policy)

The matrix uses tier aliases (`haiku`, `sonnet`, `opus`), not model IDs. How an alias becomes a
concrete model is the harness's business, and the answer differs per harness:

- **Claude Code resolves the bare aliases natively** in its dispatch `model` parameter — pass
  the alias through; it tracks the current generation with no lookup and no table here.
- **A harness that needs a concrete ID** resolves the tier against its own provider's live
  model list at dispatch time, picking the newest model in that tier. Codex and any other
  non-Anthropic-native dispatcher take this path. There is no snapshot table to fall back on:
  a hard-coded ID goes stale the moment a generation moves, and a stale ID in a cross-harness
  document is worse than a live lookup that occasionally has to retry.
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
