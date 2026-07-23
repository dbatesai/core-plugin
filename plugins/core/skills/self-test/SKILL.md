---
name: self-test
description: Run the memory system's internal blind self-test on the current project's own store — a pre-registered, round-based check of whether the memory can actually be FOUND from natural questions, including questions the store deliberately cannot answer. It authors a fresh question set BLIND (a separate agent reads only the stored facts, never the retrieval code), mechanically verifies and freezes that set, then measures the real retrieval path against it and reports a per-kind breakdown plus an old-vs-new-round comparison that watches for the store being tuned to its own test. Use whenever the user runs /self-test, asks to "test the memory on this project", "author a fresh question set and score it", "run a blind retrieval self-test", "add a self-test round", or wants an honest, self-generated answer key rather than the small static one. Do NOT use for the quick health proof (that's /metrics) or a full hygiene pass (that's /process-memory).
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Task
---

# `/self-test` — the blind, round-based memory self-test

The other half of the measurement story. `/metrics` proves the machinery round-trips; `/self-test` asks the harder question: **can the memory actually be found from the kinds of questions a person really asks — and does the system correctly say "nothing stored about that" when the answer genuinely isn't there?** It does this without grading its own homework: the questions are authored by a separate BLIND agent that never sees the retrieval code, the set is mechanically verified and frozen before anything is scored, and each new round is compared against the older ones so you can see if the store has quietly been tuned to its own test.

**Three kinds of question, on purpose:**
- **questions the store SHOULD answer** — phrased naturally, often sharing no words at all with the stored fact (the hard case: finding a fact by meaning, not keywords);
- **questions the store should answer but phrased about a change over time** — what was decided before X, what changed about Y;
- **questions the store deliberately CANNOT answer** — the right behavior is saying "nothing stored about that", not confidently returning the nearest-looking fact. A sharper version swaps in a plausible thing the store never mentions (asking why a choice was made that was never actually made) — a false-premise question.

**The script is the machinery.** `skills/core/scripts/self-test-round.mjs` owns everything mechanical: it freezes the corpus, emits the authoring brief, verifies an authored set against that frozen corpus, and runs the real measurement harness. You orchestrate the one part a script can't do — spawning a genuinely blind author — and relay results in plain language. Never hand-score, never edit a frozen set, never fix an author's mistakes silently.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/self-test/SKILL.md` — that prefix is the plugin root. If you cannot resolve a concrete root, say so plainly and stop; never run `node` against a guessed path.

## Step 1 — start a round (freeze the corpus, get the brief)

```bash
node "${CORE_ROOT}/skills/core/scripts/self-test-round.mjs" new-round <project-dir>
```

This snapshots the store's current identity (unit count + content hash), creates an append-only round directory under `<project>/_tests/self-test/round-<N>/`, and writes the **blind-authoring brief** for this round. It does not author anything. Read the printed brief path — its content is the entire input to the author in Step 2.

## Step 2 — spawn the BLIND author

Spawn a **fresh subagent** whose entire prompt is: (a) the brief from Step 1, verbatim, and (b) the bodies of the store's units (read them from `<project>/_memories/`, active units — skip files starting with `_` or `INDEX`). Nothing else — no session context, no prior rounds, no retrieval output.

The blindness rules the author must follow, and that you must enforce by what you give it:
- **The author never runs any retrieval, search, or scoring tool, and never reads the retrieval code.** It authors from the stored facts alone. Give it the unit bodies as text; do not point it at the scripts. This is the whole point — a question authored with knowledge of how the finder works is not a fair test.
- **The author states its blindness in the set's header** (`meta.blind_attestation`) and records who/which model it is (`meta.author`). Registration refuses a set with no attestation.
- **Prefer a different model family than the one that does the project's own reasoning**, when an alternate CLI author is available (e.g. a `claude -p` vs another vendor's CLI) — a set authored by the same family that will be scored can quietly flatter it. When no alternate is available, say so honestly and proceed with a same-family author; the old-vs-new delta in Step 4 is the backstop if that bias ever shows up.

The author returns one JSON object (`meta` + `queries`). Save it to a file, e.g. `<scratch>/round-<N>-goldset.json`.

## Step 3 — register (mechanical verification, then freeze)

```bash
node "${CORE_ROOT}/skills/core/scripts/self-test-round.mjs" register <project-dir> <round> <goldset-file>
```

This runs the verifier — everything checkable without trusting the author:
- **schema** (the same fail-closed gate the measurement harness uses: every question declares its support or declares itself unanswerable, no duplicate ids, known kinds);
- **zero word-overlap** for the indirect kinds, checked against each answer unit's title, body, AND topics (a question that shares words with its answer isn't testing meaning-based recall);
- **the false-premise entity checks** — the swapped-in thing must genuinely be ABSENT from the store, and the real framing things genuinely PRESENT;
- **per-kind counts** against the round's quota (too many of a kind is refused as padding; too few is allowed as an honest shortfall);
- **corpus identity** — the author must have authored against this round's frozen corpus, and the store must not have drifted since.

**On refusal, the failures go back to the author — you do not silently patch them.** A question the verifier rejects is a question the author got wrong; hand the specific violations back to a fresh author pass (or the same one) and re-register. Editing the set yourself to make it pass defeats the blindness.

**On pass, the round is FROZEN:** the verified set and a pre-registration record (question-set hash, corpus snapshot id, timestamp) are written. A frozen round is append-only — registration refuses to overwrite it. Adding questions later means a new round, never editing this one.

## Step 4 — run and relay in plain language

```bash
node "${CORE_ROOT}/skills/core/scripts/self-test-round.mjs" run <project-dir> <round>
```

This runs the **real shipped retrieval path** against the frozen set and reports:
- the **headline** recall for this round;
- a **per-kind breakdown** — how recall holds up as questions get less literal, and the **trap-leak rate** on the deliberately-unanswerable questions (how often a trap answer wrongly surfaced; lower is better, 0% is ideal);
- the **old-vs-new delta** once a prior round exists — this round's questions measured against the same store as the older rounds. A large positive delta (new questions much harder than old) is the warning sign that the store may have been tuned to the old questions rather than genuinely improved.

Relay every number in plain words. Explain each kind in the sentence it appears in — "questions whose answer is deliberately absent, where the right behavior is saying 'nothing stored about that'", not "the abstention rung". Never call this a pass/fail gate: the answer key is self-authored, so it is a directional, provisional snapshot — an honest one, but not proof the retrieval is correct.

`status` shows the whole history at a glance:
```bash
node "${CORE_ROOT}/skills/core/scripts/self-test-round.mjs" status <project-dir>
```

## Step 5 — it feeds `/metrics`

Once any round is registered, `/metrics`'s retrieval-regression section automatically prefers the newest round over the small static gold set — reporting its per-kind breakdown, the trap-leak rate, and the old-vs-new delta, still honestly labeled `provisional`. You don't do anything extra for this; running `/metrics` picks it up. It is strictly more honest than the old static number because it now includes the unanswerable classes and the overfitting detector.

## Rails

- **Fewer than ~30 active units:** say so and stop — the whole store fits any reasonable result list, so a self-test measures noise. Grow the store first.
- **No `_memories/` store:** nothing to test; offer `/core` to start one.
- **The author can't find enough clean zero-overlap pairs for a kind:** that's expected on small or vocabulary-saturated stores — an honestly short kind beats a padded one, and the verifier allows under-quota. It is itself a finding about the store's shape.
- **Never run the blind author against a store you've been discussing the questions in** — talking about a gold query in a session that then writes memory can plant a fake keyword bridge. Author in a fresh session; the verifier also warns if a unit quotes a question verbatim.
