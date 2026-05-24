---
name: orient
description: Thread-resumption skill — load project context via the retrieval ladder, run edit-detection, print a plain-voice readiness receipt, surface only the gaps that can't be resolved from durable artifacts
user-invocable: true
---

# `/orient`

You're orienting to an existing project. A resumed session should feel continuous, not like a cold start. Read what exists, reconstruct the context, surface the state in plain voice. Don't ask the user to catch you up until you've exhausted the durable artifacts.

This skill is a thin shell over the startup protocol in the sibling core skill. The full bootstrap flow is documented there — what to read, what NOT to read, the retrieval ladder, edit-detection. This skill calls out the user-invocable wrapper around that flow.

**Resolve the startup protocol from the path of this wrapper.** Take the absolute path you loaded this `SKILL.md` from, replace `/skills/orient/SKILL.md` with `/skills/core/protocols/startup.md`, and read that. Concretely:

- Loaded from `${CLAUDE_PLUGIN_ROOT}/skills/orient/SKILL.md` → read `${CLAUDE_PLUGIN_ROOT}/skills/core/protocols/startup.md`.
- Loaded from `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/orient/SKILL.md` → read `~/.codex/plugins/cache/<marketplace>/core/<version>/skills/core/protocols/startup.md`.

Don't construct the path against a guessed plugin base. The path you just loaded carries the resolution; perform the literal string replacement.

---

## Step 1 — Identify the workspace

Determine what you're orienting to:

1. Is there a `workspace.json` in the current directory? Read it.
2. Does `~/.core/index.json` have a workspace whose path matches the current directory? Use it.
3. Has `/core` already been invoked this session? You're already oriented — surface the current state and stop.
4. None of the above? Treat as a new workspace and run Phase 3B from the startup protocol (resolved per the path-replacement rule at the top of this file).

---

## Step 2 — Load context via the retrieval ladder

Don't read everything. Use the ladder.

- **Tier 0 (in-context).** The session-intent is whatever the user just said. If they said nothing yet, intent is "orient and tell me where we are."
- **Tier 1 (lexical).** Read `<project>/PROJECT.md` for the six-section view. Grep `<project>/_memories/` for session-intent topic terms. Load relevant active units.
- **Tier 2 (graph walk).** For each loaded unit, walk `supersedes` and `depends-on` edges one hop. Pull in connected context.
- **Tier 3 (semantic).** Only escalate if Tier 0–2 leave the user's question unanswered. Spawn `Explore` against the vault.

Also load:
- `~/.core/dm-profile.md` — cross-project identity.
- `~/.core/topics.md` — controlled vocabulary.
- `<project>/inbox.md` if it exists — raw pending items. When entries carry `mode: B` or `mode: C` frontmatter, they're pending review per the source-registration framework. Count them; the readiness receipt surfaces the count.
- `<project>/_sources/*.yaml` if the directory exists — the registered external sources for this project. Note the names and count for the readiness receipt.

**Do NOT read:**
- Session summaries in `<project>/_summaries/` (or the legacy `<project>/_handoffs/` if the rename hasn't happened yet). Narrative for the human reader. Facts worth keeping were already promoted to PROJECT.md or `_memories/` at session close. Re-reading summaries can resurrect user-deleted facts.
- Archive files (`PROJECT-ARCHIVE.md`, `IMPROVEMENT_LOG-ARCHIVE.md`, `_memories/archive/*`).
- Session logs in `<project>/_sessions/` unless investigating a specific historical question.

---

## Step 3 — Edit-detection sweep

Compare current file hashes against `~/.core/state-cache.json` for the files you read this turn. If hashes don't match, the user edited something between sessions:

- For unit files: the edit IS the new truth. Update the state cache, propagate any frontmatter implications, narrate what changed.
- For PROJECT.md: the edit is the user's authorship asserting itself. Propagate back to the source units (frontmatter updates, `status: retired` for removed facts). Anti-resurrection fires for removals.

If you find an edit, surface it in the readiness receipt before the agenda.

---

## Step 4 — Apply elapsed-time signals

Per `protocols/startup.md` §"Elapsed-time signals":

- Time since last session — over a week, re-confirm priorities; over a month, treat as near-new.
- Time until next deadline — under two sessions of runway, escalate.
- Risks past `last_reviewed` thresholds — flag as stale.
- Assumptions past `last_validated` thresholds — flag for revalidation.
- External-source-derived claims past their staleness threshold — disclose and consider re-fetch.
- **Open-question past `by-when` (DC-85 §2).** Walk active open-question units. Surface ones where `type: open-question`, `status: active`, and the `by-when` ISO date is in the past. Plain voice: *"One open question past its by-when: oq-michelle-design-review expected 5/22 — six days ago."* The absence is the signal; surface it before the user has to ask.
- **Recent hygiene-log signals (DC-85 Phase 1b).** Read `<project>/_sessions/<most-recent-date>/hygiene-log.jsonl` if present. Surface anything load-bearing in plain voice without piling on:
  - `demote-moves-large-batch` from the last 1-2 sessions → narrate "Last `demote-moves` ran on N candidates (threshold M); criteria may be tightening / loosening — worth a glance next /process-memory."
  - `project-md-over-cap` events that persist across sessions → narrate "PROJECT.md is stuck over the 70KB hard cap; §State / §Notes are the dominant sections — Phase 1c handles that."
  - Skip when the log is absent (common on fresh workspaces) or shows clean steady-state.

If any of these escalate, lead with the escalation in readiness.

---

## Step 4.5 — Hot-section synthesis pass (DC-85 Phase 1a)

The hot section is the 5-7 line surface atop PROJECT.md that names what matters right now. Refresh it conditionally — only when candidate ranking has shifted meaningfully since last synthesis, or when this session's intent diverges from what the existing hot section addresses.

**When to refresh** (any one suffices):

- Existing hot section is missing (project predates DC-85 Phase 1a, or it was cleared).
- Existing hot section is older than 24 hours (the candidates underneath have likely shifted).
- Session-intent topics don't overlap with the topics the existing hot section addresses (priority ranking will shift under the new intent).
- Elapsed-time signals (Step 4) escalated something the existing hot section doesn't mention.

**When to skip:** the existing hot section is fresh, the session intent matches its framing, and nothing escalated. Skip silently — don't refresh just to refresh.

**How to refresh:**

1. Call `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/hot-section.mjs candidates <project> --top 12 --session-topic <topic1> --session-topic <topic2>...` with the session-intent topics from Step 2. Read the candidate list.
2. Compose 5-7 lines of plain prose blending two inputs: the priority candidates (stable structural heft) and your session-level awareness (current work, recent reconciliations, forward moves). Spec §1.1 cap: usually 1-3 items, no bold-lead-in paragraphs unless the items genuinely need scannable headers.
3. Call `node ${CLAUDE_PLUGIN_ROOT}/skills/core/scripts/hot-section.mjs apply <project> --text "<composed prose>"` to land the section atop PROJECT.md.
4. Narrate the refresh in one sentence as part of readiness — *"Refreshed the hot section: Phase 1a is mid-flight and DC-88 just reconciled."*

The 500-token enforcement is Phase 1b; for Phase 1a, the agent self-disciplines on length.

---

## Step 5 — Print readiness in plain voice

The receipt is conversational, not a form. Target shape:

> *"Picking up on the [project name]. Last session closed Wednesday with the routing rework merged. PROJECT.md says we're mid-migration: Phase 1 done, Phase 2 in progress. Top of §Moves is the auth-rewrite review. One stale risk worth flagging: R-3 last reviewed three weeks ago. Ready."*

What's in the receipt:

- Workspace name (plain language, not the ID).
- Current state from §State — one or two sentences, not a recap of every section.
- Active risks count + top one or two by impact.
- Elapsed-time escalations (only if any tripped).
- Top 3 §Moves priorities as the agenda.
- Anything edit-detection caught (entries, not counts).
- The auto-compaction line if startup's hygiene check moved anything (entries, not counts).
- Source-registration signals when they're worth mentioning: pending Mode B/C blocks in inbox.md (count plus a one-line nudge — *"three pending observations in the inbox waiting on review"*), or observations citing a `source:` not in `<project>/_sources/` (drift signal — name the source). Skip silently when the inbox is empty and no drift surfaced.
- One-line readiness statement.

What's NOT in the receipt:

- Session summary content (you didn't read it — see Step 2).
- Auto-memory contents (scratch cache, not authoritative).
- Section-by-section recap.
- Anything that sounds like a coding assistant compiled it.

---

## Step 6 — Only ask what you still don't know

After the receipt, if there are genuine gaps — facts that couldn't be resolved from any durable artifact — ask them now. With a hypothesis when you have one.

Don't ask:

- "What were we working on?" — you just read it.
- "What would you like to do today?" — the agenda tells you.
- "Can you catch me up?" — that's exactly what orient prevents.

Do ask, when warranted:

- "PROJECT.md flags the X decision as deferred pending your call. Have you decided?"
- "Two priorities at the top of §Moves. Continue with the v2 build or pivot to the stale R-5 risk first?"
- "The session-intent topic 'auto-creation rules' didn't surface a unit at Tier 1 or Tier 2 — has that been written yet, or is it still pending?"

---

## Step 7 — Identity activation

If `/core` hasn't already been invoked this session and you're in a CORE workspace:

- Read `~/.core/dm-profile.md` if you haven't already.
- You're yourself — same name as last session, same personality, same relationship with the user.

The identity persists for the rest of the session. Don't drop back to generic-assistant mode after the receipt lands.
