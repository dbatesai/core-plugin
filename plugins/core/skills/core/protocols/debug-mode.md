# Debug Mode

## Voice

Plain person voice — same standard as SKILL.md §Voice.

---

Read this when debug mode is on — either the user said "debug on," you self-triggered it during a self-unblock, or a validation run is firing.

Debug mode is a toggle-able logger that captures every storage and retrieval operation in structured form for forensic analysis. It's verbose. Don't leave it on by default.

## Triggers

Debug mode turns on when:

- The user says "debug on" (Mode C explicit).
- You're self-unblocking on a retrieval failure and forensic visibility helps. You can flip debug on yourself, but narrate it: *"Turning debug on to capture what's happening on this retrieval."*
- A validation run fires (`protocols/validation.md`). Auto-on for the duration of the run.

Debug mode turns off when:

- The user says "debug off."
- The session ends (debug state doesn't persist across sessions).
- The triggering operation completes (for validation-triggered runs).

## What gets logged

**Debug augments the always-on retrieval log.** Every Tier 1+ retrieval event already writes a base log line to `<project>/_sessions/<YYYY-MM-DD>/retrieval-log.jsonl` regardless of debug state — that runs continuously and feeds `analyze-retrieval-quality.mjs`. Debug mode adds verbose diagnostic fields (full candidate set per tier, scores discarded, why a tier was judged insufficient) inline on the same per-retrieval write. The base log stays in place; debug enriches.

Six categories of operation:

- **Retrievals** — query, tier reached, candidate set (top N + scores), the chosen subset, why those were chosen.
- **Unit writes** — id, frontmatter at write time, edges, body summary (first 200 chars), justification for the write (which mode, which trigger).
- **Renders** — file path, sections written, diff summary, what triggered the render.
- **Hygiene operations** — verb (archive/retire/cold-store), units affected, criteria that fired, reversal path.
- **Graduation decisions** — observation source(s), unit produced, edges added, rationale for graduating (or not graduating).
- **Analysis-protocol invocations** — briefing, team composition, phase transitions, deep audit verdict.

Each event is one JSON object on its own line.

## Session ID source

When debug mode turns on, the agent picks a session-id once and uses it for the rest of the session. Resolution order:

1. **Claude Code environment variable** if available — `CLAUDE_SESSION_ID` is the harness-provided session UUID (the same one that names the directory under `~/.claude/projects/<hash>/<session-id>/`). When set, use it verbatim.
2. **Fallback** — generate at debug-on time: `date +%Y%m%d-%H%M%S-$$`. Format: `<date>-<time>-<pid>` (e.g., `20260517-1432-91245`). Unique enough for single-machine single-user use; collision probability negligible.
3. **Persist for the session** — write the chosen session-id to `~/.core/debug/.current-session-id` (single-file, overwritten on each debug-on). When the agent self-flips debug off and back on within the same session, it reads this file first to keep the same id.

The agent narrates the choice: *"Debug on. Session id: 20260517-1432-91245 (fallback). Logs at `~/.core/debug/20260517-1432-91245.jsonl`."*

Concurrent sessions across machines would collide on date-time-pid only if both started in the same second on hosts with the same PID — vanishingly unlikely for the single-user-cross-machine case. Concurrent sessions on the same machine get different PIDs.

## Format

JSONL at `~/.core/debug/<session-id>.jsonl`. One event per line. Schema per event:

```json
{
  "ts": "2026-05-17T14:32:00Z",
  "category": "retrieval",
  "session_id": "<id>",
  "details": {
    "query": "...",
    "tier_reached": 1,
    "candidates": ["dc-12-routing-rewrite", "dc-09-router-design-review", ...],
    "scores": {"dc-12-routing-rewrite": 0.87, "dc-09-router-design-review": 0.52},
    "chosen": ["dc-12-routing-rewrite"]
  }
}
```

At session end, the debug logger writes a markdown summary alongside the JSONL — high-level counts per category, anomalies detected, retrieval-tier distribution. Path: `~/.core/debug/<session-id>-summary.md`.

## Lifecycle

- **Per-session by default.** New session, new JSONL.
- **Hygiene managed.** After 30 days, debug logs move to `~/.core/debug/archive/`. After 90 days, they cold-store.
- **Validation runs.** Auto-on for the duration; auto-off when validation completes. Logs land in the same per-session JSONL.

## Anomaly classes

The logger flags anomalies inline. Six classes worth watching:

| Anomaly | What it means |
|---|---|
| Unit written but retrieval miss same query 5 min later | Edit-detection didn't pick up the write, or the write didn't include the topic anchors that would surface the unit on the next query |
| Missing inverse edge | An edge was written but the target's inverse wasn't. Reconciliation didn't fire. |
| Retired fact re-appearing in PROJECT.md render | Anti-resurrection failure. The retired unit's body is leaking into a re-render. |
| Priority function returning out-of-range value | The priority function returned a value > 1.0 or < 0.0. The function has a bug or a pin is mis-set. |
| Tier 3 fired on a query Tier 1 should have caught | Wasted tokens. Either the topic anchors are wrong or the priority function under-weights alignment. |
| Hygiene operation reversed within same session | You archived a unit and un-archived it in the same session. Either the trigger fired wrong or the reversal trigger fired wrong. |

Anomalies are flagged in the per-event JSONL with `"anomaly": "<class>"`. The session summary tallies them.

## Reading the debug log

Useful bash one-liners:

```
# All retrievals in this session
jq -c 'select(.category == "retrieval")' ~/.core/debug/<session-id>.jsonl

# All anomalies
jq -c 'select(.details.anomaly != null)' ~/.core/debug/<session-id>.jsonl

# Tier distribution
jq -r 'select(.category == "retrieval") | .details.tier_reached' ~/.core/debug/<session-id>.jsonl | sort | uniq -c

# Unit writes by mode
jq -r 'select(.category == "unit_write") | .details.mode' ~/.core/debug/<session-id>.jsonl | sort | uniq -c
```

When you're self-unblocking and you've turned debug on, narrate what you find: *"Debug shows the unit got written but Tier 1 isn't finding it — the references-topic field is missing 'memory-hygiene' even though the body mentions it. Adding the tag now."*

