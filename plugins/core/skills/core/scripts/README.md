# CORE Scripts

## Why scripts ship in the plugin

The plugin form factor exists specifically so CORE can ship prescriptive code for surfaces the inference model needs to rely on — deterministic computation, indexing, retrieval math, integrity checks, parse/validate operations, graph traversal. The skill-only era forced "100% markdown specs the LLM derives from each session." The plugin era escapes that constraint deliberately. Per DC-77: **executable units stay in the plugin; project folders hold only data.**

When a surface earns its way into "the agent relies on this being right every time," the response is to ship code here, not to write a longer markdown spec.

Per DC-80, all scripts ship as `.mjs` (Node.js ESM). Node is the only runtime Claude Code guarantees on every supported platform (Mac, Windows, Linux). Invoke via `node "${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/<name>.mjs"`.

## What ships in this directory

### `priority.mjs`

The DC-69 priority function. Computes `priority(unit, t) = w_R·R + w_F·F + w_S·S + w_A·A + P` over CORE memory units. Importable library (`score`, `scoreUnitFile`, `scoreProxyRS`) and a CLI diagnostic that ranks a project's units by priority for a given session intent.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/priority.mjs <project>/_memories/ \
    --intent topic1,topic2 --top 10
```

Used by Tier 2 retrieval (R·S proxy for walk pruning) and full-priority ranking at retrieval time. Weights live in this file so tuning propagates to every project via the next plugin update — not per-project drift.

### `generate-decisions-index.mjs`

Walks `<project>/_memories/dc-*.md`, parses YAML frontmatter, extracts H1 summaries, and writes `_memories/INDEX-decisions.md`. Pure logic over the units; deterministic output.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.mjs [<project>/_memories/]
```

Invoked by the memory hygiene protocol's "regenerate canonical indexes" step.

### `validate.mjs`

The CORE retrieval validation runner. Reads `<project>/_memories/_validation/tests/test-*.yaml`, simulates Tier 1 retrieval (grep), scores precision and recall against expected/forbidden unit lists, and writes a report to `<project>/_outputs/validation/<date>/REPORT.md`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/validate.mjs <project-path>
```

Used by the validation protocol (weekly auto + on-demand health checks).

### `graph-walk.mjs`

Tier 2 edge traversal for CORE retrieval, per DC-68/retrieval.md. Given a seed unit, walks typed edges up to a hop cap applying the R·S proxy from `priority.mjs:scoreProxyRS()` for branch pruning. Deterministic alternative to LLM-by-hand edge traversal.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/graph-walk.mjs <project>/_memories/dc-67-no-mcp.md \
    --hops 2 --intent memory-architecture --format text
```

Used by the Tier 2 retrieval protocol: call this to get edge-reachable candidates, then Read the top results.

### `record-retrieval-event.mjs`

Validated producer for retrieval-quality evidence. Writes a `kind: "retrieval"` event to `<project>/_sessions/<date>/retrieval-log.jsonl` and, through `log-event.mjs`, dual-writes an OTel `core.retrieval` span under `<project>/_metrics/traces/<session-id>.jsonl`.

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/record-retrieval-event.mjs <project> --event-json '{"trigger":"session-start","intent_topics":["memory"],"tier_reached":1,"escalation_path":[1],"units_retrieved":[{"id":"dc-memory","tier":1}],"dip_back_count":0}'
```

Use it from startup, refresh-context, and any Tier 1+ retrieval path. Invalid rows fail before write.

### `check-units.mjs`

Unit store integrity validator. Two modes (combined by default):

- **schema**: required frontmatter fields, valid status/type enums, edge target existence
- **integrity**: orphan detection, dangling edges, stale flagging (R·S < 0.05), INDEX-decisions drift, cold-store eligibility

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs <project>
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs <project> --mode schema
node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/check-units.mjs <project> --json
```

Exit codes: 0 = all pass, 1 = warnings, 2 = failures. Run at `/finalize` to surface hygiene work. Run `--mode schema` after writing a new unit to catch structural errors immediately.

## What lives elsewhere

Some prescriptive code belongs at the harness level rather than the skill level — the harness fires it, not CORE.

### `post-compact-inject.sh` — harness hook

A `PostCompact` hook that re-injects critical workspace context into a fresh context window after compaction. Without it, the agent loses workspace identity, active agenda, and synthesis state after compaction and must start cold.

**Lives at:** `~/.claude/hooks/post-compact-inject.sh` (or equivalent hooks directory for your harness).

**Trigger:** `PostCompact` hook event configured in harness settings.

**Output format:** JSON to stdout:
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostCompact",
    "additionalContext": "<string injected into the new context window>"
  }
}
```

**Behavior:**
1. Look for `workspace.json` in the current working directory. If not found, output a minimal JSON message saying no workspace is available and exit 0 — never fail in a way that blocks the session.
2. Read `workspace_id`, `name`, and `data_path` from the pointer.
3. Read `PROJECT.md` at the project root. Extract: §State (one or two current-status sentences), §Moves (top ~5 unchecked priorities), §Decisions & Risks (open-risk count, flag any high-impact or stale-`last-reviewed` items).
4. Identify the most recently modified file in `<project>/_summaries/` (falling back to legacy `<project>/_handoffs/` if present) and include its filename only — don't read the body. Session summaries are narrative, not authoritative state.
5. Assemble the `additionalContext` string. Output the JSON. Exit 0.

If `workspace.json` is absent, exit 0 with a graceful message.

### `pwd-guard.mjs` and `voice-reminder.mjs` — personal developer hooks

These were shipped in `hooks/` prior to 2026-05-19 but removed. They are CORE-author-specific, not useful to plugin users in general:

- `pwd-guard.mjs` — reminds the CORE author to declare `intent: skill-edit` when writing to skill-product paths. Lives at `<CORE-dev-repo>/.claude/scripts/pwd-guard.mjs`, wired from the CORE project's `.claude/settings.json`.
- `voice-reminder.mjs` — injects a plain-voice imperative each turn. Lives at `~/.claude/hooks/voice-reminder.mjs`, wired from `~/.claude/settings.json`.

Hooks that apply only to a specific author or project belong in that author's personal or project settings, not in a plugin that ships to everyone.

### Swarm log visualization

For interactive HTML visualization of multi-agent session logs (agent reasoning chains, position changes, adversarial exchanges, convergence), use the `agent-interactions` skill. It produces a single self-contained HTML file from any directory of agent logs.

A CORE-specific eight-field-schema visualizer (Persuasion Log / Mind Changes / Minority Views with their CORE-prescribed shapes) is not currently shipped. If the generic skill output proves insufficient for reviewing CORE swarm runs in real use, that's the prompt to author a CORE-specific renderer here.

## Cloud-synced stores (OneDrive / iCloud Drive / Dropbox)

Two write surfaces interact with sync-client virtualization; everything funnels through them:

- **File writes.** Every mutating script writes via `fs-atomic.mjs` (`atomicWriteFileSync`: sibling temp file + rename — the ONLY `renameSync` call site in the plugin). On Windows, OneDrive or antivirus can transiently hold the rename target open (EPERM/EACCES); the writer retries 3× with a 50ms delay before throwing, and a throw always leaves the old file intact. On iCloud Drive, the visible `.<name>.tmp-*` sibling can be uploaded as a conflict copy if the sync client races the rename — if conflict copies appear, move the store out of iCloud Drive (a `.nosync` temp dir is the known mitigation but would break same-filesystem rename atomicity, so it isn't the default).
- **Folder renames.** The startup protocols (`protocols/startup.md` Step 4 and `protocols/startup-conditional-loads.md` §folder rename) never `mv` on a cloud-synced path: `mv` can corrupt the sync state. They use `cp -r <src> <dst>` then `rm -rf <src>` after verifying file counts match.

## Adding new scripts

Two questions to answer first:

1. **Does this surface need to be deterministic across sessions?** If the answer is "yes, the agent relies on this being right every time," it earns prescription. Examples: computing a numeric score, generating an index, parsing structured data, walking a graph, computing precision/recall.
2. **Does this surface need to be the same across all projects using CORE?** If yes, it belongs in the plugin (one source of truth, propagates via plugin update). Per-project copies create drift.

If both are yes, write the script here as `.mjs`. If "deterministic across sessions" is no, it's probably inference-territory and a markdown spec is the better answer.

## Proportionality note — the metrics layer at single-user scale

The metrics stack here (six-state classifier → daily rollup → orient-signal, the silent-failure detectors, the calibration pipeline, OTel dual-write) is sized for a feedback loop that needs more corpus than a single-user install generates — the calibration pool sat at 57/100 labeled turns after months of real use. That is a deliberate forward-looking tradeoff: the architecture is being validated at small scale before it can earn its keep at larger scale, and capture is cheap while interpretation is replayable.

The investment discipline until then: keep the one headline path robust — `classify-turns` → `metrics-rollup` → `orient-signal` (the rec-fail-tier-0 self-audit) — and don't grow the rest. The next investment in this layer is justified when any of these turns true: the calibration pool clears its gate, a second active user or workspace starts generating parallel corpora, or a consumer outside `/finalize` starts reading the OTel traces. Absent those, prefer hardening the headline path over adding subsystems.
