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

**Script path resolution.** This file references scripts via `${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<script>.mjs`. That env var is set on Claude Code marketplace installs but not on Codex or Gemini. On Codex and Gemini, derive the path mechanically: take the absolute path you loaded this `SKILL.md` from, replace `/skills/process-memory/SKILL.md` with `/skills/core/scripts/<script>.mjs`. Concretely: `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/process-memory/SKILL.md` → `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/core/scripts/<script>.mjs`. Do not construct paths against a guessed plugin base; the loaded path carries the resolution.

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
- **Source-pull deferral pattern:** Did any external-source sweep this session find sentinel content references (event-detail blocks, file/message IDs, recording metadata) but defer fetching the actual content? "Queued for later," "added to backlog," "fetch next time" framings usually mean the deferral fired and the content never lands. Write an observation flagging the missed pulls and surface to the user for follow-up. Step 0 is the backstop when in-loop discipline slips.

Write to `<project>/_memories/observations/<YYYY-MM>/obs-<timestamp>-<slug>.md` per the spec at `protocols/data-storage.md §Tier 1`, OR to `<project>/_memories/obs-<descriptive-slug>.md` if the observation has unit-shaped weight (rich edges, durable sources, ongoing relevance).

Then narrate in plain voice: "Captured N observations from this session before processing." If zero, say "Scanned the session; nothing missed." One line is enough — don't burn a paragraph defending the scan.

---

## Step 1 — Pull inbox

If `<project>/inbox.md` is non-empty, walk the entries. Two shapes can appear:

**Mode-tagged observation blocks** carry full frontmatter (id, type, status, source, source-instance, extracted-at, references-person, confidence-level, body) plus two framework fields: `mode: B | C` and, when Mode C, `judgment-needed: <prose>`. These come from extractors implementing the source-registration framework (see `references/external-sources/source-registration-framework.md §4`). The mode tells you the routing without re-deriving it from criteria. The two framework fields (`mode`, `judgment-needed`) are inbox-only annotations — strip them from the frontmatter before writing the graduated unit.

- **Mode B blocks** — read the body and the proposed frontmatter back to the user in plain voice and ask for confirmation. On confirmation, write the block to `<project>/_memories/observations/<YYYY-MM>/obs-<id>.md` with `status: active` and the two inbox-only fields removed. Apply any user-supplied adjustments before the write. On rejection, discard with a one-line note.
- **Mode C blocks** — surface the `judgment-needed` question to the user verbatim. Wait for an explicit answer. Don't graduate on routine confirmation — Mode C means the judgment is the user's call. Acceptable resolutions: (a) the user resolves the question and the block graduates to `<project>/_memories/observations/<YYYY-MM>/obs-<id>.md` with the judgment recorded as a `## Resolution` body subsection, `status: active`, and the two inbox-only fields stripped; (b) the user defers and the block stays in `inbox.md` until next pass; (c) the user rejects and the block is discarded with a one-line note. Don't auto-resolve a deferred Mode C block on a subsequent pass — wait for explicit input each time.

**Untagged entries** (free-form text, observations dropped in without frontmatter) follow the legacy classify path:
- Clear-cut observations → write to `_memories/observations/<YYYY-MM>/`
- Items needing user review → surface inline
- Noise → discard with a one-line note

Truncate processed entries when done. Mode C blocks the user deferred stay in place. Mode B blocks the user adjusted but didn't reject also truncate after the graduated unit lands.

---

## Step 2 — Walk recent observations

For each file in `_memories/observations/<YYYY-MM>/` not yet reviewed this session, apply the graduation criteria from `protocols/data-storage.md §Graduation`:
- Clear-cut candidates → graduate to units, update edges
- Borderline → surface for user decision inline

---

## Step 2.5 — Clean cloud-sync ghost duplicates

macOS sync engines (iCloud Drive, OneDrive, Dropbox) preserve concurrent-write conflicts by creating `<filename> 2.md` (with leading space) duplicates. When the agent writes frequently to `_memories/` files mid-session, the sync engine sees a "conflict" between its cached view and the agent's write, and keeps both. Most of these settle as exact duplicates with identical content — harmless on disk, but they pollute validator output (each ghost reports separately as a unit) and confuse counts.

Find candidates and verify each is an exact duplicate of its original before deleting:

```bash
find <project>/_memories -name "* 2.md" -print0 | while IFS= read -r -d '' ghost; do
  original="${ghost% 2.md}.md"
  if [ -f "$original" ] && diff -q "$ghost" "$original" >/dev/null 2>&1; then
    rm "$ghost"
  fi
done
```

The verification step is load-bearing — never bulk-delete `* 2.md` without confirming the content matches the original. If the ghost differs from the original, surface to the user for inspection (rare; usually means the sync engine preserved a genuinely different version that needs reconciliation, not a duplicate).

Narrate: "Cleaned N ghost duplicates from `_memories/`." If zero, say nothing.

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

## Step 5 — PROJECT.md tier discipline (DC-85 Phase 1b + 1c)

Run three scripts in order — demote-moves first, then compact-project, then demote-state-narrative. The first two auto-apply: PROJECT.md is agent-managed, with effectiveness measured via the hygiene-log events these scripts emit (not user review of the diffs). The third is dry-run-default in v1 per DC-93 — only `--apply` writes.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/demote-moves.mjs" "<project>"
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/compact-project.mjs" "<project>"
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/demote-state-narrative.mjs" "<project>"
```

- `demote-moves.mjs` walks §Moves and demotes closed `[x]` bullets to `PROJECT-ARCHIVE.md §Moves` when the most-recent backing-unit `updated:` date is >30 days old AND all cited units are in terminal status. Conservative defaults: no backing-unit citation → keep; any missing/active cited unit → keep. Emits `kind: demote-moves` to `_sessions/<date>/hygiene-log.jsonl`. First runs on §Moves-heavy projects can demote 20+ items in one pass — narrate the magnitude.
- `compact-project.mjs` collapses `§Decisions` paragraphs to one-line stubs pointing at units (DC-48 pattern). Auto-MIGRATE per DC-46; idempotent. Now also emits `kind: compact-project` with section-size breakdown and `kind: project-md-over-cap` when the file remains >70KB after compaction. Use `--section-sizes` to inspect the breakdown without writing.
- `demote-state-narrative.mjs` walks §State and surfaces demotion candidates when the bullet carries a strict `*Backed by ...*` footer, ALL cited units are in terminal status (mirrors `demote-moves` set for cross-script symmetry), AND the most-recent backing-unit `updated:` date is >60 days old. **Default is dry-run in v1** per DC-93 — emits a candidate list and a `kind: demote-state` event to hygiene-log without writing. Pass `--apply` only when a §State-heavy non-CORE corpus has been exercised and produces clean candidate lists for multiple sessions; flip the default in a tracked decision then. Narrate "would demote N items" only if N > 0.

Report the demoted count and the before/after sizes the scripts print. Over-cap warnings after all three scripts have run name what's left — §Notes overflow or the §Moves citation-discipline gap captured at [[obs-demote-moves-first-fire-2026-05-24]].

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

## Step 6.6 — Capability drift scan (v2.7)

Read the per-session capability history and surface any drift:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/analyze-capability-drift.mjs" "<project>"
```

It reads `~/.core/workspaces/<id>/capability-history.jsonl` (appended each session at startup by `record-capability-snapshot.mjs`), renders `<project>/_memories/capability-drift-log.md`, and reports degrading drift + regressions. Narrate only what's actionable in plain voice — a capability that slipped PASS→DEGRADED, or one that stopped reporting between sessions. If there's no history yet, say so in one sentence ("No capability history yet — it accrues per session."). Healing-direction changes are informational; don't lead with them.

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
