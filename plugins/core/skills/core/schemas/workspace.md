# Workspace Schema


A **delivery workspace** is the DM's **operational meta** about **source data** — the input material (code, docs, requirements) being analyzed or developed. The workspace tracks *how the DM has been working on the project* (session log references, cross-session DM observations, operational telemetry). The **project synthesis** — the authoritative record of state, people, moves, decisions, risks, and notes — lives at `<project>/PROJECT.md`, never in the delivery workspace. The workspace is DM-owned operational memory; `PROJECT.md` is user-controlled project truth. Delivery workspaces are **always-live** — there is no status field, no discrete lifecycle states, no "active/inactive/completed" enum. A delivery workspace exists or it doesn't.

**Two-file pattern:** A workspace uses two `workspace.json` files with different purposes:

1. **Pointer** (`<source-data>/workspace.json`) — minimal file in the project root. The harness resolves workspace context from the working directory by finding this file. Created during Phase 3B.
2. **Manifest** (`~/.core/workspaces/<id>/workspace.json`) — full metadata, timeline, and DM observations. The operational record.

---

## Pointer File (`<source-data>/workspace.json`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workspace_id` | string | yes | Unique workspace identifier |
| `name` | string | yes | Human-readable workspace name |
| `created` | string (ISO 8601) | yes | When the workspace was first registered |
| `data_path` | string | yes | Path to workspace data directory (`~/.core/workspaces/<id>/`) |

---

## Manifest File (`~/.core/workspaces/<id>/workspace.json`) — Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workspace_id` | string | yes | Unique workspace identifier |
| `name` | string | yes | Human-readable workspace name |
| `path` | string | yes | Absolute path to the source data's root directory (where `PROJECT.md` lives). *Canonical field as of 2026-06-01. The legacy name `project_path` is still read-tolerated (the planned v3.8.0 drop did not happen); it stays a tolerant-read fallback until a dedicated migration removes it.* |
| `created` | string (ISO 8601) | yes | When the workspace was first registered |
| `last_active` | string (ISO 8601) | yes | Last time the DM performed work in this workspace. Updated automatically. |
| `session_log_refs` | array of strings | no | Optional list of paths to session log directories at `<project>/_sessions/YYYY-MM-DD/`. When present, the workspace *points to* them; it does not hold them. |
| `dm_notes` | string | yes | Free-form DM operational notes — cross-session observations about how the project is being worked on. Project facts (decisions, risks, moves, people) live in `<project>/PROJECT.md`, not here. |
| `contract_path` | string | no | (v3.0) Path to the project's `CONTRACT.md` — the canonical source the per-harness `CLAUDE.md`/`AGENTS.md` are generated from. **Omit when the contract is at the default `<project>/CONTRACT.md`** (the generators resolve that automatically); set it only for nonstandard layouts (e.g. `docs/CONTRACT.md`). Absent field = the project hasn't adopted the contract→generator system, and the contract-drift release gate is skipped. |

**What is NOT in the manifest:** timeline, milestones, `delivery_risk`, decisions, risks, action items, people. These are **project facts** and belong in `<project>/PROJECT.md` — the user-controlled synthesis. The workspace holds operational meta (how the DM has been working on the project), not the project truth itself.

---

## Example

```json
{
  "workspace_id": "ws-example-project",
  "name": "Example Project",
  "path": "/Users/<user>/Documents/Projects/example-project",
  "created": "2026-03-15T10:00:00Z",
  "last_active": "2026-03-31T14:30:00Z",
  "session_log_refs": [
    "/Users/<user>/Documents/Projects/example-project/_sessions/2026-03-15",
    "/Users/<user>/Documents/Projects/example-project/_sessions/2026-03-28"
  ],
  "dm_notes": "User prefers concrete examples over abstract framings. Push back hard on scope creep. Cross-reference with the design doc at docs/architecture.md when discussing structural choices."
}
```

---

## Always-Live Principle

There is no `status` field. Workspaces do not transition through states like "created → active → paused → completed." This is a deliberate design decision.

Why: Discrete lifecycle states create false precision. A workspace is not "paused" — it simply hasn't been worked on recently. A workspace is not "completed" — the DM may return to it. The `last_active` timestamp combined with the project's own `PROJECT.md §State` gives the DM everything needed to prioritize without forcing a state machine.

If a workspace is truly no longer relevant, the DM removes it from the index. There is no "archived" state.

---

## Workspace Registration

All workspaces must be indexed at:

```
~/.core/index.json
```

The index is an array of workspace summary objects:

```json
[
  {
    "workspace_id": "ws-example-project",
    "name": "Example Project",
    "path": "/Users/<user>/Documents/Projects/example-project",
    "last_active": "2026-03-31T14:30:00Z"
  }
]
```

The index provides the DM a single file to scan when prioritizing across workspaces. Operational detail lives in each workspace's `workspace.json`; project state lives in `<project>/PROJECT.md` — never read the workspace to learn what the project is about.

---

## Design Notes

- **Operational meta only.** The workspace records how work has been done on the project, not what the project is about. Project state lives in `<project>/PROJECT.md` — including any risk assessment, decisions, action items, and people involved. The workspace schema does not duplicate or override them.
- **`dm_notes` is free-form.** DM scratch space for operational observations. No structure imposed. Use it for cross-session hunches, user interaction patterns, DM-side process observations — never for facts that belong in `PROJECT.md`.
- **Session logs are referenced, not contained.** Session logs live at `<project>/_sessions/YYYY-MM-DD/`. The workspace points to them via `session_log_refs`; logs are not stored inside the workspace.
- **No `delivery_risk` field.** Risk is a project fact. It lives in `PROJECT.md §Decisions & Risks`. The DM reads from `PROJECT.md` — the workspace does not carry redundant state.
- **No Delivery Plan.** Task breakdowns, phase sequencing, and next-session priorities are tracked in `PROJECT.md §Moves`, not in a separate Delivery Plan artifact.
