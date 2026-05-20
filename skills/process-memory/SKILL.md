---
name: process-memory
description: On-demand memory-processing pass. Looks back at the current session for missed observations and captures them, pulls inbox, walks observations for graduation, validates units, regenerates indexes, compacts PROJECT.md when over the file cap, then surfaces anything that needs human judgment. Use for mid-session housekeeping without running a full /finalize.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# `/process-memory`

Run the memory housekeeping pass. After this finishes, the project's memory-related files should be in tip-top shape: inbox empty, observations graduated where ready, every unit validated, both indexes current, PROJECT.md under the file cap, anything that needs your judgment surfaced.

Runs synchronously in the current session.

---

## Step 0 — Look back, capture missed observations from this session

Before any other hygiene work, scan the current session for moments that should have become observations and weren't. The in-flow "answer the user" tradeoff regularly suppresses observation writes — this step exists because that failure mode is consistent and named in PROJECT.md §Moves (memory-capture robustness).

For each of these patterns in the recent conversation, write the observation now if it isn't already on disk:

- User named a constraint that affects future sessions ("we always do X" / "don't ever Y" / "the rule for this project is Z")
- User shared a stakeholder preference, dynamic, or relationship detail
- User surfaced a research finding, experiment result, or empirical fact worth keeping
- User corrected the agent's approach (caught a mistake, redirected work, named a missing step)
- User confirmed a non-obvious approach worked when proposed (validated judgment call)
- A workflow lesson surfaced that affects how future scheduled agents, hygiene passes, or other automation should be designed
- A misalignment between a protocol document and observed behavior
- The agent itself made a judgment-call decision worth recording with rationale

Write to `<project>/_memories/observations/<YYYY-MM>/obs-<timestamp>-<slug>.md` per the spec at `protocols/data-storage.md §Tier 1`, OR to `<project>/_memories/obs-<descriptive-slug>.md` if the observation has unit-shaped weight (rich edges, durable sources, ongoing relevance).

Then narrate in plain voice: "Captured N observations from this session before processing." If zero, say "Scanned the session; nothing missed." One line is enough — don't burn a paragraph defending the scan.

---

## Step 1 — Pull inbox

If `<project>/inbox.md` is non-empty, classify each entry:
- Clear-cut observations → write to `_memories/observations/<YYYY-MM>/`
- Items needing user review → surface inline
- Noise → discard with a one-line note

Truncate `inbox.md` when done.

---

## Step 2 — Walk recent observations

For each file in `_memories/observations/<YYYY-MM>/` not yet reviewed this session, apply the graduation criteria from `protocols/data-storage.md §Graduation`:
- Clear-cut candidates → graduate to units, update edges
- Borderline → surface for user decision inline

---

## Step 3 — Validate units

Run the schema + integrity check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs" "<project>/_memories"
```

Read the output. The validator emits three counts: PASS, WARN, FAIL.

**Auto-fix safe issues** when possible:
- `required-field: topics` — add `topics: []` if no better inference; otherwise pick reasonable topics from the unit's body and surrounding edges.
- `status-value: open` on a risk unit → rewrite to `active`.
- `status-value: closed` on a risk unit → rewrite to `archived`.
- `status-value: superseded` on a decision unit → rewrite to `retired`.
- `archived-in-active`: unit has `status: archived` but sits in active dir → move to `_memories/archive/`.
- `edge-unknown-type`: edge type not in the six committed types (`cites`, `supersedes`, `depends-on`, `conflicts-with`, `references-person`, `references-topic`) → remove the edge if it's `superseded-by` or `depended-on-by` (the inverse already lives on the other unit); otherwise surface.

**Surface for human judgment** without auto-fixing:
- `dangling-edge` / `edge-target-missing` — could be valid external references or typos; the user decides.
- `orphan` (no edges) — sometimes deliberate (risks often stand alone), sometimes a graduation gap.
- Anything else the validator flags that isn't on the safe-fix list.

After auto-fixing, re-run the validator and report the new counts.

---

## Step 4 — Regenerate indexes

Always run both generators (they're cheap and idempotent — if nothing changed, the file content is identical):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs" "<project>/_memories"
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-risks-index.mjs" "<project>/_memories"
```

Both write to `_memories/INDEX-*.md`. Top-level units only — archived ones in `_memories/archive/` are intentionally excluded from the index.

---

## Step 5 — Compact PROJECT.md if over the cap

```bash
wc -c "<project>/PROJECT.md"
```

If over ~66KB (~67000 bytes), run the compaction:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs" "<project>"
```

The script replaces full-text `§Decisions` entries with one-line stubs pointing to their canonical units in `_memories/`, matching the DC-48 stub-every-archived-decision pattern. Auto-MIGRATE is authorized for this shape per DC-46. The script is idempotent — entries already in stub form are left alone.

Report the before/after size and the per-entry stats the script prints.

---

## Step 6 — Cap-check IMPROVEMENT_LOG.md

```bash
wc -c "<project>/IMPROVEMENT_LOG.md"
```

If over ~66KB, surface a recommendation but do not auto-compact — IMPROVEMENT_LOG has a count-based rotation pattern (DC-42) that needs `/finalize` discretion, not in-flight compaction.

---

## Step 6.5 — Retrieval quality scan

Run the retrieval-quality analyzer over the last 30 days of session logs:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-retrieval-quality.mjs" "<project>"
```

Read the output. The three signals worth surfacing in plain voice:

- **Dip-back rate** above ~50% on a unit retrieved more than 3 times → the unit isn't satisfying queries that find it. Either the body needs sharpening, the topic tags don't match what surfaces it, or it should split into two units.
- **Tier-2+ escalation rate** above ~70% on a topic that appears in more than 3 events → the lexical layer isn't finding what it should. Either there's no unit yet for that topic, or the existing units have mismatched tags.
- **Tier 3 fires** repeatedly on similar queries → DC-67 trip-wire territory. Note the pattern for the user.

Narrate one or two top anomalies in plain voice. Don't dump the raw report. If everything is clean, say so in one sentence ("Retrieval quality looked clean — 47 events, T1=60% / T2=30% / T3=11%, no unit dipping back over 30%.").

If the project has no `_sessions/<date>/retrieval-log.jsonl` files yet, the analyzer reports "No retrieval events found" — surface that as a one-liner ("No retrieval log yet — the corpus builds with use.").

---

## Step 7 — Write state

Update `<project>/_memories/_pm-state.json` with the current timestamp:

```json
{"last_run": "<ISO timestamp>", "last_pass_outputs": "<one-line summary of what happened>"}
```

Create the file if it doesn't exist.

---

## Step 8 — Narrate results

Tell the user what happened across all steps in one tight block:
- Look-back: count captured from this session, or "nothing missed"
- Inbox: count processed / surfaced
- Observations: count graduated / surfaced
- Validation: before/after counts (PASS/WARN/FAIL) + names of any issues surfaced for user judgment
- Indexes: regenerated (and whether anything changed)
- PROJECT.md: before/after bytes if compacted, or "under cap" if not
- IMPROVEMENT_LOG.md: under cap, or surfaced recommendation
- Retrieval quality: tier distribution + any anomalies, or "clean"
- Anything else worth knowing

Two or three sentences if everything was clean. Longer only if there's something the user needs to act on.
