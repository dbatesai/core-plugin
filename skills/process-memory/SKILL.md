---
name: process-memory
description: On-demand memory-processing pass. Pulls inbox, walks observations for graduation, validates units, regenerates indexes, compacts PROJECT.md when over the file cap, then surfaces anything that needs human judgment. Use for mid-session housekeeping without running a full /finalize.
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

## Step 7 — Write state

Update `<project>/_memories/_pm-state.json` with the current timestamp:

```json
{"last_run": "<ISO timestamp>", "last_pass_outputs": "<one-line summary of what happened>"}
```

Create the file if it doesn't exist.

---

## Step 8 — Narrate results

Tell the user what happened across all steps in one tight block:
- Inbox: count processed / surfaced
- Observations: count graduated / surfaced
- Validation: before/after counts (PASS/WARN/FAIL) + names of any issues surfaced for user judgment
- Indexes: regenerated (and whether anything changed)
- PROJECT.md: before/after bytes if compacted, or "under cap" if not
- IMPROVEMENT_LOG.md: under cap, or surfaced recommendation
- Anything else worth knowing

Two or three sentences if everything was clean. Longer only if there's something the user needs to act on.
