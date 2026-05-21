# Codex memory-save micro-protocol

Trigger: user says "save this", "remember this", "save your observations", or any phrase clearly asking to persist a recall note to Codex memory.

Applies only on Codex harness. On Claude Code, "save this" routes to the normal observation-capture flow which writes into `<project>/_memories/observations/`.

See DC-86 (`_memories/dc-86-harness-local-memory-recall.md`) for the principle: harness-local recall is surface 4 in the authority stack — scratch cache for hints, never authoritative. This protocol is the explicit-save half of the dual-write model. The autonomous-curation half lives in `protocols/data-storage.md` and always writes to `<project>/_memories/`.

## When this fires

Watch for these patterns in user turns:

- "save this", "save that", "save your observations"
- "remember this", "remember that"
- "make a note", "save a note"
- Equivalent phrasings asking for persistent recall on the harness

Don't fire on:

- Normal observation capture (in-flow during conversation) — that goes to `<project>/_memories/observations/` regardless of harness.
- "Save the file" or other phrases about disk writes that aren't about memory.
- Project-canonical content that belongs in `_memories/` — write that to the unit store, not Codex memory. If the user clearly wants both (a workflow hint AND a project fact), do both: write the project fact to `_memories/observations/` first, then the workflow hint to Codex memory.

## Procedure

1. Identify what to save. If the user named specific content, use that. If not, summarize the most recent relevant context (one or two sentences) and confirm with the user before proceeding.
2. Write one ad hoc note to `~/.codex/memories/extensions/ad_hoc/notes/<timestamp>-<slug>.md`:
   - `<timestamp>` is UTC ISO-8601 compact form, e.g. `20260521T173801Z`
   - `<slug>` is a short kebab-case description, e.g. `core-codex-probe-observations`
3. Do not edit any existing Codex memory file or index. Codex's own memory system manages those.
4. If the content is project-canonical (a real observation about the project, not a workflow hint), also write a CORE observation in `<project>/_memories/observations/<YYYY-MM>/obs-<timestamp>-<slug>.md` so the project store has it too. The two writes are not duplicates — the Codex note is recall-shaped (workflow hint for future sessions), the CORE observation is project-shaped (graduates into units under the normal hygiene flow).
5. Acknowledge the save to the user in plain voice — name the path of the Codex note and any corresponding CORE observation.

## What lives in Codex memory

Per DC-86 — recall, not truth:

- Cross-session workflow lessons ("on this project, prefer X tool over Y")
- User preferences for assistant behavior ("don't ask before committing on the dev branch")
- Harness-specific empirical findings (adapter-relevant facts about Codex)
- Pointers to canonical project artifacts (PROJECT.md and unit-store locations)
- Short summaries of prior session outcomes useful as warm-start hints

## What does NOT live in Codex memory

- Project facts of record (those live in `PROJECT.md` and `_memories/`)
- Decision units, risk units, person units — canonical project content
- Anything the agent infers should be retired (anti-resurrection applies to harness recall too — if the user removed it from PROJECT.md, don't smuggle it into Codex memory)

## Cross-reference

This protocol implements the explicit-save half of the dual-write model documented in `_memories/dc-86-harness-local-memory-recall.md`. The autonomous-curation half lives in `protocols/data-storage.md` and writes to `<project>/_memories/`. The read side lives in `harnesses/codex.md §read-auto-memory`. The authority ordering that places harness-local recall at surface 4 lives in `protocols/data-storage.md §"Authority ordering"`.
