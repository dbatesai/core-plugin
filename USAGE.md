# Usage

A reference for what each part of CORE does. Commands come first — those are what you type. Protocols and scripts follow as supporting detail; you rarely touch them directly, but they're what the commands run on.

For the design reasoning behind any of this, see [ARCHITECTURE.md](ARCHITECTURE.md). For install, see [INSTALL.md](INSTALL.md).

---

## Commands

Nine slash commands ship with the plugin: `/core` and eight companions. `/core` is the agent; the companions are operations CORE invokes during a session and that you can also run on their own.

### `/core`

The agent. Type it to start or resume work on a project.

- **What it does:** loads your project context and prints a readiness summary before anything else — what the project's state is, the active risks worth surfacing, any signals that escalated since last session, and the top items on the agenda. Then it works with you: writing observations as you talk, rendering `PROJECT.md` sections as things change, surfacing decisions and risks, and pushing back when the evidence doesn't support your framing.
- **When to use:** every session. It's the entry point.
- **Resume vs. work:** a bare `/core` (or "where are we") re-composes a fresh readiness summary. `/core <task>` picks up the task with full context loaded.
- **Reads:** `PROJECT.md`, the unit store at `_memories/`, workspace metadata. **Writes:** observations, unit edits, `PROJECT.md` renders, the autonomous run log.
- **First session on a project:** it figures out whether the folder is new, has prior content to migrate, or is a returning workspace, and routes accordingly — no setup command required.

### `/finalize`

Close a session.

- **What it does:** reconciles state, writes a session summary, re-renders `PROJECT.md` from the units, and runs the comprehensive memory-hygiene pass (graduation, validation, index regeneration, file-cap compaction, the metrics interpretation pass, validity-dimension stamping).
- **When to use:** at the end of a working session, so the next `/core` picks up clean.
- **Writes:** the session summary under `_summaries/`, `PROJECT.md`, the indexes, hygiene-log entries.

### `/process-memory`

A memory-housekeeping pass without the full session close.

- **What it does:** looks back over the session for observations that should have been captured and writes them, pulls the inbox, graduates observations into units where they've earned it, validates the unit store, regenerates the indexes, compacts `PROJECT.md` if it's over the file cap, and surfaces anything that needs your judgment. Also runs the retrieval-quality, retrieval-skip, and capability-drift scans.
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

A live proof of what's actually working — and an honest account of what isn't measured yet — displayed as a plain-language evidence page where the harness has an artifact surface, with the compact terminal report as the quick view.

- **What it does:** reports four separate evidence classes, never blended into one verdict. **Mechanics** (the verdict line, `MECHANICS: HEALTHY` / `HEALTHY — with caveats` / `DEGRADED` / `MACHINERY WORKING, NO STORE`): builds a throwaway scratch store and proves the full write→validate→index→retrieve→suppress round trip fresh on every run, plus this project's real validator counts, unit census, and telemetry-capture counts. **Retrieval regression** (its own section — never covered by the verdict): a live gold-set snapshot run against the project's own pre-registered answer key when one exists, honestly labeled provisional. **Measurement readiness**: the recognition signal and the calibration pool that gates it. **User benefit**: honestly `not-evaluated` — nothing in CORE currently runs a matched memory-on/off comparison, so this row says so plainly. Every number carries an honest trust label (proven-live / direct / proxy / provisional / not-evaluated).
- **The artifact display:** on harnesses with an artifact surface (Claude Code), the full report also renders as a self-contained HTML page — the four classes as four plain questions, every measurement explained in the sentence it appears in, generated mechanically from the same data object as the terminal report — and is published as a **private** hosted artifact with the publish narrated in the conversation (content class, byte count, and truthful producer identity stated as it goes up; a local receipt records every generation and every publish outcome). The page embeds aggregate numbers and topic-level labels only — never memory-unit bodies or unit ids. On Codex there is no artifact surface: the same page is generated locally and you get the file path instead.
- **When to use:** "is memory working," "prove the memory system works," "can I trust the store," or any time you want evidence instead of a claim.
- **Writes:** the terminal check writes nothing — read-only against the real store; its own scratch store lives in the temp dir and is deleted before the command returns. The artifact step writes the HTML page to a scratch path you're told about, plus local receipts under `~/.core/`.

### `/metrics-package`

Pull an anonymized stats package showing how well the memory is actually working.

- **What it does:** builds a zip on the Desktop with retrieval, recognition, store-health, hygiene, and capability statistics — numbers, dates, fixed vocabulary, and salted pseudonyms only. Real project content never enters it by construction.
- **When to use:** "pull the memory stats," "export a metrics package," or whenever you want shareable evidence of how the memory system is performing.
- **Writes:** a zip file to `~/Desktop/`.

### `/memory-view`

Browse what CORE knows — the unit graph, full unit bodies, edges and backlinks, plus the memory-health section — as one self-contained, read-only page, published as a **private** hosted artifact so you can open it in the Claude app on desktop or phone.

- **What it does:** generates a single HTML snapshot from the project's memory store (active units by default; archive and per-topic exclusions are explicit choices), then shows you a preflight manifest — unit count, byte count, scope, snapshot id, and a sensitivity warning — and publishes **only after you confirm**. Every publish is explicit and individually confirmed; there is no standing consent and it never runs at startup, close, or on a schedule. The page itself is stamped point-in-time and read-only, with the generating plugin version and store snapshot id in the banner. Each generation writes a local receipt (`~/.core/workspaces/<id>/artifact-receipts/`) recording exactly what was generated for publish and when.
- **When to use:** "publish the memory view," "refresh the memory artifact," "let me browse the graph on my phone," or any time seeing the store beats being told about it. On a harness with no artifact surface (Codex), it generates the same page locally and gives you the file path instead — no faking.
- **Writes:** the HTML file to the scratch path you choose (never into the project or the store — the store is read-only to this flow) and the local receipt. Unit content never routes into the anonymized `/metrics-package` export.

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
- **Self-measurement** — `metrics-init.mjs`, `classify-turns.mjs`, `metrics-rollup.mjs`, `metrics-detectors.mjs`, `calibrate-classifier.mjs`, `metrics-check.mjs` (the `/metrics` live evidence check: round-trip probe + store health + calibration-pool progress), `log-event.mjs`, `record-retrieval-event.mjs`, `analyze-retrieval-quality.mjs`, `analyze-retrieval-skip.mjs`, `read-transcript.mjs`.
- **Capability & identity** — `resolve-plugin-root.mjs`, `capability-probe.mjs`, `capability-history.mjs`, `record-capability-snapshot.mjs`, `analyze-capability-drift.mjs`, `workspace-fork-check.mjs`, `project-slug.mjs`, `write-visibility-canary.mjs`.
- **Validation & integrity** — `validate.mjs` (retrieval-health runner), `orphan-detector.mjs` (every script reached, every protocol indexed), `audit-memory-boundary.mjs` (native-memory vs. CORE-store boundary).
- **Multi-agent** — `adversarial-run-gate.mjs`, `validate-adversarial-artifacts.mjs`.
- **Instruction surface (staged)** — `contract-format.mjs`, `generate-agents-md.mjs`, `generate-claude-md.mjs`, `migrate-to-contract.mjs`, `configure-project.mjs`.
- **Helpers** — `frontmatter-flat.mjs`, `fs-atomic.mjs`.
