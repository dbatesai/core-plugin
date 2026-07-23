---
name: memory-view
description: Generate a self-contained, read-only HTML snapshot of the current project's CORE memory store — interactive unit graph, full unit reading pane with edges and backlinks, and the four-evidence-class memory-health section — then publish it as a PRIVATE hosted artifact with visible narration of exactly what's in it (or hand the user the local file path on harnesses with no artifact surface). Use whenever the user asks to "publish the memory view", "refresh the memory artifact", "show me what you know as a page I can open on my phone", "let me browse the memory graph without a terminal", or any request to see the unit graph/store contents from the Claude app rather than from disk. Do NOT use for the in-terminal health check (that's /metrics), for the anonymized shareable stats export (that's /metrics-package), or for editing memory (nothing published here is editable — PROJECT.md remains the editing surface). NEVER run this automatically — not at startup, not at /finalize or session close, not on any schedule; it runs only when the user explicitly asks.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Artifact
---

# `/memory-view` — publish a read-only snapshot of what CORE knows

One self-contained HTML page — unit graph, unit bodies, edges, backlinks, memory-health section — generated from the project's `_memories/` store and published as a **private** hosted artifact so the user can browse it from the Claude app on desktop or phone. This page embeds **real memory-unit bodies**. Uploading it is a disclosure boundary (Hale's disclosure conditions, 2026-07-22; the per-publish permission gate was retired by the user's direct decision the same day — publishing the user's own project data to their own private account runs on standing authorization), so the flow below is not a suggestion: **every publish is user-triggered, narrated in the conversation where it happens, verified private, and receipted. No silent or background publishes, ever.**

**The script is the only generator.** `scripts/render-browse-artifact.mjs` (in the core skill's `scripts/` directory) reads the store through the same snapshot loader decoration uses, writes the HTML, prints the preflight manifest, and writes the local generation receipt. It never uploads anything — publishing is YOUR step, and only after the user's go-ahead. Never hand-assemble or edit the HTML; never publish a file this script didn't just generate.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/memory-view/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Step 1 — generate the snapshot locally

Resolve scope from the user's words: default is **active units only** (condition 7 — content minimization). "Everything including the archive" → `--scope all-including-archive`. "Leave out <topic>" → `--exclude-topic <topic>` (repeatable). Never widen scope beyond what the user asked for.

```bash
node "${CORE_ROOT}/skills/core/scripts/render-browse-artifact.mjs" <project-dir> \
  --out <scratch-path>/core-memory-browse.html [--scope ...] [--exclude-topic ...]
```

`--out` goes to a scratch/temp location — **never inside the project, never inside `_memories/`** (the script refuses the latter itself). The store is read-only to this whole flow. Stdout is the **preflight manifest** (JSON): unit count, byte count, scope, store snapshot id, receipt path, and a fixed sensitivity warning. Capture it — it is the input to Step 2.

## Step 2 — narrate the manifest (EVERY publish)

As part of publishing, state plainly in the conversation: the **unit count**, the **byte count**, the **scope** (and anything excluded), and the **snapshot id**. This is visible narration, not a permission gate — you say what's going up as you publish it, so the user can see and object at any point.

- Narrate on **every** publish, including a routine "refresh the memory artifact" of the same page to the same URL.
- Never publish at startup, at `/finalize`/session close, on a schedule, from a hook, or as a side effect of any other task — this skill runs only when the user asks, and every publish is stated in the conversation where it happens. (Condition 2's visibility discipline.)
- **The one real ask-first boundary:** if the store's content includes another party's data, or anything the user has flagged sensitive, ask before publishing — the standing authorization covers the user's own project data to their own private account, nothing broader.
- If the user objects at any point, stop and record the outcome as declined. The local file exists; tell them its path and that nothing left the machine.

## Step 3 — publish private, verify private

Publish the generated HTML via the harness's artifact capability as a **private** page (on Claude Code that is the Artifact tool; artifacts start private — republish to the same file path/URL to keep a stable link).

Required checks, stated because they are conditions, not habits (condition 3):

- **Verify the artifact is private at publish time.** If the harness cannot confirm visibility, treat the publish as failed: say so, and do not hand the user a URL as if it were private.
- **No silent sharing carryover on republish.** If this artifact URL existed before, its sharing setting may have been broadened since — re-verify privacy on every republish; never assume the previous state held.

**Harness honesty (DC-75 — the cross-harness capability contract):** on a harness with no artifact surface (Codex today), say so by name and fall back to the local file: give the user the exact `--out` path and how to open it. Never fake a publish, never claim a hosted URL that does not exist.

## Step 4 — record the outcome (every consent decision leaves a record)

Two receipts, two different claims. The receipt written at generation time (`~/.core/workspaces/<workspace-id>/artifact-receipts/<timestamp>.json`) is the **preflight-generation receipt**: it records what was generated and offered for publish — it is **never** a record of what went up, because it is written before consent. If the script reported it failed to write, surface that and do not publish until one lands.

After the publish step resolves — published, **declined by the user, or failed** — you MUST record the outcome as a **publish receipt** (condition 4's actual audit trail):

```bash
node "${CORE_ROOT}/skills/core/scripts/render-browse-artifact.mjs" --record-publish \
  --generation-receipt <receipt_path from the manifest> \
  --status published-private|declined|failed \
  [--artifact-url <hosted URL>] \
  [--private-verified-evidence "<how privacy was actually confirmed>"] \
  [--consent-by <who>] [--consent-mechanism "<what they were shown and agreed to>"]
```

- **`published-private`** requires `--private-verified-evidence` AND both authorization fields (`--consent-by`, `--consent-mechanism`) — the script refuses without them. State what you actually checked in Step 3, pass the hosted artifact URL when the harness surfaces one, and record what authorized the publish: a per-instance yes verbatim when one was given, or the standing authorization for a narrated autonomous publish (e.g. `--consent-by David --consent-mechanism "standing authorization for artifact publishes, David 2026-07-22"`).
- **`declined` and `failed` get recorded too.** A "no" is part of the audit trail. Never skip the receipt because nothing went up.
- The publish receipt lands atomically as `<generation-receipt>.publish.json` beside the generation receipt, linked to it by name — and **self-contained**: it carries the store snapshot id itself, so it still names what was published even if the generation receipt is later moved or lost. One outcome per generation — the script refuses to overwrite an existing publish receipt; a fresh publish means a fresh generation.
- If the user later deletes the artifact (or asks you to revoke it): `node ... --record-revocation <publish-receipt-path>` stamps `revoked_at` on the same receipt.

Then tell the user the deletion path, honestly: they can delete the artifact from their artifact gallery at claude.ai (or ask you to overwrite it with an empty page first), **and** deleting a hosted artifact may not scrub hosted copies or caches instantly — say that plainly rather than implying deletion is instant and total. The **publish receipt** — not the generation manifest — stays on their machine as the record of what actually went up.

## Boundary that never moves

**Unit content never routes into the anonymized `/metrics-package` export** (condition 5). Structurally it can't — the exporter builds from a disjoint numeric/pseudonym allowlist and never exports or routes unit bodies (its census does read whole unit files; no body content survives into package bytes — the planted-body tripwire test proves it) — and behaviorally you must never "borrow" this page's embedded content for any export, summary package, or shared aggregate. This page is the one deliberate, per-publish, user-confirmed disclosure of real unit bodies; nothing else inherits it.

## Self-healing rails

- **No `_memories/` store here:** say so; offer `/core` to start one. Nothing to publish.
- **No `workspace.json`:** the receipt falls back to `~/.core/artifact-receipts/` and the manifest flags it (`receipt_fallback: true`) — mention it, don't hide it.
- **Store feels too big to publish whole:** that's what scope selection is for — suggest `--exclude-topic` or staying with the active-only default rather than skipping the preflight.
- **Metrics gathering failed during generation:** the page carries an honest "metrics not gathered" line instead of the health section; the snapshot is still valid to publish.
