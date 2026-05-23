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

Per `protocols/startup.md` §Phase 5:

- Time since last session — over a week, re-confirm priorities; over a month, treat as near-new.
- Time until next deadline — under two sessions of runway, escalate.
- Risks past `last_reviewed` thresholds — flag as stale.
- Assumptions past `last_validated` thresholds — flag for revalidation.
- External-source-derived claims past their staleness threshold — disclose and consider re-fetch.

If any of these escalate, lead with the escalation in readiness.

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
