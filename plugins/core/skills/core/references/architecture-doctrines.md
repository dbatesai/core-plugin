# Architecture Doctrines

A thin normative index of the load-bearing architectural rules CORE has converged on. Five doctrines, each with a named first consumer. Per DC-98 (doctrine-consumer coupling), **a doctrine without an active consumer is an observation, not a doctrine.** Graduation requires a named first consumer; release-review verifies the consumer still exists.

The doctrines live here, not in protocol prose, because they cut across protocols. When a protocol document needs to lean on a doctrine, it cites this file by anchor. Consumers cite the doctrine by name; readers come here for the rule.

## Doctrine 1 — Probe before propose

> When stakes warrant adversarial review, run an empirical probe before composing the analysis prompt.

**Why.** Multi-agent analysis is expensive AND systematically over-converges (84.5% sycophancy flip rate, 9-point homogeneity gap per the independent-analysis findings). When the agents anchor on a frame that empirical reality contradicts, the convergence is on the wrong answer. A cheap probe — five minutes of grep, a script invocation, reading a known file — keeps the frame grounded.

**How to apply.** Before spawning an adversarial swarm for architectural / classification / public-copy / graduation work, ask: *"What's the cheapest empirical check that would shift my frame if it returned a different answer than I expect?"* Run it. Compose the swarm prompt with the probe result in hand. The Anvil + Sextant + Pillar parallel-critique pattern that pressure-tested the metrics spec is the canonical instance (5 pre-flight probes ran empirically before the spec frame was finalized; one collapsed v1 scope from emit-everything to subscribe-and-augment).

**First consumer.** `protocols/analysis.md` (v2.8.0 will formalize the probe-before-propose step). The metrics spec session 47 work demonstrated the pattern; the protocol codifies it.

**When this graduates from observation to doctrine.** When `protocols/analysis.md` actively cites this rule. Until then, it lives here as a graduated observation with implementation pending.

## Doctrine 2 — Documentation as contract reference

> When schema fields cross consumer boundaries, the markdown reference IS the contract. Consumers cite the reference by anchor; producers stamp the reference version on every emitted row.

**Why.** Schemas that exist only inside code drift. Multiple consumers reading the same shape without a shared anchor diverge in interpretation. A markdown contract that names every field's semantics — and is checked into the repo alongside the code that emits and reads it — keeps everyone on the same page.

**How to apply.** When a producer script writes structured rows (capability rows, hygiene events, OTel spans), the schema lives in a sibling `*-schema.md` file. The producer stamps `schema_version` on every row. Consumers cite the schema by file path + anchor in their own source comments and refuse rows above their known-major version. When the schema changes major version, the consumer list at the bottom of the schema file says who needs coordinated update.

**First consumer.** `skills/core/scripts/capability/row-schema.md` (v2.6.0) — the capability row schema is the load-bearing instance of this doctrine. `resolve-plugin-root.mjs` and (future) `capability-probe.mjs` both reference it; both stamp `schema_version: '1.0.0'` on emitted rows.

**Secondary consumers (planned).** `skills/core/scripts/hygiene-event-schema.md` (v2.7.0+) will give the hygiene-log events the same treatment. The metrics-spec OTel span shape will graduate to a schema file when T3 augmentation lands.

## Doctrine 3 — Schema lives only as long as its consumer

> A schema with no named consumer is documentation, not a contract. When the last consumer is retired, the schema graduates to deprecated docs.

**Why.** Schemas that outlive their consumers accumulate as cognitive debt. New contributors read them and assume they're load-bearing; in reality the producers and readers have all moved on. The doctrine prevents that drift by tying schema existence to consumer existence.

**How to apply.** Every schema file maintains a "Known consumers" section listing the scripts / protocols / docs that read or write the schema. When a consumer is retired, remove its entry. When the list goes empty, the schema file moves to `references/archive/` with a date-stamped note explaining why and what replaced it. Release review (`/cut-release` skill, on PR open) verifies the consumer list is non-empty for every schema file in `skills/core/scripts/*/`.

**First consumer.** This doctrine document. Per the inversion: a doctrine without an active consumer is an observation, not a doctrine. The first consumer of *this very doctrine* is the maintenance discipline applied to `capability/row-schema.md` — when that schema's consumer list goes empty, the schema gets archived.

**When this graduates fully.** When `/cut-release` actively enforces the consumer-list check. v2.6.0-α captures the doctrine; v2.6.x adds the enforcement.

## Doctrine 4 — Fail-open observation, fail-closed mutation

> Observation paths report degraded state and proceed. Mutation paths refuse the action and surface the block reason.

**Why.** Startup, readiness reporting, and routine state-checks shouldn't crash a session because some non-critical signal is missing — the user needs to see what's running, even partially. But destructive actions (writing to canonical project memory, pushing events to a cross-machine collab, modifying the plugin install) must NOT proceed under uncertain identity, because the cost of a wrong write is much higher than the cost of asking the user to confirm.

**How to apply.** Code that observes (read capability state, render readiness, surface hygiene metrics) sets a graceful fallback when probes return DEGRADED / NOT-YET / UNKNOWN — narrate the limitation, don't refuse to start. Code that mutates (collab event-write, PROJECT.md autonomous render, plugin-cache install) reads `mutation_permitted` from the relevant capability row and aborts with `mutation_block_reason` when false. The two paths use the same capability primitive but read different fields.

**First consumer.** `capability-probe.mjs --startup` (v2.6.0, fail-open) vs `capability-probe.mjs --pre-action collab-files-mutating` (v2.6.0, fail-closed). Same script, different invocation modes; the modes embody the doctrine.

**Codified in.** DC-97 (fail-open startup, fail-closed mutation). This doctrine is the cross-protocol form of DC-97 — DC-97 names the rule; this file names the consumers.

## Doctrine 5 — Doctrine-consumer coupling

> A doctrine without an active consumer is an observation, not a doctrine. Graduation requires a named first consumer; release-review verifies the consumer still exists.

**Why.** Architectural prose accumulates faster than implementations. A repo of "principles we'd like to follow" without ties to actual mechanisms becomes aspirational documentation — reads well, governs nothing. The doctrine prevents that: a rule lives in this file only when it has a load-bearing consumer in the running code. Until then it's an observation in `_memories/`.

**How to apply.** When a candidate doctrine emerges (a generalizable rule cutting across protocols), capture it first as an observation. Promote to this file ONLY when a concrete implementation cites it. Removal: when the last consumer is retired, the doctrine moves to `_memories/archive/` with the supersession context.

**First consumer.** This document itself. The graduation criteria above are the doctrine; the maintenance of this file is the consumer. When the doctrines listed here lose their first-consumers (named below each entry), the entries get demoted to observation status rather than removed silently.

**Codified in.** DC-98 (schema-and-doctrine-consumer coupling — the same rule covers both, as it does at the top of this file). The metaphor: schemas have schema_version + Known Consumers list; doctrines have First Consumer + secondary-consumer roster.

---

## Adjacency: where doctrines stop and protocols start

Doctrines are cross-cutting rules — they apply across protocols and scripts. Protocols are step-by-step instructions for specific operations (startup, finalize, process-memory). When a protocol cites a doctrine, the citation is by name (e.g. *"per Doctrine 4 — fail-open observation, fail-closed mutation"*) and the protocol's specific steps are the *application* of the doctrine, not the doctrine itself.

The flow:

1. Operational pattern emerges → observation captures it in `_memories/`.
2. Pattern is cited by multiple downstream protocols/scripts → graduates to doctrine here.
3. New protocols inherit the doctrine; new scripts implement it; old code gets audited against it during /cut-release.
4. Doctrine's last consumer retires → doctrine moves back to observation in `_memories/archive/`.

The lifecycle is symmetric. Doctrines don't accumulate one-way.

## Process for adding a doctrine

1. Confirm the rule has at least one concrete consumer (script or protocol) that will actively cite it.
2. Write a new doctrine entry below the existing five, following the same structure: rule statement (>quote block), Why, How to apply, First consumer, Codified in.
3. Update the consumer's source comments to cite the new doctrine by anchor.
4. Add a one-line entry in the relevant decision unit's `cites:` edge list pointing to this file's anchor.

Doctrines aren't created in this file from analytical insight alone. They're created when the implementation forces the rule.
