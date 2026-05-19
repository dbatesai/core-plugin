---
name: process-memory
description: The 30-minute memory-processing loop body. Routine, autonomous, never asks the user. Pulls inbox, walks observations for graduation, regenerates indexes, checks file caps, diff-appends to the rolling handoff, queues user-gated decisions. Dispatches a background Agent so the user's session stays unblocked. Runs in-session every 30 min via `/loop`; can also be invoked manually for a forced pass.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
---

# `/process-memory`

You're running the memory-processing pass. This is the routine, mechanical work that keeps the unit store, indexes, and rolling handoff current in real time — so `/finalize` doesn't have to do it all at session close, and `/orient` doesn't find a stale architecture next time.

**Core rule: never ask the user anything.** Decisions that need a judgment call land in `<project>/_memories/_loop-queue.md` for review at `/finalize` or `/orient`. The user invoked the loop precisely to be uninvolved.

The pass runs as a foreground dispatcher that spawns a background `Agent` for the actual work. The dispatcher is cheap (under 5 seconds) and returns control to the user immediately. The background agent does the work in parallel — the user keeps moving.

---

## Step 1 — Cheap-check, decide whether to dispatch

Read `<project>/_memories/_loop-state.json` if it exists. If it doesn't, this is the first pass — proceed to dispatch.

Compute `now - last_run`. If under 5 minutes, exit silently (some other invocation just fired; debounce). If over 25 minutes since `last_run`, definitely dispatch.

For the in-between range (5-25 min), check whether anything has changed since `last_run`:

```bash
# All checks run from the project root.
find _memories/observations -type f -newer <last_run_ts> 2>/dev/null | head -1
test -s inbox.md  # non-empty inbox
find _memories -maxdepth 1 -name "*.md" -newer <last_run_ts> 2>/dev/null | head -1
```

If none of those report change, exit cheaply — write a heartbeat entry to `<project>/autonomous-run-log.md` and update `_loop-state.json` with the current timestamp. Total cost: a few hundred tokens. No background agent dispatched.

If anything changed (or it's been >25 min regardless), proceed to Step 2.

---

## Step 2 — Acquire the loop-lock

Check for `<project>/_memories/.loop-lock`. If it exists AND was written less than 5 minutes ago, another pass is in flight — exit silently. If it exists but is stale (>5 min old), a prior pass crashed; remove it and continue.

Write `<project>/_memories/.loop-lock` with the current timestamp and your session id. The background agent will release this lock when it finishes (or it ages out on the next pass).

---

## Step 3 — Dispatch the background Agent

Spawn an `Agent` with `run_in_background: true`. The prompt embeds the workspace path and the work spec below.

Narrate one line to the user before dispatch: *"Memory-processing pass dispatched — running in the background."* If the user is mid-conversation, this lands as a single-sentence aside before you continue with their actual question.

The background agent's prompt (template):

```
You're running a single memory-processing pass for the workspace at <project-path>.

Constraints:
- Run quietly. No questions to the user. No back-and-forth. Decisions that need judgment go to _memories/_loop-queue.md.
- Target wall clock: under 90 seconds. Skip anything that would take longer; queue it instead.
- Release the loop-lock at _memories/.loop-lock before exiting.

Work to do (in order — skip steps where there's nothing to process):

1. Read _loop-state.json to know what was processed last time.

2. Pull inbox. If <project>/inbox.md is non-empty, classify each entry — promote to observations under _memories/observations/<YYYY-MM>/, surface as user-review items to _loop-queue.md, or noise-filter (delete with a narration line in the run-log). Truncate inbox.md to empty when done.

3. Walk new observations. For each file in _memories/observations/<YYYY-MM>/ with mtime newer than _loop-state.json's last_run, run the graduation criteria from protocols/data-storage.md §Graduation. Clear-cut cases: graduate to units (write the unit file, update auto-edges). Borderline cases: write an entry to _loop-queue.md describing the observation and the call to make.

4. Cheap INDEX-drift check. List _memories/dc-*.md and compare against _memories/INDEX-decisions.md entries. If counts or ids don't match, regenerate via ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/generate-decisions-index.py. Same pattern for INDEX-risks.md against _memories/risk-*.md.

5. File-cap check. wc -c on PROJECT.md and IMPROVEMENT_LOG.md. If either is over 80% of the Read tool cap (~80% of ~83KB = ~66KB), write an entry to _loop-queue.md suggesting compaction at next /finalize. Do not auto-compact.

6. Handoff diff-append. Find the latest _handoffs/handoff-<YYYY-MM-DD><letter>.md. If none exists for today, create the stub per protocols/startup.md long-sessions section. Append a "## Loop pass <ISO timestamp>" block summarizing this pass's outputs (units graduated, indexes regenerated, queue items added). One short paragraph — not a recap.

7. Update _loop-state.json: bump last_run, increment passes_this_session, record last_pass_outputs.

8. Append one line to autonomous-run-log.md: [<ts>] PROCESS-MEMORY — <one-line summary>.

9. Remove _memories/.loop-lock.

Output one short line: "Done — <summary>." That's all the parent needs to narrate when you complete.
```

Pass the dispatched agent's id to the user-facing narration if your harness shows it; otherwise just narrate "dispatched."

---

## Step 4 — Return immediately

Don't wait for the background agent. Once the dispatch is made, the parent session is done with this fire. /loop will schedule the next 30-min wakeup automatically.

When the background agent completes, the harness notifies the parent. On the parent's next turn, read the tail of `<project>/autonomous-run-log.md` and narrate a one-liner if anything notable landed:

> *"Memory-processing finished — graduated 2 observations, regenerated decision index, queued 1 archive proposal."*

If nothing notable happened (idle pass), say nothing.

---

## Failure modes

- **Background agent crashes silently.** The loop-lock ages out after 5 minutes; the next /loop fire will detect the stale lock, remove it, and proceed. State stays consistent because `_loop-state.json` is only updated when a pass completes.
- **Two passes overlap (long pass + short interval).** Loop-lock prevents concurrent writes. Second pass exits cheaply.
- **PROJECT.md user-edit collision.** The pass is read-only on PROJECT.md — re-render lives in `/finalize`. No collision risk.
- **`Agent` tool unavailable.** Fallback: run the work spec foreground in the current session. Narrate "Background dispatch unavailable — running pass synchronously, ~60-90 sec." User waits but the work still gets done.

---

## When the user invokes `/process-memory` manually

Same flow. Manual invocation is identical to a loop-fired pass. Used for one-off forced runs (e.g., user just dumped a lot into inbox.md and wants it processed without waiting for the next 30-min fire).
