# Source-Registration Framework

CORE's contract for how an external data source becomes part of a project's intelligence. CORE provides the framework; installations (per-organization wrappers, per-user configurations, or any layer above CORE) provide the source-specific implementation.

This document is source-agnostic throughout. It does not name Asana, Confluence, Teams, OneDrive, or any specific tool. Every concept here makes sense regardless of which sources an installation happens to support.

---

## What this is

A source becomes part of a project's memory by being **registered** to the project. Registration is a deliberate act at intake time and is the single surface where CORE knows a source exists. Without registration, source data has no authorized path into the project's memory.

The framework defines six pieces:

1. **Source-registration schema** — what declaring a source looks like
2. **Observation schema during draft state** — the existing CORE observation schema, in its in-flight form
3. **Intake protocol** — how sources get registered to a project at setup time
4. **Promotion-mode landing destinations** — where observations land based on confidence + content signals
5. **Annotation frameworks** — confidence-level and stability-class, source-agnostic
6. **Orchestration-skill contract** — what an installation's source-pulling skill must do

The framework relies on three existing CORE mechanisms it does not redesign:

- **Observation unit schema** (per `protocols/data-storage.md`) — the in-flight draft state and the fully-graduated state are the same schema, distinguished by `status`.
- **DC-70 promotion modes** (A autonomous / B confirmed / C explicit) — the landing-destination rule.
- **`inbox.md`** — the existing staging surface for non-autonomous observations.

---

## 1. Source-registration schema

### Where registrations live

Project-side, in `<project>/_sources/`. One YAML file per registered source:

```
<project>/_sources/<source-name>.yaml
```

Project-side because the registration is project context — what sources feed this project's intelligence is part of what the user sees, edits, and reasons about. This aligns with the user-control invariant: the registration is a fact about the project, owned by the project surface.

The leading `_` on `_sources/` follows the DC-74 convention for CORE-managed project subdirectories.

### Required fields

```yaml
name: <human-readable identifier>
kind: structured | semi-structured | free-text
authority: <prose declaration of who/what speaks on this source and with what authority for this project>
cadence: always-on | session-pull | user-flagged | event-driven
confidence-default: sourced | inferred | reconstructed
relevance-contract: <prose declaration of how this source's facts are identified as project-relevant>
extractor-pointer: <installation-specific path or identifier for the extractor implementation>
```

**Field semantics:**

- `name` — used as the `source` field on every observation extracted from this source. Match the file basename (without `.yaml`).
- `kind` — describes data shape, not source type. Structured = field-typed records (rows, tickets, calendar events). Semi-structured = mixed-shape content with consistent metadata (emails, documents with frontmatter). Free-text = prose without enforced structure (chat logs, transcripts, prose pages).
- `authority` — prose, not enum. The intake protocol uses this to scaffold the `source-of-authority` unit (per DC-85). One or two sentences describing what claims this source is authoritative for in this project. Examples: *"the official project tracker for engineering work — authoritative for ticket status, ownership, and dates; not authoritative for cross-team agreements that haven't been ticketed"*; *"the team's primary async communication channel — authoritative for in-thread agreements when both participants confirm; not authoritative for unilateral statements without confirmation."*
- `cadence` — when/how often this source should be pulled. `always-on` = swept at every refresh. `session-pull` = pulled on demand during a session. `user-flagged` = pulled only when the user explicitly says to. `event-driven` = pulled when an external trigger fires (webhook, notification, scheduled job).
- `confidence-default` — the default confidence-level for facts extracted from this source absent specific signal. Per-fact overrides happen via `confidence-overrides` (optional, below) or extractor judgment on content signals.
- `relevance-contract` — prose declaration of how the extractor decides whether a given datum from this source is project-relevant. Examples: *"items mentioning project keywords or assigned to project participants"*; *"messages in chats whose members include any of the project participants"*; *"events whose subject includes a project keyword or whose attendees include any project stakeholder."*
- `extractor-pointer` — installation-specific path to the extractor implementation. CORE doesn't dictate format — could be a script path, a skill name, a MCP tool reference. The installation knows what its extractor looks like.

### Optional fields

```yaml
confidence-overrides:
  - when: "<structural signal>"
    confidence: sourced | inferred | reconstructed
stability-defaults:
  - pattern: "<structural signal>"
    proposed-class: durably-correct | durably-suspect
archive-policy-overrides: <prose declaration if standard graduation doesn't fit>
```

- `confidence-overrides` — rules that change the default for specific content patterns. Example: a free-text source might default to `inferred` but override to `sourced` when the content is a verbatim quote. Each rule is a `when` (structural signal in the source data) + a `confidence` value.
- `stability-defaults` — patterns that warrant the extractor proposing a stability-class. Example: a structured source might propose `durably-suspect` when an automation actor set a field and no human edit followed. Patterns are structural signals (provenance markers, edit history), not age-based.
- `archive-policy-overrides` — when standard graduation rules don't fit. Rare. Use only when the source's data has a fundamentally different lifecycle than typical observations.

### What CORE does NOT ship

CORE ships zero example registrations. Not even abstract patterns. The framework defines the schema; installations populate it.

CORE does not ship `kind` enum values beyond the three abstract shape categories. There is no `kind: chat` or `kind: wiki` or `kind: task-tracker`. Different installations might categorize the same external system differently (a wiki might be `semi-structured` for an installation that uses wiki-page-metadata heavily; `free-text` for one that doesn't).

CORE does not maintain a registry of "known external systems." There is no preset for Asana, Confluence, GitHub, Linear, Notion, or any specific system. The framework is the only thing CORE knows about.

---

## 2. Observation schema during draft state

The observation unit schema (per `protocols/data-storage.md`) is the same schema in draft state and graduated state. There is no separate "candidate" schema. The difference between draft and graduated is the `status` field and which fields are populated.

### Draft state

When an extractor writes a new observation:

```yaml
---
id: <deterministic id; suggested hash(source-name + source-instance + content-prefix)>
type: observation
status: draft                                      # or pending, or whatever the new in-flight state is named
source: <source-name from registration>
source-instance: <opaque-to-CORE id from the source>
extracted-at: <ISO-8601 timestamp>
references-person: [<person-ids>]
confidence-level: sourced | inferred | reconstructed
proposed-stability-class: durably-correct | durably-suspect      # optional
topics: [<topic-tags, best-effort by extractor>]
---

<body — fact in plain prose, self-contained>

## Verbatim                                        # optional, when source supports verbatim
<verbatim text>

## Context                                         # optional, when surrounding signal matters for graduation
<context>
```

**Required at draft time:** `id`, `type`, `status`, `source`, `source-instance`, `extracted-at`, `references-person`, `confidence-level`, body.

**Optional at draft time:** `proposed-stability-class`, `topics`, body subsections, additional edges.

**Populated at graduation:** `status` flips from draft to active, `stability-class` ratified from `proposed-stability-class` if applicable, `topics` refined, additional edges (`cites`, `contradicts`, `extends`, `supersedes`) added based on graduation reasoning.

### Why this is the interface (and the harvester isn't)

This schema does the centralization work an intermediate "harvester" format would do. Any extractor — regardless of source — produces this shape. Any downstream consumer (graduation, retrieval, synthesis) reads this shape. The extractor is source-shaped (knows its source); the schema is source-agnostic. No intermediate process or format is needed because the schema does the job.

---

## 3. Intake protocol

A source becomes registered to a project through this protocol. Re-runnable when sources are added later or when a project's relationship to a source changes.

### Steps

1. **Discover.** The installation lists sources it has available for the project. The user (or the agent in interview mode) sees what's on offer.

2. **Per-source authority decision.** For each source the user wants to register, an interview question: *"What's this source's authority for this project's intelligence?"* The answer becomes:
   - A `source-of-authority` unit in `<project>/_memories/` (per DC-85)
   - The `authority` field on the registration YAML

3. **Confidence calibration.** Surface the source's proposed `confidence-default` (installation's suggestion) and any `confidence-overrides`. User confirms or adjusts. Final values land in the registration.

4. **Relevance contract.** Installation surfaces its proposed relevance criteria; user confirms or overrides. The agreed contract lands in the registration's `relevance-contract` field.

5. **Cadence + kind declaration.** Installation suggests `cadence` and `kind` values based on the source's nature; user confirms.

6. **Registration write.** Each registered source's YAML lands in `<project>/_sources/`. The corresponding `source-of-authority` unit lands in `<project>/_memories/`.

### Re-intake

When a new source is added later: protocol runs only for the new source.

When a project's relationship to an existing source changes (authority shift, relevance criteria change): protocol re-runs for that source, the registration updates, and a new `source-of-authority` unit supersedes the prior one (per DC-83 supersedes-not-deletes pattern).

### Who runs the intake

The intake protocol is part of CORE's startup flow (per `protocols/startup.md`) when a new project is detected with un-registered sources. The installation provides the source list (step 1) and the suggested defaults (steps 3-5); CORE provides the protocol that walks the user through the decisions and produces the registration files.

---

## 4. Promotion-mode landing destinations

When the extractor produces an observation, the observation lands in one of three destinations based on DC-70 promotion modes. The mode is determined by the extractor at write time using confidence-level and content signals.

### The three destinations

**Mode A — autonomous.** Observation lands directly in `<project>/_memories/` as an active unit. `status: active`. No user review required.

Criteria for Mode A:
- `confidence-level: sourced`
- No `proposed-stability-class` (or proposal is structurally unambiguous)
- No contradicting unit in existing memory
- Promotion target is unambiguous (observation stays as observation; no observation-to-decision promotion needed)
- Source-of-authority is settled for this source

**Mode B — confirmed.** Observation lands in `<project>/inbox.md` as a pending item with full proposed frontmatter inline. Next `/process-memory` or `/finalize` pass surfaces the item; user confirms or adjusts at the review.

Criteria for Mode B (any of):
- `confidence-level: inferred`
- `proposed-stability-class` is set and ratification is needed
- Observation could promote to decision/risk/etc. (judgment call needed)
- Observation extends an existing unit and the extension is non-trivial

**Mode C — explicit.** Observation lands in `inbox.md` flagged as requiring explicit user judgment. The flag carries the reason for explicit-mode classification. Synthesis/render passes don't pull this observation until it's resolved.

Criteria for Mode C (any of):
- `confidence-level: reconstructed`
- Observation contradicts an existing unit
- Source-of-authority is unsettled or being challenged
- Graduation can't be made mechanical (genuinely judgment-heavy)

### Landing format in `inbox.md`

Mode B and Mode C observations land in `inbox.md` as standalone blocks with full frontmatter and body inline (so the full observation is reviewable without leaving the file). The graduation pass at `/process-memory` reads these blocks, presents them for review, and on confirmation moves them into `_memories/` as active units (with `status: active`).

Open: whether `inbox.md` needs internal sections (by source / by confidence / by mode) is a structural question for installations to resolve based on their volume. Framework doesn't mandate sectioning; recommends free-form with chronological ordering by default.

### The graduation pass

`/process-memory` (existing skill) gains a step that walks `inbox.md`, presents Mode B items for confirmation, presents Mode C items for explicit user judgment, handles ratifications and contradictions. This is integrated with `/process-memory`'s existing observation-graduation logic.

Mode A observations don't pass through `/process-memory` for graduation — they're already active when extraction writes them. They do pass through `/process-memory`'s other hygiene operations (validation, archival check, etc.).

---

## 5. Annotation frameworks (source-agnostic restatement of DC-85)

### Confidence-level

Three values, required on every observation:

- **sourced** — fact captured directly from a primary source. The source itself is the evidence. Examples (pattern-anchored, not source-type-anchored): a state change recorded with authoritative actor and timestamp; a verbatim quote with attribution; a structured field value as it exists in the source-of-record.
- **inferred** — fact derived from secondary evidence within a tight reasoning window. Examples: a commitment extracted from free-text (someone said they'd do X); an event status inferred from related signals (deadline passed without flag); a stakeholder position derived from observable behavior within the source.
- **reconstructed** — fact reconstructed from indirect signals through a longer reasoning chain. Examples: decoding what happened in a meeting from the chat thread that followed it; inferring a stakeholder position from absence of objection; cross-source pattern matching where no single source carries the claim.

The extractor sets `confidence-level` using:
1. The source's `confidence-default` (from registration) as the starting point
2. Any `confidence-overrides` (from registration) that fire on content signals
3. Pattern-based assignment per the confidence-assignment guide (see `confidence-assignment-guide.md`)

Graduation does not re-judge confidence. The extractor's call stands.

### Stability-class

Two values, optional, ratified at graduation:

- **durably-correct** — fact is structurally true and should not fall off the radar because nothing has challenged it recently. Defense against the priority function demoting it for low recency.
- **durably-suspect** — fact appears stable but is wrong or unvalidated; surfaces with a flag when retrieved. Defense against silent acceptance of automation defaults, stale tracker fields, untouched governance state.

Both values zero out the recency signal in the priority function (treats the unit as if just written for ranking purposes).

The extractor may set `proposed-stability-class` when **structural criteria** are clearly met. Structural means: detectable from source provenance (field set by automation actor with no human edit; date past commitment without challenge). Age alone never qualifies.

Graduation ratifies the proposal (or doesn't). Unratified proposals do not become authoritative `stability-class` values. The proposal sits in `proposed-stability-class` until ratified, expired, or rejected.

### Authority anchoring

Every observation's `source` field points to a registered source. The `source-of-authority` unit for that source (created at intake) is the authoritative statement of what claims this source can make for the project. Synthesis passes that touch the observation can resolve authority by walking the edge to the source's authority unit.

---

## 6. Orchestration-skill contract

CORE does not ship an orchestration skill. Installations do — naming and shape are installation-level choices. CORE describes what an orchestration skill must do at the contract level.

### Required behaviors

1. **Resolve which sources to pull** based on cadence (always-on sources at every pull; session-pull on demand; event-driven when triggered; user-flagged when the user requests).

2. **Invoke the per-source extractor.** Installation owns the extractor implementation; the skill knows how to call it.

3. **Ensure observations land at the correct destination** per Mode A/B/C criteria. Either the extractor writes to the destination directly (preferred), or the orchestration skill routes the extractor's output.

4. **Append to `source-pull-log.jsonl`** with the pull event per the monitoring contract (see §7).

5. **Trigger graduation** when source pulls complete and graduation is warranted. The installation decides when (after every refresh; on a schedule; when inbox count crosses a threshold). The entry point is `/process-memory` or equivalent.

6. **Surface errors** via the standard notification surface (DC-78 channel-agnostic — installation uses whatever channel its harness supports).

### Prohibited behaviors

- Must not bypass the destination rules. All writes go through the Mode A/B/C destinations.
- Must not re-judge `confidence-level` after the extractor sets it. Confidence is the extractor's call.
- Must not auto-ratify `proposed-stability-class`. That's graduation's job.
- Must not assume a single cadence pattern across all sources. Per-source cadence is in each source's registration.

### Three-filter pipeline as contract, not implementation

DC-85 defines three filter steps (relevance → extraction → confidence judgment). The framework requires these three judgments happen in order; it does not require they happen in separate processes.

An installation may dispatch each step as a subagent (per DC-82 model-tier matrix — Haiku filter, Sonnet extraction, Sonnet confidence judgment). Or it may run all three inline in a single agent context. The choice is installation-level and is governed by performance/cost considerations the installation owns.

DC-82's model-assignment matrix becomes a **reference for installations**, not a prescription. CORE recommends; installations decide.

---

## 7. Monitoring contract

The orchestration skill writes a structured log of every source pull. This enables `/finalize` and other hygiene passes to surface monitoring signals.

### Location

```
~/.core/workspaces/<id>/source-pull-log.jsonl
```

Workspace-meta layer, not project layer. The log is monitoring data (DM operational meta), not project context the user reads or edits. It belongs alongside `state-cache.json`, `last-bootstrap.json`, etc.

This location also survives project repository operations (archive/restore, fork, rename) — project-folder logs become fragile against these operations.

### Format

One JSON object per line. Append-only. No mutation of existing lines.

```jsonl
{"timestamp": "<ISO-8601>", "source": "<source-name>", "cadence": "<cadence-from-registration>", "candidates": <count>, "mode-a": <count>, "mode-b": <count>, "mode-c": <count>, "errors": [<error-objects>], "duration-ms": <int>}
```

Schema evolution: new fields added with default values for backward compatibility. Existing fields never removed or repurposed.

### Creation

The orchestration skill creates the file on first append. If the file doesn't exist when the skill goes to append, the skill creates it (`touch` then append). No CORE scaffolding step needed.

### Rotation

None initially. If the file grows past a threshold (say 50MB), a hygiene pass at `/process-memory` could rotate to `source-pull-log.jsonl.YYYY-MM` and start a fresh file. Defer this design until file size is a real problem.

### Read protocol

`/finalize` reads the log at session close to surface monitoring signals per DC-85 spec section 9. A CORE script (`scripts/analyze-source-pull-log.mjs`, to be drafted) aggregates per-source statistics over a window and produces a brief report integrated into `/finalize`'s output.

---

## What CORE ships alongside this framework

Three artifacts CORE ships in support of the framework:

1. **This framework document.** The contract.
2. **`references/confidence-assignment-guide.md`.** Pattern catalog for confidence-level assignment, source-category-agnostic, pattern-anchored. Installations reference this when implementing extractors.
3. **`scripts/analyze-source-pull-log.mjs`.** Monitoring log analyzer; reads the JSONL, produces aggregate statistics. Used by `/finalize` and on-demand.

These three plus the existing observation schema, DC-70 promotion modes, `inbox.md`, `/process-memory`, and `protocols/startup.md` intake flow constitute everything CORE provides for external-source integration. Installations build on top; CORE doesn't reach into installations.

---

## Generalization guarantee

Any installation that fits its sources into this framework can integrate with CORE's memory architecture. The framework imposes no assumptions about:

- What specific sources exist
- What auth/tool ecosystem the installation lives in
- What categorization the installation uses for its sources
- What scheduling/triggering model the installation prefers
- What model-tier dispatch pattern the installation chooses

The framework requires:

- Sources are registered at intake
- Extractors produce observations matching the schema
- Observations land at Mode A/B/C destinations per the criteria
- The orchestration skill writes the monitoring log

That's the contract. Everything else is installation-level choice.

---

Companion: `confidence-assignment-guide.md`.
