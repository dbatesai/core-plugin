---
name: process-memory
description: On-demand memory-processing pass. Pulls inbox, walks observations for graduation, regenerates indexes, checks file caps. Use for mid-session housekeeping without running a full /finalize.
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

Run the memory housekeeping pass. This is the same work that `/finalize` runs in its hygiene step, without the handoff, render, and session-close steps. Use it when you want to process accumulated observations, refresh indexes, or check file caps mid-session.

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

## Step 3 — INDEX drift check

Compare `_memories/dc-*.md` count against `_memories/INDEX-decisions.md` entries. If counts or ids don't match, regenerate:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.py" "<project>/_memories"
```

Same for `INDEX-risks.md` against `_memories/risk-*.md`.

---

## Step 4 — File-cap check

```bash
wc -c "<project>/PROJECT.md" "<project>/IMPROVEMENT_LOG.md"
```

If either is over ~66KB, surface a compaction recommendation. Don't auto-compact.

---

## Step 5 — Write state

Update `<project>/_memories/_pm-state.json` with the current timestamp:

```json
{"last_run": "<ISO timestamp>", "last_pass_outputs": "<one-line summary of what happened>"}
```

Create the file if it doesn't exist.

---

## Step 6 — Narrate results

Tell the user what happened: units graduated, indexes regenerated, any file-cap warnings. One or two sentences.
