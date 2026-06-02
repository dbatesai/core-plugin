# Data Storage

## Voice

Plain person voice — same standard as SKILL.md §Voice. Specific note for this file: it's reference material the agent re-reads often; resist the urge to load every concept with a label header.

---

Read this before any Write/Edit on a unit, an observation, a PROJECT.md render, or any artifact where you're unsure where it goes. This is the central piece of v2. The rest of the protocols hang off it.

## What lives where

Three surfaces, three responsibilities. Don't mix them.

- **Project surface** — `<project>/` — the user's editable surface. `PROJECT.md` is the rendered six-section view. `_memories/` is the canonical unit store. `_summaries/`, `_sessions/`, `_outputs/` are CORE-created project artifacts (underscore-prefixed per DC-74 so CORE's scaffolding sorts visibly apart from the user's own folders). `docs/` and any other unprefixed folders are user territory. The user can read, edit, and delete anything in the project surface; the agent treats user edits as ground truth.

- **DM operational meta** — `~/.core/` — your operational layer across projects. `dm-profile.md` is your cross-project home. `workspaces/<id>/` holds workspace-scoped meta. `topics.md` is the controlled vocabulary. `state-cache.json` is the edit-detection cache. None of this holds project facts.

- **Skill product** — `${CLAUDE_PLUGIN_ROOT}/skills/core/` (marketplace install) or `~/.claude/skills/core/` (legacy direct install) — the installed skill. Read-only at runtime. Writes here require declared `intent: skill-edit`.

The test if you're unsure where something belongs: if the project folder were wiped, would you still need this file to serve *other projects*? If yes, it's DM meta. If the answer involves "this project's decisions, risks, people, commitments," it's project surface.

There's a fourth surface that isn't CORE's to own but that CORE reads from: **harness-local recall** — Claude Code's `~/.claude/projects/*/memory/MEMORY.md`, Codex's `~/.codex/memories/`, equivalents in future harnesses. CORE treats this as scratch cache, never authoritative. See `dc-86-harness-local-memory-recall` for the principle and the `save-recall-note` adapter verb (resolved per `harnesses/<name>.md`) for the explicit-save mechanism. The trigger for invoking explicit-save — what user phrases mean "save this" to a given user — is install-level configuration in the user's `AGENTS.md`, not CORE prose.

---

## Authority ordering

When sources conflict, this is the order CORE resolves:

1. **Direct user instruction in the current session** — overrides everything else.
2. **User-edited `<project>/PROJECT.md`** — the user's curation surface; anti-resurrection rule applies.
3. **Canonical units in `<project>/_memories/`** — project facts of record.
4. **CORE operational meta in `~/.core/`** — runtime state only; not project fact authority.
5. **Harness-local recall** — Claude Code `MEMORY.md`, Codex memories at `~/.codex/memories/`, and equivalents in future harnesses. Hints only; must verify against the unit store before acting.

See `dc-86-harness-local-memory-recall` for the principle behind levels 4 and 5 — the four-surface model that makes the divergence between Claude's autonomous-write and Codex's explicit-save-only memory models safe.

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

### External-source observations — three-layer filtering

Observations from external sources (Teams, SharePoint, Jira, Confluence, Figma, anything else with an MCP) flow through three filtering layers before anything lands on disk. The disk-write volume stays proportional to relevance, not to source volume.

| Layer | Where | Model | Disk write? |
|---|---|---|---|
| 1. Source-side scoping | MCP query parameters | n/a (mechanical) | No |
| 2. In-memory cheap filter | Pull subagent context | Haiku | No |
| 3. Relevance judgment + extraction | Relevance subagent | Sonnet (default), Opus (multi-session context calls) | **Yes** — only here |

**Layer 1** is critical for high-volume sources. The pull subagent never asks Teams for all messages — it queries with parameters informed by project context: topic vocabulary from `~/.core/topics.md`, relevant keywords from current units, time scope, channel/space/project scope. The MCP query is shaped by what the project cares about *before* anything transfers.

**Layer 2** runs entirely in the pull subagent's context. Keyword + topic-vocabulary scan; drops obvious misses. Nothing written.

**Layer 3** is the Sonnet relevance agent. It receives the filtered candidates from Layer 2, a brief of the current unit-store topic vocabulary, and any relevant PROJECT.md context. It decides what's actually relevant to *this project* and extracts the specific signal worth recording. Only Layer 3 output gets written to `_memories/observations/`. Same schema as in-conversation observations — the source is opaque to anything downstream.

The pull subagent must be initialized with project context before dispatch — without it, Layer 1 collapses and Layer 2 has to carry more work than it should. The main agent hands the pull subagent a brief (topic vocabulary, scope, keywords) as part of the dispatch prompt.

Model assignments per layer live in `references/model-assignments.md`. When in doubt at Layer 3 — multi-session implications, ambiguous cross-project signals — escalate to Opus.

### Tier 2 — Units

Graduated, reasoned facts. Rich frontmatter, typed edges, body with the full reasoning.

```yaml
---
id: dc-12-routing-rewrite
type: decision
status: active
created: 2026-04-02T18:45:00Z
updated: 2026-04-02T18:45:00Z
confidence: 0.90
sources:
  - _summaries/summary-2026-04-02.md
  - docs/plans/routing-rewrite-plan.md
people:
  - alex
topics:
  - routing
  - auth
  - api-rewrite
edges:
  - {type: cites, target: dc-09-router-design-review, note: "executes design"}
  - {type: supersedes, target: dc-04-routing-hotfix, note: "subsumes the hotfix path"}
canonical: true
last_accessed: 2026-04-02T18:45:00Z
access_count: 1
---
The routing rewrite locks 4 phases for the migration to the new
auth boundary. ...
```

Location: `<project>/_memories/<prefix>-<slug>.md` — flat layout per DC-68, with the type encoded in the filename prefix.

**Field-name distinction between tiers.** Tier 1 observations carry `references-person:` and `references-topic:` — the raw entities mentioned in the capture. Tier 2 units carry curated `people:` and `topics:` arrays — the result of graduation reasoning, which may add, drop, or rename entries from the raw observation lists. `priority.mjs` and `check-units.mjs` read the Tier 2 `topics:` field; the priority function's A signal (Jaccard alignment with session-intent topics) operates on this curated list.

### The canonical flag

Top-priority units mark `canonical: true` in frontmatter. Canonical units get a priority floor, drive PROJECT.md rendering, and surface most heavily in retrieval. Not a separate tier — a marker on individual units.

### Open-question units and the `by-when` field (DC-85 §2)

`open-question` is a Tier 2 unit type for unresolved questions whose answers shape the project: pending stakeholder decisions, awaited approvals, deliverables expected by a date, asks that need a response. Distinct from observation (a fact captured) and decision (a settled choice) — an open question is a known-unknown the project is waiting on.

Frontmatter shape — same six required fields as other Tier 2 units (`id`, `type`, `status`, `created`, `updated`, `topics`), plus one optional field specific to open questions:

```yaml
---
id: oq-michelle-design-review
type: open-question
status: active
created: 2026-05-15T18:00:00Z
updated: 2026-05-15T18:00:00Z
by-when: 2026-05-22
topics:
  - design-review
  - stakeholder-feedback
people:
  - michelle
edges:
  - {type: depends-on, target: dc-12-design-spec-v2}
---
The design review feedback Michelle owes us by Friday 5/22 — needed
before we can lock the spec.
```

The `by-when` field is an optional ISO date (YYYY-MM-DD). When set on an `active` (unresolved) open-question and the date is in the past, the question is **stale**. Staleness is a retrieval signal, not a status — the unit stays `active` until resolved.

Status lifecycle: `active` → `archived` (resolved with the answer captured elsewhere — usually a decision unit citing this one as `supersedes`-equivalent context) or `active` → `retired` (no longer relevant; the question stopped mattering).

**Resolution by supersession.** When an open-question is answered, the answer typically lands as an observation or decision unit citing the open-question. The open-question itself moves to `status: archived` rather than being deleted — the question and its eventual answer both stay queryable.

**Staleness at `/orient`.** The startup protocol's elapsed-time signals (per `protocols/startup.md` §"Elapsed-time signals") include a sweep over active open-question units. Any unit with a past `by-when` surfaces in the readiness summary. This is the absence-detection primitive — the architecture knows the question is past due even when nobody has explicitly noted it. Mechanism for the Michelle probe (spec §10).

---

## The committed edge types

Edges live in unit frontmatter as `{type, target, note?}` triples. The committed types, no proliferation without a new decision unit:

- `cites` — generic reference. Use this when one unit references another without a stronger relationship.
- `supersedes` — replacement. The target unit is no longer current truth.
- `superseded-by` — inverse of `supersedes`. The target is the unit that replaced this one; this unit usually carries `status: superseded`.
- `depends-on` — dependency. This unit's validity depends on the target.
- `depended-on-by` — inverse of `depends-on`.
- `conflicts-with` — contradiction. The two units make incompatible claims; reconciliation owed.
- `references-person` — a person mentioned in the unit (used on Tier 1 observations).
- `references-topic` — a topic mentioned (used on Tier 1 observations).

**Eager vs lazy writes.** Three types you write the moment you commit the unit, because retrieval and hygiene depend on them right away: `supersedes`, `depends-on`, `conflicts-with`. Inverse edges (`superseded-by`, `depended-on-by`) are eager for these too — written at the same time on the target unit.

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

### Dispatch gate — Sonnet vs Opus

Graduation runs as a subagent, not in the main agent's context. Classify the call before dispatching:

| Signal | Path |
|---|---|
| Clear trigger (explicit user cue, direct repeated references, in-conversation decision with one clear successor) | **Sonnet, standard reasoning, background mid-session / blocking at `/finalize`** |
| Complex call (multi-session pattern, ambiguous relationship to existing units, implications touch several units non-obviously) | **Opus, extended thinking, blocking** |
| You find yourself reasoning "this might connect to several things and I'm not sure how" | **Opus** |
| Genuinely unsure which path applies | **Opus** |

Missed graduations on complex observations compound across sessions. When uncertain, Opus.

The graduation subagent — both paths — can invoke Tier 3 retrieval (Explore) internally when it needs to answer "what existing units does this observation touch semantically?" That's a Sonnet subagent spawned from inside the graduation subagent's context, not a separate dispatch from the main agent.

### Mode A vs Mode B at graduation

Most graduations are Mode A — the subagent completes, writes the unit, narrates the outcome to the main agent which narrates to the user. Mode B fires when the graduated unit would supersede or conflict with an existing canonical unit. The graduation subagent surfaces the conflict to the main agent; the main agent surfaces it to the user; the unit doesn't land until the user confirms.

Full matrix at `references/model-assignments.md`.

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

Harness-local recall (via the `read-auto-memory` adapter verb — Claude Code's `MEMORY.md`, Codex memories, equivalents) is queried alongside `_memories/` at every tier as scratch context. Useful for hints; never authoritative — verify against the unit store before acting. See §"Authority ordering" above for where it sits in the stack.

**Default retrieval excludes observations.** Only graduated units surface by default. Observations are queryable on demand ("show me observations about X").

**Default retrieval excludes invalidated units.** A unit whose validity dimension shows `t_invalid` in the past is suppressed from the Tier-2 candidate set the same way a retired unit is — the fact no longer holds in the world. Cold history stays reachable by an explicit point-in-time query (`graph-walk --include-invalid`, `bitemporal --as-of`). See `references/retrieval.md` walk-termination.

**The semantic tier is where graduation-style reasoning happens.** The Explore subagent is strictly more capable than a vector store at single-user scale because it has the full LLM as its embedding model — it can reason about queries in context, distinguish polysemy, recognize negations, and synthesize structured answers with citations rather than chunks.

Detail in `references/retrieval.md`.

### Logging is always on

Every Tier 1+ retrieval event writes one JSONL line to `<project>/_sessions/<YYYY-MM-DD>/retrieval-log.jsonl`. This is base operational telemetry — not debug-mode-gated. The writer is the agent inline at the retrieval site via `scripts/record-retrieval-event.mjs`; there is no hook. Schema and reading patterns in `references/retrieval.md`.

**PROJECT.md management events (DC-85 Phase 1b).** PROJECT.md is agent-managed; effectiveness is measured via structured event emission, not user review. Two logs carry the signal — both written by `scripts/log-event.mjs` (shared helper):

| File | Event kinds | Written by |
|---|---|---|
| `_sessions/<date>/retrieval-log.jsonl` | `retrieval`, `hot-section-synthesis`, `hot-section-over-budget`, `synthesis-pass-behavior` (Phase 3) | `record-retrieval-event.mjs`, `hot-section.mjs` |
| `_sessions/<date>/hygiene-log.jsonl` | `demote-moves`, `demote-moves-large-batch`, `compact-project`, `project-md-over-cap` | `demote-moves.mjs`, `compact-project.mjs` |

`/orient` Step 4 surfaces load-bearing signals from these logs in the readiness summary; the Phase 5 quality-pass analyzer (when it ships) reads the full corpus.

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
- **S (source-type weight)** — lookup from the source-type table (PROJECT.md = 1.0, configuration = 0.9, operational meta = 0.7, `_summaries/`/`_outputs/` = 0.5, session logs = 0.3, raw transcripts = 0.2).
- **A (alignment with current intention)** — Jaccard overlap of unit's topics against session-intent topics.
- **P (pinning)** — user-only pin levels: `floor` (priority floor 0.7), `true` (floor 0.9, decay bypassed), `always` (priority 1.5, alignment-independent). `pinned: false` or `suppress: true` is an anti-pin (priority × 0.3).

Starting weights: `w_R=0.30, w_F=0.15, w_S=0.20, w_A=0.35`.

Priority is computed at retrieval time over a candidate set, never persisted as a stored ranked list. The implementation ships with the plugin at `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs` (DC-77 — executable units stay in the plugin; project folders hold only data). Invoke as `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs <project>/_memories/ [--intent t1,t2]` for a ranking diagnostic, or import the `score`, `scoreUnitFile`, and `scoreProxyRS` library functions.

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

### Push policy is per-user, per-repo

Commits are autonomous — commit as needed without asking. Pushes follow the user's established policy. Default when the user has named no policy: confirm every push, every repo. When the user has named standing authorization for specific repos (in feedback memory under `feedback_commit_push_policy.md` or similar), push to those repos autonomously per the named scope. Common shapes:

- *"Push to main on `<repo>` is autonomous"* — push without asking.
- *"Follow the release process on `<repo>`"* — work on feature branches, open PRs, never push directly to main; the release flow (e.g., `/cut-release`) carries main updates.
- No standing rule named for a repo — confirm before push.

If origin owner doesn't match what the user authorized (e.g., the user authorized `dbatesai/*` and you find `someoneelse/foo`), skip the push and surface the mismatch.

---

## PROJECT.md ↔ units rendering

PROJECT.md is rendered from canonical units. Three triggers:

1. **At `/finalize`** — full regeneration. Walk canonical units, compose the six sections, show the draft, accept-or-edit, commit.
2. **On-demand** — any time the user asks.
3. **In-session, autonomously** — section-level re-render after each meaningful update affecting a section. New decision → re-render Decisions & Risks. New risk → re-render Decisions & Risks. Status-shifting event → re-render State.

Section-level writes, not full-file. You read the current section state, preserve user edits, propagate them back into the source-of-truth units.

When you invoke `priority.mjs` during an in-session render (trigger 3 above) and want an audit trail, pass `--log <project>/_sessions/<date>/priority-log.jsonl --log-label render-on-change`. The log captures the timestamp, intent topics, top-K rankings, and label per invocation — useful for reconstructing why a particular re-render happened after the fact. Optional; not required for the render to happen.

### The anti-resurrection rule

When the user removes a fact from PROJECT.md, that fact is gone. You don't re-derive it from the same source observations on the next render. The corresponding unit's `status` becomes `retired` (frontmatter change, body preserved for forensic value), and hygiene's retire verb fires.

If the same fact would have surfaced again on the next render, the retired status keeps it out. Resurrection requires the user actively un-retiring it.

### Authority over PROJECT.md sits with the user

The user owns PROJECT.md. Manage it in whatever way best serves accuracy and thoroughness. Render mechanics, edit-detection, propagation back to units — these are tools, not the goal. Accuracy and thoroughness are what matter. The mechanisms can change.

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

### Harness-local recall says X, unit store says not-X

The unit store wins (per §"Authority ordering" above). Harness-local recall is scratch cache — Claude Code rebuilds `MEMORY.md` from synthesis at bootstrap; Codex memory is user-curated and never rebuilt. If they diverge mid-session, write or update the unit and let hygiene reconcile the harness recall surface at the next reconciliation pass (Claude Code) or surface the divergence to the user (Codex — explicit-save only, so the agent shouldn't silently rewrite).

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

## Harness-local recall integration

Harness-local recall is its own store at a harness-specific path — Claude Code uses `~/.claude/projects/<cwd>/memory/`, Codex uses `~/.codex/memories/`, future harnesses bring their own. The `read-auto-memory` adapter verb resolves the path per harness (see `harnesses/<name>.md`). Per DC-86 it's surface 4 in the authority stack — recall, never authoritative.

- Loaded at session start by the harness when it has an auto-load surface (Claude Code does, Codex doesn't auto-load memory).
- Holds cross-session workflow lessons — user preferences, patterns, references, harness-specific empirical findings.
- Retrieval queries BOTH `_memories/` and harness-local recall — no separate path.
- Graduation can promote a harness recall entry into `_memories/` when it reveals cross-project implications worth a durable unit. The reverse — auto-write into harness recall from project facts — happens per harness: Claude Code refreshes `MEMORY.md` from top-priority units at `/finalize` Step 5; Codex never auto-writes (explicit-save only, via the `save-recall-note` verb mapped in `harnesses/codex.md`).
- Hygiene reads harness recall and reconciles with `_memories/` — no duplication. On Codex, reconciliation surfaces divergences rather than silently rewriting.
- The harness recall index, when one exists (Claude Code's `MEMORY.md`), is maintained by the same agent that maintains `_memories/` indexes.

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
| Person | `who-` | `_memories/who-alex.md` | flat |
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

A natural-prose version is fine — *"Writing the swarm synthesis to `_outputs/<date>/<topic>/SYNTHESIS.md` as the per-topic output artifact; standard naming convention for swarm outputs."* A harness hook may inject a structured-format reminder on these writes (the CORE author's install wires one; most installs won't have it); that reminder is fine as machine-generated context, but your own voice in the chat is plain prose.

When two or more surfaces could legitimately hold the same artifact, name the alternative explicitly and the reason for the choice. When no surface fits, say so as a clear *uncovered artifact* announcement, propose where you're putting it, and file a §Moves item to extend the closure list — the user can redirect on the next turn.

### Mechanical-write exemption

You don't have to narrate placement when the path is fully determined without a classification judgment:

- Your own session log (`<project>/_sessions/<YYYY-MM-DD>/agent-log.md`).
- The autonomous run log (`<project>/autonomous-run-log.md`).
- `inbox.md` raw external pulls.
- Harness-local recall writes (path resolved per the `save-recall-note` adapter verb in `harnesses/<name>.md` — Claude Code's `~/.claude/projects/<hash>/memory/`, Codex's `~/.codex/memories/extensions/ad_hoc/notes/`).
- Edits to a file the user explicitly named in the same turn.
- State cache writes (`~/.core/state-cache.json`).
- Hygiene log entries (`~/.core/hygiene-log.jsonl`).

The test: exempt only when the path is determined by the artifact's own name, schema, or the user's explicit statement — not by classification you had to make.

### Skill-product writes

When the proposed path is `~/.claude/skills/core/**` or `~/.claude/plugins/**/skills/core/**`, declare `intent: skill-edit` so any configured skill-edit guard recognizes the write as intentional. Such a guard, where an install has one wired, fires on writes to these paths as advisory machine context; your own narration to the user follows the plain-prose pattern above.

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
├── _summaries/                    ← human-readable session summaries (CORE-created)
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
│   ├── workspace.json
│   └── last-bootstrap.json        ← session_started_at + bootstrap_completed_at; SKILL.md off-switch
└── research/                      ← cross-project knowledge library
```

**Skill ring** — `${CLAUDE_PLUGIN_ROOT}/skills/core/` (marketplace) or `~/.claude/skills/core/` (legacy direct install)

Read-only at runtime. Writes require `intent: skill-edit` declaration.

---

## What's not in the v2 architecture

Removed in v2 (was present in v1, no longer applies):

- The `routing sheet` as a 7-rule table for every write classification — replaced by surface-based routing (project / DM meta / skill product) with the PWD mechanic at the boundary.
- The `file-shape classifier` and `auto-compaction strategy` — replaced by `protocols/hygiene.md` (three verbs: archive / retire / cold-store). Hygiene handles all compaction, retire, and archive operations.
- Cowork capability-routing — Cowork is not a v2 target harness. The skill works on Claude Code Desktop's Code tab; future-Cowork support is its own design exercise.

If you encounter references to "DC-46 auto-compaction," "BM-DC46-7 effectiveness reports," "the file-shape classifier," or "Cowork capability levels" in older protocol files or memory entries, treat them as historical context. The v2 mechanism is `protocols/hygiene.md`.
