# Usage

A reference for what each part of CORE does. Commands come first — those are what you type, and every one of them is listed. Protocols and scripts follow as supporting detail; you rarely touch them directly, but they're what the commands run on. The script section groups the ones worth reading or running by hand rather than naming all of them — `docs/shipped-surface-inventory.json` is the generated list of every shipped skill, hook door, and script file (what ships — registration and callers are proven separately).

For the design reasoning behind any of this, see [ARCHITECTURE.md](ARCHITECTURE.md). For install, see [INSTALL.md](INSTALL.md).

---

## Commands

Ten slash commands ship with the plugin: `/core`, eight companions, and one deprecation shim. `/core` is the agent; the companions are operations CORE invokes during a session and that you can also run on their own; the shims forward to where their behavior moved.

### `/core`

The agent. Type it to start or resume work on a project.

- **What it does:** loads your project context and prints a readiness summary before anything else — what the project's state is, the active risks worth surfacing, any signals that escalated since last session, and the top items on the agenda. Then it works with you: writing observations as you talk, rendering `PROJECT.md` sections as things change, surfacing decisions and risks, and pushing back when the evidence doesn't support your framing.
- **When to use:** every session. It's the entry point.
- **Resume vs. work:** a bare `/core` (or "where are we") re-composes a fresh readiness summary. `/core <task>` picks up the task with full context loaded.
- **Reads:** `PROJECT.md`, the unit store at `_memories/`, workspace metadata. **Writes:** observations, unit edits, `PROJECT.md` renders, the autonomous run log.
- **First session on a project:** it figures out whether the folder is new, has prior content to migrate, or is a returning workspace, and routes accordingly — no setup command required.

### `/finalize`

Close a session.

- **What it does:** the bounded close — captures what the session made true that isn't yet durable (decisions, corrections, open work), writes a resume summary (at most ~400 words), re-renders `PROJECT.md` only when the session materially changed it, refreshes harness memory, and certifies the exact session's close receipt so the automatic close never runs a second pass over it. Memory maintenance deliberately does not run here — that's `/process-memory`; analytics are `/metrics`.
- **When to use:** at the end of a working session, so the next `/core` picks up clean. Skipping it is safe: the SessionEnd hook records a deterministic, zero-model lifecycle receipt for the session, and `/process-memory` back-fills the memory processing later.
- **Writes:** the session summary under `_summaries/`, `PROJECT.md` when owed, the close receipt.

### `/refocus`

Recenter mid-session on what matters most right now, given what became known since you started.

- **What it does:** re-reads the room — the original objective, the latest direction from you, decisions already accepted, and everything that arrived after the objective was set (corrections, documents, tool/test results, repository changes, mailbox or collaboration messages, other agents' findings). Assigns each material new item an effect (confirms, weakens, contradicts, replaces, adds, no-change) and reconsiders priority accordingly.
- **When to use:** the session has changed direction and you want the agent to reconsider what's important without losing the original thread. Not for closing a session (`/finalize`), running memory maintenance (`/process-memory`), or seeing measurement (`/metrics`).
- **Reads:** active context only by default — retrieves more only to resolve a specific named gap. **Writes:** nothing durable unless you accept a proposed priority change.

### `/process-memory`

A memory-housekeeping pass without the full session close.

- **What it does:** looks back over the session for observations that should have been captured and writes them, back-fills the memory processing for sessions the automatic close preserved without it, pulls the inbox, graduates observations into units where they've earned it, validates the unit store, regenerates the indexes, stamps the validity dimension, compacts `PROJECT.md` if it's over the file cap, and surfaces anything that needs your judgment. Also runs the retrieval-quality, retrieval-skip, capability-drift, and turn-classification scans.
- **When to use:** mid-session housekeeping, or any time you want the memory in tip-top shape without closing out.
- **Writes:** observations, graduated units, indexes, `PROJECT.md` (when over cap), `_pm-state.json`.

### `/register-sources`

Add, modify, or audit the external data sources that feed a project's memory.

- **What it does:** walks the source-registration intake — authority, confidence default, relevance contract, cadence, kind — and writes the registration YAML plus a source-of-authority unit. This is the same intake the new-workspace setup runs, available any time the source landscape changes.
- **When to use:** "register a source," "what sources are registered," or when you add or change an outside feed.
- **Writes:** `_sources/<name>.yaml`, `_memories/source-of-authority-<name>.md`.

### `/configure-project`

A one-shot setup-and-health check that confirms a harness is wired correctly against a project's store.

- **What it does:** confirms the install, validates the memory store, resolves workspace identity, reports connector capability, and (only with `--apply` and a `CONTRACT.md`) generates the harness instruction surface. It's the Codex-side counterpart to Claude Code's automatic startup — on Claude Code, `/core` already does this at session start, so you rarely need it there.
- **When to use:** setting up CORE on a folder under Codex, when a second harness joins a folder Claude Code already manages, or any time you want a "is this wired right?" check.
- **Idempotent and report-only by default.** The only write it ever makes is generating `AGENTS.md`, and only with `--apply`.

### `/vibecheck`

Capture the emotional truth of a session as ASCII art.

- **What it does:** renders how the session felt — not a status report, the actual vibe — and logs it to `~/.core/vibes/vibe-log.md`. Terminal-only, no browser.
- **When to use:** "vibecheck," or whenever you want to mark the feel of a session.

### `/metrics`

The one door to memory health (v3.14.0). The default answers the three questions that matter in plain sentences; the deeper instruments live behind explicit modes.

- **Default (`/metrics`):** three answer lines — *is it storing the right memories, is it loading them when you need them, does it pass its own blind test* — each with the single number that matters and a trend word, sourced from **pinned grading history** (never a live reinterpretation, so today's answer and next month's are comparable). Verdict words carry their trust label inline (a loading verdict reads "MOSTLY (mechanical grade)" — the grading re-runs the same text search with the full question in hindsight, measuring whether the right stored text was found, not semantic rightness). Ends with "Nothing needs your attention right now." or the specific plain-language escalation that replaces it. Honest degradation: "not yet measured" before grading exists; "turn capture is off" when you opted out.
- **`/metrics full`:** the complete instrument readout — three separate evidence classes, never blended into one verdict. **Mechanics** (the verdict line, `MECHANICS: HEALTHY` / `HEALTHY — with caveats` / `DEGRADED` / `MACHINERY WORKING, NO STORE`): builds a throwaway scratch store and proves the full write→validate→index→retrieve→suppress round trip fresh on every run, plus this project's real validator counts, unit census, telemetry-capture counts, and the always-visible turn-capture state line (the ON line carries the disclosure and every off-switch; the OFF line confirms your opt-out took effect). **Retrieval regression** (its own section — never covered by the verdict): the newest blind self-test round when one exists, else the static gold set, honestly labeled provisional. **Measurement readiness**: the recognition signal and the calibration pool that gates it. Every number carries an honest trust label (proven-live / direct / proxy / provisional / not-evaluated). *(The old fourth class — user benefit, permanently "not evaluated" — was removed in v3.14.0: measuring what you did with an answer is unobservable, so the question left scope by decision, not by gap.)*
- **`/metrics export`:** the anonymized memory-metrics stats zip on your Desktop. **`/metrics self-test`:** author, verify, and score a blind test round now (the scheduled path also authors one automatically when the current round goes stale, at most once a week).
- **The artifact display:** on harnesses with an artifact surface (Claude Code), the full report also renders as a self-contained HTML page — the four classes as four plain questions, every measurement explained in the sentence it appears in, generated mechanically from the same data object as the terminal report — and is published as a **private** hosted artifact with the publish narrated in the conversation (content class, byte count, and truthful producer identity stated as it goes up; a local receipt records every generation and every publish outcome). The page embeds aggregate numbers and topic-level labels only — never memory-unit bodies or unit ids. On Codex there is no artifact surface: the same page is generated locally and you get the file path instead.
- **When to use:** "is memory working," "prove the memory system works," "can I trust the store," or any time you want evidence instead of a claim.
- **Writes:** the terminal check writes nothing — read-only against the real store; its own scratch store lives in the temp dir and is deleted before the command returns. The artifact step writes the HTML page to a scratch path you're told about, plus local receipts under `~/.core/`.

### `/memory-view`

Browse what CORE knows — the unit graph, full unit bodies, edges and backlinks, plus the memory-health section — as one self-contained, read-only page, published as a **private** hosted artifact so you can open it in the Claude app on desktop or phone.

- **What it does:** generates a single HTML snapshot from the project's memory store (active units by default; archive and per-topic exclusions are explicit choices), then shows you a preflight manifest — unit count, byte count, scope, snapshot id, and a sensitivity warning — and publishes **only after you confirm**. Every publish is explicit and individually confirmed; there is no standing consent and it never runs at startup, close, or on a schedule. The page itself is stamped point-in-time and read-only, with the generating plugin version and store snapshot id in the banner. Each generation writes a local receipt (`~/.core/workspaces/<id>/artifact-receipts/`) recording exactly what was generated for publish and when.
- **When to use:** "publish the memory view," "refresh the memory artifact," "let me browse the graph on my phone," or any time seeing the store beats being told about it. On a harness with no artifact surface (Codex), it generates the same page locally and gives you the file path instead — no faking.
- **Writes:** the HTML file to the scratch path you choose (never into the project or the store — the store is read-only to this flow) and the local receipt. Unit content never routes into the anonymized `/metrics export` zip.

### `/orient` *(deprecated shim — folded into `/core`)*

Session bootstrap is part of CORE's startup protocol now, so `/orient` does no work of its own: it prints a notice pointing at `/core` and stops. Kept only so an existing habit doesn't hit an unrecognized command. Removal scheduled for 2026-08-15.

---

## Additional reference

### Protocols

Protocols are internal documents `/core` reads when it needs them — they aren't commands. Each governs one part of how the agent operates.

| Protocol | Governs |
|---|---|
| `startup.md` | Session bootstrap — workspace resolution, architecture-state routing, the returning-workspace load, elapsed-time signals, the hot-section refresh, and the readiness summary. Read at every session start. |
| `startup-conditional-loads.md` | The two rare startup branches — new-workspace scaffold and folder-rename — read only when routing selects them. |
| `harness.md` | The abstract-verb contract and how it maps to each harness (Claude Code, Codex). |
| `workspace.md` | Creating, resuming, or winding down a workspace. |
| `data-storage.md` | The unit format, the edge types, the retrieval ladder, and the promotion modes — read before writing any unit, observation, or render. |
| `hygiene.md` | The three hygiene verbs (archive, retire, cold-store), graduation, and continuous self-evaluation. |
| `execution.md` | Execution discipline, solo and swarm. |
| `analysis.md` | The multi-agent machinery — phase structure, the anti-convergence discipline, the monitor pattern — invoked when stakes warrant a single pass isn't enough. |
| `validation.md` | Retrieval-health checks: substrate, convergence, ranking quality. |
| `debug-mode.md` | The structured logger for diagnosing retrieval, writes, renders, and hygiene. |
| `self-evolution.md` | Session-end learning and hygiene-triggered skill evolution. |

Supporting references live alongside them: `retrieval.md` (the four-tier ladder in depth), `model-assignments.md` (which model tier per pipeline stage), `hygiene-strategies.md`, `confidence-assignment-guide.md`, `memory-extension-contracts.md`, `architecture-doctrines.md`.

### Scripts

The plugin ships the deterministic spine the commands run on — the surfaces where inference can't be trusted to be exact. You don't call these directly; the commands and protocols do. Grouped by what they're for:

- **Memory store & retrieval** — `retrieve-context.mjs` (the live retriever: title ∪ body-BM25 over one request-scoped snapshot + one-hop edge expansion; `buildFinalContextPack` is the single implementation of the delivered context — ordering, tier labels, byte cap — that the per-turn hook, the `--pack` CLI mode, and the measurement harness all call; `buildRetrievalTrace` records a local-only per-request evidence trace), `bm25.mjs` (the body-search arm + tokenizer), `generate-summary-index.mjs` (the recursive path-bearing retrieval index + validating loader + `loadSnapshot` content-addressed snapshot identity), `select-relevant-units.mjs` (the reasoning-tier shortlist), `retrieval-harness.mjs` (offline recall measurement on the product path; its final-context arm scores delivered identities, byte cap included), `aggregate-receipt.mjs` (the privacy-safe evidence exporter: whitelist-built aggregate receipt + refusal scan; rows stay local), `priority.mjs` (the ranking function), `check-units.mjs` (schema + integrity validation), `graph-walk.mjs` (typed-edge traversal), `generate-decisions-index.mjs` / `generate-risks-index.mjs` / `generate-memory-index.mjs` (the indexes).
- **`PROJECT.md` rendering & hygiene** — `hot-section.mjs` (the top-of-file "right now" block), `compact-project.mjs` (file-cap compaction), `demote-moves.mjs` / `demote-state-narrative.mjs` (tier discipline), `decorate-graph.mjs` (in-place Obsidian `[[wikilink]]` decoration of `_memories/`, run automatically at close and on-demand hygiene passes), `render-browse-artifact.mjs` (the `/memory-view` generator: one self-contained, read-only HTML snapshot of the store plus the preflight manifest and local receipt — it never uploads anything itself).
- **Validity dimension** — `bitemporal.mjs` (the `t_valid`/`t_invalid` stamp, as-of queries, storage-health metrics), `impact-trace.mjs` (what an invalidation touches).
- **Self-measurement** — `metrics-init.mjs`, `classify-turns.mjs`, `metrics-rollup.mjs`, `metrics-detectors.mjs`, `calibrate-classifier.mjs`, `metrics-check.mjs` (the `/metrics` live evidence check: round-trip probe + store health + calibration-pool progress; prefers a frozen self-test round when one exists), `self-test-round.mjs` (the `/metrics self-test` round manager: freezes the corpus, emits the blind-authoring brief, mechanically verifies + freezes an authored question set, runs the real harness against it, computes the old-vs-new-round overfitting delta), `log-event.mjs`, `record-retrieval-event.mjs`, `analyze-retrieval-quality.mjs`, `analyze-retrieval-skip.mjs`, `read-transcript.mjs`.
- **Capability & identity** — `resolve-plugin-root.mjs`, `capability-probe.mjs`, `capability-history.mjs`, `record-capability-snapshot.mjs`, `analyze-capability-drift.mjs`, `workspace-fork-check.mjs`, `project-slug.mjs`, `write-visibility-canary.mjs`.
- **Validation & integrity** — `validate.mjs` (retrieval-health runner), `orphan-detector.mjs` (every script reached, every protocol indexed), `audit-memory-boundary.mjs` (native-memory vs. CORE-store boundary).
- **Multi-agent** — `adversarial-run-gate.mjs`.
- **Instruction surface (staged)** — `contract-format.mjs`, `generate-agents-md.mjs`, `generate-claude-md.mjs`, `migrate-to-contract.mjs`, `configure-project.mjs`.
- **Helpers** — `frontmatter-flat.mjs`, `fs-atomic.mjs`.
