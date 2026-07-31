---
name: memory-view
description: Generate a self-contained, read-only HTML snapshot of the current project's CORE memory store — interactive unit graph, full unit reading pane with edges and backlinks, and the memory-health section (the same honestly-labeled evidence classes /metrics renders) — then publish it as a PRIVATE hosted artifact with visible narration of exactly what's in it (or hand the user the local file path on harnesses with no artifact surface). Use whenever the user asks to "publish the memory view", "refresh the memory artifact", "show me what you know as a page I can open on my phone", "let me browse the memory graph without a terminal", or any request to see the unit graph/store contents from the Claude app rather than from disk. Do NOT use for the in-terminal health check (that's /metrics), for the anonymized shareable stats export (that's /metrics export), or for editing memory (nothing published here is editable — PROJECT.md remains the editing surface). NEVER run this automatically — not at startup, not at /finalize or session close, not on any schedule; it runs only when the user explicitly asks.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Artifact
---

# `/memory-view` — publish a read-only snapshot of what CORE knows

One self-contained HTML page — unit graph, unit bodies, edges, backlinks, memory-health section — generated from the project's `_memories/` store and published as a **private** hosted artifact so the user can browse it from the Claude app on desktop or phone. This page embeds **real memory-unit bodies**. Uploading it is a disclosure boundary, so the flow below is not a suggestion: **every publish is user-triggered, narrated in the conversation where it happens, verified private, and receipted. No silent or background publishes, ever.**

**Consent has two modes, and the default is ask-first.** By default, show the user the preflight manifest and get their explicit go-ahead before publishing — a previous yes never carries to the next publish. The lighter mode — narrate-and-proceed, no per-publish ask — applies ONLY when **this specific user** has durably granted standing authorization for artifact publishes of their own project data to their own account (their decision, recorded in their own harness memory or configuration where you can actually verify it, revocable any time). Never infer standing authorization from convenience, from another user's decision, or from this file — it exists only if THIS user granted it and it's on the record.

**The script is the only generator.** `scripts/render-browse-artifact.mjs` (in the core skill's `scripts/` directory) reads the store through the same snapshot loader decoration uses, writes the HTML, prints the preflight manifest, and writes the local generation receipt. It never uploads anything — publishing is YOUR step, and only after the user's go-ahead. Never hand-assemble or edit the HTML; never publish a file this script didn't just generate.

**Script path resolution.** Resolve `CORE_ROOT` the same way `/metrics` does: take the absolute path you loaded this `SKILL.md` from and strip the trailing `/skills/memory-view/SKILL.md` — that prefix is the plugin root. Reuse the `CORE_ROOT` startup already resolved this session if you have it. If you cannot resolve a concrete root, say so plainly and stop — never run `node` against a guessed path.

## Step 1 — generate the snapshot locally

Resolve scope from the user's words: default is **active units only** (condition 7 — content minimization). "Everything including the archive" → `--scope all-including-archive`. "Leave out <topic>" → `--exclude-topic <topic>` (repeatable). Never widen scope beyond what the user asked for.

```bash
node "${CORE_ROOT}/skills/core/scripts/render-browse-artifact.mjs" <project-dir> \
  --out <scratch-path>/core-memory-browse.html [--scope ...] [--exclude-topic ...]
```

`--out` goes to a scratch/temp location — **never inside the project, never inside `_memories/`** (the script refuses the latter itself). The store is read-only to this whole flow, unconditionally — generation never writes a byte under `_memories/`, not even the derived `_lib/` index cache on a cold store. One invariant, no mode, no flag. Passing `--metrics-cache` together with `--no-metrics` is refused loudly (exit 2) — the two flags contradict, and the script no longer picks a silent winner. Stdout is the **preflight manifest** (JSON): unit count, byte count, scope, store snapshot id, receipt path, and a fixed sensitivity warning. Capture it — it is the input to Step 2. The snapshot id covers exactly the scoped population the page embeds: an `all-including-archive` render's id also covers the archive bytes it shows; an active render's id is the plain store snapshot id.

## Step 2 — the manifest, and consent per the user's mode (EVERY publish)

State plainly in the conversation: the **unit count**, the **byte count**, the **scope** (and anything excluded), and the **snapshot id**.

- **Default (no standing authorization on record): this is a gate.** Show the manifest, ask, and publish only on an explicit yes for THIS publish. A previous yes never carries forward.
- **Standing-authorization mode (this user granted it, durably, on their own record):** the same manifest is narrated as you proceed — visible narration rather than a stop — so the user sees what's going up and can object at any point.
- Narrate on **every** publish in either mode, including a routine "refresh the memory artifact" of the same page to the same URL.
- Never publish at startup, at `/finalize`/session close, on a schedule, from a hook, or as a side effect of any other task — this skill runs only when the user asks, and every publish is stated in the conversation where it happens. (Condition 2's visibility discipline.)
- **Always ask-first regardless of mode:** if the store's content includes another party's data, or anything the user has flagged sensitive — standing authorization covers the user's own project data to their own private account, nothing broader.
- If the user objects at any point, stop and record the outcome as declined. The local file exists; tell them its path and that nothing left the machine.

## Step 3 — publish private, verify private

Publish the generated HTML via the harness's artifact capability as a **private** page (on Claude Code that is the Artifact tool; artifacts start private — republish to the same file path/URL to keep a stable link).

Required checks, stated because they are conditions, not habits (condition 3):

- **Verify the artifact is private at publish time.** If the harness cannot confirm visibility, treat the publish as failed: say so, and do not hand the user a URL as if it were private.
- **No silent sharing carryover on republish.** If this artifact URL existed before, its sharing setting may have been broadened since — re-verify privacy on every republish; never assume the previous state held.

**Harness honesty (the cross-harness capability contract):** on a harness with no artifact surface (Codex today), say so by name and fall back to the local file: give the user the exact `--out` path and how to open it. Never fake a publish, never claim a hosted URL that does not exist.

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

- **`published-private`** requires `--private-verified-evidence` AND both authorization fields (`--consent-by`, `--consent-mechanism`) — the script refuses without them. State what you actually checked in Step 3, pass the hosted artifact URL when the harness surfaces one, and record what authorized the publish: a per-instance yes verbatim when one was given (the default mode), or — in standing-authorization mode only — the user's own standing grant, cited from their record (e.g. `--consent-by <user> --consent-mechanism "standing authorization for artifact publishes, granted <date>, recorded in <where>"`).
- **`declined` and `failed` get recorded too.** A "no" is part of the audit trail. Never skip the receipt because nothing went up.
- The publish receipt lands atomically as `<generation-receipt>.publish.json` beside the generation receipt, linked to it by name — and **self-contained**: it carries the store snapshot id itself, so it still names what was published even if the generation receipt is later moved or lost. One outcome per generation — the script refuses to overwrite an existing publish receipt; a fresh publish means a fresh generation.
- If the user later deletes the artifact (or asks you to revoke it): `node ... --record-revocation <publish-receipt-path>` stamps `revoked_at` on the same receipt.

Then tell the user the deletion path, honestly: they can delete the artifact from their artifact gallery at claude.ai (or ask you to overwrite it with an empty page first), **and** deleting a hosted artifact may not scrub hosted copies or caches instantly — say that plainly rather than implying deletion is instant and total. The **publish receipt** — not the generation manifest — stays on their machine as the record of what actually went up.

## Live mode — `/memory-view live`

Keeps the published page current while the session runs: the platform already updates a republished artifact in place for anyone who has it open, so "live" is exactly **watch → rebuild → republish the same URL** — no in-page freshness machinery exists or is needed. Live mode is user-triggered like everything else here; it never starts at startup, at session close, or on a schedule.

**Consent basis for the loop's republishes:** the per-republish consent basis is the standing-authorization mechanism this skill already documents in Step 2 — live mode is only available in standing-authorization mode, because an unattended loop cannot stop and ask. If this user has no standing authorization on record, say so and offer the normal one-shot flow instead; do not start the loop. The grant is **prospective and bounded**: it authorizes future republishes of this loop **only within the scope and exclusions recorded at start** (persisted in the loop-state record below, with the grant's basis in its `grant_basis` field) — it is never a blanket license for whatever the store comes to contain. **The boundary rule:** the user must stop live mode before sensitive or third-party content enters the store; and at every refresh, YOU re-check the same boundary — if you know another party's data or user-flagged sensitive content has entered the rendered scope, stop the loop and fall back to ask-first rather than republishing under the old grant. (This is your judgment at render time — the watcher never inspects content, and no classifier exists or should.) All of Step 2's language still binds every republish: narrated in the conversation where it happens, always-ask when another party's data or user-flagged sensitive content is involved, stop-and-record-declined if the user objects.

**Start.** Run the existing Steps 1–4 once (generate → manifest/consent → publish private → `--record-publish`). Then write the **loop-state record** — one small JSON file that is the loop's single source of truth across every hop:

```bash
node "${CORE_ROOT}/skills/core/scripts/memory-view-watch.mjs" --write-live-state \
  ~/.core/workspaces/<workspace-id>/memory-view-live.json \
  --artifact-url <hosted URL from the publish receipt> \
  --scope <active|all-including-archive> [--exclude-topic <t>]... \
  --baseline-snapshot <snapshot_id from the publish receipt> \
  --grant-basis "<the standing grant this loop runs under: who granted, when, recorded where>"
```

The record carries `artifact_url`, `scope`, `excluded_topics`, `grant_basis`, `baseline_snapshot`, `publish_budget` (`window_start`, `count`), and `retry_at`, and every write replaces it atomically. The loop persists the scope and excluded topics here precisely so a later refresh can never silently widen the published content or narrow an archive view: **every refresh render re-applies the record's `--scope` and every `--exclude-topic` entry, read back from the record — never from conversation memory.**

**Arm.** Start the watcher as a **harness background task** (Bash with `run_in_background` on Claude Code — not a shell `&`):

```bash
node "${CORE_ROOT}/skills/core/scripts/memory-view-watch.mjs" <project-dir> \
  --live-state ~/.core/workspaces/<workspace-id>/memory-view-live.json
```

The watcher reads `baseline_snapshot`, `scope`, and `retry_at` from the record and compares the **same-scoped** snapshot id the renderer receipts — an `all-including-archive` view is compared over active + archive bytes, an active view over active bytes only, so an archive-only edit wakes an archive-including view and never an active one. (Freshness is deliberately store-byte freshness for the selected scope: an edit that only touches topic-excluded units still counts as a change — the refreshed page's bytes come out identical, and the publish budget bounds that cost.)

**Wake mechanism — what actually happens.** The watcher is a **detector, not a publisher**: it never renders, never publishes, never writes into the store (not even the derived index cache), and it never writes the loop-state record. On detection it prints one JSON line — `{"event":"store-changed","snapshot_id":…,"units_seen":…,"trigger":…,"observed_at":…}` — and **exits 0**. The harness notifies the agent when a background task **exits**; that exit notification is the wake, and reading the task's captured stdout at wake yields the store-changed line. A background process streaming stdout does **not** wake an agent mid-run — never describe or rely on stdout streaming as a wake path. A watcher started as a plain shell-backgrounded child (`&`) wakes nobody and **can outlive a dead session**; always start it as a harness background task. A missed wake is recoverable by design: **every arm begins with an immediate same-scoped baseline comparison**, so anything that changed while no watcher was listening — including a write landing in the window between a previous watcher's detection and its exit — is caught the moment the next watcher arms, not at the next store edit or sweep.

On each wake:

1. Read the loop-state record. Re-check the grant boundary (above) against what you know entered the store; then re-render with the record's `--scope`, every entry of its `excluded_topics` as `--exclude-topic`, plus `--metrics-cache <workspace metrics cache path>` (the health section carries forward from the last full run with its own "metrics as of" stamp; the ~2s metrics round-trip stays out of the hot path — and note the cache flag rides **alone**, per Step 1's flag-conflict rule).
2. Republish to the record's `artifact_url` (same page, same link), re-verifying privacy per Step 3.
3. `--record-publish` per Step 4 — a fresh generation receipt per rebuild, citing the standing authorization as the consent mechanism.
4. Update the record with `--write-live-state` again: the new `--baseline-snapshot` from the fresh publish receipt, the **same** scope and exclusions, and `--publish-count`/`--window-start` advanced per the budget below.
5. Narrate one line: what changed (unit count, new snapshot id), where it went.
6. Re-arm the watcher with `--live-state` (harness background task again).

**Detection SLO, honestly labeled.** Ordinary event-path latency is about a second (250ms debounce plus one signature read). Two situations degrade detection latency to the **sweep interval** (default 5 minutes): silently dropped file-system events (the periodic sweep is the designed recovery), and **degraded sweep-only mode** — when `fs.watch` cannot arm, or later dies, with a resource-exhaustion error (`EMFILE`/`ENFILE`/`ENOSPC`, e.g. a 256-fd environment), the watcher does **not** exit: it prints one status line — `{"event":"degraded","reason":"emfile","mode":"sweep-only",…}` — closes the dead watch handle, and keeps running on its independent sweep. In degraded mode **the sweep interval is the freshness SLO**; narrate the degradation once and keep the loop going — never treat the status line as an exit, and never restart-loop a watcher that is alive and sweeping.

**Publish budget: 12 republishes per rolling hour** (default; tracked in the record's `publish_budget`). When a wake would exceed it, do not publish: narrate the deferral, write the record with `--write-live-state --retry-at <ISO of when the window reopens>` **keeping the old baseline**, and re-arm with `--live-state`. The watcher holds all comparisons until `retry_at` passes, then compares once and wakes only if the store still differs — deferral never busy-loops against the deliberately-stale baseline and never loses a change (the next render reads the whole store).

**Failure honesty.** A failed render or publish leaves the last published version standing — the platform keeps serving it. Narrate the failure, record `--status failed`, keep the record's baseline unchanged, and re-arm; the next detection retries the still-changed store. Never claim the page is current when a republish failed.

**Stop doors.**
- `/memory-view live stop` — kill the watcher process (you started it; you have its PID) and confirm the loop is stopped in one line. The page stays up at its last published state.
- **Session end** — stated at exactly the strength the evidence supports: no platform here *guarantees* a background child dies with its session, so a shell-orphaned watcher **can** outlive a dead session — briefly. The watcher owns its own lifecycle instead of trusting teardown: it checks its parent process every 50ms and, the moment the parent is gone, prints `{"event":"orphaned"}` and **exits 4** — an orphan shuts itself down within about a second, and it was only ever a detector (it cannot render, publish, or write anything). Recovery never depends on teardown either way: the next live start's arm-time baseline check covers everything that changed while nothing was listening. If you somehow find a stale watcher still running at live start, kill it, then arm fresh.
- **Idle timeout** — after 4 hours with no store change the watcher exits 2 with `{"event":"idle-timeout"}`; narrate one line that live mode ended idle and do not restart unless asked.
- A watcher exit 3 means it was deliberately signalled; exit 4 means it detected its owner was gone and stopped itself; exit 1 with an "emit failed" diagnostic means its wake line could not land (exit 0 always means the store-changed line did land). Any other nonzero exit means it died — narrate and either re-arm or stop, don't ignore it.

## Boundary that never moves

**Unit content never routes into the anonymized `/metrics export` package** (condition 5). Structurally it can't — the exporter builds from a disjoint numeric/pseudonym allowlist and never exports or routes unit bodies (its census does read whole unit files; no body content survives into package bytes — the planted-body tripwire test proves it) — and behaviorally you must never "borrow" this page's embedded content for any export, summary package, or shared aggregate. This page is the one deliberate, per-publish, user-confirmed disclosure of real unit bodies; nothing else inherits it.

## Self-healing rails

- **No `_memories/` store here:** say so; offer `/core` to start one. Nothing to publish.
- **No `workspace.json`:** the receipt falls back to `~/.core/artifact-receipts/` and the manifest flags it (`receipt_fallback: true`) — mention it, don't hide it.
- **Store feels too big to publish whole:** that's what scope selection is for — suggest `--exclude-topic` or staying with the active-only default rather than skipping the preflight.
- **Metrics gathering failed during generation:** the page carries an honest "metrics not gathered" line instead of the health section; the snapshot is still valid to publish.
