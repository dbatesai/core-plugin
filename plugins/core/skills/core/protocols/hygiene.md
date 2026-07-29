# Memory Hygiene

## Voice

Plain person voice — same standard as SKILL.md §Voice. Specific note for this file: hygiene operations are operational, not ceremonial. Resist words like "ritual" or "comprehensive pass" — say what the operation does in plain terms.

---

Memory hygiene is the single mechanism that keeps the memory architecture healthy over time: archive, retire, cold-store, graduate observations into units, reconcile contradictions, regenerate indexes, monitor file caps, and self-evaluate retrieval quality.

It replaces the dream cycle. Every dream-cycle phase folded into one of the operations below.

Read this before any cleanup pass, and any time you notice the memory architecture drifting (stale units in retrieval, contradictions surfacing, indexes out of sync).

---

## The three verbs

These are the operational primitives. Each has a trigger, an action, and a retrieval impact.

### Archive — move out of default retrieval, keep retrievable on demand

**When to archive.** Priority score below threshold AND last-referenced age past threshold for the unit's source-type. Concretely, when `R · S < 0.05` and the unit hasn't been cited or read in 90 days, it's a candidate. (Decay rate at τ=60 means R·S < 0.05 at roughly 180 days plus weight 1.0, 90 days plus weight 0.5, 60 days plus weight 0.3.)

**Action.** Move the unit file from `<project>/_memories/<prefix>-<slug>.md` to `<project>/_memories/archive/<prefix>-<slug>.md`. Frontmatter adds `archived: true` and `archived_at: <ISO timestamp>`. The original prefix stays — the flat layout holds for archive too.

**Retrieval impact.** Archived units are not in the default candidate set. Tier 1 grep and Tier 2 graph walks skip the archive directory. Explicit queries like "historical context on X" or "show me archived units" still reach them.

**Never autonomous on user-authored units.** This is the integrity-uncertainty case named in SKILL.md §"Act first, confirm when integrity is uncertain." Archive of a user-authored unit would overwrite their authorship, which triggers Mode B (propose, wait for explicit yes). Surface the candidate list at `/process-memory` and let the user choose `y` (archive all), `N` (none), or `per-unit`. Even if priority math says low-value, the user may have intent the math can't see.

### Retire — declare no longer current truth; keep the trace

**When to retire.** Explicit retirement event: a successor unit is committed with a `supersedes` edge pointing here, OR the user removes a fact from PROJECT.md that this unit captured (anti-resurrection rule fires).

**Action.** Unit stays in original location. Frontmatter `status: active` → `status: retired`, `retired_at: <ISO timestamp>`, optional `retired_reason: <one-line>`. Body preserved for forensic value.

**Retrieval impact.** Retired units don't appear in default retrieval. They're reachable by chasing a `supersedes` edge from the canonical successor, or by explicit "what was the predecessor of X" queries.

**Anti-resurrection rule.** When a retired claim shows up again in a later render, you don't un-retire it on your own. Either the user un-retires it (Mode C explicit), or a successor unit captures the new framing without resurrecting the retired one.

### Cold-store — fully out-of-band; only deep historical queries reach

**When to cold-store.** Archived AND retired AND last-referenced > 365 days, OR explicit user request ("cold-store this").

**Action.** Move to `<project>/_memories/cold-storage/<YYYY>/<MM>/<prefix>-<slug>.md`. Date-organized sub-dirs (cold-store is potentially high-volume over time — same exception rationale as observations).

**Retrieval impact.** Not in any default. Explicit "search cold storage" or direct grep into the cold-store path only. You can walk it on user request.

---

## Scope — what hygiene covers

Hygiene is the canonical mechanism for all of these. If you find yourself building separate protocol pieces for any of them, fold back into hygiene:

- Archive / retire / cold-store with priority-aware triggers.
- Graduation (observations → units → canonical flag).
- Memory contradiction detection and reconciliation (was dream-cycle Phase 3a).
- Wikilink promotion — durable `[[unit-id]]` body links become typed `cites` edges (see §"Wikilink promotion").
- Index regeneration — `_memories/INDEX-decisions.md`, `_memories/INDEX-risks.md`, others (was dream-cycle Phase 3d).
- File-cap monitoring and proactive compaction when synthesis files grow over the Read tool cap (replaces the equivalent machinery from v1).
- Auto-memory ↔ unit-store reconciliation.
- Session-log cleanup (was dream-cycle Phase 3e).
- Continuous self-evaluation: storage and retrieval quality monitoring with structural adjustment.

---

## When the mechanism fires

| Trigger | What runs |
|---|---|
| `/process-memory` (user-invoked) | The comprehensive hygiene pass — back-fill of auto-closed sessions, archive/retire/cold-store, graduation, index regeneration, file-cap reconciliation, validity stamps, turn classification. The primary scheduled hygiene event. See `skills/process-memory/SKILL.md`. |
| Startup backstop | Unconditional decoration + index refresh every returning-workspace bootstrap (`protocols/startup.md §"Decoration + index refresh backstop"`) — keeps the store current even when no hygiene pass ran. |
| `/finalize` | No hygiene. The close captures material session outcomes and certifies the receipt; it deliberately runs none of this table. |
| On-demand user request | "Run hygiene now," "graduate this," "archive the old decisions about X." |
| Meaningful PROJECT.md change | User removes fact → retire-trigger fires for the affected units. |
| Edit-detection hash mismatch | Reconciliation pass runs as a follow-on after edit-detection captures the user's change. |

### Mid-session batching

Rapid edits in a single turn (a graduation followed by an index regen followed by a render) shouldn't trigger a separate hygiene pass each. Batch instead — and judge the batching by agent turns, which you can observe, not by wall-clock seconds, which you can't reliably measure between turns. The rule:

- **Same-turn coalescing.** Multiple triggers within a single agent turn batch into one hygiene call at turn's end. If the user edits PROJECT.md and you then write two new units in the same turn, all three events fire one combined hygiene pass after your last write.
- **Don't re-run within a turn for non-structural triggers.** If you already ran a hygiene pass this turn, don't re-fire it for a cosmetic or repeat trigger — let the next structural trigger (graduation candidate, contradiction, retire-on-removal) carry it, or the next `/process-memory`.
- **Stay quiet during a burst.** When you're in a long run of rapid edits, defer the pass until the edits settle rather than firing on each one.

Narrate when you batch: *"Several hygiene triggers this turn — coalescing into one pass once the edits settle."*

### Render-collision handling

When the agent is mid-render on a PROJECT.md section and hygiene fires on a unit that flows into that same section, the render wins until it commits. The collision rule:

- **Render in flight + hygiene trigger on same section → defer hygiene** until the render commits (frontmatter `updated:` lands, unit reaches consistent state).
- **Render in flight + hygiene trigger on unrelated section → proceed in parallel.** No conflict; they operate on different unit subsets.
- **User edits PROJECT.md while agent is rendering it → render aborts.** The user's edit becomes ground truth; the agent reads the user's version, propagates edits back to source units, and only then resumes the render against the updated source.

Render-vs-hygiene collision on the same section is the seam where this matters; the failure-modes table below carries the resolution as a row.

---

## Audit trail

Every hygiene operation gets logged twice:

- Human-readable narrative in `<project>/autonomous-run-log.md`: `[2026-05-17 14:32] HYGIENE archive — dc-XX-<slug>: priority 0.04, last_accessed 90d, source weight 0.5 — moved to _memories/archive/`
- Machine-readable record in `<project>/_sessions/<date>/hygiene-log.jsonl`: `{"ts": "...", "verb": "archive", "unit_id": "dc-XX-<slug>", "reason": "priority_below_threshold", "trigger": "process-memory", ...}`

The dual log is intentional. The run log is what the user reads during the session; the JSONL is what subsequent hygiene passes consult to detect patterns (over-archive, under-graduate, etc.).

---

## Mechanical maintenance — the cadence ledger

The *mechanical* half of upkeep — index regeneration (decisions, risks, summary), ghost-duplicate cleanup, PROJECT.md cap check — is consolidated in `scripts/maintenance-run.mjs` and separated from the *judgment* half (graduation, retire calls) that stays in `/process-memory`. `/process-memory` and the startup backstop both invoke it:

```bash
node "${CORE_ROOT}/skills/core/scripts/maintenance-run.mjs" <project>
```

It is **signature-gated** (regenerates only when the unit set changed since last run — cheap on an unchanged store), **narrated** (returns a one-line summary of what ran; never silent — honors visible-continuous-curation), and **ledger-recorded** in `<project>/_memories/_maintenance-state.json` (per-op `run_count` + `last_run` — the cadence data the autonomous-maintenance gate observes). Surface its narration line in the run. `--dry-run` reports without writing.

### Autonomous maintenance — gated, not built

Maintenance is ledger-first on purpose: it runs **at invocation** (`/process-memory`, the startup backstop, on-demand), not on a per-turn hook. Running any maintenance op unattended/autonomously is gated behind four preconditions, none yet built:

1. a **deterministic "clear-cut" gate** (like the six-factor promotion cost gate) — no agent-adjudicated "clear-cut";
2. a **kill switch** (env var / workspace flag);
3. a **per-change audit log** (what changed, not just that an op ran);
4. **cadence evidence** from the ledger showing the op has enough work to justify unattended runs.

Autonomous graduation, autonomous edge-writing, and autonomous PROJECT.md §State/§Moves re-render all live behind these. Until they exist, maintenance never silently mutates the store between turns.

---

## Reversal — every operation is reversible

- **Archive → active**: move file from `_memories/archive/<prefix>-<slug>.md` back to `_memories/<prefix>-<slug>.md`. Remove `archived:` and `archived_at:` from frontmatter.
- **Retire → active**: flip frontmatter `status: retired` back to `status: active`. Remove `retired_at:` and `retired_reason:`.
- **Cold-store → active**: move file from `_memories/cold-storage/<YYYY>/<MM>/` back to `_memories/`.

Reversal is autonomous (Mode A) when it's a self-correction (you just archived something and you realize it shouldn't have been). It's confirm-first (Mode B) when the user-initiated reversal is ambiguous (which unit, which version, etc.).

---

## Failure modes

| Mode | What goes wrong | Mitigation |
|---|---|---|
| Over-aggressive archive | High-value units get archived because their priority score under-counts something | Pin frontmatter (`pinned: floor` / `true` / `always`); priority-floor for pinned units; user-gated archive surface at `/process-memory` |
| Resurrection of retired content | A retired unit's claim shows up again because similar conversation generates a similar observation | Anti-resurrection rule — retired units check source-of-truth match before any re-promotion; successor units carry the new framing without re-promoting the old |
| Cold-store losing edges | An edge pointing at a cold-stored unit dangles | Cold-store keeps edges intact in the moved file; retrieval treats the cold-target as a placeholder so the link doesn't 404 |
| Mid-session conflict with user edit | You're about to render a section the user just edited | Edit-detection surfaces the change; render pauses on the conflicted section; reconcile before re-rendering |
| Render-vs-hygiene collision (same section) | Hygiene fires on a unit flowing into a section the agent is mid-rendering | Defer hygiene until the render commits; see "Render-collision handling" above |
| Trigger storm | Three+ hygiene triggers within a single agent turn during rapid edits | Burst suppression — batch into one pass at turn's end; if the burst spans turns, defer until a turn completes with no new trigger (per §"Mid-session batching": judge by turns, never wall-clock) |
| Index drift | `INDEX-decisions.md` shows units that don't exist (or misses units that do) | Index regeneration runs at every `/process-memory` pass and the startup backstop; on detected drift, regenerate immediately |
| Observation backlog | Observations pile up ungraduated; graduation candidates get lost in volume | Continuous self-evaluation surfaces "this observation keeps mattering" patterns; graduation passes at `/process-memory` walk recent observations explicitly |

---

## Graduation surfaces here

Graduation — observation becoming unit — is the highest-value reasoning move CORE makes. Triggers, the seven-step process, the anti-miss bias, and the hand-off to multi-agent on hard calls all live in `protocols/data-storage.md` §Graduation. Hygiene's role is to surface candidates: `/process-memory` walks recent observations and flags the ones that keep mattering, and on-demand passes do the same when the user asks.

---

## Wikilink promotion

Part of the reconciliation work at `/process-memory`. No script — this is an agent-performed pass:

1. Find candidates: `grep -rn '\[\[[a-z0-9-]\+\]\]' <project>/_memories --include='*.md'`, skipping `archive/` and `cold-storage/`.
2. Resolve each `[[id]]` to an existing unit file. An id that resolves to nothing gets flagged in the hygiene log (`verb: wikilink-unresolved`) — never auto-create a unit to satisfy a link.
3. Promote when the link is durable and citation-style — the sentence leans on the target as evidence, precedent, or source ("per [[dc-69-priority-function]]", "captured in [[obs-...]]"). A passing mention stays a wikilink; promotion is for links retrieval should be able to walk.
4. Promotion means adding `{type: cites, target: <id>}` to the citing unit's `edges:` frontmatter when not already present. `cites` is a lazy, one-directional edge — no inverse edge required (per `protocols/data-storage.md` §"The committed edge types").
5. Log each promotion in the hygiene JSONL (`verb: promote-wikilink`, with citing unit and target).

## On-demand project setup — governance-hierarchy capture

The new-workspace path (in `protocols/startup-conditional-loads.md`) asks about source-authority hierarchy at intake. Returning workspaces that predate this intake won't have the unit yet. When a returning project would benefit from one (multi-document governance, recurring authority contradictions surfaced by synthesis-pass behavior #5, user mentions "what does the spec say vs. what we agreed in chat"), capture it on demand:

- **Ask the user the same question the startup intake asks** — *"When this project's documents disagree, which one wins? PRD > HLSD > RTM > chat, or some other ordering, or single-source?"*
- **Single-source / trivially-ordered projects: skip.** No unit needed; the question doesn't bind anything.
- **Multi-document projects: write the decision unit.** Name `dc-NN-source-authority-hierarchy.md` (singular, per project), `type: decision`, `topics: [source-authority, governance]`, body holds the ordered list with one-line rationale per ranked source.
- **When governance changes:** supersede the existing unit with a new one carrying a `supersedes` edge to the prior. Synthesis-pass behavior #5 (spec §5) always reads the current authoritative version.

Triggering moments worth pulling this in:

- The user surfaces a contradiction across two sources and asks "which one's right?" — that's a synthesis-pass behavior #5 fire and the absence of a governance-hierarchy unit becomes visible.
- A new project artifact lands (PRD update, governance doc supersession) that changes the ordering.
- During `/process-memory` if observations citing different sources are accumulating without authority disambiguation.

This intake is distinct from the per-source authority capture (`source-of-authority-<source-name>.md` per registered external source). Both shapes can coexist; they answer different questions. The per-source units capture *what authority a single source claims*. The project-hierarchy unit captures *which source wins across the project's hierarchy of artifacts*.

---

## Continuous self-evaluation

Storage and retrieval aren't frozen — they evolve based on observed performance.

### Retrieval-quality surfacing — always at hygiene passes

At every `/process-memory` invocation, call:

```bash
[ -n "$CORE_ROOT" ] && node "${CORE_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs" <project>
```

Default window is the last 30 days. The analyzer returns tier distribution, top dip-back units (precision proxy), and top tier-escalation topics (recall proxy). The main agent narrates the top anomalies in plain language — not the raw report dump.

Example narration shape:
- "Last 30 days: 47 retrievals across 5 sessions. dc-12-routing-rewrite is dipping back 75% of the time when we hit it — the unit's body or its topic tags might not match what we keep needing it for. Worth a look."
- "Topic 'performance' escalates to Tier 3 every time we touch it — the lexical layer isn't finding what it should. Either there's no unit yet, or the unit exists with different tags."

These observations feed the structural adjustment options below — add an edge, restructure a unit, re-tune weights, evolve query shape. The point is closing the loop from retrieval behavior → logged → surfaced → tuned.

### What to watch

- **Under-recall** — you asked a query, the relevant unit didn't surface. Why? Wrong tier? Topics mis-tagged? Edge missing?
- **Over-recall** — Tier 1 returned 14 units when 3 was the right scope. Is the priority function under-weighting alignment? Is the query under-specified?
- **Stale-surfacing** — units that should have archived keep coming back. Anti-resurrection failure or priority function under-weighting recency?
- **Contradiction not flagged** — two units make incompatible claims, neither got `conflicts-with` edges. Reconciliation pass needs to run.
- **Drift in topic vocabulary** — same concept tagged inconsistently across units. Vocabulary needs reconciliation.

### Structural adjustment options (in order of cost)

1. **Add an edge** — a single missing `cites` or `references-topic` often fixes retrieval. Free.
2. **Restructure a unit** — split into two, merge two into one, change the prefix. Cheap, but breaks any existing cites — handle inverse-edge updates.
3. **Re-tune priority weights** — adjust `w_R`, `w_F`, `w_S`, or `w_A` in the plugin's `scripts/priority.mjs`. Weights live in the plugin by design so the tuning propagates to every project via the next plugin update — not per-project drift. Document the change in the plugin changelog entry that ships it.
4. **Evolve query shape** — change how you phrase retrieval prompts.
5. **Escalate infrastructure** — vector store, graph DB, or other. Earned only after repeated trip-wire firings, per the infrastructure-must-be-earned framework. Two consecutive Explore-miss cycles proposing the same gap = candidate for a new DC.

---

## Dream cycle absorption

Former dream cycle phases mapped to v2 hygiene:

| Former dream-cycle phase | Now lives in |
|---|---|
| Phase 3a: contradiction detection | Continuous self-evaluation — runs against `conflicts-with` edges + topic-vocabulary drift |
| Phase 3b: archive reconciliation | Archive / retire / cold-store verbs — verbs are the operational primitives |
| Phase 3c: volume audit | File-cap monitoring — synthesis files (PROJECT.md, IMPROVEMENT_LOG.md) checked against Read tool cap; over-threshold → compact |
| Phase 3d: edge integrity sweep | Index regeneration + edge-reconciliation pass — `INDEX-*.md` regenerates, broken edges flagged |
| Phase 3e: session-log auto-prune | Sessions cleanup — `<project>/_sessions/<date>/` directories older than 90 days, with no unit cite and no summary reference, get archived |
| Phase 4: pattern synthesis | Graduation reasoning — same operation, named for what it actually is |
| Phase 5: agent roster refresh | Lives in `protocols/self-evolution.md` (effectiveness-tracking-driven) |

There's no separate dream-cycle ritual, and no retrospective file — a per-pass retrospective had no reader. What a hygiene pass learns lands where it gets read: durable lessons graduate into units, and the pass's own narration tells the user what happened.

---

## DECISIONS.md graduation — the pattern

DECISIONS.md grew to ~99K characters / 40K tokens in v1, over the Read tool cap. The v2 fix:

1. Each decision in DECISIONS.md becomes a unit at `<project>/_memories/dc-<NN>-<slug>.md` with v2 unit shape (frontmatter + edges + reasoning body).
2. `_memories/INDEX-decisions.md` is auto-generated by `node "${CORE_ROOT}/skills/core/scripts/generate-decisions-index.mjs"` (`CORE_ROOT` as resolved at startup; ships with the plugin by design) — walks `_memories/dc-*.md`, parses frontmatter, sorts chronologically. Invoke from the project root or pass an explicit memories dir; the script overwrites `INDEX-decisions.md` in place.
3. DECISIONS.md is archived to `<project>/_memories/archive/DECISIONS-pre-graduation.md` (or wherever the cold-start migration plan placed v1 docs).
4. PROJECT.md's Decisions & Risks section renders from active-status decision units only.

The same pattern applies to any future Read-cap wound — large append-only synthesis files get unit-graduation rather than special-case compaction.

Full migration steps live in the cold-start-migration path in `protocols/startup.md`.

