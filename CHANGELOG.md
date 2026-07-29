# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.15.1] — 2026-07-29

### Fixed
- Hook logging no longer leaks a `hook-log-write-failed` diagnostic to the user on every answer
  in sandboxed harnesses (e.g. Codex workspace sandbox) where `~/.core` is readable but not
  writable — permission-shaped errors now fall back to a fixed, trusted tmpdir log.
- CI: a shell-quoting defect in the hooks-schema validation step (two possessive apostrophes
  breaking a single-quoted `node -e` block) that made `validate plugin` exit 126 on every run.

### Changed
- Continued the v3.15.0 development-narrative cleanup: removed the remaining internal
  review-batch labels, issue ids, and decision-lineage references from shipped comments,
  tests, and the CHANGELOG. The dev-leakage guard's allowlist mechanism now scopes exemptions
  to exact literal tokens instead of a whole file+pattern, so legitimate short product
  vocabulary (the P0-P3 retrieval-policy enum) can be allowlisted without hiding an unrelated
  internal label sharing the same file.

## [3.15.0] — 2026-07-29

### Changed
- **The public repository carries no internal development narrative.** Internal issue ids, reviewer attributions, review-round lineage, decision-ledger tags, and unbuilt design specs are removed from every tracked file — shipped payload, docs, tests, and this changelog's history alike — each rewritten to the technical constraint it stood for. The dev-leakage guard now enforces exactly that scope, with planted falsifiers proving a leak in a test file or a changelog entry fails the build.
- **`/finalize` is the bounded close.** It captures what the session made true that isn't yet durable, writes a resume summary capped near 400 words, renders `PROJECT.md` only when the session materially changed it, refreshes harness memory, and certifies the exact session's close receipt — and does nothing else. Memory maintenance lives in `/process-memory`, analytics in `/metrics`, the session-perspective critique in `/refocus`, and development checks in the test suite. The close op set narrows to four (`material-capture`, `render-project-md`, `session-summary`, `memory-refresh`), the startup catch-up recovers exactly those, and hygiene's own trigger table names `/process-memory` and the unconditional startup backstop as its owners.
- **The agent's name is per workspace.** An optional `agent_name` field on the workspace manifest carries the emergent name the agent picks for each project; the cross-project profile (voice, patterns, user model — one lineage everywhere) moves to `~/.core/agent-profile.md`, with a one-time startup migration from the legacy `dm-profile.md` path and fallback reads wherever the old path appeared.
- **The anonymized export is named for what it measures.** Every "memory-efficacy" surface string is now "memory-metrics" — the package reports storage and retrieval mechanics; nothing in it establishes user benefit.

### Added
- **Manual closes certify their exact session.** `close-pass.mjs certify` resolves the current session from the newest project-bound transcript (or takes `--session` explicitly), writes the `closed` receipt, refuses to synthesize an identity, and no-ops on an already-certified session — so the SessionEnd hook can never run a second close over a session closed by hand.
- **Memory back-fill for auto-closed sessions.** The automatic close is deterministic and zero-model, so it preserves a session without processing its memory. `backfill-memory.mjs list` names the sessions whose receipts show preserved-but-unprocessed work (corrupt receipts counted, never elided); `/process-memory` reads their transcripts, captures what they warranted, and stamps each receipt done.
- **A source-derived shipped-surface inventory.** `scripts/release/generate-shipped-surface-inventory.mjs` (repo tooling, not shipped in the plugin payload) walks the shipped tree and emits `docs/shipped-surface-inventory.json` — what ships, honestly labeled: skills and hook doors carry registration; script files carry presence only, since callers and invocation are proven separately. A guard fails whenever any count claim (README, USAGE, INSTALL, llms.txt, both marketplaces) drifts from the shipped set, whenever an active user-invocable skill goes unmentioned, or whenever shipped prose cites a path outside the shipped tree.
- **Release identity is gated end to end.** `scripts/release/verify-release-identity.mjs` (repo tooling, outside the shipped payload) distinguishes a release-fresh embedded source SHA from a stale mid-development one and fails a deliberately stale installed cache; tag creation requires the CI workflow for that exact SHA to have succeeded; pull requests are compared against their actual base branch; the packaged smoke is renamed `source-package-smoke.sh` for what it proves, selects the immediate-prior release dynamically for its rollback leg, and fails on an empty rollback result.
- **Blind prose evals.** A deterministic rubric checker scores `/refocus` answers and finalize resume summaries against scenario fixtures with planted expectations — obligations that must survive, embedded injection markers that must not be followed, provenance and effect labels, earlier-thread statuses, word caps, and claims the planted evidence cannot support.

### Removed
- **The model-spawn close architecture.** `runClose`, `defaultSpawnFinalize`, the CLI `run` verb, the envelope-mode env vars, and their tests — nothing reached them; the live path is the deterministic per-session close. One close architecture remains, and a falsifier asserts the dead verb stays dead.
- **The `/metrics-package` and `/self-test` deprecation shims**, on their announced one-release schedule — use `/metrics export` and `/metrics self-test`. (`/orient` remains until its dated removal.)
- **The per-pass hygiene retrospective file** (`~/.core/hygiene-cycles/`). It was written every close and read by nothing; durable lessons graduate into units instead.
- **Removed internal mailbox coordination tooling from the plugin payload** (`_mailbox/`, `mailbox.mjs`, the per-turn unread-count hook). It was internal coordination infrastructure, not a capability any `/core` project needs — it never appeared in the user-facing docs, only in the startup protocol and one hook registration.

### Added
- **A one-time batch adoption path for a store that predates the creation-baseline stamping seam.** A project that adopted CORE before v3.14.x surfaces its ENTIRE unit store as `no-baseline` on first contact — not a partial gap, all of it, since none of those units were ever stamped at creation. `lifecycle-detect.mjs --adopt-existing-store` reports the candidate count (dry-run by default); `--apply` stamps each currently-unstamped file's current bytes as its adoption baseline, the same one-time ceremony a hand-written loop over `--stamp-created` would do, just built in and explicit rather than something every adopting project reinvents on its own.

### Fixed
- **Both Codex hook wrappers (`answer-close-hook-codex.mjs`, `retrieve-context-hook-codex.mjs`) now stay fail-open when the shared implementation fails to import.** The top-level `await import(...)` sat outside any try/catch, so a resolution or syntax failure threw before the imported module's own fail-open entry guard ever ran — contradicting the always-exit-0 contract every hook in this plugin is supposed to honor.
- **The memory-health chain can now detect its own silence.** Every check that reports on the evidence recorder needed the recorder to be running in order to say anything, so an idle recorder read as a healthy one. Volumes are now counted per reporting window as well as cumulatively (a cumulative total never returns to zero, so any past volume permanently masked present silence); the flight-recorder-dead check reads the window; a new coverage check fires when evidence is recorded for under half of hook-triggered lookups; and a new staleness check fires when no conclusion has been pinned in 14 days — the one signal that survives the whole chain going quiet. A rejected row now counts as a failed attempt, so a caller that stops supplying a required field becomes visible instead of recording nothing at all.
- **`/metrics` states how much evidence is behind its answers.** Under 20 graded turns the default view reports the sample size rather than a verdict — a handful of turns can read 100% and mean nothing.
- **The default `/metrics` view discloses what is stored whether capture is on or off**, with the off-switch, instead of mentioning capture only when it is already disabled.
- **The first-run privacy notice reaches every workspace.** It ran only on the brand-new-workspace scaffold, so a project that already existed when local turn capture arrived — the common case on upgrade — was never told. It now runs at every session start, self-gating so it appears once, and the shown-flag is versioned so a materially newer notice reaches a workspace that saw an older one.

## [3.14.1] — 2026-07-24

### Changed
- **Dev-process scrub of the entire shipped tree.** All internal development-process references are gone from everything a marketplace install pulls: internal decision-ledger tags, reviewer cross-talk attributions in code comments, internal agent codenames, and a tenant company name — ~710 references across ~190 files, reworded into self-contained plain language (meaning-preserving, not stripped). Public docs, protocols, skills, and code comments now explain every rule in their own words.
- **Comments describe the present state only.** Every shipped code comment and protocol passage that narrated a prior state, a process story, or calendar-date provenance is rewritten as the plain present constraint (or removed when it carried no present-state content) — ~340 passages across 96 files. Lifecycle vocabulary, format-example dates, and live compatibility/deprecation contracts are unchanged.
- **Dev-leakage guard enforces the new bar.** The release-gate scan now flags decision-ledger references (upper- or lowercase, on the product surface and CHANGELOG) and agent names in shipped code comments — with a documented carve-out for `dc-<n>-<slug>` unit-id examples, which are the product's own naming convention. The release flow gains a post-bump scrub-verification step; the guard remains the fail-closed enforcement.

## [3.14.0] — 2026-07-24

### Added
- **Every-turn evidence capture (turn-capture stream).** The per-turn retrieval hook now writes one evidence row per turn — the user's prompt (64 KiB cap), the exact delivered context-pack text (16 KiB cap), per-unit ids+scores, the top-20 rejected candidates with scores, a store signature for drift detection, and producer identity — joined to the numbers row by `retrieval_id`. Local-only under the metrics storage base (dirs 0700 / files 0600), 30-day retention on the maintenance cadence, `--purge-turn-capture`, its own exclusion lock, and a health counter that survives even a failure to create the stream itself. The exporter has no read path into it, enforced by a planted-canary tripwire test. Default ON; off-switches: `CORE_TURN_CAPTURE=0`, `"turn_capture": false` in the project's `workspace.json`, or the master `CORE_METRICS_ENABLED=0`. `/metrics` always shows the stream's state — the ON line carries the full disclosure and every off-switch; the OFF line confirms an opt-out took effect.
- **Producer identity on every measurement row.** `retrieval-log.jsonl` and `self-test-log.jsonl` rows now carry `producer_version`/`producer_sha` (retrieval-event schema 1.0.0 → 1.1.0, additive; 1.0.0 rows stay valid), via a new shared `producer-identity.mjs` — a score or trend moving between runs is now attributable to store-drift vs code-change from the stored record alone.

- **Pinned scorecards — trends you can trust.** A maintenance-cadence pass pins one immutable conclusions row per period (hindsight grade counts, self-test headline, volumes, capture health) stamped with the data window, producer identity, judge version, and the live tripwire thresholds. Trends are computed only from stored scorecards, so a scoring-code change can never silently rewrite history.
- **Mechanical-grade hindsight judge.** A bounded, idempotent maintenance pass re-runs the same lexical ranking over each captured turn's FULL prompt (the live hook saw a truncated view) and grades the delivered set: hit-right, noise, hindsight-miss (the store had a better match), or storage-gap (the store had nothing) — plus drift-invalidated when the store changed between capture and judgment (flagged and dropped, never guessed). Every verdict is labeled `mechanical grade`; the storage-gap floor is deliberately conservative and configurable (`CORE_JUDGE_GAP_FLOOR`).
- **Startup tripwires.** A cheap session-start check over pinned scorecards surfaces degradation proactively in plain language: self-test score drops, a rising hindsight-miss trend, recurring storage gaps, capture-write failures (10% rate at ≥20 attempts, or 3 consecutive), and a dead flight recorder. Healthy → total silence.
- **Self-test rounds refresh themselves.** When the newest blind round goes stale (corpus grew >20%, or >10 sessions old), maintenance emits one authoring-due note — hard-capped at once per week, and never while an authored round sits unrun.
- **`/metrics` is now the one door.** The default output answers the three questions that matter in plain sentences from pinned history (with inline trust labels and honest not-yet-measured/capture-off states); `/metrics full` keeps the complete instrument readout; `/metrics export` absorbs `/metrics-package`; `/metrics self-test` absorbs `/self-test`. Both old commands remain as one-release deprecation shims (removal v3.15.0).

- **Self-test results reach the exported metrics package.** `/metrics-package` now includes a `self-test.json` block (and both the markdown and HTML reports show it) built from a project's own self-test grading history — round id, per-question-kind Recall@10, the unanswerable trap-leak rate, the old-vs-new-round overfitting delta, and how many runs/rounds have happened. Numbers, hashes, and closed-vocabulary labels only — never question or answer text, never a unit body. A leaked trap on the most recent round raises a package flag.
- **Self-test grading writes its own log.** Every self-test grading run — whether triggered manually via `/self-test run` or automatically (below) — appends one row to a dedicated `self-test-log.jsonl`, kept separate from the ordinary retrieval/hygiene logs so synthetic self-test measurements never mix with real usage data.
- **Self-test re-grades automatically.** The routine maintenance pass — already run at every session start, `/finalize`, and `/process-memory` — now also re-grades the newest registered self-test round, a cheap, bounded operation, so a fresh regression number is available without remembering to run `/self-test run` by hand. Writing a brand-new round of questions, and the full multi-round overfitting delta, both stay something a user triggers on purpose.
- **Self-test's question mix adapts to recent retrieval behavior.** When a new self-test round is created without an explicit quota, the mix of question types is computed from the project's own recent retrieval metrics: a high rate of retrievals needing more than the cheap first-pass search shifts weight toward the harder "connect the dots" question type, and any recent self-test trap that leaked shifts weight toward more trap questions next round. An explicit quota (as tests already use) is honored exactly as given, with no adjustment.
- **`/self-test` — the blind, round-based memory self-test.** A project can now run an internal self-test on its own memory store that measures whether the memory can actually be *found* from natural questions — not just that the machinery round-trips. It is deliberately round-based and append-only (`self-test-round.mjs`, verbs `new-round` / `register` / `run` / `status`): `new-round` freezes the store's content-addressed identity for the round and emits a blind-authoring brief; a separate BLIND agent (orchestrated by the skill, never the build) authors a fresh question set reading only the stored facts — never the retrieval code — covering questions the store *should* answer with zero shared wording, questions about change over time, and questions the store deliberately *cannot* answer (where the right behavior is "nothing stored about that"), including false-premise questions that swap in a plausible thing the store never mentions. `register` runs a mechanical verifier and, only on a clean pass, pre-registers and **freezes** the round (question-set sha256 + corpus snapshot id + timestamp); a frozen round refuses re-registration, and a new round is the only way to add questions. The verifier enforces, without trusting the author: schema conformance (the same fail-closed gate the measurement harness uses), zero content-word overlap for the indirect kinds checked against each answer unit's title, body, AND topics (stem-aware, function words excluded), the false-premise entity checks (the swapped-in thing must be genuinely ABSENT and the framing things genuinely PRESENT), per-kind counts against the round quota (over-quota refused as padding, under-quota allowed as honest shortfall), answer-id existence, the required blindness attestation, and corpus identity/no-drift. `run` refuses an unregistered round, then runs the REAL `retrieval-harness.mjs` against the frozen set and reports the per-kind recall breakdown, the unanswerable trap-leak rate, and — once a prior round exists — the old-vs-new-round delta measured against the same current corpus (the standing overfitting detector). The retrieval harness's rung vocabulary gained two deliberately-added kinds, `temporal` and `abstention`, so the new question kinds report as first-class (abstention scores through the existing `expected:[]` + forbidden-rate path with no scorer change).
- **`/metrics` prefers a frozen self-test round.** When a project has any registered self-test round, `/metrics`'s retrieval-regression section now reads the newest round instead of the small static gold set — reporting its per-kind breakdown, the trap-leak rate, and the old-vs-new-round delta, still honestly labeled `provisional` (self-authored answer key, no preregistered pass threshold), but now covering the unanswerable classes and carrying the overfitting detector, which is strictly more honest than the static number. The metrics read is read-only (it never writes a run record). The static `_tests/retrieval-gold-set.json` remains the fallback when no round exists.
- **Opt-in rich-context capture (off by default).** A new local capture stream saves a bounded 4 KiB head of the literal query text and of the delivered context-pack on a **synchronous no-hit** retrieval so a developer can debug WHY a retrieval failed with full context — the closed-schema telemetry records that it happened but not why. It is OFF by default and activates only when the **machine-local, per-user** workspace meta (`~/.core/workspaces/<id>/workspace.json`) carries `rich_context_capture: true` — deliberately NOT the project-root `workspace.json` pointer, which travels with a copied or shared project, so one user's sensitive-capture choice can never ride along to a teammate (a project-root flag is ignored). When on, `/metrics` shows one plain-language line reporting **effective** state — "ON" only when aggregate metrics are also on, or "configured on, but inactive: aggregate metrics disabled" when the flag is on but metrics are off (the hook writes rich rows only inside the metrics branch), and nothing when off. Rows are schema-versioned JSONL, owner-only on disk (dir `0700`, files `0600` where the platform supports it, best-effort on Windows), written to `<metrics-storage-base>/rich-context/<date>.jsonl`. Append, retention, and purge all share **one exclusion lock** at a stable sibling path OUTSIDE the purged directory (`<metrics-storage-base>/.rich-context.lock`), so a purge can never unlink the lock out from under a writer and the three ops can never race (no lost or torn rows, no delete-while-appending). Rows are retained 30 days by default (retention runs inside `maintenance-run.mjs` with dry-run and deletion proof) and can be purged on an explicit ask (`maintenance-run.mjs --purge-rich-context`). A capture outcome — including a failure — rides the retrieval hook's terminal operational receipt as a closed `rich_capture` status code, never raw content. The stream is physically separate from the aggregate metrics and is NEVER read by the `/metrics-package` exporter — a permanent canary tripwire test asserts no rich-context content can reach an exported package. The first-run metrics disclosure notes this optional stream exists, is off by default, lives in the per-user meta, and captures a 4 KiB head (not the full text) only on no-hit turns.
- **`/metrics` artifact display** — the memory-health report now displays artifact-first on harnesses with an artifact surface: a self-contained, plain-language HTML page (the four evidence classes as four plain questions — does the machinery work, how good is the search, can the self-measurements be trusted, does any of it help you — every measurement explained in the sentence it appears in, an honest trust tag on every line, hatched empty states for anything unmeasured, both light and dark themes, reduced motion respected, and a snapshot banner stating the page does not update itself). Generated mechanically by a new `render-metrics-artifact.mjs` from the SAME canonical data object the terminal render consumes, so the two views can never diverge; the terminal render stays as the quick view and the Codex fallback (no artifact surface there — the local file path is handed over instead, never a faked publish). The generator prints a lightweight preflight manifest (`content_class: "aggregates-only"` — the page embeds aggregate numbers and topic-level labels only, never memory-unit bodies or unit ids), carries truthful producer identity (real git commit in a source checkout, release-manifest identity in an installed tree, fail-closed with neither), writes a generation receipt, and records publish outcomes through the same receipt mechanism as `/memory-view` (publish-receipt kind `core-metrics-artifact-publish`). A `--json-in` flag renders from a pre-captured `--json` object for replays and tests.
- **Shared artifact-page helpers** — the truthful-producer-identity logic and the publish-receipt mechanism moved out of `render-browse-artifact.mjs` into two shared modules (`artifact-provenance.mjs`, `artifact-receipts.mjs`) now that two generators need them; behavior-preserving for the browse flow, one owner instead of copies.

### Changed
- **Companion-utility count** is now nine: `/export-obsidian` retired (below), `/metrics` and `/memory-view` joined the roster, and the `/metrics-package` and `/self-test` deprecation shims ride along for one release until their v3.15.0 removal. Reflected across the plugin manifests, README, USAGE, and INSTALL.
- **Artifact publish receipts are self-contained and require an authorization record.** A publish receipt now copies the snapshot identity out of its generation receipt at record time (store snapshot id for browse pages, data-gathering instant for metrics pages), so it still names what was published even if the generation receipt is later moved or lost; and `--record-publish --status published-private` now refuses to record without `--consent-by` and `--consent-mechanism` alongside the existing privacy-verification evidence — closing the gap between the skill prose and the CLI contract. Applies to both artifact kinds through the shared helper.
- **Artifact publishes are narrated, not permission-gated.** The per-publish show-manifest-and-wait-for-yes step in `/memory-view` (and the same step planned for the `/metrics` artifact) is replaced by narrate-and-proceed per the user's direct decision (2026-07-22): the agent states what it's publishing — counts, bytes, scope, identity — in the conversation as it publishes, publishes privately, records the receipt, and reports the URL. Unchanged: automatic generation + publish receipts, private-by-default, truthful provenance, no startup/close/scheduled/background publishes, and an explicit ask-first for anything carrying another party's data or content the user has flagged sensitive.
- **`/memory-view`** — browse what CORE knows as one self-contained, read-only HTML page: an interactive unit graph (pan/zoom/click, all JavaScript inline, zero external resources — built to survive a strict CSP that blocks every external request), a unit reading pane (full body, frontmatter summary, clickable typed edges, backlinks), and the same four-evidence-class memory-health section `/metrics` renders, embedded verbatim. Generated by a new `render-browse-artifact.mjs` from the same snapshot loader decoration uses (active units only by default; `--scope all-including-archive` and repeatable `--exclude-topic` are explicit caller choices — never an unconditional whole-store dump). Publishing it as a private hosted artifact is a separate, always-explicit step governed by the skill: every publish shows a preflight manifest first (unit count, byte count, scope, store snapshot id, fixed sensitivity warning) and requires the user's go-ahead each time — no standing consent, never at startup/close/scheduled; private visibility is verified at publish and re-verified on every republish; each generation writes a local audit receipt to `~/.core/workspaces/<id>/artifact-receipts/`; and the page banner carries an unmissable "POINT-IN-TIME SNAPSHOT — READ-ONLY" label with generated-at, producer version + source SHA, and snapshot id. The generator never uploads anything and never writes to `_memories/` (regression-tested byte-identical); unit content has no route into the anonymized `/metrics-package` export. Design and boundary conditions per the 2026-07-22 memory-browse spec.
- **Startup decoration + index refresh backstop.** Every returning-workspace session start now runs `decorate-graph.mjs` (real run, not a dry-run) and `maintenance-run.mjs` (index + summary-index regeneration) unconditionally against the project's memory store, right after the existing integrity probe — independent of whatever the session-close bookkeeping believes is "owed." Both calls are idempotent and cheap, so a fully-current store is a fast no-op; the readiness summary only mentions this step when decoration touches a meaningful number of units, an index regenerates with something material to report, or either call is skipped or fails. This is a second, deliberately redundant layer alongside the existing `/finalize`- and `/process-memory`-time wiring — a direct check specifically so a maintenance op that's missing from the tracked-ops list entirely (the `decorate-graph.mjs` gap this same day) can never again go unnoticed for weeks.
- **First-run metrics disclosure.** A brand-new workspace's very first readiness summary now says, once, that CORE keeps a local, on-this-machine log of how well it's answering turn by turn — to help CORE improve — and that nothing about it is ever transmitted anywhere. Names both opt-outs (`CORE_METRICS_ENABLED=0`, or `metrics_enabled: false` in the project's `workspace.json`). Scripted (`metrics-disclosure.mjs`) rather than left to the agent to remember, and flagged in the workspace manifest so it fires exactly once per workspace and never again on later sessions.
- **`/metrics`** — a live, in-terminal health check for the memory system, ported from a personal machine-local skill into the plugin proper. Builds a throwaway scratch store and proves the write→validate→index→retrieve→suppress round trip fresh on every run, then reads this project's real validator counts, unit census, retrieval-log coverage, recognition-signal state, and a new calibration-pool row — the classifier's labeled-turn count against its 100-turn calibration gate, and whether it has cleared it. Renders a verdict (WORKING / WORKING — with caveats / DEGRADED / MACHINERY WORKING, NO STORE), a 10-character bar gauge per row, and a 1-3 sentence plain-voice summary, every number carrying an honest trust label (proven-live / direct / provisional). Writes nothing — read-only against the real store, its own scratch store deleted before the command returns.
- **`/metrics` evidence-class split (same day, follow-up fix).** The verdict above used to silently cover retrieval regression and user benefit too, even though neither had real proof — a self-audit caught the overclaim before release. `/metrics` now reports three separate, honestly-labeled evidence classes instead of one blended verdict: **mechanics** (the verdict line, scoped to exactly what it proves — round-trip proof + unit integrity); **retrieval regression** (its own section: retrieval-log coverage relabeled as capture volume not correctness, a new live gold-set Recall@K row that runs `retrieval-harness.mjs` for real against the project's own pre-registered gold set at `_tests/retrieval-gold-set.json` when one exists, a new live retrieval-quality proxy row from `analyze-retrieval-quality.mjs`'s real retrieval-log rows, plus the recognition signal and calibration pool moved here since they measure retrieval quality, not store mechanics); and **user benefit** (a new row, always present, always honestly `not-evaluated` — no matched memory-on/off comparison exists anywhere in this codebase yet). Two new trust labels (`proxy`, `not-evaluated`) join `proven-live`/`direct`/`provisional`. No new capture infrastructure — every row reads evidence that already existed or states its honest absence.

### Fixed
- **Rich-context capture: six boundary corrections at the shared boundary of the opt-in stream.** Six precise defects at the shared boundary of the opt-in stream, fixed as one narrow change: **(1) causal binding** — the in-hook seam now captures a **synchronous no-hit only**, bound to the current retrieval as its own subject; the corrective-retry trigger is dropped, because a retry is evidence about the *prior* retrieval's outcome and the seam holds only `prev.retrieval_id`/`prev.query_terms` (never the prior query text or pack), so writing the current turn's content under a `corrective-retry` label mislabeled the wrong retrieval (a later out-of-band human/agent judgment may still record that verdict). **(2) Per-user opt-in** — the `rich_context_capture` switch moved from the project-root `workspace.json` pointer (which travels with a copied/shared project) to the machine-local per-user manifest `~/.core/workspaces/<id>/workspace.json`; a project-root flag is now ignored (test proves a copied-project flag does not activate capture). **(3) Filesystem hardening** — the sensitive directory is `0700` and row files `0600`, asserted on create and re-asserted on every append (best-effort on Windows, honest comment). **(4) One exclusion lock** — append, retention deletion, and purge now share a single lock at a stable sibling path OUTSIDE the purged directory, so a purge can't unlink the lock out from under a writer; two real concurrent-process falsifiers (capture-vs-retention, capture-vs-purge) prove no lost/torn rows and no delete-while-appending. **(5) Truthful effective state** — `richContextStats()`/`/metrics` report EFFECTIVE state: "configured on, but inactive: aggregate metrics disabled" when the flag is on but the aggregate-metrics master switch is off, instead of a bare "ON" while capture is impossible (both renders tested). **(6) Exact disclosure + visible failures** — the UI/first-run disclosure now say precisely what is stored (a 4 KiB head of query and delivered context, on synchronous no-hit only — not "full text"), and `captureRichContext()`'s `{captured:false, reason}` plus caught errors surface as a closed `rich_capture` status code on the hook's terminal operational receipt (never raw content, never silent). Each fix ships its own acceptance test.
- **Calibrated rollups can no longer mix measurement instruments.** The read-side replay dedupe that shipped in `8b5e229` validated calibration against the CURRENT classifier/proxy constants but then aggregated every surviving deduplicated row regardless of which instrument produced it — an old-version row with no newer counterpart survives newest-wins dedupe, so a store holding 0.2.0-era and 0.3.0-era rows could report `calibrated: true` while its numbers silently summed both instruments' judgments. `metrics-rollup.mjs` and `metrics-package.mjs` now select exactly one instrument cohort — the current `(schema_version, classifier_version, proxy_version)` triple — after dedupe and before any aggregation; every surviving row outside the cohort is excluded and reported as an explicit coverage gap (count + versions present, version labels whitelist-folded) in the rollup JSON, the one-line orient signal, the daily markdown, and the package's numbers-only recognition block. On the live CORE store this was not hypothetical: 55 of 147 deduped rows (14× classifier 0.1.0, 41× 0.2.0, never re-classified) had been counted alongside the 92 current-instrument rows. Two sibling defects from the same audit fixed in the same pass: equal-rank conflicts (same replay identity, same versions, contradictory states) now resolve deterministically — later-dated file wins, then lexicographically smaller state (which for the current vocabulary is also the conservative, non-self-favoring reading), then smaller content signature — instead of by file-read order, proven by both-input-orders tests; and the cross-date attribution policy is now explicit rather than implicit: replayed sessions attribute to the replay's day, stated in the module header, the rollup JSON (`day_attribution: "replay-day"`), the daily markdown, and the package block. The mixed-instrument falsifier ships as a permanent test at all three layers (dedupe, rollup, package). Detector dedupe stays as-is: tested helper, no production consumer, flagged not invented.
- **The memory-browse page now carries truthful producer provenance.** In a source Git checkout, `render-browse-artifact.mjs` used to stamp the page and manifest with the release manifest's stale `source_sha` — precise but false provenance (the reviewed tree was `8b5e229`; the banner said `d677b319`). `producerIdentity()` now resolves from the executing module's realpath (never cwd) and, in a git checkout, emits the REAL `git rev-parse HEAD` of the tree the script actually runs from — accepting the SHA only when this script is tracked in that repo, so an installed copy nested inside an unrelated repo can't inherit false provenance. Installed/package trees (no git) keep the stamped manifest identity, now labeled `source_sha_from: "manifest"`. If NEITHER source can establish a SHA, generation fails closed — nonzero exit, no page written, never an "unknown-sha" render. The exact falsifier ships as a test: in a git checkout the emitted SHA must equal `git rev-parse HEAD` and must not silently fall back to an older manifest stamp.
- **A publish outcome now leaves its own receipt, separate from the preflight-generation receipt.** The receipt written at generation time records what was generated and offered — it is written before consent, so a declined candidate and a real publish used to leave the same kind of record. A new `--record-publish` mode writes a post-publish receipt atomically as `<generation-receipt>.publish.json` beside (and linked by name to) the generation receipt: `publish_status` (`declined` / `failed` / `published-private`), `recorded_at`, `published_at`, the hosted artifact URL when available, consent fields, and `private_verified` at/evidence — with `published-private` refused unless privacy-verification evidence is stated. `--record-revocation` later stamps `revoked_at` on the same receipt. One outcome per generation (overwrite refused); schema matches the first real hand-authored publish receipt, whose extra fields survive revocation intact. The `/memory-view` skill now mandates recording EVERY outcome — including declined and failed — and no longer describes the generation manifest as the record of "what went up."
- **`/memory-view` condition-5 wording overclaimed:** the `/metrics-package` exporter's guarantee is that it never *exports or routes* unit bodies (the planted-body tripwire proves it) — not that it never *reads* them; its census does read whole unit files and discards the body. The skill now states the true claim.
- **Clicking a node in the browse page's graph actually selects it now.** The pan handler's `setPointerCapture` made the browser retarget the derived `click` event to the SVG root, so the click-to-read handler never saw the clicked `<circle>` — node selection silently never fired on the published page. Selection now rides `pointerup` with a small movement threshold (<5px) using the original `pointerdown` target; the dead SVG click binding is removed, and a structural regression test pins the new path. The unit-list pane's plain click binding was unaffected.
- **`render-browse-artifact.mjs` invoked through a symlinked path was a silent no-op** — the CLI-entry check compared the module's realpath against the raw `argv[1]` spelling (e.g. macOS `/var/folders` vs `/private/var/folders`), concluded it wasn't the entrypoint, and exited 0 having done nothing. The entry check now compares realpaths on both sides.
- **Replayed sessions no longer inflate recognition metrics (read-side replay dedupe — metrics evidence-contract item 3).** The classified-turns store is append-only by design, so a session processed at close AND again at a later catch-up (or a `/process-memory` re-run) appends the same turns twice — and nothing deduped at read time, so rollup and package counts silently inflated (the live CORE workspace measured 166 rows for 147 unique turns, ~11% inflation, plus one genuine same-key conflict). A new shared helper (`metrics-dedupe.mjs`) now gives every aggregate reader one row per replay identity — the invariant: reprocessing the same (harness, session, turn, producer/schema version) leaves totals unchanged. Policy: the newest (classifier_version, proxy_version) wins across producer upgrades (a re-classification is a correction, not additional evidence — superseded rows are counted, never summed); same-version duplicates resolve last-written-wins with any state disagreement counted as a visible conflict; rows without an affirmative identity are kept and counted as unkeyed, never guessed away. Wired into `metrics-rollup.mjs` (store-wide deduped view; stats in the JSON, an always-on line in the daily rollup, and a `[replay-dedupe: N→M]` tag in the orient signal whenever dedupe changed the numbers) and `metrics-package.mjs`'s recognition block (numbers-only `replay_dedupe` stats; the free-text whitelist boundary is untouched), surfaced in both package reports. Detector rows get the same helper per (detector, session, finding); the detector store has no aggregate reader yet — the helper exists so the first one starts honest. Writers stay append-only on purpose: capture remains ground truth and replayable; the honesty lives at read time, the same split as the retrieval-event schema-validation slice.
- **Mixed-ownership writers (`decorate-graph.mjs`, `hot-section.mjs`) could silently launder an unreconciled user edit.** Both scripts correctly preserve the human-authored bytes of a file when regenerating their own generated region (the edges block / the hot section) — but both then unconditionally stamped a FRESH state-cache baseline over the whole file, even when the human-authored region had ALREADY diverged from the last known-good baseline (a between-session user edit nobody had reconciled yet). The fresh stamp made that divergence permanently undetectable: the user's bytes survived on disk, but the fact that they'd changed was never observed, attributed, or propagated — the next edit-detection check read `edges-block-only`/`hot-block-only` (CORE's own write) instead of `outside-changed` (a genuine user edit). Fixed at the writer boundary, in code: `decorateStore`/`decorateStoreLocked` and `applyHotSection`/`clearHotSection` now read the pre-write state cache and classify each file's human-authored region against its last established baseline BEFORE writing. A file with a prior baseline that already classifies `outside-changed` or `no-baseline` is refused — never decorated, never re-stamped — and surfaced as `needs_reconciliation` (decorate-graph: in `decorateStore`'s return value; hot-section: a thrown `NEEDS_RECONCILIATION` error, caught and reported by the CLI). A file with no prior baseline at all still decorates normally on its first pass — there's nothing to violate yet. `startup.md`'s decoration + index refresh backstop is also reordered to run after edit-detection, not before, so the prose sequence no longer contradicts the code-level fix (belt and suspenders; the code-level refusal is what actually matters).
- **`stampFiles()`/`stampFile()` (`state-cache.mjs`) was an unlocked read-modify-write** over the per-project state-cache file, despite the file's own comment claiming single-owner safety — untrue within a project, where `decorate-graph.mjs`, `hot-section.mjs`, and `maintenance-run.mjs` can all stamp the same cache in the same window. A 40-concurrent-process probe measured real lost writes (29/40 survived) before this fix. Now serialized under a project-local `.state-cache.lock` via the existing `withFileLock` primitive (no new locking mechanism) — a matching regression test spawns 40 genuinely concurrent OS processes stamping distinct files and confirms all 40 survive.
- **The collab-files target-surface capability probe** no longer ships with a specific personal repo path and remote baked into the shared descriptor every install reads — every user's plugin install was probing connectivity to one particular person's private git repo by default. Per-installation config now goes through `CORE_COLLAB_FILES_REPO` / `CORE_COLLAB_FILES_EXPECTED_REMOTE` env vars, checked before the descriptor; the shipped descriptor now ships unconfigured (`null`), and an install with nothing configured reports the capability as not applicable rather than silently defaulting to someone else's repo.

### Removed
- **The user-benefit "not evaluated" row** from `/metrics` and the artifact page: measuring what the user did with delivered answers is unobservable, so the question left scope by decision rather than by gap — keeping the row would imply it was still open.
- **The opt-in rich-context stream** (`rich_context_capture`), superseded by turn-capture: it could only fire on zero-hit turns, and a zero-hit has no delivered context to record — the every-turn evidence layer closes that defect by construction. A leftover `rich-context/` directory is swept by the next maintenance pass; the machine-local flag is ignored.
- **`CORE_RETRIEVAL_TRACE`** and its `_sessions/retrieval-trace.jsonl` output — an undocumented opt-in that put conversation content in the plain project tree and never had a reader. The turn-capture stream is the supported (and protected) equivalent.
- **The OTel-format trace dual-write.** `log-event.mjs` no longer writes a parallel `_metrics/traces/<session>.jsonl` span file alongside the ordinary JSONL logs — it never gained a reader in the roughly two months it ran. The JSONL logs (`retrieval-log.jsonl`, `outcome-log.jsonl`, `hygiene-log.jsonl`, and now `self-test-log.jsonl`) are the sole event substrate.
- **`/export-obsidian`** — retired as a user-invoked command. The worker it ran (`decorate-graph.mjs`, in-place `[[wikilink]]` decoration of the memory store) is unchanged and still ships; it now runs automatically as part of the memory-hygiene pass in `/finalize` (session close) and `/process-memory` (on-demand hygiene), the same way `demote-moves.mjs` and `compact-project.mjs` already do. Point Obsidian at a project's `_memories/` directory at any time and the graph, backlinks, and note browsing are current without a manual step.

## [3.13.1] — 2026-07-22

### Fixed
- **`source_sha` provenance metadata** in both shipped plugin manifests was stamped at version-bump time and never re-stamped, even though 36 more commits landed on `next` before the v3.13.0 PR actually merged — the tagged artifact carried a `source_sha` 33 commits stale relative to what it actually packaged. This is not cosmetic: `answer-close-hook.mjs` and `retrieve-context-hook.mjs` both read this field and stamp it as `producer_sha` on every retrieval-outcome and answer-close-outcome row, so the v3.13.0 tag was writing every such row with the wrong producer commit. Corrected to the actual packaged commit.
- **Plugin manifest descriptions** still described `/export-obsidian` as producing an "OKF-conformant memory export" (the design superseded in v3.13.0 by in-place decoration) and undercounted the companion-utility list (five named where seven ship, missing `/metrics-package` and `/export-obsidian`). Corrected in `plugins/core/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
- **Graduation's Mode-B trigger contradicted itself.** `protocols/data-storage.md`'s graduation section said Mode B (propose-and-wait) fires only when a new unit would supersede or conflict with an existing one — but the general Mode-B trigger list separately said any write to a durable destination (which includes every canonical unit) fires Mode B, unconditionally overriding the narrower graduation-specific rule. Added an explicit carve-out so an ordinary, non-conflicting graduation stays autonomous as the graduation section already said; the other six general triggers are unaffected.
- **A flaky liveness assertion in the test suite (dev-only, not shipped).** Two concurrency tests (`capture-store.test.mjs`, rounds 11 and 12) inferred "the writer is still active" from how many samples a fixed-iteration observation loop happened to catch — reliably flaky under real CPU contention, unrelated to the correctness of the code under test. Rebuilt on a causal probe/ack handshake that proves in-window liveness directly instead of inferring it from timing. Two further test-harness bugs surfaced and fixed while building this fix (a blocking wait that prevented the writer from ever processing an incoming signal; a process that no longer exited on its own once given an incoming-message listener).

## [3.13.0] — 2026-07-21

### Added
- **`/export-obsidian`** — decorates the project's memory store in place with real Obsidian `[[wikilinks]]`, so `_memories/` itself opens directly as an Obsidian vault (graph view, backlinks, note browsing) — no separate export copy to go stale. Each unit gets a marker-delimited, auto-regenerated edges block computed from its own frontmatter, from one atomic snapshot of the store; retired/archived units and any edge pointing at one are excluded entirely. Idempotent (a unit is only rewritten when its block actually changed) and fails closed on a malformed marker state rather than guessing.
- **`CORE_REASONING_ARM`** — a test-only environment-variable control (`automatic`/`deterministic-only`/`always-on`) that lets the memory-efficacy pilot force which reasoning-escalation behavior runs on a given trial. `automatic` (the default, whether set explicitly or left unset) stays byte-identical to previously shipped behavior.
- **Mailbox unread-count nudge** — a per-turn hook surfaces the unread `_mailbox/` count so backlogs can't silently accumulate unnoticed.
- **PROJECT.md size-pressure fallback** — `demote-moves.mjs` now escalates to a shorter age floor for one run when PROJECT.md is over its cap and the normal floor can't keep up with a fast-moving project.

### Fixed
- **Five real defects found in an independent audit**, each with a regression test: anti-resurrection wasn't fully structural (a cache staleness check was byte-only, so a unit past its own expiration date could keep serving from a stale cache); the aggregate-receipt privacy scanner had two path-refusal bypasses and could leak a project-specific identifier prefix through its "generic vocabulary" boundary; a lock-release failure could go completely unsurfaced; the mailbox's archive step could silently overwrite an already-archived message with the same name; the artifact-identity CLI's directory-export mode didn't record which computation method produced its output.
- **Windows path/encoding correctness**: two capability probes were mis-mapping a Windows drive-colon path to the wrong memory location; `/metrics-package` could silently ship a corrupt zip on a GNU-tar box with no warning; `retrieve-context --query` swallowed an unrecognized flag as the query instead of failing loud. All three confirmed live against a real installed Windows cache, still broken in the prior release.
- **`hot-section.mjs`** no longer trusts a cache stamp that couldn't distinguish "the user edited PROJECT.md's real content" from "only the hot block changed" — a user-control-invariant bug.
- **`close-pass.mjs`** no longer certifies a session closed when the LLM half of close recorded zero judgment ops.
- **`mailbox.mjs`** fails closed instead of silently proceeding when gitignore leak-protection genuinely can't be established.
- **`check-units.mjs` `archived-in-active` check** only recognized `status: archived`, missing the canonical shape (`archived: true`/`archived_at`, status unchanged) entirely; a full-path segment scan could also false-positive (an unrelated ancestor directory literally named "archive") or false-negative (a substring match on a top-level filename containing "archive"). Now recognizes the canonical shape and checks only the unit's immediate parent directory.

### Removed
- **`analyze-source-pull-log.mjs`** and its tests — three-way consensus determined it was structurally dead code.
- **`instruction-surface-adapter.mjs`** and its test — a dry-run-only v3.0 instruction-surface system with no real caller in the product (no command, no hook). Its core mutation path was a permanent stub that always refused. Everything it was reaching for — writing a CORE-owned block into a harness instruction surface — is already covered by the CONTRACT.md generator system (`generate-claude-md.mjs`/`generate-agents-md.mjs`), which actually writes.
- **`render-okf-export.mjs`** and its test — superseded by the in-place `[[wikilink]]` decoration described above; the separate export folder it produced is gone along with it.

### Changed
- **`/orient` shim** now carries an explicit 2026-08-15 sunset date.

### Docs
- Corrected two v3.12.0 release-note inaccuracies found in post-release review: the `producer_sha` scope claim below now says "recorded retrieval-outcome row" (the actual scope) instead of "telemetry row"; the Codex manifest's companion-utilities count and list are now consistent with the Claude manifest (six, including `/metrics-package`). The immutable `v3.12.0` tag is unchanged — these are forward corrections on `next`.

## [3.12.0] — 2026-07-18

### Added
- **Reasoning-tier retrieval** — the retrieval path can selectively escalate to a deeper reasoning tier instead of running one-size-fits-all; shipped and tested, no calibrated measurement yet of its effect on retrieval quality.
- **Self-identifying build provenance (`source_sha`)** — `/cut-release` now stamps the exact source commit a release packages into both plugin manifests, and every recorded retrieval-outcome row can carry the matching `producer_sha`. This release is the first to carry a real (non-`"unknown"`) value.
- **Governed outcome-tracking core** — write-time enrichment, a terminal correctness stack, and a production outcome-writer for retrieval/answer outcomes. Schema-valid and covered by hostile-negative and fault-injection tests; not yet exercised on an installed artifact in production — that proof is the next step now that a real `source_sha` exists to anchor it.

### Changed
- **"Delivery Manager"/"DM" retired** — user-facing skill prose now says "agent" ("lead agent" in swarm contexts) throughout. Internal machine identifiers (`dm-profile.md`, `dm_notes`) are unchanged, pending a separate per-project identity rework.

### Fixed
- **Security** — `CORE_HOOKS_LOG_FILE`, `CORE_RETRIEVAL_STORE`, and `CORE_CLOSE_STORE` can no longer be used to redirect telemetry writes outside the trusted `~/.core` boundary; the two store variables were removed outright, the log-file variable hardened against symlink bypass.
- A concurrency-related test-isolation bug in the retrieve-hook test suite (a shared fixture path collided under concurrent invocation).
- A Windows-only tar-extraction bug in the test harness.

## [3.11.0] — 2026-07-15

### Added
- **Shared-write concurrency** — `index-registry.mjs` is the sole scripted writer of `~/.core/index.json`, guarded by a rename-claim generation lock (no stealing from live processes at any age; verified, fail-closed release at both the owner and operator paths, with failure-injection tests); `capability-history` unified onto the shared lock; `last_active` and the edit-detection state cache moved to per-project single-owner files. Race coverage uses genuinely concurrent processes (spawn, not spawnSync).
- **`buildFinalContextPack`** — one product function now owns the delivered per-turn context end-to-end: final ordering, authority tier labels, UTF-8 byte accounting, the byte cap, and the degraded-store warning. The installed hook is a thin adapter around it, the CLI gains `--pack` (emits the exact delivered bytes), and the measurement harness's final-context arm scores pack-accepted identities — so a measured number describes the bytes the agent actually receives, never a pre-cap selection.
- **Request-scoped content-addressed snapshots** (`loadSnapshot`) — one index load feeds the title arm, the body-BM25 arm, and edge expansion within a retrieval request; the snapshot id (sha256 of the content-derived source signature) pins every trace and evaluator receipt to the exact store bytes measured. **`buildRetrievalTrace`** records the full local-only evidence trace of one request (snapshot id, component hashes, stages, delivered pack, timing) on the same staged pipeline the product runs.
- **Strict evaluator** — the gold-set validator refuses under-declared queries (≥1 expected support or explicit `no_answer: true`); the evaluator fails closed on unknown authority tiers (the product path stays tolerant); counterfactual tier-policy bands are per (query, gold) pair; harness and sweep receipts carry a schema version, product-function sha256s, the snapshot id, and declared counts.
- **`aggregate-receipt.mjs`** — the privacy-safe evidence exporter: a whitelist-constructed aggregate receipt (rates, counts, latencies, hashes) refusal-scanned against every unit id, query text, and path the local report saw; any hit refuses the export (exit 2). Per-query band rows leave only as a histogram. Row-level evidence stays local.
- **Policy-stage safety battery** (`tests/fixtures/policy-safety-store`) — active-wrong, conflicting, vocabulary-stuffed, terminal (`t_invalid`), and retired distractors exercised AT the tier-policy stage: terminal/retired excluded under every policy; the tier-weighting policy proven downweight-only; the slot-reservation policy's canonical-authority promotion risk characterized and measured (`forbidden@3 > 0` on the fixture), feeding the ceremony evidence.
- **Committed package-smoke** — the 16-check packaged-install procedure (committed-artifact build, installed-path lifecycle hooks, hostile-environment authority, storeless no-littering, rollback/no-resurrection/re-upgrade round-trip) moved into `tests/smoke/` and runs as a dedicated CI job; it prints its own sha256 so evidence receipts pin the exact procedure.
- Live retriever now unions title-match with body-BM25 (`bm25.mjs`): full note bodies are searched, closing the body-blind recall gap (dev-set numbers re-measured on the product path below; re-earned under the pre-registered measurement ceremony). Cost honesty: the retrieval INDEX is cached and freshness-validated; bodies are re-read and term statistics rebuilt per call — measured warm p50 ~6ms at 200 units, ~63ms at 2,000 (fine at CORE/BBLens scale; precompute document statistics if a store outgrows that).
- **Recursive path-bearing retrieval index** (the "index every note" half of the retrieval ruling): `generate-summary-index.mjs` walks the whole memory tree (nested `observations/<YYYY-MM>/` included — previously ~42% of CORE's memory files were invisible to retrieval), each record carries its real relative `path` plus an authority `tier` (canonical vs raw observation, labeled on every retrieval result, never flattened), and the staleness signature is recursive so a nested edit invalidates the cache. One validating loader (`loadFreshIndex`) now feeds every consumer.
- `CORE_AUTOSTART_SKILL` seam: a wrapper plugin (e.g. BBLens) names its own autostart entry point and inherits CORE's guarded SessionStart hook (recursion guard + `CORE_AUTOSTART=0` opt-out). Default `/core`. **Authority-gated:** a wrapper skill is honored only when registered in the user's own `~/.claude/settings.json` (`CORE_AUTOSTART_SKILL` or the `CORE_AUTOSTART_ALLOWED_SKILLS` list) — a project's forwarded env can never redirect the session's mandated first action (shape ≠ authority). Wrapper installs: register the entry point in USER settings.
- Offline Recall@K measurement harness (`retrieval-harness.mjs`): scores each retrieval arm (lexical / live / bm25) on a pre-registered gold set with per-rung breakdown and forbidden-retrieval rate. The `live` arm calls `productRankedIds` — the same function the shipped retriever ranks with (product/harness identity), and every run emits a provenance manifest (plugin version, gold sha256, corpus signature, arm params, p50 latency) with raw per-query ranks in `--json`.

### Fixed
- **Autostart authority bypass (never released; caught before release):** the user-settings check resolved home via `os.homedir()`, which follows `HOME`/`USERPROFILE` — a project-controlled hook environment could point it at an attacker directory and redirect the session's first action. The trusted home now comes from `os.userInfo()` (the OS account database, environment-independent), with the hostile-environment attack as a committed negative test.
- **Preserved-timestamp resurrection (never released; same re-review):** the freshness signature hashed paths+mtimes, so a unit rewritten as retired with its original timestamp restored kept ranking. The signature is content-derived now (per-file sha1); timestamp equality no longer certifies content equality. Cached index records are also fully validated (every record's id/path shape, containment, uniqueness — not just the first).
- **Duplicate unit ids resolved by authority, loudly:** a nested observation can no longer silently shadow a canonical unit out of the index — canonical outranks observation, same-tier ties are deterministic, every conflict is recorded on the index (`degraded` flag + conflict list), the generator CLI exits non-zero, and the per-turn hook surfaces a degraded-store warning.
- **Authority tier reaches the agent:** the per-turn hook now labels observation hits (`[observation]`) in the injected context instead of stripping the tier; body-search failure degrades to title-only with a visible health signal (stderr + `storeHealth()`) instead of silently.
- **One-hop edge expansion regression (never released; repro'd against v3.10.0):** the first union rewrite replaced magnitude scores with synthetic rank positions, which mathematically excluded every edge-expanded neighbor from the default top-3. Scoring is now per-arm max-normalized magnitudes; a neighbor of a strong hit competes again (edge-bearing fixture + regression test added — the old fixture had no edges, so the suite couldn't see this class).
- **Stale-cache anti-resurrection hole on standalone read paths (never released; same review):** `bm25Rank` (and the reasoning-tier shortlist `select-relevant-units.mjs`) accepted any parseable cached index, so a retired unit could keep ranking through the standalone CLI/harness path. All public retrieval entry points now load through the validating loader, and every reader is enrolled in the anti-resurrection guard test.
- Retrieval-event example in the startup protocol no longer stamps `usefulness_outcome` at retrieval time (self-graded at the wrong instant — usefulness is a later fact on the offered→exposed→attributed→outcome ladder).
- Doc truth: INSTALL/ARCHITECTURE now document the three shipped lifecycle hooks (they claimed "no hooks" since v3.9.0 shipped them); the startup protocol now says the per-turn retrieval hook is default-ON opt-out (it claimed default-off); `validate.mjs` is labeled NOT-PRODUCT-PATH (diagnostics only, never a release gate); USAGE lists the retrieval scripts.

### Removed
- The dense/ollama embedding arm (`embed-index.mjs`) — never released; deleted before this release per the standing rule that CORE runs no local models. The model-free BM25 + union-combiner half it contained now lives in `bm25.mjs`. Dense measurement, if it returns, is a pinned-embedder ceremony arm, not shipped plugin code.

## [3.10.0] — 2026-06-30

### Added

CORE now runs itself end to end — installing the plugin is the only step. Two new lifecycle hooks close the loop: a **SessionStart** hook makes `/core` the agent's first action of every session (you never type it), and a **SessionEnd** hook discharges the session close in the background (you never type `/finalize`). Memory bootstraps, stays current, and closes out on its own.

- **Self-invoking startup.** A SessionStart hook injects a directive so the agent runs `/core` before anything else. It leans on `/core`'s own bootstrap dedup (won't re-run if it already ran this session) and re-orients after a compaction. Opt out with `CORE_AUTOSTART=0`.
- **Self-discharging close.** A SessionEnd hook spawns a detached, recursion-guarded background close at session end; a startup catch-up backstops a missed fire (hard kill, no PATH, crash mid-run). The close runs through a **deterministic envelope** (`close-pass.mjs run`) that guarantees the marker lifecycle and mechanical maintenance around the LLM close — so the reliability spine can't be skipped by the agent. It discharges only owed work via a per-op completion marker and a single-flight lock; a crashed or failed close is detected and re-owed rather than falsely marked done. Opt out with `CORE_AUTO_CLOSE=0`.
- **Control-surface protection.** Every PROJECT.md write is edit-gated: edit-detection runs first in every path and a between-session user edit always wins (anti-resurrection holds; a catch-up render can never clobber your edit).
- **Close reflection.** The old fresh-eyes + summary steps became two reflection tasks on the close agent — resynthesis (capture what the session concluded) and a decision-gated perspective pass (turn the overconfidence/anti-smuggling lens on the session's own output). The session summary is now a one-line trace plus a short resume stub; full narrative on demand.
- **Forensic visibility.** Both lifecycle hooks append one JSONL line per fire to `~/.core/hooks-log.jsonl` (override `CORE_HOOKS_LOG_FILE`) recording the decision made — `inject` / `spawn` / `skip` / `close-complete` / `close-failed` with the reason. The spawned close agent's own output is captured to `~/.core/close-pass-last.log` (append, `0600`) so the background close isn't invisible.
- **Background close uses the subscription login by default.** The spawned close strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from its env so an unattended close doesn't surprise-bill an API key (and a dead/omitted key can't shadow the claude.ai login and kill the close). Opt back in with `CORE_CLOSE_USE_API_KEY=1`.

Behavior note: this changes turn-1 and session-end behavior for every install. Both hooks are opt-out via the env vars above. On Codex (no validated SessionEnd-equivalent) the close is startup-catch-up-only — same correctness, later timing.

### Security

- **The background close only runs in a registered CORE workspace.** The gate that decides whether to spawn the detached, tool-enabled close agent now requires the directory to be a workspace registered in `~/.core/index.json` (canonicalized with `realpathSync`), not merely a directory that happens to contain a `_memories/` folder. This prevents an attacker-supplied repo from triggering an autonomous agent over its own files. (Found by a pre-release adversarial security review.)

### Fixed

- **A failed background close no longer reports success.** The close now captures the `claude -p` exit status; a failed/killed/missing-binary finalize is marked `failed` (not `closed`) so the next startup re-owes and retries it, instead of the marker falsely claiming a completed close.
- **The single-flight lock can no longer strand forever.** A hard age ceiling makes a lock left by a `SIGKILL`'d process stealable even if its PID gets recycled, so closes can't silently stop happening. Lock acquisition and release are now transactionally coupled (a failed marker write releases the lock it took).
- Corrected stale `project_path` documentation: the schema and fork-check comment claimed the legacy field would be dropped in v3.8.0, but that drop never shipped — it remains a tolerant-read fallback until a dedicated migration removes it.

The test suite grew 739 → 771.

## [3.9.0] — 2026-06-28

This release makes the memory actively work for you mid-session instead of only at startup. The headline: per-turn retrieval is now live by default — on every prompt, the most relevant stored facts are surfaced into context automatically, so the agent stops failing to recall what it already knows. It also lands self-managed mechanical maintenance (the store keeps itself current without you invoking it) and the deterministic retrieval + integrity machinery underneath. Per-turn injection is opt-out (`CORE_RETRIEVAL_HOOK=0`). The test suite grew 681 → 739.

### Added
- **Per-turn retrieval, live by default.** A UserPromptSubmit hook surfaces the most relevant stored units into context on every prompt — automatic recall, not bootstrap-only. Registered in the plugin manifest; opt out with `CORE_RETRIEVAL_HOOK=0`. Lexical matching can occasionally surface a topical-but-irrelevant unit on an abstract query; injection is advisory, byte-capped, and fail-open (a reasoning-based de-noiser is the planned next step).
- **Self-managed mechanical maintenance.** `maintenance-run.mjs` keeps the indexes, summary index, ghost-duplicate cleanup, and PROJECT.md cap-check current via a cadence ledger — narrated (never silent), signature-gated (no work when nothing changed), wired into `/finalize` and `/process-memory`. Autonomous/unattended maintenance stays gated behind explicit preconditions.
- **Deterministic per-turn retrieval + summary index.** A lexical retriever (token overlap + one-hop edge expansion) over a compact `_lib/unit-summaries.json` index.
- **Bootstrap context-integrity marker + full PROJECT.md read.** The agent is told when its context was truncated, and reads PROJECT.md whole instead of a head slice.
- **Link-at-graduation + capture criteria.** Graduation writes denser edges; capture criteria add the forward-decision test and value/disposition capture.

### Changed
- **The summary index regenerates on source staleness** (a set-diff signature over the units), closing an anti-resurrection gap at the retrieval layer — a retired or deleted unit no longer lingers in retrieval results.
- **The project-path slug encodes the Windows drive colon**, so `~/.claude/projects/<slug>` is a valid directory on Windows.

### Fixed
- Windows CI portability: the drive-colon slug, the obligation-3 test fixture moved in-repo so CI can reach it, and an unused import that failed the lint gate.
- Metrics: versioned the in-context proxy (`proxy_version` 2) with an over-fire regression guard.

## [3.8.0] — 2026-06-28

A hardening pass built from a fresh-eyes audit of the whole shipped tree, a new first-class unit type, and a real Windows-portability fix. The audit produced 111 findings; remediation ran as 8 workstreams over 71 commits, touching scripts, protocols, docs, and CI. Day-to-day use of `/core` doesn't change — the deterministic layer underneath gets harder to break mid-operation and more honest about what it can claim. The test suite grew 528 → 681, and the Windows CI leg is now genuinely green (24 portability bugs the audit batch had shipped unverified are fixed).

### Added
- **`premise` unit type.** A first-class type for axioms — facts a decision can violate and be wrong by definition, distinct from `principle` (which guides). Premises are exempt from the staleness/archive-candidate check: a settled, rarely-touched axiom is correct, not stale.
- **CI.** Every push runs the full test suite on Linux and Windows, plus doc-drift, hooks-schema, lint, and release gates — docs that enumerate shipped skills or counts now fail the build when they drift from the tree.
- **`check-inbox.mjs`.** A mechanical pre-flight for inbox graduation — it reads the inbox and reports what's there before any judgment pass runs.
- **Shared `unit-vocab.mjs`.** One module owns the status/type/edge vocabulary for every script that reads units; the scripts no longer carry their own diverging copies, and a `retired` unit now demotes instead of slipping through the status checks.

### Changed
- **`CORE_ROOT` resolves through `resolve-plugin-root.mjs --print-root`.** One resolution line works under bash, zsh, Git-Bash, PowerShell, and CMD; the bash-only resolver block is gone.
- **`/finalize` Step 3 is now 16 numbered sub-steps with a recovery contract.** A failure resumes at the failed sub-step instead of restarting the whole closing pass; sub-steps that change the store are separated from the read-and-report passes.
- **Cold-start migration writes resume markers.** An interrupted migration picks up at the step that failed rather than re-running from the top.
- **The extension boundary is stated honestly.** The memory-extension reference now carries a SPEC-ONLY legend: layers that are built say so, layers that are specs awaiting a consumer say so, and the closed sets that don't extend locally are named.

### Fixed
- Docs no longer claim hooks ship via the plugin manifest — hook installation is documented as the manual step it actually is.
- Priority ranking honors bi-temporal suppression: an invalidated unit no longer ranks alongside live ones.
- Metrics resolve the session transcript by session id; file mtime is demoted to a label, so a concurrently-written transcript can't be misattributed.
- The metrics lock uses bounded, CPU-yielding retries instead of a 5-second busy-spin.
- A scalar `sources:` value in unit frontmatter now scores as one source instead of silently falling to the no-sources default, and the store validator nudges toward list form with a benign warning.
- **Windows portability.** 24 real bugs the audit batch shipped while assuming the Windows CI leg was green (it had never run clean): dynamic `import()` now uses `file://` URLs; path builders use `posix.join`; project slugs strip the drive colon; the Claude-projects home seam honors `USERPROFILE`; `fileURLToPath` no longer throws on a driveless file URL; and a top-level-await module that perturbed the test runner was hardened. Both test legs and the validate gate are green on Windows.

## [3.7.0] — 2026-06-07

A documentation release. CORE now ships a full command reference and an agent-compatibility map, the README leads with the memory architecture instead of the swarm, and the public docs read from a user's perspective rather than a contributor's. The `/organize-files` utility no longer ships — it was a general-purpose file-cleanup tool, separate from CORE's project-intelligence mission.

### Added
- **`USAGE.md`.** A full reference for the plugin — every command, protocol, and script, and how they fit together.
- **`llms.txt`.** An agent-compatibility map so other agents can read what CORE exposes without parsing the whole tree.

### Changed
- **README rewritten to be memory-forward.** The unit store and retrieval ladder lead; the multi-agent adversarial swarm is framed as one tool CORE reaches for, not the headline.
- **Public docs read from a user/agent perspective.** README, INSTALL, and ARCHITECTURE were stripped of developer scaffolding (decision-codes, provenance pointers, contributor-only framing) so a reader installing the plugin sees what it does, not how it's built.

### Removed
- **`/organize-files`.** The file-cleanup utility no longer ships with CORE — it was a general-purpose tool, separate from CORE's project-intelligence mission. The plugin now ships five companion utilities (`/finalize`, `/process-memory`, `/register-sources`, `/configure-project`, `/vibecheck`).

## [3.6.0] — 2026-06-07

`/orient` is now a deprecated no-op — typing it prints a notice and points you to `/core`, which does everything it used to, including a fresh readiness summary when you re-run it mid-session. Metrics capture runs by default now: CORE measures how well it recognizes your project across sessions and writes the results to local disk only, with a per-workspace and environment-variable opt-out. The classifier behind that measurement is PROVISIONAL — it isn't calibrated, so the readiness summary only flags an upward recognition-failure trend, never an absolute score. Underneath, the deterministic scripts got safer: writes to irreplaceable files are atomic, the CLI entry guards no longer silently no-op on symlinked installs, and diagnostics fail loudly instead of producing wrong-but-plausible output. The startup protocol loads its rare branches only when it needs them. The test suite grew 490 → 528.

### Deprecated
- **`/orient`.** Folded into `/core`: picking a thread back up, the readiness summary, edit detection, hygiene-log signals, the hot-section refresh, and source-registration readiness all run when you type `/core`. Re-running `/core` mid-session with no task re-composes a fresh readiness summary. `/orient` still resolves but is now a no-op that prints a deprecation notice — kept so existing muscle memory, scripts, and wrappers don't break. Use `/core`.

### Changed
- **Metrics capture defaults to on, opt-out.** CORE captures recognition metrics to local disk under `<project>/_metrics/`. Opt out per workspace with `metrics_enabled: false` in `workspace.json`, or globally with `CORE_METRICS_ENABLED=0`. Capture stays local — nothing leaves your machine. The classifier stays PROVISIONAL until a human-labeled set clears a 0.7-precision gate; every surface that shows a recognition signal says so, and the readiness summary only flags an upward trend.
- **Edge vocabulary adds `refines` and `amends`.** `refines` sharpens a prior decision without replacing it; `amends` modifies specific parts while the prior stands. Both are distinct from `supersedes`. Informal types (`relates`, `related`, `relates-to`) normalize to `cites`.
- **Startup loads its rare branches on demand.** The new-workspace and folder-rename paths live in `protocols/startup-conditional-loads.md`, read only when routing selects them. Cold-start migration stays inline. Returning sessions carry a lighter startup protocol.
- **`/finalize` validates the unit store.** It runs the schema and integrity check over `_memories/` as a closing step.
- **One root-resolution idiom across surfaces.** Scripts resolve from the skill's own base directory; `${CLAUDE_PLUGIN_ROOT}` is documented as not reliably injected into agent shell calls and used only as a fallback. Command bodies in `/finalize`, `/process-memory`, and validation share the one idiom.

### Fixed
- Writes to MEMORY.md and the decision and risk indexes are atomic — an interrupted write can't truncate them or cause a false drift report.
- The CLI entry guards in `metrics-init`, `validate-adversarial-artifacts`, and `audit-memory-boundary` canonicalize both sides, so they run instead of silently no-opping on symlinked installs.
- `/finalize`'s unit check runs both the schema and integrity passes (the flags previously collapsed to integrity-only).
- The validity supersession stamp tolerates CRLF line endings, so Windows/OneDrive-authored units get stamped.
- Diagnostics fail loudly instead of producing wrong-but-plausible output: `priority --today`, retrieval-skip flag parsing, the rollup's PROVISIONAL label on calibrated workspaces, and unreadable adversarial-artifact paths.
- The calibration worksheet is idempotent — a same-day re-run no longer double-counts turns toward the precision gate; capability-history appends are atomic.
- Malformed dates no longer fall through to a demote; a non-finite `--since-days` no longer selects every event; Codex array-form transcript events parse.
- Documentation corrected on shipped surfaces: authority ordering, hygiene verbs, cross-references, and counts.

## [3.5.0] — 2026-06-02

A scripts-hardening release — the full open set from an internal review of all 48 shipped scripts, closed as one pass. Nothing about how you use `/core` changes; the deterministic spine under it gets safer. Highlights: writes to your project's irreplaceable files (PROJECT.md, the archive, the workspace pointer) are now atomic, so an interrupted write can never leave a half-written or truncated file. The capability gates that protect destructive actions now fail closed honestly — a mutation surface that can't prove it's writable, or an adversarial run whose anti-anchoring gate is denied, no longer reads as "all clear." And the self-measurement instruments (the recognition classifier, its calibration gate) got more honest about what they can and can't claim. The test suite grew 445 → 482.

### Changed
- **Fail-closed mutation, enforced.** The adversarial-run gate no longer reports AUTHORIZED when the operation-scoped mutation gate was actually denied, and the collab-files target-surface probe degrades when it can't prove write access instead of silently passing. Both align with the fail-open-observation / fail-closed-mutation doctrine. (A configured collab-files repo that's offline will now show DEGRADED at startup rather than a false PASS — honest signal, not a failure.)
- **The recognition classifier is more honest.** Its in-context check now matches on word boundaries (a short term that was merely a substring of your large PROJECT.md no longer counts as "recognized"), it no longer treats ordinary hyphenated English like "opt-in" as a project term, and the previously-dead mechanics-failure discriminator is wired. Still PROVISIONAL until calibration clears.
- **Calibration gate requires coverage.** The classifier's 0.7-precision gate can no longer clear while whole recognition states sit unmeasured — every state present in the labels must be measured.

### Fixed
- Atomic writes for PROJECT.md / PROJECT-ARCHIVE.md / the workspace pointer (temp-file + rename) across all four hygiene mutators and the workspace fork-check — an interrupted write can no longer truncate them, and the fork-check writes the irreplaceable pointer last.
- The memory-visible canary probe now requires the *agent* to echo the token (injected memory text no longer false-passes it).
- Capability rows always carry the unconditional schema fields (`observed_at`/`harness`/`cwd`/`env_signals`) — the runner backfills any a probe omitted.
- Pipes in a decision/risk title no longer corrupt the generated index tables; the canary strip no longer deletes documentation prose that mentions the canary tag; `generate-memory-index --top <non-integer>` (or a missing target file) now refuses cleanly instead of silently thinning or crashing MEMORY.md; capability-drift no longer fabricates regressions from session-less rows or double-counts across stores; the retrieval-validation report no longer shows contradictory `FAIL | 1 | 1` rows.

## [3.4.0] — 2026-06-02

The instrumented-memory system (Phases 0–4) and the validity dimension. CORE now measures its own recognition — a per-turn classifier, a daily rollup, and an `/orient` signal — all privacy-gated and default-off, with the classifier honestly marked PROVISIONAL until a human-labeled calibration set clears a 0.7-precision gate. Units gain an optional world-time validity dimension (`t_valid`/`t_invalid`) that retrieval honors by suppressing invalidated facts. The whole thing is additive — a project that opts into nothing behaves exactly as on 3.3.0.

### Added
- **Instrumented-memory recognition loop (Phases 0–4).** Per-turn six-state classifier, daily metrics rollup + `/orient` recognition signal, and citation-resolver / stale-context / anticipation-gap detectors — all behind a privacy gate (default-off, opt-in per workspace via `metrics_enabled` / `CORE_METRICS_ENABLED`). The classifier is **PROVISIONAL**: uncalibrated until ~100 hand-labeled turns clear a 0.7-precision gate, and every surface says so. `/orient` only flags an upward recognition-failure trend, never an absolute level.
- **Validity dimension on units.** Optional `t_valid`/`t_invalid` world-time fields, `--as-of` point-in-time reconstruction, a storage-health `--metrics` readout, and Tier-2 retrieval suppression of invalidated units (`--include-invalid` walks cold history). Additive — units without the fields behave exactly as before.
- **Impact-propagation trace** over `depends-on` edges and **absence-with-deadline** detection.
- **Calibration harness** with a self-grading guard: precision is computed only from human labels, never the classifier's own output (the R-1 anti-self-confirmation guard).
- **Memory + metrics extension contracts** for downstream overlays: passthrough capture, additive detectors, and the `world-time-policy` source hook for populating `t_valid` from a source's own timestamps.
- **`orphan-detector`** — definition-of-done enforcement: every script must be reached by a skill and every protocol indexed.

### Changed
- **`demote-moves` archives completed `[x]` §Moves items on checkbox + age** rather than requiring all cited units to be in terminal status (the old gate never fired on real corpora and let PROJECT.md grow unbounded). `--strict` restores the old behavior; a large first batch is held until `--apply-large-batch` so a bulk migration of a user-owned file gets a look.
- **Validity is consolidated as a dimension on units** — read predicates in `priority.mjs`, field-validation in `check-units`, suppression in `graph-walk` — not a standalone subsystem.
- **Frontmatter parsers are CRLF-tolerant**; a `.gitattributes` normalizes line endings to LF (Windows/OneDrive checkouts).

### Fixed
- **demote-moves stub re-demotion**: an archive stub could re-demote itself across a date boundary, degrading the pointer trail. Now guarded. Citation, backtick, and future dates are no longer misread as completion dates.
- **`generate-memory-index` Windows no-op** (`fileURLToPath`); slug encoders handle Windows drive letters.
- Pre-release prose fixes (dev-meta leak, push-policy contradiction, stale references).

### Notes
- R-17 trust-based anti-anchoring on Claude Code remains **DEGRADED** — multi-agent analysis output is advisory-only and watermarked until independent acceptance. The physical-isolation proof that would close R-17 is separate and not in this release.

## [3.3.0] — 2026-06-01

Track B of the Codex co-existence workstream — the structural half: a project bootstrap/health-check for either harness, a real fork-check bug fix, and the supporting contract. Plus the workspace-identity field standardization and the R-17 adversarial-run-gate wiring that were already on `next`. Track B's pre-build `/core` review reshaped it: CORE ships no connector name-map (it ships the contract; the overlay owns the data) because a grep proved CORE hardcodes zero connector names.

### Added
- **`/configure-project` — a new companion skill (and `configure-project.mjs`).** Bootstraps and health-checks a project for the current harness: confirms the install + manifests, validates the memory store, resolves workspace identity (detect-only — never mutates), reports connector capability in two honest tiers, runs the capability probe, and generates `AGENTS.md` from a `CONTRACT.md` when one exists. The Codex-side counterpart to Claude Code's startup mandate; idempotent and report-only unless `--apply`. Wired as the Codex setup step in the Codex adapter. (CORE now ships seven companion utilities.)
- **Two-tier capability reporting.** The check distinguishes what a script can verify from disk (manifests, store validation, MCP servers *declared* in `~/.claude.json` — not verified reachable, capability-probe rows) from session-live questions only the running agent can answer (is a connector reachable + authed this session? the `~/.codex/config.toml` server list, which the script does not parse; the live two-harness check). The script never asserts a capability it cannot check.
- **`dryRun` mode for `workspace-fork-check`** — detect the fork decision without performing the multi-file mutation.

### Changed
- **Workspace-identity field standardized on `path`** across the schema, startup prose, and the fork-check writer. Legacy `project_path` stays read-tolerated for one release, then drops.
- **The R-17 adversarial-run-gate is now wired into `protocols/analysis.md`.** Multi-agent runs are classified AUTHORIZED / ADVISORY / BLOCKED at Phase 0; ADVISORY (the Claude Code norm under R-17) watermarks the synthesis and withholds canonical-mutation authority until independent acceptance. This makes R-17's degraded state *enforced*, not just labelled — it does not close R-17.
- **`source-registration-framework.md`** documents the overlay-owned `connector-map.json` contract and the script-visible/session-live capability boundary.

### Fixed
- **`workspace-fork-check` re-forked an already-registered workspace under a symlinked project root** (macOS `/tmp`→`/private/tmp`, OneDrive/Dropbox/iCloud sync roots). The fork decision compared paths with `resolve()` while the CLI entry-guard canonicalizes with `realpathSync`, so the live cwd and the registered index path differed by symlink-vs-real form and the workspace re-forked on every startup. Both comparison sides now canonicalize with `realpathSync` (resolve-fallback when the path is absent).
- **`generate-agents-md` crashed with an uncaught ENOENT when `CONTRACT.md` was absent.** It now skips cleanly (the common case for a project without an adopted contract); a present-but-malformed contract still throws loudly.

## [3.2.2] — 2026-06-01

A patch fixing a slug-encoding bug that broke MEMORY.md auto-refresh and the visibility canary on dotted usernames, plus three `check-units` validator false-positives. Folder-independent fixes for Codex co-existence, from a multi-source field report.

### Fixed
- **Slug-encoding bug broke `generate-memory-index` and `write-visibility-canary` on dotted usernames.** The project-path→slug encoding replaced `/` but not `.`, so a username like `David.Bates28` produced a slug (`-Users-David.Bates28-…`) that never matched Claude Code's real projects folder (`-Users-David-Bates28-…`). Two confirmed failures: `generate-memory-index`'s cross-project guard false-refused (MEMORY.md priority block couldn't auto-refresh — manual fix every finalize), and `write-visibility-canary` couldn't locate the right MEMORY.md and returned `memory_written: false`. Fixed with a single canonical `mapProjectPathToSlug()` helper (`/`, `\`, `.` → `-`) used at both sites; legitimate cross-project refusal is preserved (a genuinely different path still mismatches).
- **`check-units` rejected valid flow-style YAML arrays.** Inline `topics: [a, b, c]` was parsed as a scalar string, producing false `topics-format` warnings. The shared frontmatter parser (`priority.mjs` `_coerce`) now parses flow-style arrays as lists.
- **`check-units` false `dangling-edge` on `references-topic`.** Those edges target the controlled vocabulary (`topics.md`), not unit IDs; they're now exempt from the unit-existence check.
- **`check-units` exit code blocked startup on benign warnings.** A healthy store with orphan/stale warnings exited non-zero. New exit contract: `0` pass (incl. pass-with-benign-warnings), `1` degraded (non-benign warnings, still non-blocking), `2` hard fail (schema/enum/required-field/broken edge).
- **Legacy `capability-drift-log.md` left behind on upgrade.** Before v3.1.0 the drift log was written without the `_` prefix; the rename to `_capability-drift-log.md` left the old file in already-migrated projects, where `check-units` treats it as a malformed unit (6 schema FAILs). `analyze-capability-drift` now removes the legacy non-prefixed file when it writes the current one, so upgraders self-heal.

## [3.2.1] — 2026-05-31

A patch fixing a workspace-registration bug surfaced by on-box Windows use.

### Fixed
- **Workspace fork-check no longer spuriously re-forks every startup.** It matched index entries on `path`, but the workspace schema specifies `project_path` — so a schema-compliant entry was invisible to the path-match and the check kept forking the workspace (`-2`, `-3`, …) on each fresh session. It now reads `project_path || path` at both match points, recognizing both conventions. Distinct from the v3.1.x resolver fixes (those were plugin identity/authority; this is workspace registration).

## [3.2.0] — 2026-05-31

A structural release. `plugins/core/` becomes the single canonical tree (the dual-tree mirror is gone), and `/orient` now records retrieval events so retrieval-quality analysis measures real data. Transparent to users — `claude plugins update core@core` re-pulls from the new source.

### Added
- **`/orient` records retrieval events.** A resumption bootstrap now emits one retrieval-shaped row per load (`session-start` trigger), so `analyze-retrieval-quality` measures real retrievals instead of empty telemetry. The most common retrieval path was previously invisible to the corpus.

### Changed
- **Structural collapse — `plugins/core/` is the single canonical skill tree.** The top-level `skills/`/`hooks/` trees and the rsync mirror are removed; the Claude marketplace `source` is now `./plugins/core`, matching where Codex already read. Tests live at the repo root and no longer ship in the install bundle (install drops from ~2.4 MB to ~1.2 MB). One tree, both harnesses.
- Version source canonicalized on the `plugins/core` manifests; the repo root keeps only the marketplace listing.

## [3.1.1] — 2026-05-31

A patch release fixing two plugin-root resolver defects surfaced by on-box Windows validation (#45), both confirmed live on the shipped v3.1.0.

### Fixed
- **Windows authority classification.** `classifyAuthority` compared the resolved plugin root against forward-slash path literals while `homedir()` returns a backslash path on Windows, so every Windows install classified as `unknown` and its mutation gates failed closed. Both sides are now normalized to forward slashes before comparison (safe on POSIX, where backslashes can't appear in a path). (#45)
- **Identity DEGRADED on co-located manifests.** When the install root co-locates the Claude and Codex manifests (the shipped layout), the codex-first anchor walk always reported `manifest_harness: codex`, tripping the split-brain check and degrading identity on every Claude resolution. The resolver now re-points to the consuming harness's own manifest when it's co-located in the resolved root — before env reconciliation — and still flags genuine wrong-plugin cases where only the foreign manifest is present. (#45)

### Changed
- CI hardens the script-import glob guards and adds a Codex mirror parity gate.
- Dropped a redundant `RENDER_ONLY_ARTIFACTS` validator guard now subsumed by the `_`-prefix convention.

## [3.1.0] — 2026-05-31

A reliability release on top of v3.0.0: it hardens the startup `CORE_ROOT` resolver against a silent wrong-drive failure, adds a guard against cross-project memory contamination, and removes the Gemini harness (which never had a working callable-skill surface). MINOR rather than patch because it removes a harness and adds a register-sources capability note.

### Fixed
- **`CORE_ROOT` resolver hardened against silent wrong-drive failure.** The tier-3 fallback's inline `node -e` used a backslash regex that collapses in a shell's double-quotes into a compile-time SyntaxError `try/catch` can't catch — which left `CORE_ROOT` empty and resolved `node "/skills/..."` against the Git-Bash MSYS root on Windows, dying silently. Every `node "${CORE_ROOT}/..."` call site is now mechanically gated on the scripts dir, an unresolved root blanks `CORE_ROOT` and surfaces loudly in the readiness receipt instead of crashing, and the separator normalization moved to the shell. The SyntaxError was actually universal (verified on macOS); only the catastrophic empty-path consequence was Windows-specific.
- **`generate-memory-index` refuses cross-project writes.** The script took its `_memories` source and `--memory-md` target as independent path args and never checked they belonged to the same project; pairing one project's units with another's MEMORY.md silently overwrote the target. It now recovers the target's project identity from the Claude Code path mapping and refuses on mismatch.
- `capability-drift-log` render no longer trips the unit validator (underscore-prefixed so `check-units` skips it).
- Corrected the shipped-skill count to six (adds `register-sources`).

### Added
- `register-sources`: an advisory `platform_credentials` note — CORE flags the concept; the overlay owns the value.

### Removed
- Gemini harness support — the `.gemini-plugin` manifest, the `harnesses/gemini.md` adapter, the `generate-gemini-md` generator, and all Gemini detection/capability rows. Gemini CLI has no callable-skill surface, so CORE-on-Gemini relied entirely on the agent inferring the protocol — it didn't work in practice. The contract system now generates CLAUDE.md + AGENTS.md only.

## [3.0.0] — 2026-05-30

This release ships the instruction-surface generator system (CONTRACT.md → harness instruction files). It also includes the full v2.9 evidence-layer hardening, native Codex marketplace support for both repos, and a retrieval-quality analyzer fix that makes metrics fail honest when retrieval-shaped rows are absent. End-to-end retrieval-effectiveness proof remains open until startup/orient/refresh emit retrieval-shaped rows and expected/forbidden-memory scenarios pass. The MAJOR bump reflects the maintenance-model change: generating CLAUDE.md/AGENTS.md/GEMINI.md from a single CONTRACT.md changes how projects maintain instruction surfaces.

### Added (v3.0 — instruction-surface generator system)
- `skills/core/scripts/contract-format.mjs` — parses the canonical CONTRACT.md source format
- `skills/core/scripts/generate-claude-md.mjs`, `generate-agents-md.mjs`, `generate-gemini-md.mjs` — generate harness instruction files from CONTRACT.md
- `skills/core/scripts/migrate-to-contract.mjs` — bootstraps a draft CONTRACT.md from existing files; non-destructive
- Fail-closed release gate: `last_revised: unknown` or non-canonical `canonical_for` → exit 1
- `skills/core/scripts/audit-memory-boundary.mjs` — read-only sampled audit surfacing native-only memory entries as graduation candidates
- `skills/core/scripts/validate-adversarial-artifacts.mjs` — validates adversarial protocol artifacts (initial-frame, persuasion-log, mind-changes)
- `schemas/adversarial-artifacts.md` — schema spec for adversarial output artifacts
- `skills/core/scripts/record-retrieval-event.mjs` — validated retrieval-evidence producer that writes analyzer-visible rows and OTel `core.retrieval` spans
- Golden tests for all three generators + contract parser

### Added (v2.9 — evidence layer)
- `skills/core/scripts/analyze-retrieval-skip.mjs` — transcript-based scan for the recognition-failure signature; candidates not verdicts
- Byte-cap truncation detection in `capability/memory-visible-probe.mjs` — line-count check replaced with byte check (~24.4KB injection cap)
- Codex `function_call`/`custom_tool_call` extraction in `read-transcript.mjs` — flips `memory-accessed` from always-UNKNOWN on Codex to classifying
- `harnesses/claude-code.md` adapter modernization: Workflow/Teams, subagent_type catalog, ScheduleWakeup cadence default; doc-regression tests

### Added (Codex marketplace support)
- `plugins/core/` — self-contained Codex marketplace plugin directory; enables native `codex plugin marketplace add dbatesai/core-plugin --ref main && codex plugin add core@core`
- `scripts/sync-codex-plugin.sh` — sync helper for keeping plugins/core/ current
- CI gate verifying marketplace.json source.path integrity

### Open verification gates
- End-to-end retrieval-effectiveness proof remains `NOT-YET`: live startup/orient/refresh runs still need to use the producer to emit retrieval-shaped rows with selected unit IDs, tier path, suppression counts, context-pack size, and outcome/usefulness fields. **Forbidden-memory scenario gate is now wired** (PR #38 ships the validation gate that catches forbidden-unit hits in the top-5 candidate set); expected-memory precision/recall scoring was already in place. The remaining gap is live startup/orient/refresh actually CALLING the producer on each retrieval operation.

### Fixed
- `analyze-retrieval-quality.mjs` — gated on `isRetrievalShapedEvent()`; stops counting telemetry rows as retrieval proof; surfaces the split plainly
- `check-units.mjs` — render-only exemption narrowed to generated `capability-drift-log.md` only; real units mentioning the phrase still validate
- `protocols/startup.md` — removed stale "Codex has no equivalent auto-memory" text; aligned with `harnesses/codex.md §read-auto-memory`
- Anti-anchoring probe: `CLOSURE_TARGET` corrected from `v2.8.0` (never closed) to `v2.9+`
- `skills/finalize/SKILL.md` — added Step 3.5 ROADMAP.md regen (documented in ROADMAP header but missing from the skill)
- `validate.mjs` — negated-query exclusions: `no <term>` in a validation query is now parsed as an exclusion signal rather than a positive match. The Tier 1 simulator was previously dropping the `no` prefix and rewarding units that mentioned the term, which let stale runtime-probe memory into the top-5 even when better units were present. (Root cause found via core-codex validation: `no heartbeat` was rewarding a stale heartbeat-automation unit.)
- `validate.mjs` — forbidden-candidate gate: validation now scans the top-5 candidate set for units that should NOT appear; a forbidden hit now fails the run rather than silently passing. Live validation against core-codex surfaced a previously-hidden forbidden-memory miss (4/5 pass, 1 fail). This closes the "expected-memory and forbidden-memory scenario tests" open verification gate.
- `validate.test.mjs` CLI regression resolves the script from the test file location (same cwd-independence fix as #35 for the retrieval producer test)
- `record-retrieval-event.test.mjs` CLI regression now resolves the script from the test file's own location rather than the working directory — test passes when run from external project roots and installed plugin caches (Codex `/orient` probe caught this)
- `record-capability-snapshot.mjs` — adds project-local capability history fallback at `<project>/_metrics/capability-history/<workspace-id>.jsonl` for Codex sandbox environments where the primary `~/.core/workspaces/<id>/capability-history.jsonl` is outside the writable sandbox (EPERM/EACCES/EROFS/ENOTDIR errors). `analyze-capability-drift.mjs` reads both stores.

### Improved
- `protocols/startup.md` — inline `record-retrieval-event.mjs` call example with real field names pins agents to the actual schema; explicit warning against rejected alias fields (`session_intent_topics`, `highest_tier_reached`, `selected_units`) prevents first-call mistakes (Codex `/orient` probe caught the ambiguity)

## [2.8.1] — 2026-05-29

A patch fixing the visibility canary, which shipped broken in v2.8.0.

### Fixed
- `write-visibility-canary.mjs` now writes the canary as a **visible markdown line** instead of an HTML comment. A field bootstrap on 2026-05-29 proved Claude Code strips HTML comments when it injects `MEMORY.md` into context — the line-1 `<!-- CORE-VISIBILITY-CANARY -->` did not reach injected memory (injection began at the first `## ` heading) — and separately byte-truncates the injected copy at ~24.4KB. Both kept the canary out of context and blocked the memory-visible field-cycle PASS. The replacement regex now matches both the legacy HTML-comment form and the new visible form, so the upgrade is a clean in-place replacement with no accumulation. Tests cover the visible-not-comment invariant and the legacy-comment migration.

### Notes
- Independent adversarial review was still outstanding at release time; the release shipped with that flagged — a v2.8.2 is cheap if the review finds something.
- The memory-visible field-cycle PASS is observable at the next bootstrap from the canary already written to `MEMORY.md`, but it is not yet demonstrated. This release's role is durability: it makes the installed plugin emit the visible canary going forward, so `/finalize` stops reverting it to an HTML comment.

## [2.8.0] — 2026-05-29

This release folds in the v2.7 work that was never tagged — capability history, drift detection, the adversarial-run gate, and several new probes — and adds the v2.8 memory-visibility runtime plus the foundation scaffolding that v2.9 will wire up. There is no `v2.7.0` tag; its content ships here under 2.8.0.

### Added
- `skills/core/scripts/capability-history.mjs` — per-session capability snapshots in a JSONL store with an advisory file lock, so drift and regression analysis at `/finalize` and `/process-memory` read a real history instead of a single point.
- `skills/core/scripts/analyze-capability-drift.mjs` — reads that history and reports drift and regressions (a row that was PASS last session and is DEGRADED now, for instance).
- `skills/core/scripts/record-capability-snapshot.mjs` — appends the current session's snapshot to the history; runs at startup after the capability probe.
- `skills/core/scripts/capability/memory-visible-probe.mjs` — proves the auto-loaded memory was actually in the agent's context, not just present on disk, via a startup canary echo. Includes load-completeness detection: when injected memory is truncated, the row DEGRADES instead of reporting PASS. Wired and exercised.
- `skills/core/scripts/write-visibility-canary.mjs` — writes the canary token the next session echoes.
- `skills/core/scripts/capability/auto-memory-injection-probe.mjs` — checks whether the harness injected project memory at all.
- `skills/core/scripts/capability/instruction-surface-resolution-probe.mjs` — checks that CLAUDE.md / AGENTS.md instruction-surface precedence resolves the way the skill expects.
- `skills/core/scripts/capability/anti-anchoring-mechanism-probe.mjs` — surfaces R-17 as a DEGRADED-by-mechanism row rather than claiming a guarantee the harness can't enforce.
- `skills/core/scripts/instruction-surface-adapter.mjs` — dry-run core (inventory + patch plan, no writes) for the v3.0 instruction-surface adapter. Foundation only.
- `skills/core/scripts/read-transcript.mjs` — adapter verb that parses session transcripts (Claude Code + Codex message parsers; Gemini returns null; Codex tool-call extraction still pending). Built and unit-tested in isolation, **not yet wired to a consumer** — foundation for v2.9.
- `skills/core/scripts/capability/memory-accessed-probe.mjs` — store-selection tier that consumes read-transcript to tell "memory present" from "memory actually reached." Built and unit-tested, **not yet wired** — foundation for v2.9.

### Changed
- `skills/core/scripts/adversarial-run-gate.mjs` — consumer gate that enforces the anti-anchoring discipline, with a machine-readable decision enum.
- `skills/core/scripts/capability-probe.mjs` — probe-itself validation: a probe that crashes reports UNKNOWN with a probe-error reason instead of failing silently.
- `protocols/startup.md`, `skills/finalize/SKILL.md`, `skills/process-memory/SKILL.md` — wire capability history and drift snapshots into startup, finalize, and process-memory.

### Risks
- R-17 (trust-based anti-anchoring on Claude Code) is demoted to an honest anti-anchoring-mechanism row that reports DEGRADED-by-mechanism. The earlier 2.6.0 note said this "closes in v2.8.0" — what actually shipped is the honest demotion, not hard enforcement. The mechanism stays trust-based on Claude Code.

### Status notes
- `read-transcript` and `memory-accessed` are foundation: tested in isolation, not wired to any consumer, and do nothing at runtime yet. v2.9 wires them.
- The memory-visibility field-cycle PASS is a cross-session check — it confirms on a future bootstrap, not within this release.
- Every new script ships with unit tests under `tests/scripts/`; the script suite passes at cut.

## [2.6.0] — 2026-05-27

### Added
- `skills/core/scripts/resolve-plugin-root.mjs` — v2.6.0-δ: conflict-not-priority refactor of `detectConsumingHarnessSignal()`. Collects all env signals then classifies as unanimous/conflict/absent instead of first-match-wins. New `consuming_harness_signal_weight` field (`strong`|`weak`|`null`) threads through to row schema. `consuming-harness-conflict` evidence entry emitted when multiple harnesses detected. Block code `consuming_harness_signal_weak` for action profiles that require strong signals.
- `skills/core/scripts/capability/target-surface-collab-files-probe.mjs` — New target-surface capability. Five proofs: (1) files repo path exists, (2) git root matches configured path, (3) working tree state parseable, (4) remote URL matches expected, (5) write/push verified or marked unproven. Config source: descriptor's `surfaces.collab_files_repo` + `surfaces.collab_files_expected_remote` (Option A). Identity_status PASS only when all proofs agree; DEGRADED on root/remote mismatch; UNKNOWN on git failure.
- `skills/core/schemas/harness-capability-descriptor.json` — Two new action profiles: `installed-runtime-write` (installed-cache only) and `source-maintenance-write` (canonical-source only). `allowed_signal_weight: 'strong'` on `collab-files-mutating` and `project-memory-write`. `surfaces` block with `collab_files_repo` + `collab_files_expected_remote` config. `target-surface-collab-files` added to each harness's capabilities + `collab-files-mutating` requires_pass. **Note**: relocated from `scripts/capability/` to `schemas/` — descriptor is contract content, not script content; schemas/ is the correct home per Doctrine 2.
- `skills/core/references/architecture-doctrines.md` — Five doctrines with named first consumers: probe-before-propose, documentation-as-contract-reference, schema-consumer-coupling, fail-open-observation/fail-closed-mutation, doctrine-consumer-coupling.
- `protocols/startup.md` — Capability probe wire-in before readiness composition. Runs `capability-probe.mjs --startup`; writes `capability-state.json` to workspace; surfaces non-PASS rows with "continuing with degraded capability evidence" verbatim. All-PASS: silent per `feedback_readiness_only_escalations`.

### Changed
- `skills/core/scripts/capability-probe.mjs` — Extended `invokeProbe()` to handle `capability/`-prefixed delegate paths via dynamic import. Added `allowed_signal_weight` gate to `runPreAction()` with `consuming_harness_signal_weak` block code. Updated `detectConsumingHarness` comment to reflect conflict-not-priority behavior.

### Decision units
- capability-probe-distribution — probe approach per harness vs universal
- effective-script-root-as-identity-gate — script root as the hard identity signal
- fail-open-startup-fail-closed-mutation — mode separation doctrine
- schema-and-doctrine-consumer-coupling — consumer-cited schema lifecycle
- harness-docs-as-contract-reference — docs-as-contract doctrine
- harness-memory-authority-boundary — memory authority per harness
- trust-based-anti-anchoring-claude-code — degraded by mechanism; closes in v2.8.0

## [2.5.0] — 2026-05-27

### Added
- `skills/core/scripts/metrics-init.mjs` (266 lines) — T1 storage scaffold for metrics & observability v1. Idempotent per-workspace setup; library + CLI entry.
  - Non-Windows: default storage at `<project>/_metrics/{traces,payloads,queue}/`.
  - Windows-with-OneDrive: detection via path-substring + `.ini`-scan (UTF-16LE; Personal + Business<N> account dirs); redirects to `~/AppData/Local/core-metrics/<workspace-id>/`. Method (a) catches the common Documents-redirection case; method (c) catches non-default sync setups.
  - Detection-method results logged to `~/.core/workspaces/<id>/metrics/scaffold.log` for forensic trail. Resolved storage path pinned to sibling `storage-path.txt` for write-time consumers.
  - Stub README at project location when storage is redirected — preserves grep-discoverability and points user at actual location.
  - `CORE_METRICS_FORCE_PROJECT_LOCAL=1` and `CORE_METRICS_FORCE_APPDATA_FALLBACK=1` env-var escape hatches; both short-circuit detection.
- `skills/core/scripts/demote-state-narrative.mjs` (~320 lines) — §State narrative compaction. Demotes §State bullets to `PROJECT-ARCHIVE.md §State` when ALL three conditions hold: strict `*Backed by ...*` footer citation present, all cited units in terminal status (`resolved`/`archived`/`superseded`/`closed` — mirrors `demote-moves` for cross-script symmetry), AND the most-recent backing-unit `updated:` date is >60 days old. Conservative defaults match `demote-moves` — no citation, missing unit, or any-active-unit → keep. **Default mode is dry-run in v1** (only `--apply` writes) because §State demotion is materially riskier than §Moves demotion and the criteria are tuned for §State-heavy non-CORE corpora that haven't been exercised yet. The flip to apply-default waits on cross-corpus validation against `all-in-mesh-redemption` or similar. Older citation styles fall into the no-citation bucket by design. 36 unit tests cover the full classification matrix plus the dry-run-vs-apply contract.

### Changed
- `skills/core/scripts/log-event.mjs` (+100 lines, then +25 lines) — added OTel-format dual-write per spec §17.7 transition path. Legacy JSONL write at `_sessions/<date>/<filename>.jsonl` is byte-identical to before (existing analyzers untouched). New OTel-format span lines land at `<storage>/traces/<session-id>.jsonl` where `<storage>` is resolved via `resolveStoragePath()` honoring scaffold-time pin (preserves (g.5) AppData redirect on Windows+OneDrive). Session id resolves via a four-step chain: explicit option → `CLAUDE_CODE_SESSION_ID` (Claude Code's native env var) → `CODEX_THREAD_ID` (Codex Desktop, observed `019e6287-...` shape, empirically confirmed) → sentinel `no-session-context`. New exports: `resolveStoragePath`, `resolveSessionId`, `traceLogPath`, `eventToOtelSpan`, `SCHEMA_VERSION` (semver `1.0.0`). Schema version on every emitted span.
- Cross-environment empirical validation on Mac and Windows 11. 41 unit tests across `metrics-init.mjs` and `log-event.mjs` cover mode coverage, UTF-16LE fixture handling, false-positive guard, cross-phase integration invariant ("dual-write traces land in pinned location, NOT in project"), and the four-step session-id resolution chain.
- `skills/finalize/SKILL.md` — Step 3 hygiene pass gains a `demote-state-narrative` bullet positioned after `compact-project.mjs`, with the v1 dry-run-default discipline named explicitly and the flip-to-apply gate documented.

### Notes
- v2.5.0 bundles two threads of follow-through work that landed end-to-end this release: **T1 Phase 1+2 of the metrics & observability v1 work** per spec `docs/specs/2026-05-25-metrics-and-observability-spec.md` (post-synthesis design, §17.12 v1 scope), and **Phase 1c of the memory architecture redesign** (Phase 1a + 1b already shipped in v2.3.0). T2 (SessionStart/Stop/SessionEnd hooks per WR-1/WR-2/WR-3 + RL-1/RL-3) and T3 (augmentation-event correlation per AS group) are upstream future work; the storage substrate ships first because every later layer depends on it.
- Five collab-recorded design corrections empirically caught during the 30-fire metrics collab — captured in `obs-20260526-pseudo-code-discipline-before-lock` for graduation review.
- Phase 1c first-fire dry-run on CORE PROJECT.md returned `0 demoted, 15 kept` as expected — CORE's §State backing units are all `status: active` (decisions are durable architectural artifacts on this corpus). The deeper criteria-vs-corpus mismatch finding — that the demote-* terminal-status set doesn't align with the actually-used `active` / `retired` vocabulary in CORE's 233-unit corpus — is captured in `obs-20260527-demote-terminal-status-corpus-mismatch` for follow-up alignment of both `demote-moves` and `demote-state-narrative`.

## [2.4.1] — 2026-05-26

### Changed
- `skills/core/protocols/startup.md` — "Compose the readiness summary" section now opens with a "Before composing — view memory" paragraph instructing the agent to re-check the auto-memory it loaded earlier (especially cross-project feedback memories) before writing the first turn. Closes a recognition-failure mode where memory was loaded but not consulted at composition time. Mirrors Anthropic's memory-tool system prompt ("always view your memory directory before doing anything else"). Part of the measurement window running through 2026-05-31.

## [2.4.0] — 2026-05-25

### Added
- `skills/core/harnesses/gemini.md` — Gemini harness adapter. Status: `draft — unverified` (Phase 1 design complete; Phase 2 probe rounds pending). Maps `spawn-subagent`/`spawn-team` to `invoke_subagent`, `send-message` to `send_message`, `await-completion` to implicit reactive wakeup, `schedule` to the `schedule` tool, `save-recall-note` to `<appDataDir>/brain/<conversation-id>/scratch/`. `hook-register` and `read-auto-memory` are documented drops.
- `.gemini-plugin/plugin.json` — Gemini harness manifest, version locked to `2.4.0`.
- CI step: "All harness manifests report same version" — `ci.yml` now enforces lockstep across `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `.gemini-plugin/plugin.json` on every PR and push.

### Changed
- `skills/core/protocols/harness.md` — `detect-harness()` now returns `gemini` as a named harness alongside `claude-code` and `codex`.
- `skills/core/harnesses/codex.md` — `read-auto-memory` section corrected. Old text said Codex has no auto-memory. Corrected to: Codex can inject memory-like context when `features.memories = true` (experimental, gated by `no_memories_if_mcp_or_web_search`). Treat injected memory as harness-local recall; run a startup probe before relying on it for bootstrap behavior.
- `.codex-plugin/plugin.json` — bumped from stale `2.0.1-dev.20260521.5` to `2.4.0` in lockstep with all other manifests.
- `RELEASE.json` — updated to v2.4.0 with `gemini` added to `targets`, `manifests`, and release notes.
- `skills/finalize/SKILL.md`, `skills/process-memory/SKILL.md`, `skills/register-sources/SKILL.md` — path derivation rule updated from "On Codex" to "On Codex and Gemini".
- `skills/orient/SKILL.md` — Gemini path derivation example added alongside existing Claude Code and Codex examples.
- `.github/workflows/version-check.yml` — now checks `.codex-plugin/plugin.json` and `.gemini-plugin/plugin.json` version against `.claude-plugin/plugin.json`; any mismatch fails CI.
- `.github/workflows/ci.yml` — manifest validation step now parses `.codex-plugin/plugin.json`, `.gemini-plugin/plugin.json`, and `.agents/plugins/marketplace.json` in addition to the existing Claude manifests.

### Fixed
- `skills/core/scripts/generate-memory-index.mjs` (bug 3.1) — `spliceSection` no longer throws when `## Top project units` is absent from MEMORY.md. Instead it appends the section at the end of the file and emits a one-line notice to stderr. Idempotent on the next run. Affects workspaces that adopted CORE before this section became a contract (e.g. `local-llm-build`, early BBLens installs).
- `skills/core/scripts/analyze-retrieval-quality.mjs` (bug 3.2) — `buildReport` now counts distinct calendar dates from event `ts` timestamps instead of unique `ev.session` IDs (which were never written). Previously `Sessions analyzed: 0 | Events: 2` when events existed but lacked a session field — now correctly shows `Session dates in window: 1 | Total retrieval events: 2`. Label updated from "Sessions analyzed" to "Session dates in window" to match the counting semantics.
- `skills/core/protocols/startup.md` (bug 3.3) — CORE_ROOT resolver node snippet now calls `.replace(/\\/g, '/')` before emitting the install path. On Windows via Git Bash, `installPath` carries OS-native backslashes; the replacement ensures the shell variable carries a forward-slash path compatible with bash string operations.
- `skills/core/scripts/generate-memory-index.mjs` (bug 3.4) — `path.relative()` result now converted with `.replace(/\\/g, '/')` before being embedded in a markdown link. On Windows, `path.relative()` returns OS-native backslash separators which break markdown link resolution.

## [2.3.3] — 2026-05-24

### Changed
- `scripts/compact-project.mjs` renames `HARD_CAP_BYTES` → `SOFT_TARGET_BYTES` (still 70000). The script never refused to write at this threshold — it only emits an advisory event. The old name implied enforcement the behavior never had. `HARD_CAP_BYTES` remains exported as a back-compat alias; the `project-md-over-cap` event payload now carries both `soft_target` and `hard_cap` (same value) for the same reason. Warning prose updated from "over hard cap" to "over soft target" with explicit "advisory only" framing. Tests updated to assert both the new name and the back-compat alias.

## [2.3.2] — 2026-05-24

### Fixed
- `scripts/generate-memory-index.mjs` now emits project-root-relative paths (`_memories/foo.md`) instead of `dirname(MEMORY.md)`-relative paths. Claude Code resolves MEMORY.md links against the session CWD (the project root), not against the harness-managed `~/.claude/projects/<encoded>/memory/` folder where MEMORY.md lives. The previous behavior produced long `../../../../...` traversals — accidentally fine on CORE-on-CORE, but on BBLens (OneDrive-synced project root) the traversal went through cloud storage and was actively brittle. Reported from a downstream project's first live run.
- `scripts/generate-memory-index.mjs` description fallback now cascades through frontmatter `description:` field and first non-blank body line before giving up with `(description pending)`. The prior H1-only fallback produced `(description pending)` for every unit on projects whose unit files start prose directly after frontmatter without a markdown H1 — including BBLens. Reported from a downstream project's first live run.

### Internal
- `renderPriorityBlock()` no longer accepts a `memoryMdPath` parameter; it derives the project root from `dirname(memoriesDir)`.
- New exported helpers: `extractFirstBodyLine(text)`, `resolveDescription(existing, fm, text)`.
- Test suite: 497 → 508 (+11 regression tests for both bugs and the description cascade).

## [2.3.1] — 2026-05-24

### Added
- `/process-memory` Step 0 now catches "source-pull deferral" patterns — sentinel content references found during external-source sweeps but not actually fetched. Backstop when in-loop discipline slips in the Phase 2 sweep.
- New `scripts/generate-memory-index.mjs` mechanically regenerates the "## Top project units" section of MEMORY.md from `priority.mjs` ranking. Preserves existing one-line descriptions for units that remain in top-N; falls back to the unit's H1 for newly-promoted units; idempotent (re-runs with no underlying change write nothing).

### Changed
- `/finalize` Step 5 (Claude Code branch) now calls `generate-memory-index.mjs` for the priority block instead of asking the agent to rewrite manually. Curation pass for the surrounding sections (Recent activity, Feedback pointers, H1-fallback refinement) stays inline.

### Fixed
- `/core` startup: `CORE_ROOT` resolution from `~/.claude/plugins/installed_plugins.json` now handles the array-of-installs shape correctly. The prior resolver assumed an object shape, so the fallback silently returned empty and startup printed a "CORE plugin root not resolved" warning even when the plugin was correctly installed. User-scope install is preferred when present; first entry otherwise.

## [2.3.0] — 2026-05-24

### Added
- Phase 1b: `scripts/demote-moves.mjs` auto-demotes closed `[x]` §Moves bullets to `PROJECT-ARCHIVE.md §Moves` when the most-recent backing-unit `updated:` date is >30 days old AND all cited units are in terminal status. Conservative defaults: bullets with no backing-unit citation never demote; bullets with any missing or still-active cited unit never demote; max(updated) across cited; never destructive (move-with-pointer + one-line stub). Auto-applies; `--dry-run` kept as inspection mode.
- Hot-tier 500-token budget enforcement in `scripts/hot-section.mjs`. `applyHotSection()` throws `HOT_SECTION_OVER_BUDGET` when synthesis exceeds the cap (with `allowOverBudget: true` escape hatch).
- `scripts/compact-project.mjs` gains `HARD_CAP_BYTES = 70000` and a new `--section-sizes` flag for inspection-only breakdown.
- New `scripts/log-event.mjs` shared structured-logging helper. Writes JSONL events to `<project>/_sessions/<YYYY-MM-DD>/<filename>` with silent-skip on bad project dir.
- Four new event kinds: `hot-section-synthesis` / `hot-section-over-budget` to `retrieval-log.jsonl`; `demote-moves` / `demote-moves-large-batch` / `compact-project` / `project-md-over-cap` to `hygiene-log.jsonl`.

### Changed
- `/finalize` Step 3 (Memory hygiene): runs `demote-moves` then `compact-project` before ghost-file cleanup. Concurrency order is `demote-moves → compact-project → hot-section`.
- `/process-memory` Step 5 rewritten as "PROJECT.md tier discipline" — both scripts run in order; auto-applies.
- `/orient` Step 4 (elapsed-time signals) surfaces recent `demote-moves-large-batch` and `project-md-over-cap` events from `hygiene-log.jsonl`.
- `protocols/data-storage.md` documents the two log files and the four Phase 1b event kinds.
- PROJECT.md management framing: humans MAY read or edit but the agent treats the file as agent-managed; effectiveness measured via hygiene-log events, not user review. Auto-applies on day 1 (dry-run is the agent's own inspection mode, not a permanent user-ratification gate).

## [2.2.0] — 2026-05-23

### Added
- `protocols/clusters.md` — cluster naming discipline doc (Phase 1a). Three valid naming triggers (project-shape at intake, traversal-pattern emergence, deliberate investigation), ratification gate, render-vs-load defaults, when-NOT-to-cluster guidance.
- Source-of-authority hierarchy intake in `protocols/startup.md` new-workspace path and `protocols/hygiene.md` on-demand setup. Captures governance ordering across project artifacts (PRD > HLSD > RTM > chat) as a per-project decision unit. Distinct from the per-external-source authority.
- `by-when` optional frontmatter field on `open-question` units. Documented in `protocols/data-storage.md`; validated by `check-units.mjs` (ISO date format + wrong-type warning).
- Open-question staleness check at `/orient` Step 4 — surfaces past-due `by-when` items in the readiness summary. Michelle probe mechanism.
- `scripts/hot-section.mjs` — new script with `candidates` / `apply` / `current` / `clear` subcommands. Inserts agent-composed 5-7 line "Right now" section atop `PROJECT.md` between front-matter and §What & Why, bracketed by HTML-comment markers for idempotent find/replace.
- `/orient` Step 4.5 — conditional hot-section refresh on candidate/intent shift.
- `/finalize` Step 2.6 — post-render hot-section refresh capturing session outcome.

### Changed
- **Push policy reframed from universal-confirm to per-user, per-repo with safe default.** Pushes now follow the user's established policy; default when no policy named is confirm every push (safe for new users). Documented in `SKILL.md §Core principles` and `protocols/data-storage.md §"Push policy is per-user, per-repo"`. No behavior change for users who haven't named a policy.

## [2.1.0] — 2026-05-23

### Added
- Ghost-file cleanup in `/process-memory` and `/finalize` — both commands now automatically remove macOS cloud-sync duplicate files from the unit store on each run
- CHANGELOG.md — human-readable release history, Keep a Changelog format
- Version-check CI gate — all PRs to main must bump version in lockstep across plugin.json and marketplace.json
- Auto-tag GitHub Action — pushes to main automatically create a `vX.Y.Z` git tag from plugin.json
- `/cut-release` slash command — LLM-orchestrated release flow with 11 pre-flight checks, dry-run mode, CHANGELOG update, and stranded-release recovery (F-SR)
- `/sync-next` slash command — back-merges main into next after release PR merges

### Changed
- Plugin version is now read from `plugin.json` throughout the skill — `skills/core/VERSION` removed as a redundant (and stale) source; startup.md reads `../../.claude-plugin/plugin.json` from the skill base directory

## [2.0.2] — 2026-05-23

### Added
- Source-registration framework — source-agnostic intake protocol, `/register-sources` slash command, confidence-assignment guide, source-pull-log analyzer
- Codex harness adapter — full CERT-READY at BUILD 20260521.5; dual plugin manifest (Claude Code + Codex)
- Workspace fork-check script — auto-forks copied workspaces, prevents identity confusion

### Fixed
- CLAUDE_PLUGIN_ROOT resolution fallback in startup.md (symlink + non-env environments)
- Symlink resolution on CLI entry guards (realpathSync across all 10 scripts)
- dc77-invariants test now covers `${CORE_ROOT}` as derived plugin-root anchor

## [2.0.1] — 2026-05-20

### Added
- Codex harness adapter (initial) — cross-harness verb contract + adapter pattern
- Downstream plugin cleanup — 8 scripts updated

### Changed
- core-plugin marketplace path corrected: `./` → `./plugins/core`

## [Earlier releases]

History prior to v2.0.1 not retroactively reconstructed. See `git log` and `_summaries/` in the CORE dev repo for context.
