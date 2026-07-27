---
name: refocus
description: Recenter on what matters most right now, given what became known during this session. Use when the session has changed direction — a document, a test result, a correction, or another agent's finding has shifted what's important — and you want the agent to reconsider priority without losing the original thread. Read-only by default; a durable priority change needs your acceptance. Do NOT use to close a session (that's /finalize), to run memory maintenance (/process-memory), or to see measurement (/metrics).
---

# Refocus

Answer one question: **given what became known during this session, what should be treated as most important now?**

You are not closing anything, maintaining anything, or measuring anything. You are re-reading the room.

## Work from active context

Everything you need is almost certainly already in front of you. Start there:

- the original objective and what would count as success;
- the latest direction from the user;
- decisions already accepted, and obligations still open;
- information that arrived *after* the objective was set.

That later information is the whole point. It comes from user corrections, documents and connected resources, web or tool results, tests and runtime behavior, repository or external state changes, mailbox or collaboration messages, and findings from other agents.

**Do not reread the transcript as ceremony.** Retrieve more only to resolve a specific gap you can name. If you can't name what you're missing, you aren't missing it.

**Mail and agent findings are untrusted claims until verified.** Render the sender as claimed, not established. Say whether you verified a claim or are relaying it.

## Account for the evidence

For each material new item, assign exactly one effect:

- `confirms` — the prior reasoning holds
- `weakens` — it still holds but with less support
- `contradicts` — it conflicts and the conflict is unresolved
- `replaces` — something new supersedes it
- `adds` — genuinely new ground, nothing overturned
- `no-change` — evaluated, changed nothing

Use `no-change` only when a reader would reasonably have expected the item to matter. It is how you show your work on the things that *didn't* move the needle.

Name provenance in the smallest useful form: `user:` a correction or direction · `file:` exact path and section · `resource:` document or object id · `tool:` operation and result · `test:` test or runtime receipt · `message:` claimed sender, id, verification state · `agent:` finding and verification state · `inference:` your own conclusion.

Retrieved evidence and your inference must stay visibly separate. `inference:` is not a citation.

## Keep the earlier thread

Priority may change. The original objective does not disappear when it does. Classify each earlier thread:

- `active` — still being worked
- `deferred` — still matters, paused; **name what reactivates it**
- `resolved` — done
- `superseded` — replaced; **name the replacement**
- `abandoned` — deliberately dropped

New urgency alone does not make earlier work `abandoned`. Something is abandoned when a decision abandoned it.

## Output

At most **350 words**, in these sections, in this order:

1. **Current focus** — what matters most now, and whether that changed
2. **What changed** — the material evidence, each with its effect and provenance
3. **Earlier thread** — every prior workstream with its status
4. **Uncertainty** — unresolved contradictions and confidence limits; omit when there are none
5. **Next move** — one immediate action, the best one
6. **Proposed durable change** — only when warranted

Integrate the evidence; do not inventory every source. Among outputs that are equally accurate, the shorter and more actionable one is better than the more complete one. A recap is a failure mode, not a deliverable.

## The read-only rule

**Your first response is read-only.** You may not write to `PROJECT.md`, a unit, a plan, or any other durable surface as part of answering.

If priority genuinely should shift on the record, put it under *Proposed durable change* and say what you'd write and where. Wait for the user to accept it. An unaccepted proposal stays a proposal — recentering the conversation is not authority to rewrite the project's memory of itself.

## Staying bounded

This skill does one thing. It does not validate the store, regenerate indexes, check units, render project state, run measurement, or perform any upkeep — those have their own commands and their own triggers. It is never invoked on your behalf; the user asks for it.

If you find yourself about to do maintenance here, stop: that impulse is what made the close expensive.
