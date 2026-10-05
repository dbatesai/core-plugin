# Workspace Schema


A **delivery workspace** is the agent's **operational meta** about **source data** — the input material (code, docs, requirements) being analyzed or developed. The workspace tracks *how the agent has been working on the project* (session log references, cross-session agent observations, operational telemetry). The **project synthesis** — the authoritative record of state, people, moves, decisions, risks, and notes — lives at `<project>/PROJECT.md`, never in the delivery workspace. The workspace is agent-owned operational memory; `PROJECT.md` is user-controlled project truth. Delivery workspaces are **always-live** — there is no status field, no discrete lifecycle states, no "active/inactive/completed" enum. A delivery workspace exists or it doesn't.

**Where it lives:** inside the project, at `<project>/_core/<harness>/`, one subfolder per harness (`claude-code`, `codex`, …) so two harnesses working one folder never write the same file. `<project>/_core/` carries its own `.gitignore` (`*`), so git ignores it by default. A file someone force-adds is still committable, and CORE does not trust a tracked state file. Every read and write goes through `scripts/project-state.mjs`; state is trusted only when its `stamp` — an HMAC over (path, harness, install id) keyed with `~/.core/install-secret` — verifies, so a `_core/` that arrives in a clone or a download is set aside unread. The project root is the folder the user registered by running `/core` there (`~/.core/projects.json`).

---

## Manifest File (`<project>/_core/<harness>/workspace.json`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `project_id` | string | yes | A label for the project, minted at random the first time the harness works it (a migrated project keeps its old workspace id here). Never used to find a path. The metrics export seeds its project pseudonym from it. A copy of the folder gets a new one. |
| `harness` | string | yes | The harness this subfolder belongs to. |
| `name` | string | no | Human-readable project name. |
| `created` | string (ISO 8601) | no | When the project was first scaffolded. |
| `session_log_refs` | array of strings | no | Optional list of paths to session log directories at `<project>/_sessions/YYYY-MM-DD/`. When present, the workspace *points to* them; it does not hold them. |
| `agent_name` | string | no | The agent's emergent name for THIS project. Set by the agent itself the first time it works a project (picked to fit the project, then persisted here so it survives sessions). When absent, the session identity falls back to the name in `<project>/_core/_agent/agent-profile.md`. One agent lineage spans every project — the profile carries the shared voice, patterns, and user model; this field carries only the per-project name. |
| `agent_notes` | string | no | Free-form agent operational notes — cross-session observations about how the project is being worked on. Project facts (decisions, risks, moves, people) live in `<project>/PROJECT.md`, not here. *Manifests written by older versions may carry the legacy key `dm_notes` — read it as the same field, and migrate the key when you next rewrite the manifest.* |
| `contract_path` | string | no | Path to the project's `CONTRACT.md` — the canonical source the per-harness `CLAUDE.md`/`AGENTS.md` are generated from. **Omit when the contract is at the default `<project>/CONTRACT.md`** (the generators resolve that automatically); set it only for nonstandard layouts (e.g. `docs/CONTRACT.md`). An absent field does not establish non-adoption: check the default contract path. No contract at the resolved path means there is no contract to generate or drift-check. |
| `metrics_disclosure_shown` | boolean | no | Written by `scripts/metrics-disclosure.mjs` the first time it runs for this project and harness. `true` means the first-run metrics-capture notice has already appeared in a readiness summary — never show it again. Absent/`false` = not yet shown. |
| `metrics_enabled` | boolean | no | `false` opts this project out of the metrics/evidence producers that honor the capture gate (`CORE_METRICS_ENABLED=0` is the environment-wide opt-out). The base local retrieval/outcome JSONL event writer remains on; this flag is not a guarantee that no operational event is written. |
| `turn_capture` | boolean | no | `false` turns the every-turn evidence record off for this project (`CORE_TURN_CAPTURE=0` everywhere). See `protocols/data-storage.md` §"Two capture streams". |
| `rich_context_capture` | boolean | no | **Retired.** Ignored if present. The maintenance pass reports any leftover `rich-context/` stream directory and leaves it in place for explicit user removal. |

Beside the manifest, single-owner files: `last-active` (ISO timestamp, written by `index-registry.mjs touch`), `last-bootstrap.json` (`index-registry.mjs bootstrap`), `stamp`. Write the manifest with `index-registry.mjs manifest --set-json`, never by hand-building a path.

**What is NOT in the manifest:** timeline, milestones, `delivery_risk`, decisions, risks, action items, people. These are **project facts** and belong in `<project>/PROJECT.md` — the user-controlled synthesis. The workspace holds operational meta (how the agent has been working on the project), not the project truth itself.

---

## Example

```json
{
  "project_id": "5f0c2a7e9b1d4c38a6e2f1b07d93c4a1",
  "harness": "claude-code",
  "name": "Example Project",
  "created": "2026-03-15T10:00:00Z",
  "session_log_refs": [
    "/Users/<user>/Documents/Projects/example-project/_sessions/2026-03-15",
    "/Users/<user>/Documents/Projects/example-project/_sessions/2026-03-28"
  ],
  "agent_notes": "User prefers concrete examples over abstract framings. Push back hard on scope creep. Cross-reference with the design doc at docs/architecture.md when discussing structural choices."
}
```

---

## Always-Live Principle

There is no `status` field. Workspaces do not transition through states like "created → active → paused → completed." This is a deliberate design decision.

Why: Discrete lifecycle states create false precision. A workspace is not "paused" — it simply hasn't been worked on recently. A workspace is not "completed" — the agent may return to it. The `last-active` timestamp combined with the project's own `PROJECT.md §State` gives the agent everything needed to prioritize without forcing a state machine.

If a project is truly no longer relevant, its folder goes; there is no "archived" state.

---

## Project Registration

Every project is registered at:

```
~/.core/projects.json
```

The registry is an array of project roots:

```json
[
  { "path": "/Users/<user>/Documents/Projects/example-project", "registered_at": "2026-03-15T10:00:00Z" }
]
```

It lists the projects for cross-project reads and exports, and it's the auto-close trust anchor: a repo can't plant an entry. Operational detail lives in each project's `_core/<harness>/`; project state lives in `<project>/PROJECT.md` — never read the workspace to learn what the project is about.

**Writes go through `scripts/index-registry.mjs` only** (`register`, under the registry lock) — hand-editing `projects.json` races concurrent sessions and is forbidden per `protocols/data-storage.md §Shared-write concurrency`. The legacy `~/.core/index.json` and `~/.core/workspaces/<id>/` are read by `scripts/migrate-workspace-state.mjs`, which copies each project's old state into its `_core/<harness>/`; nothing writes them for new projects.

---

## Design Notes

- **Operational meta only.** The workspace records how work has been done on the project, not what the project is about. Project state lives in `<project>/PROJECT.md` — including any risk assessment, decisions, action items, and people involved. The workspace schema does not duplicate or override them.
- **`agent_notes` is free-form.** Agent scratch space for operational observations. No structure imposed. Use it for cross-session hunches, user interaction patterns, agent-side process observations — never for facts that belong in `PROJECT.md`.
- **Session logs are referenced, not contained.** Session logs live at `<project>/_sessions/YYYY-MM-DD/`. The workspace points to them via `session_log_refs`; logs are not stored inside the workspace.
- **No `delivery_risk` field.** Risk is a project fact. It lives in `PROJECT.md §Decisions & Risks`. The agent reads from `PROJECT.md` — the workspace does not carry redundant state.
- **No Delivery Plan.** Task breakdowns, phase sequencing, and next-session priorities are tracked in `PROJECT.md §Moves`, not in a separate Delivery Plan artifact.
