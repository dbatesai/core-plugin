# Confidence-Assignment Guide

Pattern catalog for assigning `confidence-level` to observations during extraction. Source-category-agnostic — the patterns describe structural signals any source might exhibit, not categories of sources (no "for task-trackers, X" or "for chat, Y" framing here).

Used by extractors (per `source-registration-framework.md`) when writing observations. The extractor maps the source datum onto one or more patterns; the patterns prescribe the confidence-level.

---

## The framework

Per `protocols/data-storage.md` and DC-85, every observation carries one of three confidence values:

- **sourced** — fact captured directly from a primary source. The source itself is the evidence.
- **inferred** — fact derived from secondary evidence within a tight reasoning window. Short reasoning chain, structurally supported.
- **reconstructed** — fact reconstructed from indirect signals through a longer reasoning chain. The chain is named when the fact surfaces in synthesis.

Synthesis treats each level differently: `sourced` facts state the conclusion directly; `inferred` facts state the conclusion with the source chain; `reconstructed` facts state the conclusion with the reconstruction explicitly named inline.

The values are about **epistemic strength**, not about whether the fact is "true." A `reconstructed` fact can be entirely correct; the label says the chain of reasoning from source to claim is long enough to warrant naming explicitly.

---

## The patterns

### Pattern 1 — State change with authoritative actor and timestamp

**When:** the source records a state transition (field updated, status changed, completion marked, assignment changed) and the record includes who/what made the change and when.

**Confidence:** `sourced` for the fact of the state change. The change happened; the source-of-record is the evidence.

**Example body framing:** *"X transitioned from Y to Z on date D, attributed to actor A."*

**Inference layer:** if the observation also asserts what the state change *means* (a status flip implies completion of work; a reassignment implies a workload shift), the meaning-assertion is a separate `inferred` claim — write it as its own observation if it carries weight.

---

### Pattern 2 — Verbatim quote with attribution

**When:** the source carries a verbatim capture (transcript line, direct quote, message text) attributed to a specific speaker.

**Confidence:** `sourced` for the captured words. The words were said; the capture is the evidence.

**Example body framing:** *"X said 'verbatim quote' on date D."*

**Inference layer:** if the observation asserts what the speaker meant beyond the words themselves (a casual "I'll handle that" interpreted as a binding commitment), the interpretation is `inferred`. Be explicit about which is which — captured words are `sourced`; interpreted intent is `inferred`.

---

### Pattern 3 — Structured field value as record

**When:** the source's data model has a typed field, and the observation captures the field's current value.

**Confidence:** `sourced` for the field value. The field has the value the source says it has.

**Example body framing:** *"X's field F has value V as of date D."*

**Edge case — automation-set fields:** if the field is set by an automation actor with no subsequent human edit, this may warrant `proposed-stability-class: durably-suspect` (see stability-class criteria) in addition to `confidence-level: sourced`. The field is sourced (it exists); whether its value is meaningful is another question handled by stability-class.

---

### Pattern 4 — Free-text commitment extraction

**When:** the observation derives a commitment, intent, or agreement from free-text content (chat message, email body, document prose).

**Confidence:** `inferred`. The text is the source; the commitment is an inference from the text.

**Example body framing:** *"In free-text source X, Y indicated intent to do Z by date D. Inferred from: \"<short quote>\"."*

**When this becomes `sourced`:** if the same source contains both the proposed commitment and explicit confirmation (the recipient acknowledges; both parties confirm), the confirmed agreement is `sourced`. The unconfirmed proposal stays `inferred`.

**When this becomes `reconstructed`:** if the commitment is inferred across multiple sources (mentioned in chat, alluded to in a follow-up email, confirmed indirectly in a third place), the multi-source reconstruction is `reconstructed`. Name the chain.

---

### Pattern 5 — Absence-detection

**When:** the observation derives meaning from something that *didn't* happen — a deadline passed without acknowledgment, a channel went quiet during a critical phase, an expected response never arrived, a planned meeting didn't occur.

**Confidence:** `inferred`. The absence is structurally significant; the meaning of the absence is an inference.

**Example body framing:** *"X was expected by date D but did not occur. Inferred meaning: <interpretation>."*

**Why not `sourced`:** the source records what *did* happen, not what didn't. The agent's expectation (X should have happened) plus the source's silence (it didn't) is the chain. The chain is short — `inferred`, not `reconstructed` — but the inference is the load-bearing part of the observation, not the source data.

**Field-level absence:** a structured field with fewer or different values than the project context implies it should have (a meeting attendee list missing an expected stakeholder; a status that's never moved off "New" after weeks) is also `inferred`. The field value itself is `sourced` (the source says what it says); the expectation that the field should have different values is the agent's inference from project context. Write as `inferred` and name the expectation in the body.

---

### Pattern 6 — Cross-source pattern reconstruction

**When:** the observation reconstructs an event, decision, or position from signals scattered across multiple sources, none of which carries the claim alone.

**Confidence:** `reconstructed`. The reasoning chain is long, the claim is synthesized from indirect signals, and the synthesis is the agent's work.

**Example body framing:** *"Reconstruction: X happened/was decided/is true. Evidence chain: source A shows [signal]; source B shows [signal]; source C shows [signal]. Combined: [reconstruction]."*

**Discipline:** the reconstruction chain is named explicitly in the body. A `reconstructed` observation without a chain is malformed. Synthesis passes reading the observation must be able to see the chain to evaluate the claim.

---

### Pattern 7 — Decoding from related signals

**When:** the observation infers what happened in one context from signals in an adjacent context (decoding a meeting's content from the chat thread that followed it; inferring an executive's position from the questions they asked; decoding a stakeholder's concern from what they didn't push back on).

**Confidence:** `reconstructed`. The signal-to-claim chain crosses a meaningful boundary (one context to another) and requires interpretive reasoning.

**Example body framing:** *"Reconstruction: in [context X], [event/decision/position]. Inferred from signals in [adjacent context Y]: [signal chain]."*

**Distinction from Pattern 6:** Pattern 6 is multi-source synthesis (each source contributes one signal). Pattern 7 is single-source-as-proxy (one adjacent source carries signals about what happened elsewhere). Both are `reconstructed`; both need the chain named.

---

### Pattern 8 — Verbal relay

**When:** the observation carries a third-party report (X said Y said Z; Neetha mentioned that Phil's position is W).

**Confidence:** `reconstructed`. The chain has at least two hops: the original speaker (Z), the relayer (Y), the recorder (the source). The agent has only the relayer's account.

**Example body framing:** *"Reconstruction: Z (per Y's relay in source S). Original speaker not directly confirmed."*

**When this can become `inferred`:** if the original speaker independently confirms the position in another source, the cross-check moves it to `inferred` (still not `sourced` because the original capture wasn't direct). If the original speaker directly states it in any source, that capture becomes the `sourced` observation; the relay becomes a related observation.

---

### Pattern 9 — Document-section assertion

**When:** the observation derives a claim from a structured section of a document (a section header + content; a numbered decision in a decisions log; a row in a table).

**Confidence:** `sourced` for the assertion as it appears in the document. The document says X; the observation captures X.

**Example body framing:** *"Document D, section S, asserts: X."*

**Inference layer:** what the assertion *implies* for the project is `inferred` — same pattern as Pattern 1's inference layer. If a PRD section says "the system will support 10K users," that's `sourced` for what the PRD says. Whether the system actually will support 10K users (or whether the PRD is current) is a separate question.

---

### Pattern 10 — Reading history as record

**When:** the observation derives a claim from the edit history of a source (this field has been edited N times in M days; this section was rewritten by actor A on date D; this status was last touched 90 days ago).

**Confidence:** `sourced` for the historical fact (the edits happened; the history records them). Often pairs with `proposed-stability-class: durably-suspect` when the history shows abandonment (90 days since touch; automation-only edits).

**Example body framing:** *"Source S's history shows [historical pattern]. Last meaningful change: [event] on date D."*

**Inference layer:** what the history *means* (abandonment; active work; contested ownership) is `inferred`. Write the inference as a paired observation if it carries weight; keep the historical fact as the sourced anchor.

---

### Pattern 11 — Derived metric from sourced fields

**When:** the observation derives a metric (spread, count, duration, inconsistency) by comparing sourced field values across one or more sources. The underlying fields are sourced; the derived metric is the load-bearing claim.

**Confidence:** `inferred`. The fields are sourced, but the metric is an inference about what the comparison means for the project.

**Example body framing:** *"Comparison: across [fields/sources], values are [X, Y, Z]. Derived metric: [spread/inconsistency/duration]. Inferred meaning: [what the metric implies for the project]."*

**Discipline:** name the comparison explicitly in the body. A derived-metric observation without the comparison chain is malformed — synthesis can't evaluate whether the metric is load-bearing without seeing what was compared.

---

### Pattern 12 — Degraded source fidelity

**When:** the source is structurally a verbatim/sourced source (transcript, document) but has materially degraded fidelity — marked inaudible sections in a transcript, OCR errors in a scanned document, partial capture, transcription errors above noise threshold.

**Confidence:** **downgrade one level** from what the pattern would otherwise assign. Sourced becomes `inferred`; `inferred` becomes `reconstructed`.

**Example body framing:** *"From [source] (degradation note: [what's degraded]): [claim]. Confidence downgraded from [original] to [downgraded] due to [degradation pattern]."*

**Threshold guidance:** "material degradation" means the degradation touches the section the claim is extracted from, not just the source overall. A transcript with `[inaudible]` markers throughout but a clean section containing the claim → no downgrade. A transcript where the claim's section has fragmented sentences → downgrade.

---

## Edge cases and tiebreakers

**Ambiguous between `sourced` and `inferred`:** when the captured datum is partly direct and partly interpretive (a structured field whose value is "Yes" but only the agent's reading of context tells you what "Yes" applies to), default to `inferred` and name the interpretive piece in the body. `sourced` is the higher-trust label; conservatism toward `inferred` is the right bias.

**Ambiguous between `inferred` and `reconstructed`:** the discriminator is chain length and chain naming. If the chain is one or two structurally supported steps and doesn't need explicit naming for the reader to evaluate, it's `inferred`. If the chain is three or more steps, crosses contexts, or requires the chain to be named for the reader to evaluate the claim, it's `reconstructed`.

**Same observation could fit multiple patterns:** use the highest-confidence pattern that genuinely applies, but be honest. If the observation's load-bearing claim is a reconstruction, don't dress it up as `sourced` because one of its inputs was direct.

**One datum, two patterns at different facets → split into two observations.** When a single source datum produces findings under different patterns (e.g., a verbatim quote that's both Pattern 2 sourced for the words AND Pattern 4 inferred for the binding commitment in those words), write separate observations rather than one observation with blended confidence. Each observation carries the confidence appropriate to its own claim. They can reference each other via `cites` edges. This applies generally — the same source datum often yields a "what was said/recorded" sourced finding plus an "what it means for the project" inferred finding, and conflating them loses signal.

**Sourced anchor with inference caveat — single observation, sourced.** Distinct from the split-into-two case: when an observation has a single load-bearing claim that's sourced but warrants a brief inference caveat (a task is marked Complete, but the deliverable's actual delivery is unclear; a field shows a value, but the value's currency is suspect), keep it as one `sourced` observation. Write the sourced anchor first, then a labeled caveat — e.g., *"Task X marked Complete on date D. **Caveat (inferred):** the deliverable's actual shipment is not confirmed; completion may be administrative."* The caveat doesn't change the observation's confidence label; it preserves the sourced fact while making the inference visible for synthesis. If the caveat is the load-bearing claim, write a separate inferred observation instead.

**Social signals do not upgrade confidence.** Reactions (👍, ❤️), read receipts, thread presence, view counts, and similar weak-confirmation signals do not upgrade a Pattern 4 `inferred` finding to `sourced`. They're too ambiguous — a reaction may mean "I agree," "I saw this," "this is funny," or be reflexive. Explicit verbal confirmation in the same source (someone says "yes" or "confirmed" or explicitly acknowledges the proposed agreement) is the minimum bar for upgrading `inferred` to `sourced`.

**Context (formality, channel type) does not modulate confidence.** A commitment extracted from free-text content is `inferred` regardless of whether it was said in a formal meeting or a casual DM. The pattern governs, not the channel's perceived seriousness. The reasoning chain from text to commitment is the same chain in either setting; the formality of the venue doesn't shorten the chain.

**The source's `confidence-default` and the pattern conflict:** the pattern wins. The default is a starting point; the pattern is the structurally-grounded judgment. The override mechanism (`confidence-overrides` in the source registration) is for when a source has structural signals the pattern catalog doesn't yet cover — capture as an override, surface for catalog expansion.

---

## The "name the inference" discipline

For `reconstructed` observations (and `inferred` observations where the inference is the load-bearing claim), the body must name the reasoning chain. Not as a footnote — as part of the observation's substance.

What this looks like in practice:

**Bad:** *"The team is concerned about timeline."* (no source, no chain)

**Okay:** *"The team is concerned about timeline (reconstructed from Slack discussion 2026-05-20)."* (chain named but not specific)

**Good:** *"Reconstruction: the team's concern about timeline. Evidence: PM raised the question in [source A]; tech lead's response was non-committal in [source B]; subsequent task estimates in [source C] doubled. Pattern indicates concern, not certainty about cause."*

The good version lets a future reader (or synthesis pass) evaluate the chain. The bad version is a claim without scaffolding.

---

## What this guide is not

- **Not exhaustive.** Ten patterns cover most cases. Sources will produce findings that fit no pattern cleanly. Extractor judgment fills the gap; the pattern-fits-gap is the signal to expand the catalog in a future revision.

- **Not source-specific.** The patterns describe structural signals any source might exhibit. An installation reading this should be able to map any of its sources' typical findings onto patterns without the guide naming the source's specific tool.

- **Not a hard rule.** Confidence is a judgment about epistemic strength. The patterns are heuristics that produce defensible defaults. Extractor override is acceptable when content signals clearly warrant it; the override should be visible in the observation body so synthesis can evaluate the override's basis.

---

## Maintenance

Patterns get added when extractors repeatedly hit findings that don't fit any pattern. The gap is the signal.

The proposal flow:

1. When an extractor encounters a finding it can't map cleanly to any pattern, it writes the observation with confidence-level set to its best judgment plus a `pattern-gap:` annotation in the body naming the gap.
2. `/process-memory` collects pattern-gap annotations during its observation-graduation pass and surfaces them as a structured list in the synthesis output.
3. When pattern gaps accumulate (same gap recurring; multiple distinct gaps in one window), the user runs a deliberate revision pass on this guide. Proposals are evaluated together; the guide grows in tracked revisions rather than per-incident.

Free-form pattern accumulation in scratch directories isn't structured enough to be reliable. The `pattern-gap:` annotation is the structured signal that catches gaps where the work is happening.

The guide is part of the framework spec at `source-registration-framework.md` §5. Changes here may require corresponding changes there.

---

Companion: `source-registration-framework.md`.
