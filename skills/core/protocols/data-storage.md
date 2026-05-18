# Data Storage

## Voice

Plain person voice — same standard as SKILL.md §Voice. Specific note for this file: it's reference material the agent re-reads often; resist the urge to load every concept with a label header.

---

Read this before any Write/Edit on a unit, an observation, a PROJECT.md render, or any artifact where you're unsure where it goes. This is the central piece of v2. The rest of the protocols hang off it.

## What lives where

Three surfaces, three responsibilities. Don't mix them.

- **Project surface** — `<project>/` — the user's editable surface. `PROJECT.md` is the rendered six-section view. `_memories/` is the canonical unit store. `_handoffs/`, `_sessions/`, `_outputs/` are CORE-created project artifacts (underscore-prefixed per DC-74 so CORE's scaffolding sorts visibly apart from the user's own folders). `docs/` and any other unprefixed folders are user territory. The user can read, edit, and delete anything in the project surface; the agent treats user edits as ground truth.

- **DM operational meta** — `~/.core/` — your operational layer across projects. `dm-profile.md` is your cross-project home. `workspaces/<id>/` holds workspace-scoped meta. `topics.md` is the controlled vocabulary. `state-cache.json` is the edit-detection cache. None of this holds project facts.

- **Skill product** — `~/.claude/skills/core/` — the installed skill. Read-only at runtime. Writes here require declared `intent: skill-edit`.

The test if you're unsure where something belongs: if the project folder were wiped, would you still need this file to serve *other projects*? If yes, it's DM meta. If the answer involves "this project's decisions, risks, people, commitments," it's project surface.

---

## Two tiers — observations and units

The memory architecture is two tiers plus a canonical flag. Both tiers are markdown files with YAML frontmatter.

### Tier 1 — Observations

Capture-everything. Every utterance, tool output, casual mention, conversational signal that *could* matter. Low-effort frontmatter, no edges required at write time, bias-to-capture.

```yaml
---
id: obs-2026-05-17-1432-architect-timeline
type: observation
created: 2026-05-17T14:32:00Z
session: 2026-05-17-c
sources:
  - surface: teams-chat
  - thread: <thread-id>
references-person:
  - architect-name
references-topic:
  - timeline
  - deliverable-x
---
Architect committed to X done by July 15. Mentioned in passing
during weekly sync.
```

Location: `<project>/_memories/observations/<YYYY-MM>/obs-<timestamp>-<slug>.md`. Date-organized for browsability — observations are high-volume; flat-with-prefix at the unit-store root would overwhelm. This is the explicit observation exception to the DC-68 flat-layout rule.

You auto-extract `references-person` and `references-topic` at write time using the topic vocabulary at `~/.core/topics.md` plus your own judgment. If you encounter a person or topic not in the vocabulary, you can add it under Mode A (autonomous, narrated).

### Tier 2 — Units

Graduated, reasoned facts. Rich frontmatter, typed edges, body with the full reasoning.

```yaml
---
id: dc-72-v2-execution-plan
type: decision
status: active
created: 2026-05-17T18:45:00Z
updated: 2026-05-17T18:45:00Z
confidence: 0.90
sources:
  - _handoffs/handoff-2026-05-17d.md
  - docs/plans/2026-05-17-v2-execution-plan.md
references-person:
  - david-bates
references-topic:
  - v2-build
  - memory-architecture
  - autonomous-execution
edges:
  - {type: cites, target: dc-71-v2-spec-drafted, note: "executes spec"}
  - {type: supersedes, target: dc-60-pivot-personal-tool, note: "subsumes by adopting v2 as the delivery"}
canonical: true
last_accessed: 2026-05-17T18:45:00Z
access_count: 1
---
The v2 execution plan locks 8 phases and 38 steps for the
autonomous build. ...
```

Location: `<project>/_memories/<prefix>-<slug>.md` — flat layout per DC-68, with the type encoded in the filename prefix.

### The canonical flag

Top-priority units mark `canonical: true` in frontmatter. Canonical units get a priority floor, drive PROJECT.md rendering, and surface most heavily in retrieval. Not a separate tier — a marker on individual units.

---

## The six edge types

Edges live in unit frontmatter as `{type, target, note?}` triples. Six committed types, no proliferation past these without a new decision unit:

- `cites` — generic reference. Use this when one unit references another without a stronger relationship.
- `supersedes` — replacement. The target unit is no longer current truth.
- `depends-on` — dependency. This unit's validity depends on the target.
- `conflicts-with` — contradiction. The two units make incompatible claims; reconciliation owed.
- `references-person` — a person mentioned in the unit (also surfaces in the top-level `references-person:` list).
- `references-topic` — a topic mentioned (also surfaces in the top-level `references-topic:` list).

**Eager vs lazy writes.** Three types you write the moment you commit the unit, because retrieval and hygiene depend on them right away: `supersedes`, `depends-on`, `conflicts-with`. Inverse edges (the target gains the reciprocal edge) are eager for these three too.

The other three — `cites`, `references-person`, `references-topic` — are eager when the relationship is clear at write time, lazy otherwise. Memory hygiene's reconciliation pass catches implicit ones missed at write time.

**Wikilinks** (`[[unit-id]]`) in the body are permitted as a secondary, organic edge form. Hygiene's reconciliation pass promotes durable wikilinks to typed edges (default type: `cites`) when they appear in citation-style contexts.

---

## Graduation — observation → unit

The graduation step is where the LLM's value lives — noticing connections across observations that a basic capture system would miss.

### Triggers

- An observation gets referenced more than twice → graduation candidate.
- Pattern recognition: multiple observations connect into a substantive implication → graduate.
- Continuous self-evaluation flags an observation as "this keeps mattering" → graduate.
- Explicit user cue ("this matters," "remember this") → graduate.
- Scheduled graduation pass at `/finalize` and on-demand.

### Process

1. Read the source observation(s) with extended thinking.
2. Reason about implications: what does this commit to, depend on, create risk for?
3. Reason about relationships: who and what else is affected?
4. Reason about cross-session impact: does this matter beyond the current session?
5. Compose the graduated unit with rich frontmatter and edges.
6. Edge back to source observations via `cites` with `note: "graduated from"`.
7. Source observations stay in place — the raw record is preserved.

### Anti-miss bias

When in doubt, write the unit. A slightly-too-eager unit is cheap. A missed critical fact isn't. Hard calls — should this be one unit or three, what's the right edge structure, which existing unit does this supersede — are candidates for invoking `protocols/analysis.md`. Multi-agent earns its cost on classification and structural calls.

---

## Retrieval ladder

Four tiers. Score-gated termination — you decide at each tier whether the candidate set is good enough or you need to escalate.

```
Tier 0: In-context (already loaded — no retrieval)
   ↓ miss or insufficient
Tier 1: Lexical via Grep + Read + Glob (keyword-anchored)
   ↓ miss or insufficient
Tier 2: Graph walk via typed-edge frontmatter (relational)
   ↓ miss or insufficient
Tier 3: Semantic via Explore subagent (LLM reasoning over the vault)
```

Auto-memory at `~/.claude/projects/*/memory/` is queried alongside `_memories/` at every tier — it's a complementary resource, not a competing store.

**Default retrieval excludes observations.** Only graduated units surface by default. Observations are queryable on demand ("show me observations about X").

**The semantic tier is where graduation-style reasoning happens.** The Explore subagent is strictly more capable than a vector store at single-user scale because it has the full LLM as its embedding model — it can reason about queries in context, distinguish polysemy, recognize negations, and synthesize structured answers with citations rather than chunks.

Detail in `references/retrieval.md`.

---

## Priority function

The committed function from DC-69:

```
priority(unit, t) = w_R · R(unit, t)
                  + w_F · F(unit, t)
                  + w_S · S(unit)
                  + w_A · A(unit, t)
                  + P(unit)
```

Signals:

- **R (recency)** — `exp(-recency_days / τ)`, τ=60 days.
- **F (frequency-across-sources)** — distinct surface-types the unit appears in, normalized by 6.
- **S (source-type weight)** — lookup from the source-type table (PROJECT.md = 1.0, configuration = 0.9, operational meta = 0.7, `_handoffs/`/`_outputs/` = 0.5, session logs = 0.3, raw transcripts = 0.2).
- **A (alignment with current intention)** — Jaccard overlap of unit's topics against session-intent topics.
- **P (pinning)** — user-only pin levels: `floor` (priority floor 0.7), `true` (floor 0.9, decay bypassed), `always` (priority 1.5, alignment-independent). `pinned: false` or `suppress: true` is an anti-pin (priority × 0.3).

Starting weights: `w_R=0.30, w_F=0.15, w_S=0.20, w_A=0.35`.

Priority is computed at retrieval time over a candidate set, never persisted as a stored ranked list. The implementation ships with the plugin at `~/.claude/skills/core/scripts/priority.py` (DC-77 — executable units stay in the plugin; project folders hold only data). Invoke as `python3 ~/.claude/skills/core/scripts/priority.py <project>/_memories/ [--intent t1,t2]` for a ranking diagnostic, or import the `score`, `score_unit_file`, and `score_proxy_RS` library functions.

---

## Promotion modes (internal vocabulary)

You reason about three modes internally. In conversation with the user, plain language: "I'll do X," "want me to do X?", or just doing what they said.

- **Mode A — autonomous.** You act, you narrate the action. Most operations. The criterion is integrity uncertainty: if you're reasonably confident the action preserves project-context accuracy, act.
- **Mode B — propose-and-wait.** You propose, you wait for explicit yes. Fires when integrity uncertainty kicks in: smuggling risk, overwriting user authorship, new structural commitment, irreversible, push.
- **Mode C — explicit.** The user uses vocabulary like "remember," "forget," "pin," "save as X" — you obey without re-asking. Overrides the cost gate entirely.

### What triggers integrity uncertainty (the Mode B switch)

- Destination is durable (PROJECT.md, dm-profile.md, canonical unit).
- Action would overwrite content the user authored.
- New structural pattern the user hasn't endorsed.
- Action is irreversible or hard to undo.
- High contradiction risk against existing decisions or risks.
- Inference distance is long (extrapolation, not direct user statement).
- Smuggling tripwire categories: data topology, identity, protocol migration, invariant changes, global defaults.

When in doubt, propose first. A bad Mode B prompt costs the user a small interruption. A smuggled Mode A action costs you trust.

### Pushes always require explicit yes

Commits are autonomous (you commit as needed without asking). Pushes — every push, every repo — require explicit yes from the user every time.

---

## PROJECT.md ↔ units rendering

PROJECT.md is rendered from canonical units. Three triggers:

1. **At `/finalize`** — full regeneration. Walk canonical units, compose the six sections, show the draft, accept-or-edit, commit.
2. **On-demand** — any time the user asks.
3. **In-session, autonomously** — section-level re-render after each meaningful update affecting a section. New decision → re-render Decisions & Risks. New risk → re-render Decisions & Risks. Status-shifting event → re-render State.

Section-level writes, not full-file. You read the current section state, preserve user edits, propagate them back into the source-of-truth units.

### The anti-resurrection rule

When the user removes a fact from PROJECT.md, that fact is gone. You don't re-derive it from the same source observations on the next render. The corresponding unit's `status` becomes `retired` (frontmatter change, body preserved for forensic value), and hygiene's retire verb fires.

If the same fact would have surfaced again on the next render, the retired status keeps it out. Resurrection requires the user actively un-retiring it.

### David's broad authority (per DC-72)

The user (David) explicitly granted broad authority to manage PROJECT.md "in whatever way is best for maintaining project context accurately and thoroughly." Render mechanics, edit-detection, propagation back to units — these are tools, not the goal. Accuracy and thoroughness are what matter. The mechanisms can change.

---

## Edit detection

Hash-based comparison against the state cache at `~/.core/state-cache.json`:

```json
{
  "files": {
    "/path/to/PROJECT.md": {
      "last_hash": "abc123...",
      "last_written": "2026-05-17T14:32:00Z",
      "last_written_by": "agent",
      "last_section_written": "Decisions"
    }
  }
}
```

You update the cache on every read/write. You compare at every read.

Runs at:
- `/orient` (full sweep).
- Before any autonomous render (just-in-time).
- `/finalize` (full sweep).
- On-demand.

When a user edit is detected → ground truth → propagate back to source-of-truth units → anti-resurrection fires for removals → audit trail captured in the autonomous run log.

Belt-and-suspenders for tracked files: cache is primary, `git diff` is the fallback.

---

## Topic vocabulary

`~/.core/topics.md` holds the controlled vocabulary. Currently 18 tags. You evolve the vocabulary during runs — add tags as units accumulate.

Each addition is appended to a changelog at the top of the file:

```
- 2026-05-17: added v2-build — emerged from the autonomous build run
- 2026-05-16: added memory-architecture — coalescing topic across DC-65/67/68/69
```

This is Mode A (autonomous, narrated). No per-tag confirmation required.

Auto-extraction at observation write time uses the current vocabulary plus your judgment to populate `references-topic` frontmatter on the observation.

---

## Auto-creating people, topics, and deliverables on observation reference

When you write an observation that references a person, topic, or deliverable that doesn't already have a unit, you create the stub unit autonomously (Mode A). Don't leave dangling edges into thin air — edges into non-existent units break the retrieval graph at Tier 2.

**Stub creation triggers:**

- Observation's `references-person` field names someone with no `who-<slug>.md` unit.
- Observation's `references-topic` field uses a tag that doesn't have a `topic-<slug>.md` unit (the topic itself may already exist in `~/.core/topics.md`; the unit holds the substantive description).
- Observation mentions a deliverable (named work product, milestone, named artifact) with no `del-<slug>.md` unit.

**Stub frontmatter (minimal — graduate later):**

```yaml
---
id: who-<slug>          # or topic-<slug> or del-<slug>
type: person            # or topic or deliverable
status: active
created: <ISO timestamp>
updated: <ISO timestamp>
confidence: 0.5          # low — this is a stub
sources:
  - <observation-id-that-triggered-creation>
canonical: false
last_accessed: <ISO timestamp>
access_count: 1
---
Stub unit — created Mode A from <observation-id>. Body fills in as more observations reference this entity.
```

Narrate the creation: *"Creating stub unit `who-architect-name.md` — first mention in `obs-2026-05-17-1432-architect-timeline`."* That keeps the visible-curation contract.

Stubs graduate to full units when subsequent observations add substance. Hygiene's continuous self-evaluation surfaces stubs that have been quiet for a long time but accumulated references — graduation candidates.

---

## Conflict resolution

The memory architecture creates several seams where data can disagree. Handle each consistently.

### Auto-memory says X, unit store says not-X

The unit store wins. Auto-memory is scratch cache rebuilt from synthesis at bootstrap. If they diverge mid-session, write or update the unit and let hygiene reconcile auto-memory at the next reconciliation pass.

### Your render of a section disagrees with the user's most recent edit

The user's edit is ground truth. Edit-detection surfaces the change; you propagate it back to the source-of-truth unit (frontmatter update, or `status: retired` for a removed fact); the next render starts from the updated units. Anti-resurrection fires for removals.

### Queued autonomous render vs the user starting to edit the same section

The user wins. Pause the render. Edit-detection surfaces the in-progress edit; you don't write over it. Resume when the section settles (next turn or explicit "go ahead").

### Two units make the same claim

Reconcile at the next hygiene pass. The reconciliation either merges them (pick the canonical id, update edges in every citing unit, retire the merged-away unit) or keeps both with a `conflicts-with` edge if they genuinely make incompatible variants of the claim. The merge case writes an after-action report to `~/.core/hygiene-log.jsonl` with the canonical id, the merged-away id, every edge rewritten, and the count of out-edges union-merged.

### Retired content re-emerges in a conversation

The anti-resurrection rule fires. You don't re-promote the retired unit. If the new conversation generates a genuinely new framing of the underlying fact, that's a new unit — composed fresh, not a revival. The retired unit stays retired unless the user explicitly un-retires it (Mode C).

### Cross-project drift (different projects, same fact, different framings)

You don't auto-reconcile across projects. The cross-project store is `~/.core/research/` for shared knowledge; `dm-profile.md` is cross-project patterns only. Project facts stay in their project. If the user switches projects mid-conversation and starts referencing facts from a different project, surface the project-switch and either context-shift to the other project or ask the user to restate the relevant facts.

### No-response-inference default

When the user goes quiet mid-conversation and you've staged a Mode B proposal: act on your best judgment after a reasonable delay, narrate what you did, log it. Don't block the session indefinitely waiting for a yes/no on something you can reverse. If the action is genuinely irreversible (push, destructive external op), wait — but also self-unblock with an unblock plan and execute the plan rather than freezing.

---

## Auto-memory integration

Auto-memory at `~/.claude/projects/<cwd>/memory/` stays as its own store. It's a complementary resource in the overall memory architecture:

- Loaded at session start (200-line cap stays).
- Holds cross-session feedback memories — user preferences, patterns, references.
- Retrieval queries BOTH `_memories/` and auto-memory — no separate path.
- Graduation can promote auto-memory entries to `_memories/` when they reveal cross-project implications worth a durable unit.
- Hygiene reads auto-memory and reconciles with `_memories/` — no duplication, no conflict.
- Auto-memory's `MEMORY.md` index is maintained by the same agent that maintains `_memories/` indexes.

---

## File locations and naming

Unit prefix convention (locked at plan revision 2026-05-17, per DC-68 + Invariant 6):

| Type | Prefix | Example | Layout |
|---|---|---|---|
| Decision | `dc-` | `_memories/dc-69-priority-function.md` | flat |
| Risk | `risk-` | `_memories/risk-3-premature-convergence.md` | flat |
| Explainer | `exp-` | `_memories/exp-overview.md` | flat |
| Review finding | `rf-` | `_memories/rf-v2-adversarial-review.md` | flat |
| Principle | `pr-` | `_memories/pr-anti-resurrection.md` | flat |
| Person | `who-` | `_memories/who-david-bates.md` | flat |
| Deliverable | `del-` | `_memories/del-explainer-set.md` | flat |
| Topic | `topic-` | `_memories/topic-voice-discipline.md` | flat |
| Observation | `obs-<YYYY-MM-DD-HHMM>-` | `_memories/observations/2026-05/obs-2026-05-17-1432-architect-timeline.md` | sub-dir by month |

Archive and cold-storage layout:

- **Archive**: `_memories/archive/` — flat directory. Archived units keep their original prefix and gain `archived: true` + `archived_at:` in frontmatter. Not `_memories/archive/decisions/dc-XX.md` — just `_memories/archive/dc-XX.md`.
- **Cold-storage**: `_memories/cold-storage/<YYYY>/<MM>/` — date-organized sub-dirs (same exception rationale as observations: cold-store is potentially high-volume over time).
- **Observation archive**: `_memories/archive/observations/<YYYY-MM>/obs-*.md` — preserves the date-organization of the high-volume case.

Indexes at `_memories/`:

- `INDEX-decisions.md` — auto-generated chronological index of `dc-*.md`.
- `INDEX-risks.md` — auto-generated index of risk units.
- Other type indexes generated as needed.

Always read frontmatter to confirm a unit's status before relying on it; the filename prefix is a hint, not a guarantee.

---

## Make the placement choice visible

Before any non-exempt Write or Edit on a project-context, DM-meta, or skill-product artifact, narrate the placement choice in user-visible chat. The user should see where you're writing, what kind of surface it is, why that surface (especially if another reasonable surface exists), and what naming convention you're following. This isn't an approval gate — announce and proceed. The point is that placement decisions don't get smuggled past the user.

A natural-prose version is fine — *"Writing the swarm synthesis to `_outputs/<date>/<topic>/SYNTHESIS.md` as the per-topic output artifact; standard naming convention for swarm outputs."* The `pwd-guard.py` hook may inject a structured-format reminder when it fires; the reminder is fine as machine-generated context, but your own voice in the chat is plain prose.

When two or more surfaces could legitimately hold the same artifact, name the alternative explicitly and the reason for the choice. When no surface fits, say so as a clear *uncovered artifact* announcement, propose where you're putting it, and file a §Moves item to extend the closure list — the user can redirect on the next turn.

### Mechanical-write exemption

You don't have to narrate placement when the path is fully determined without a classification judgment:

- Your own session log (`<project>/_sessions/<YYYY-MM-DD>/agent-log.md`).
- The autonomous run log (`<project>/autonomous-run-log.md`).
- `inbox.md` raw external pulls.
- Auto-memory cache writes (`~/.claude/projects/<hash>/memory/`).
- Edits to a file the user explicitly named in the same turn.
- State cache writes (`~/.core/state-cache.json`).
- Hygiene log entries (`~/.core/hygiene-log.jsonl`).

The test: exempt only when the path is determined by the artifact's own name, schema, or the user's explicit statement — not by classification you had to make.

### Skill-product writes

When the proposed path is `~/.claude/skills/core/**` or `<project>/core-skill/**`, declare `intent: skill-edit` so the hook recognizes the write as intentional. The `pwd-guard.py` hook fires on writes to these paths as advisory machine context; your own narration to the user follows the plain-prose pattern above.

---

## Where everything lives — quick reference

Three rings, one read at runtime.

**Project ring** — `<project>/`

```
<project>/
├── PROJECT.md                     ← rendered six-section view
├── _memories/                        ← canonical unit store (flat per DC-68)
│   ├── <prefix>-<slug>.md         ← active units
│   ├── observations/<YYYY-MM>/    ← capture-everything tier
│   ├── archive/                   ← archived units (flat)
│   ├── cold-storage/<YYYY>/<MM>/  ← deep historical
│   ├── _validation/tests/         ← validation regime test corpus
│   └── INDEX-<type>.md            ← auto-generated indexes
├── inbox.md                       ← optional: raw external pulls
├── _handoffs/                     ← narrative session logs (CORE-created)
├── _sessions/                     ← per-session agent logs (CORE-created)
├── _outputs/                      ← swarm synthesis, deliverables (CORE-created)
├── docs/                          ← architecture, explainers (user surface)
└── .claude/                       ← harness config + scripts
```

**DM operational ring** — `~/.core/`

```
~/.core/
├── dm-profile.md                  ← cross-project personality, portfolio observations
├── index.json                     ← global workspace registry
├── topics.md                      ← controlled vocabulary
├── state-cache.json               ← edit-detection hashes
├── hygiene-log.jsonl              ← machine-readable hygiene operations
├── workspaces/<id>/               ← per-workspace operational meta
│   └── workspace.json
└── research/                      ← cross-project knowledge library
```

**Skill ring** — `~/.claude/skills/core/`

Read-only at runtime. Writes require `intent: skill-edit` declaration.

---

## What's not in the v2 architecture

Removed in v2 (was present in v1, no longer applies):

- The `routing sheet` as a 7-rule table for every write classification — replaced by surface-based routing (project / DM meta / skill product) with the PWD mechanic at the boundary.
- The `file-shape classifier` and `auto-compaction strategy` — replaced by `protocols/hygiene.md` (three verbs: archive / retire / cold-store). Hygiene handles all compaction, retire, and archive operations.
- Cowork capability-routing — Cowork is not a v2 target harness. The skill works on Claude Code Desktop's Code tab; future-Cowork support is its own design exercise.

If you encounter references to "DC-46 auto-compaction," "BM-DC46-7 effectiveness reports," "the file-shape classifier," or "Cowork capability levels" in older protocol files or memory entries, treat them as historical context. The v2 mechanism is `protocols/hygiene.md`.
