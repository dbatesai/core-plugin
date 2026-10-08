# What CORE writes, and what git sees

Every path CORE creates, sorted three ways: **durable** (project content, meant to be committed),
**instance** (this machine's working state, ignored by git) and **private** (conversation content
or answer keys, ignored by git and owner-only where the OS allows). One project folder holds all of
it; `~/.core` keeps only the keys and registry named at the end.

An ignore file CORE writes starts with the line `# Written by CORE: …`. CORE writes one only when
none is there and never edits one it finds. When a file the user already has leaves a CORE file
visible, re-includes one, or git already tracks one, `maintenance-run` reports it. It changes
nothing, because a tracked file is the user's call to untrack. Writers that run every turn only
make sure the ignore file exists, so a turn never waits on git. A project whose `.git` is a link or
pointer file (a worktree or submodule) is reported as not checked: the repository it names is
outside the folder.

## Durable — committed with the project

| Path | What it is |
|---|---|
| `PROJECT.md` | The six-section synthesis the user controls |
| `_memories/*.md`, `_memories/observations/`, `_memories/archive/`, `_memories/cold-storage/` | Canonical units |
| `_memories/INDEX-*.md`, `_memories/inbox.md` | Navigation indexes and the raw intake |
| `_summaries/` | Session summaries |
| `_sessions/<date>/` (everything not listed below) | Session notes people and agents write |
| `_outputs/` | Deliverables: reports, `research/` with its `index.json`, `swarm-effectiveness/`, `metrics-package/` |
| `_tests/self-test/` curated gold sets | Test inputs people review |
| `_metrics/.gitignore`, `_metrics/README.md` | The metrics folder's own rules and explanation |

## Instance — this machine's working state, ignored

| Path | Rule lives in | Writers |
|---|---|---|
| `_core/` (all of it: `<harness>/`, `_agent/`, `_hooks/`, `_scratch/`, `_package/`, `_project-only/`) | `_core/.gitignore` = `*` | project-state, project-only, project-artifacts |
| `_memories/_lib/` | `_memories/_lib/.gitignore` = `*` | state-cache, generate-summary-index, enrichment-sidecar, lifecycle-detect |
| `_memories/_close.lock*`, `.*.lock*`, `.*.tmp-*`, `_close-marker.json`, `_maintenance-state.json`, `_pm-state.json`, `_capability-drift-log.md` | `_memories/.gitignore` | close-pass, decorate-graph, lifecycle-core, maintenance-run, analyze-capability-drift, `/process-memory` prose |
| `_sessions/<date>/{retrieval,hygiene,outcome,self-test,priority}-log.jsonl` | `_sessions/.gitignore` (these names only) | log-event and its callers |
| `_metrics/turn-capture-health.json`, `judgment-log.jsonl`, `scorecard-log.jsonl`, `.turn-capture.lock`, `.judgment.lock`, `.scorecard.lock` | `_metrics/.gitignore` = `*` except itself and `README.md` | turn-capture, hindsight-judge, scorecard, metrics-init |

## Private — conversation content and answer keys, ignored

| Path | Rule lives in | Why private |
|---|---|---|
| `_metrics/turn-capture/<date>.jsonl` | `_metrics/turn-capture/.gitignore` = `*`, and `_metrics/.gitignore` | Each turn's prompt and delivered context |
| `_tests/self-test/round-*/`, `auto-author-state.json` | `_tests/self-test/.gitignore` | Generated answer keys and run state |
| `_core/<harness>/artifact-receipts/` | `_core/.gitignore` | Consent and publication records |

## Outside the project — `~/.core`

| Path | Status |
|---|---|
| `install-secret`, `install-id`, the machine lock identity | Kept: the keys that sign project state |
| `projects.json`, `index.json`, `index.lock` (enrollment only) | Kept: the registry |
| `local/<key>/declined-adopt`, `pending-adopt-<harness>.json`, `adopted-sibling-stamps` | Kept: adoption consent records |
| `migration-manifest.json`, `migration-manifest.lock`, `workspaces/<id>/MOVED.md` | Read-only history: an older install wrote them. The migration now reads the manifest if present, takes no account-wide manifest lock, writes nothing into the legacy `workspaces/` folders, and records what migrated in the project's signed per-harness receipts and `_core/legacy-moved.md` |
| `migrate-harness-table.json` | Optional input the user supplies; CORE never writes it. An entry is `{harness, evidence}`, or `{disposition: "retained-history", evidence}` to keep a registered old workspace as history without importing it (no harness label allowed) |
| `agent-profile.md`, `dm-profile.md`, `topics.md`, `agents/`, `task-configs/` | Read-only history; copied into a project once by `import-agent-notes.mjs` |
| `research/`, `state-cache.json`, `local/<key>/<harness>/`, `artifact-receipts/`, `workspaces/<id>/` | Read-only history; copied only on an explicit ask (`--research`, the legacy-cache importer) or by the one-time migration |

Harness-owned files (`~/.claude/`, `~/.codex/`, transcripts) are the harness's. CORE reads them where
a feature needs to and writes only its own pointer index in the harness memory folder.
