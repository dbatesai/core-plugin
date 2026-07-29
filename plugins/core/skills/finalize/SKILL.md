---
name: finalize
description: Close the session — capture what must survive, write the resume summary, certify this exact session's close receipt
user-invocable: true
---

# `/finalize`

You're closing the session. Project state has been updating continuously — observations written as the user talks, units graduated as patterns emerge, PROJECT.md re-rendered when something meaningful changed. Finalize is the bounded close: preserve what this session produced that isn't yet durable, write the resume summary, certify the exact-session receipt. Nothing else.

Everything the old close did beyond that has a different home: memory maintenance runs in `/process-memory`, analytics in `/metrics`, priority recentering in `/refocus`, plugin-development checks in the test suite. Do not run those here. A close that reruns maintenance "to be safe" is a defect, not diligence.

**Script path resolution.** Commands invoke scripts as `${CORE_ROOT}/skills/core/scripts/<script>.mjs`. `${CLAUDE_PLUGIN_ROOT}` is not reliably injected into agent Bash tool calls, so resolve `CORE_ROOT` the same way startup does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/finalize/SKILL.md`. Reuse the session's already-resolved value when you have it. If you cannot resolve a concrete root, skip the affected script step and say so plainly — never run `node` against a guessed base.

**Kill switch.** `CORE_AUTO_CLOSE=0` disables the automatic close hook, not this command — the user typed `/finalize`, so run it. But while it's set, don't perform unattended autonomous writes beyond what this skill names.

---

## Step 1 — Begin: lock and owed-ops marker

```bash
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs begin <project> --session <session-id-if-known> \
  --ops material-capture,render-project-md,session-summary,memory-refresh
```

If `begin` refuses ("lock held"), another close is running — stop and say so. Record each op below as you complete it (`close-pass.mjs record <project> --op <op> --status done|skipped|failed`); the per-op trail is what makes a crashed close recoverable.

## Step 2 — Material capture (from the active context, once)

Use the context you already have. Do not re-read the transcript from the top; do not scan the store for hypothetical omissions. Ask one question: **what became true this session that isn't yet durable?**

- Decisions made, corrected, or reversed → a unit each (or update the existing unit), with edges.
- Conclusions and corrections that change what the next session should believe → unit or observation.
- Open work and obligations → §Moves reflects next-session priorities (edit-gated, below).
- Explicit user requests from this session → each one traceable to a task, unit, or a named §Moves bullet.

When in doubt about one item, write the unit — the cost asymmetry favors capture. What you must NOT do is turn this into a store-wide sweep; `/process-memory` owns that.

Record op `material-capture`.

## Step 3 — Project render, only when it's owed

Run the edit gate first — every PROJECT.md write is edit-gated, no exceptions:

```bash
node ${CORE_ROOT}/skills/core/scripts/lifecycle-detect.mjs <project> --json
```

`pending-edit` → the user's edit wins: propagate it to source units, fire anti-resurrection for removals, and do not render over it this pass. `malformed` / `no-baseline` (unsafe) / `missing` / `read-only` → surface plainly, don't write. Only `clean` / `generated-only` (or safe first write) proceeds.

Render only when this session materially changed §State or §Moves — a session that changed neither records `render-project-md` as `skipped`. When it fires interactively, show the draft and let the user accept or edit (their edits become ground truth and propagate back to units). Then refresh the hot section (`hot-section.mjs candidates` → compose 5–7 plain lines → `hot-section.mjs apply --file`), skipping when the existing one still describes current truth.

Record op `render-project-md`.

## Step 4 — Resume summary (bounded)

Write `<project>/_summaries/summary-<YYYY-MM-DD>.md` (letter suffix if taken). At most ~400 words. Compose from the active context and the units written this session — never from prior summaries. Shape:

```markdown
# Session Summary — <YYYY-MM-DD>

## Resume here
[2–3 lines: start here, in this order.]

## What was done
## Decisions made        [unit ids; "None" is a fine answer]
## Open work             [consistent with §Moves]
## Open questions        [waiting on the user]
## Honest assessment     [one paragraph — what surprised us, what degraded]
```

Scale honestly: a trivial session gets one-liners, not padding. Summaries are write-only at bootstrap.

Record op `session-summary`.

## Step 5 — Harness memory refresh (cheap, Claude Code only)

On Claude Code: run `node ${CORE_ROOT}/skills/core/scripts/generate-memory-index.mjs <project>/_memories --memory-md ~/.claude/projects/<mapped-cwd>/memory/MEMORY.md --top 15`, add this session's one-line entry to "Recent activity", drop pointers to anything retired, keep MEMORY.md under 200 lines. Then write the visibility canary:

```bash
node "${CORE_ROOT}/skills/core/scripts/write-visibility-canary.mjs" --workspace-id <id> --session-id "${CLAUDE_CODE_SESSION_ID:-}" 2>/dev/null || true
```

Passing this session's id is what lets next session's probe tell a real echo from this session re-reading a token it wrote itself.

On Codex: no harness-memory writes (explicit-save only) — confirm the facts are in `_memories/` and the summary from Step 4, and say so in one line.

Record op `memory-refresh`.

## Step 6 — Certify and finish

Certify this exact session's close receipt — this is what stops the SessionEnd hook from running a second close over a session you just closed by hand:

```bash
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs certify <project> --summary <summary-path>
```

`certify` resolves the current session's native id from the newest project-bound transcript and writes the `closed` receipt. If it prints `UNRESOLVED`, pass `--session <id>` explicitly if you know it; otherwise say so — the automatic close will record the session's lifecycle evidence instead, and nothing is lost.

Then finish the marker and release the lock:

```bash
node ${CORE_ROOT}/skills/core/scripts/close-pass.mjs finish <project> --session <session-id>
```

Close in plain voice, naming anything skipped or failed:

> *"Session closed. Summary at `_summaries/summary-<date>.md`. PROJECT.md render skipped — no material §State/§Moves change. Receipt certified for this session."*

---

## What moved out, and where it lives

| Old close work | Where it runs now |
|---|---|
| Index regen, ghost cleanup, cap checks, decoration, demotion, compaction, validation, bitemporal stamps, boundary audit | `/process-memory` |
| Back-fill of auto-closed sessions' memory processing | `/process-memory` (backfill-memory list/mark) |
| Turn classification, rollups, detectors, calibration, retrieval-quality/skip analysis, capability drift | `/metrics` |
| Session perspective critique (overconfidence, smuggling, contradiction) | `/refocus` |
| Orphan detection, manifest checks, doc-reference checks | test suite / release review |

The automatic close (SessionEnd) is deterministic and zero-model: it validates the registered workspace, normalizes the native session id, skips an already-certified session, and records lifecycle evidence (`recorded`) with no writes to PROJECT.md or units. Its receipts are recovery evidence, not canonical project truth.
