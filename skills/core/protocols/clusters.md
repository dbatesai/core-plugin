# Clusters

## Voice

Plain person voice — same standard as SKILL.md §Voice. Clusters are a retrieval-shape concern, not a ceremony. Talk about them the way you'd talk about a folder in a filesystem: it exists, it has a rule for what's in it, it shows you something when you ask.

---

Read this before naming a cluster, before proposing one to the user for ratification, or before deciding whether something the user asked about is cluster-shaped or just a one-off query.

This doc is the **discipline** layer. The **mechanism** layer (how clusters render, the schema of the cluster unit, the composition pass) lives in spec §7.1 and ships in DC-85 Phase 2.

---

## What a cluster is

A cluster is a named topic with a defined unit-membership rule. It exists in the unit store as a small unit holding three things: the cluster name, the membership rule, and a render template. When something asks for the cluster's summary — a grep, a Tier 2 graph walk, an explicit consultation — the synthesis pass composes the summary from current member units in that moment. The composed text never persists beyond a session-scoped cache, and the cache invalidates on any member unit's `updated:` field changing.

The clean property that follows: cluster summaries cannot drift from their members because they're not stored. There's no "we wrote this three weeks ago, the members have moved on" failure mode.

## When to name a cluster — three valid triggers

All three are first-class. None is preferred over the others.

**1. Project-shape at intake.** When a project's organizing topics are visible at intake, name them as clusters then. AI Gateway Placement: execution-state, email-approval, people-coverage, data-pipeline. Mesh Redemption: delivery-timeline, scope-decisions, tracker-hygiene, returns-architecture, stakeholder-map. These come out of the intake interview directly — the user describes the project, the organizing topics fall out, you name them as clusters. Captured during /orient new-workspace flow or /register-sources companion setup.

**2. Traversal-pattern emergence.** When you notice you keep walking the same edges to answer a recurring class of question — `Tier 2 walk from observation-N → person-M → decision-K → risk-J` for three different sessions in a row, all answering "where does the email-approval state actually sit?" — that's a cluster waiting to be named. Propose it during /process-memory or /finalize. The Mesh `tracker-hygiene` cluster came from this kind of recognition, not from intake.

**3. Deliberate investigation.** A deep-sweep around a topic produces a coherent set of facts sharing a property — same stakeholder, same project phase, same source-document family. When the sweep settles, name the result as a cluster so the next consultation doesn't have to re-walk the graph. This is the highest-cost trigger; reserve for genuinely worth-curating sets.

## Naming requires ratification

No auto-created clusters. Naming requires either:

- **Human action.** The user names a cluster directly. No further ratification needed; the cluster exists once they say it does.
- **Agent proposal + ratification.** The agent proposes a name (during /process-memory, /finalize, or in-flow when a traversal pattern surfaces). The proposal lands as `proposed-cluster` shape — same surface as `proposed-stability-class` from spec §2. Ratification happens at /process-memory or /finalize before the cluster becomes authoritative.

The ratification gate is load-bearing. Auto-creation invites cluster sprawl: every Tier 2 walk becomes a candidate, the unit store fills with thin clusters that fragment retrieval rather than focus it. Forcing a ratification step keeps the cluster count small enough to matter.

## Render vs. load — two separate questions

**Render: does this cluster appear in PROJECT.md?** No, by default. A cluster surfaces in PROJECT.md only if something from it is hot enough to clear the hot-tier ranking threshold (spec §1.1). Clusters are not a new PROJECT.md section.

**Load: does cluster membership get walked at /orient?** No, by default. Clusters load on demand when a Tier 2 graph walk traverses cluster-membership edges, or when a query explicitly names the cluster. Walking every cluster at /orient would defeat the lazy-retrieval principle the architecture rests on — Tier 0–1 retrieval should answer most questions without ever touching the cluster layer.

These two defaults preserve the cost shape: clusters add retrieval power without raising the floor of every session.

## When NOT to create a cluster

Three patterns where the cluster shape is wrong:

**Time-series / cadence-aggregation surfaces.** Per-refresh metadata, source-pull log records, retrieval log entries — append-heavy time-series that cluster summaries don't fit. The cluster mechanism renders a cross-section of current state; per-event log data has a different cadence and a different consumer (the monitoring loop in spec §9, not retrieval). Effectiveness measurement artifacts and refresh-cadence aggregates stay on their existing artifact-surface designs rather than becoming clusters.

**Ad-hoc one-off groupings.** A query that returns three units once and never again doesn't justify a cluster. The Tier 2 walk that produced those three units is the retrieval mechanism; making it a cluster adds curation cost without retrieval payoff.

**Things that already have a unit type.** Decision sequences, risk relationships, people-roster — these have edge types (`supersedes`, `references-person`) and rendering mechanisms (`INDEX-decisions.md`, `INDEX-risks.md`, PROJECT.md §People). Don't recreate them as clusters.

## Cluster lifecycle and hygiene

Clusters participate in hygiene like other units:

- **Active.** Default. Member units render on consultation.
- **Retired.** Cluster name superseded by a different cluster or by direct unit retrieval. Cluster file stays for forensic value (frontmatter `status: retired`); rendering stops. Successor cluster may carry a `supersedes` edge.
- **Archived.** Long-inactive cluster with no recent member updates. Same archive rules as other units per `protocols/hygiene.md`.

Membership rule changes (a stakeholder added to the cluster, a topic redefined) require user ratification — the membership rule is the load-bearing structural piece, not just metadata.

## Cross-references

- **Spec §7.1** — composition-only summary mechanism, render template format, session-scoped cache discipline.
- **Spec §1.1** — hot-tier promotion threshold (when a cluster's content surfaces in PROJECT.md).
- **protocols/hygiene.md** — archive/retire/cold-store rules apply to cluster units the same way they apply to belief units.
- **DC-85 Phase 2** — the implementation work that lands the cluster unit type, composition pass, and retrieval integration.
