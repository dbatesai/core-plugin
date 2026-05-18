# CORE Scripts

The CORE skill is 100% inference-based markdown — no executable scripts ship with the skill itself. Scripts that support CORE are generated from these behavioral specifications and live outside the skill directory.

If you need to recreate a script, read the specification below and generate it. The spec describes purpose, inputs, outputs, and behavior — enough for any LLM to produce a correct implementation on any platform.

---

## post-compact-inject.sh

**Lives at:** `~/.claude/hooks/post-compact-inject.sh` (or equivalent hooks directory for your harness)

**Purpose:** After the harness compacts the conversation history, this hook re-injects the workspace's most critical operational context into the new context window. Without it, the DM loses workspace identity, active agenda, and synthesis state after compaction and must start cold.

**Trigger:** `PostCompact` hook event in harness settings.

**Output format:** JSON to stdout with the shape:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostCompact",
    "additionalContext": "<string injected into new context window>"
  }
}
```

**Behavior:**
1. Look for `workspace.json` in the current working directory. If not found, output a minimal JSON message saying no workspace is available and exit cleanly — do not fail.
2. If found, read `workspace_id`, `name`, and `data_path` from the pointer.
3. Read `PROJECT.md` at the project folder root. Extract:
   - §State — the one or two current-status sentences.
   - §Moves — top unchecked priorities (first ~5 items).
   - §Decisions & Risks — count of open risks; surface any flagged as high-impact or with a stale `last-reviewed` date.
4. Identify the most recently modified file in `<project>/_handoffs/` and include its filename only (do not read the body — handoffs are narrative, not authoritative state).
5. Assemble an `additionalContext` string that tells the DM: workspace name and ID, current state, top Moves, open-risk count (with any stale/high-impact items called out), and which handoff is most recent.
6. Output the JSON and exit 0.

**Guard:** If workspace.json is absent, exit 0 with a graceful message. Never error in a way that blocks the session.

---

## generate-swarm-analysis.py

**Lives at:** Project scripts directory (e.g., `~/Documents/Projects/CORE/.claude/scripts/`) — not part of the skill.

**Purpose:** Takes agent session logs from a swarm run and generates a self-contained interactive HTML visualization. Makes it easy to review agent reasoning chains, position changes, adversarial exchanges, and final convergence across all eight output fields.

**Usage:**
```bash
generate-swarm-analysis.py <session-log-directory> [--output <path>] [--open]
```

**Inputs:** A directory containing agent log files in markdown format (one per agent per session). Each log is structured around the eight-field output schema.

**Output:** A single `.html` file, fully self-contained — no external dependencies, opens in any browser.

**Visualization requirements:**
- Display each agent's contributions by round — follow one agent across rounds or compare all agents within a round.
- Highlight Persuasion Log and Mind Changes entries prominently — these are CORE's primary differentiators.
- Show Minority Views distinctly — never buried or collapsed by default.
- Make Confidence scores and round-to-round changes visible.
- Tone should reflect the adversarial nature: disagreement is signal, not noise.

**Guard:** If the input directory contains no recognizable agent logs, output a clear error. Do not generate an empty or misleading HTML file.
