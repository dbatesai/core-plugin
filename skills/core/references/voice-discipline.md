# Voice Discipline — Reference for CORE Skill Documentation

**Status:** Reference. Loaded when an agent or DM is doing voice review on `README.md`, `ARCHITECTURE.md`, `SKILL.md`, or other public-facing CORE documentation.
**Origin:** Distilled from the 2026-04-26 overnight voice loop and prior April-26 voice-consistency review.

---

## Purpose

Voice review is the periodic discipline of removing pitch voice, definitional copulas, and capability claims without residual from CORE's user-facing documentation. This reference is the vocabulary and the catalog. The `_outputs/2026-04-26/voice-loop-retrospective.md` documents one execution and what to improve about the loop shape itself.

This is reference material, not a protocol. Voice review happens every 3–6 months when documentation drifts. The loop template at the end of this doc is one data point — adapt, don't recite.

---

## Voice Target Standard

The calibration line is `ARCHITECTURE.md` §11.1 *Inference-quality ceiling*:

> *"CORE is as good as the model it runs on. A less capable model produces worse output with no automatic detection; the framework does not degrade gracefully in that direction."*

Two sentences. Concrete declarative. Honest residual ("does not degrade gracefully in that direction"). No metaphor, no pitch, no V-class violations.

The README-register runner-up is the *Learn From the Past* paragraph:

> *"When someone leaves the project, the context doesn't leave with them. When a project goes quiet for three months and comes back, CORE picks up exactly where it left off."*

Specific scenarios. No abstraction. The reader can verify the claim because the claim is concrete.

**Use these as the shape every replacement-text proposal aims at.** When in doubt, ask: *would this line feel like it belongs next to the §11.1 calibration sentence?* If not, the proposal hasn't earned its register yet.

---

## V-Class Vocabulary

Five classes catalog the violations voice review is hunting. Numbers are stable; descriptions are operational.

### V2 — Rhetorical Binary Flip

Construction: *"X is not Y — it is Z"* or *"not X but Y"*. Group A is a violation; Group B is exempt only when a strict three-clause test passes.

**Group B test (a/b/c — burden of proof on whoever invokes it):**
- (a) The negation half names a *specific* misreading the reader is likely to hold *at this point in the document*. Not a constructed strawman.
- (b) The affirmation half corrects with content unavailable from a non-flipped declarative.
- (c) The correction has not already been delivered elsewhere.

If any clause fails, the flip is Group A. Replace with a positive declarative.

**Verified Group B examples** (from ARCH, retained after Iter 4 re-test):
- L39: "The asymmetry is intentional, not unfinished."
- L107: "iteration is how high quality is reached, not a sign that something failed"
- L359: "Speed of approval is a warning sign, not a green flag."
- L601: "Agreement among agents after adversarial loops is not proof of correctness; it is justified higher confidence."

**Failed Group B → reclassified as Group A:**
- ARCH §2.2 P6 closer: "The reach of agentic AI is bounded by your authority, not in spite of it." Clause (a) failed — "in spite of authority" is not a likely reader misread; it's a constructed strawman. Replacement: *"The reach of agentic AI is the reach you authorize."*

### V4 — Definitional Copula

Construction: *"X is Y"* where Y is a definition of X. Lead-with-what-something-IS rather than lead-with-what-it-DOES.

The hazard pattern is a *fragment-then-copula opener* — a fragment label, then a copula sentence that defines it. The fragment creates the appearance of structural-row exemption while functioning as definitional argument.

**Examples caught:**
- ARCH §2.1 lead: *"The substrate. These properties are characteristic of inference-based multi-agent systems with current-generation models."* — fragment-then-copula.
- ARCH §8 lead: *"It is a skill loaded by a host harness."* — copula in second sentence.
- ARCH §9.2 lead: *"Learning is captured at two cadences:"* — passive copula opening.
- ARCH §9.4 lead: *"Fields four through eight are the innovation..."* — copula + V5 self-laudatory abstraction.

**Fix shape:** Lead with what the thing DOES (operational verb) or what to DO with it (imperative/modal). Reserve copula for explicit labeled-definition rows (glossary entries, schema rows, ADR Context/Decision rows).

### V5 — Undefined Capability Language

Construction: Abstract capability words without referent. *"intelligence," "synthesizes," "monitors," "predicts," "improves"* used as if self-defining.

The voice target avoids these. Specific words to flag:
- **"intelligence"** — only acceptable when contextually bounded ("Decision Intelligence" is a labeled capability area; "project intelligence" as standalone hero phrasing fails).
- **"synthesize"/"synthesis"** — flag any use that implies a mechanism without specifying what's synthesized from what.
- **"monitor"** — flag any use that implies continuous surveillance unless explicitly bounded to "session bootstrap" or "during swarms."
- **"predict"** — flag any use that implies a prediction engine; per ARCH §6.2, Risk Intelligence is Aspirational.
- **"improve"/"improving"** — flag any use that implies continuous improvement; memory hygienes run every 3–5 sessions, not continuously.

**Fix shape:** Replace with the concrete mechanism. If the mechanism can't be named without making an Aspirational claim, the original sentence was overpromising — cut it.

### V6 — Capability Claim Without Residual

Construction: Asserting a capability as implemented when it's aspirational, partial, or session-bounded.

The behavioral-honesty meta-posture (ARCH §2.3) says residuals must be disclosed, not absorbed silently. V6 is the failure mode where the disclosure is missing.

**Examples caught:**
- README L11 *"It improves with every interaction."* — frequency claim is wrong; memory hygienes are session-close, not per-exchange.
- README L13 *"CORE can [track all the signals]."* — implies continuous tracking; CORE runs at session start.
- README L62 *"The tool learns your project's language."* — implies adaptive learning; mechanism is retrieval from PROJECT.md, not learning.
- ARCH §4 *"Self-evolution (the skill improves itself across sessions via memory hygienes)."* — missing cadence residual (every 3–5 sessions, not every session).
- ARCH §9.5 *"every agent-to-agent message is visible to the user in real time"* — missing harness-dependence residual (sub-agent boundaries surface at whatever granularity the harness supports).

**Fix shape:** Either name the residual (cadence, mechanism trigger, honest failure mode) or cut the claim.

### C5 — Definitional Prose

Function-based test (Prism's canonicalization, 2026-04-26 review):
- Structured-row exemption only when content *functions* as labeled definition (glossary entries, schema rows, ADR Context/Decision/Consequence rows).
- Format alone is not the test. A list-shaped fragment that opens with definitional load functioning as argument or elaboration is C5.

The fragment-then-copula opener is the C5 trap dressed as structural-row exemption. Test by asking: *does the surrounding content function as definition (glossary-shaped) or as argument (essay-shaped)?* If argument, C5 applies regardless of format.

---

## Structural Habits Catalog

Habits are the templates that *generate* V-class violations. Catching habits is higher-leverage than catching instances; fixing the template retires the generator.

### README's habit: *Subject-verb-capability without mechanism*

Diagnosed by Jab, Iter 1, 2026-04-26.

Construction: *"CORE [verb]s [capability]"* — subject + present-tense capability verb, repeated at every section opening, no constraint or residual.

The rule: **If a sentence names what CORE does without specifying what triggers it, what constrains it, or where it falls short, it is a pitch sentence.** Rewrite by adding at least one of: trigger mechanism, constraint, or honest failure mode.

### ARCHITECTURE's habit: *Definitional opener inheritance / Subject-copula-definition without operation*

Diagnosed by Loom + Anvil convergent, Iter 2, 2026-04-26.

Construction: Sections open by *naming* what something is (or is composed of) before saying what it does. Quieter than README's pitch verbs because the document is technical, but definitional in the same C5/V4 sense.

The rule: **In ARCHITECTURE.md, principle Statement-italic lines and section openers use imperative or modal voice. Passive-copula construction ("X is Y") is reserved for §12 Glossary entries and explicit labeled-definition rows (the §9.4 schema row, ADR Context/Decision/Consequence rows where Consequences must report effects, not assert qualities).**

### SKILL.md's habit (from Cassandra, Iter 3, partial finding): *Second-person imperative-with-copula-backup*

Construction: Opens with "You are…" then leans on copulas for invariants ("There is ONE Delivery Manager…", "All protections are discipline-enforced…").

This is partly correct register (DM instructing itself), but copula leaks into invariants where imperative would be sharper. **Out of scope for the 2026-04-26 loop**; flagged for a future SKILL.md voice pass. Documented here so the next loop has the diagnosis ready.

---

## Pattern Catalog

Patterns are repeating tics that span multiple instances. Pattern-finding beats instance-finding; one pattern caught equals N instances fixed.

### Self-laudatory abstraction tic

Construction: *"X is the innovation,"* *"is genuine,"* *"the differentiator,"* *"the breakthrough."*

Caught at two locations in the 2026-04-26 loop (SF-A6 ADR 2; A-H8 §9.4). When applied uniformly, the tic produces internal contradiction — the lead paragraph editorializes while the table or ADR row reports facts.

**Hunt for this in:** ADR Consequences rows, §9.x section leads, README hero/closer regions.

### ADR Consequences editorializing pattern

ADR rows (Context / Decision / Consequence) are structurally good for capturing decision rationale. The Consequences row has the most interpretive latitude — it captures trade-offs, costs, mitigations.

**The discipline:** Consequences describe observable effects and costs, not value claims about the decision itself. *"Innovation is genuine"* (cut from ADR 2) and *"Universal rules are carried uniformly"* (rewritten in ADR 4) and *"Critics find issues that reading the Generator first would have hidden"* (rewritten in ADR 7) all editorialized where they should have reported.

**Hunt for this in:** every ADR's Consequences row. Test each sentence: *does it describe an effect, or does it assert a quality?* If the latter, replace with effect description.

### Crescendo / dramatic opener tic

Construction: *"X is where Y"* or *"X is the Z"* — produces tonal lift at the cost of definitional honesty. ARCH-side equivalent of README's pitch-voice tic.

Caught at §6.2 lead, §7.2 lead, §8 lead, §9.4 lead in the 2026-04-26 loop. Different surface texts, same underlying shape.

**Fix shape:** Drop the dramatic copula; lead with the operational verb or the failure mode being countered.

---

## Editing Rules (Adopted From the Loop)

Two rules earned their place by surviving Iter 4 adversarial review:

### Rule 1: Statement-line and section-opener voice

> In `ARCHITECTURE.md`, principle Statement-italic lines and section openers use imperative or modal voice. Passive-copula construction is reserved for §12 Glossary entries and explicit labeled-definition rows (the §9.4 schema row, ADR Context/Decision/Consequence rows where Consequences must report effects, not assert qualities).

### Rule 2: Capability claim residual disclosure

> No present-tense capability claim in `README.md` without a corresponding implementation-status reference. If the claim names a behavior the framework does not yet schedule as an instrumented mechanism, the residual must be named in the same paragraph or in a directly adjacent capability table row.

These rules go INTO the document they govern (the meta-posture pattern — see ARCH §2.3 *Behavioral honesty* for the existing parallel). The reference doc here is for the vocabulary; the rules live next to the prose they govern.

---

## Voice Review Loop Template

The 2026-04-26 overnight loop ran 6 iterations across ~6h44m and applied 36 logical edits. **Treat this as one data point, not canonical.** The retrospective at `_outputs/2026-04-26/voice-loop-retrospective.md` names what to improve.

### Iteration shape

| Iter | Focus | Agents (one example composition) |
|---|---|---|
| 0 | **Stale-review verification** (NEW — was Iter 2/3 in 2026-04-26; should be first) | Calipers (consistency), Synthesizer (manifest builder) |
| 1 | Voice principles research, editorial calls | Reed (reader-experience), Jab (voice-critic) |
| 2 | Per-document deep dive (one doc per iter if budget permits) | Loom (structural), Anvil (V-class hunter) |
| 3 | Cross-document consistency | Cassandra (skeptic), Archivist (taxonomy drift) |
| 4 | Adversarial review of all proposals + manifest verification | Tribunal (aggressive critic), Threshold (naive reader), Caliper (fact-checker) |
| 5 | Application — execute the manifest | DM direct, optionally one Editor agent for contested rewrites |
| 6 | Verification + commit + sync | Quality Sentinel, DM finalization |

### Lessons baked in (from retrospective)

1. **Stale-review verification is Iter 0**, not Iter 2. The 2026-04-26 loop discovered MF-A1/A2/A4/A5 were all already-resolved or had no source text. Verify against current source files BEFORE doing voice analysis. Shrinks scope, prevents Iter 5 from corrupting correct text.

2. **DM-synthesis verification step required.** When the DM composes proposed text after agent outputs, that text must be cross-checked against source files (base-protocol.md, memory-hygiene.md, etc.) before landing in the iter doc. The 2026-04-26 loop had A-H8 and MF-R4 errors generated at this step; Caliper caught both in Iter 4. Without that pass, factually wrong text would have shipped.

3. **Convergent independent findings carry more reliability than any solo high-confidence finding.** Cassandra + Archivist convergence on SKILL.md L104 was high-signal. Anvil's solo 0.95 on A-H8 was wrong. Convergent findings auto-promote; solo findings need adversarial verification.

4. **Pattern inventory before adopting any "master fix."** When an agent claims to have found a generative pattern (e.g., Loom: "Definitional opener inheritance"), the DM synthesis should validate by inventorying the full pattern surface (all P-statements; all section openers) before adopting the prescription. Loom's imperative master fix was the wrong prescription; Tribunal's pattern inventory in Iter 4 corrected to modal-passive.

5. **Time-budget enforcement per iteration with explicit compress plans.** Each iteration needs: hard timer, "what to compress if running long" plan, automatic abort at the per-iteration hard stop. The 2026-04-26 Iter 5 had no compress plan and overran the 04:00 hard stop by 50 min. Iter 6 verification was the casualty.

6. **Combined Iter 5/6 with hard verification gate.** Don't let verification be the iteration that gets cut. Pattern: apply HIGH-confidence first → verify → apply MEDIUM → verify → commit. Verification before commit is non-negotiable.

7. **The save-comprehensive-doc-then-compact pattern is load-bearing.** Each iteration writes a comprehensive doc; the next iteration reads the doc, not accumulated context. Auto-compact will fire on long loops; the docs are the only durable source of truth.

### Agent identity tips

- Use named agents with distinct lenses (Reed = reader-experience; Jab = voice-critic; Loom = structural). Same names across iterations cause confusion if they map to different agent runs — use loop-specific identifiers if needed.
- Convergent findings between agents with *complementary* lenses (e.g., a structural agent + a V-class agent) are higher-signal than convergence between two agents with the same lens.
- 3 agents per iteration is the working number. 4+ over-parallelizes (David rejected this in 2026-04-26 Iter 1). 1–2 risks missing convergence signals.

---

## Cross-References

- `_outputs/2026-04-26/voice-loop-iter-01-research.md` — Iter 1 (Reed + Jab) full outputs and editorial calls
- `_outputs/2026-04-26/voice-loop-iter-02-architecture.md` — Iter 2 staleness discovery, master fix diagnosis
- `_outputs/2026-04-26/voice-loop-iter-03-crossdoc.md` — Iter 3 cross-doc findings + Synthesizer manifest pointer
- `_outputs/2026-04-26/voice-loop-iter-04-adversarial.md` — Iter 4 manifest defects caught + corrections
- `_outputs/2026-04-26/voice-loop-iter-05-edits.md` — Iter 5 application record
- `_outputs/2026-04-26/voice-loop-iter-06-final-synthesis.md` — Final overnight synthesis
- `_outputs/2026-04-26/voice-loop-retrospective.md` — what to improve about the loop shape itself
- `agents/base-protocol.md` — agent output schema (8 fields), used as ground truth for §9.4 schema descriptions
- `protocols/self-evolution.md` — memory-hygiene ground truth (cadence, phases, risk tiers)

---

## Origin and Maintenance

This reference distills the 2026-04-26 overnight voice loop. Subsequent voice reviews should:
- Use the V-class vocabulary above without redefining
- Add new pattern findings to the Pattern Catalog (don't replace; append)
- Update the loop template with retrospective lessons (don't replace; iterate)
- Treat the rules in §"Editing Rules" as durable; only revise on clear evidence

The vocabulary is the load-bearing part. The loop template is one shape that worked; the next loop can pick a different shape if its structure suggests it.
