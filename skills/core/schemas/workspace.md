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
| `project_path` | string | yes | Absolute path to the source data's root directory (where `PROJECT.md` lives) |
| `created` | string (ISO 8601) | yes | When the workspace was first registered |
| `last_active` | string (ISO 8601) | yes | Last time the DM performed work in this workspace. Updated automatically. |
| `session_log_refs` | array of strings | no | Optional list of paths to session log directories at `<project>/_sessions/YYYY-MM-DD/`. When present, the workspace *points to* them; it does not hold them. |
| `dm_notes` | string | yes | Free-form DM operational notes — cross-session observations about how the project is being worked on. Project facts (decisions, risks, moves, people) live in `<project>/PROJECT.md`, not here. |

**What is NOT in the manifest:** timeline, milestones, `delivery_risk`, decisions, risks, action items, people. These are **project facts** and belong in `<project>/PROJECT.md` — the user-controlled synthesis. The workspace holds operational meta (how the DM has been working on the project), not the project truth itself.

---

## Manifest File (`~/.core/workspaces/<id>/workspace.json`) — Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `current_swarm` | object \| null | Tracks the DM's active swarm for this workspace (v1.2.x Observatory feature). Written by `update_swarm_status` with patch semantics; read by `read_dashboard_state`. Absent or null when idle. |
| `swarm_artifact_id` | string \| null | Identifier for the Cowork Swarm Live View artifact. Set by `update_swarm_status` when the artifact is first created; persists across multiple swarm runs in the same workspace. Used to call `update_artifact()` in subsequent sessions. |

---

## current_swarm Field (v1.2.x, Observatory feature)

Tracks the DM's active swarm for this workspace. Written by `update_swarm_status` (patch semantics); read by `read_dashboard_state`. Absent or null when idle.

```json
"current_swarm": {
  "status": "idle | running | halted | complete",
  "phase": "Phase 2: Critic Analysis",
  "agent_count": 5,
  "agent_names": ["Vellum", "Fold", "Spar", "Reed", "Vex"],
  "agent_roles": {
    "Vellum": "generator",
    "Fold": "generator",
    "Spar": "critic",
    "Reed": "critic",
    "Vex": "monitor"
  },
  "task_summary": "F9 install-time permissions review",
  "started_at": "2026-05-12T22:00:00.000Z",
  "updated_at": "2026-05-12T22:15:00.000Z",
  "completed_at": null
}
```

**Status lifecycle**

| Status | Written when |
|---|---|
| `"running"` | Phase 1 spawn; also when resuming after a halted state |
| `"halted"` | DM calls `AskUserQuestion` mid-swarm; graceful halt |
| `"complete"` | Swarm accepted; result delivered |
| `"idle"` (or field absent) | Reset to `"idle"` (or omitted) at session start |

**Related top-level field:** `swarm_artifact_id` (string \| null) is stored at the manifest root (not inside `current_swarm`) so it persists across multiple swarm runs for the same workspace. Set by `update_swarm_status` when the Cowork Swarm Live View artifact is first created. Used by the DM to call `update_artifact({ id: swarm_artifact_id, ... })` in subsequent sessions.

---

## Example

```json
{
  "workspace_id": "ws-core-framework",
  "name": "CORE Framework",
  "project_path": "/Users/dbates/Documents/Projects/CORE",
  "created": "2026-03-15T10:00:00Z",
  "last_active": "2026-03-31T14:30:00Z",
  "session_log_refs": [
    "/Users/dbates/Documents/Projects/CORE/sessions/2026-03-15",
    "/Users/dbates/Documents/Projects/CORE/sessions/2026-03-28"
  ],
  "dm_notes": "Framework is self-referential — changes to CORE affect how CORE evaluates those changes. Extra adversarial rigor needed. User prefers direct pushback on stale assumptions."
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
    "workspace_id": "ws-core-framework",
    "name": "CORE Framework",
    "project_path": "/Users/dbates/Documents/Projects/CORE",
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
