# Capability Row Schema

The contract every capability row carries. Producers (`*-capability-probe.mjs` scripts) write to this shape; consumers (pre-action gates, startup readiness, drift detection in v2.7) read it. Per DC-98, this markdown IS the contract — consumers cite anchors here rather than re-deriving the field semantics.

**Schema version:** 1.0.0 (additive minor bumps preserve backward compatibility; major bumps require coordinated consumer update)

## Identity quality (`identity_status`)

The four-state enum. **Identity quality is one dimension; mutation permission is a separate dimension.** Do not overload `identity_status` with action gating — that's what `mutation_permitted` is for.

| Value | Meaning | When to use |
|---|---|---|
| `PASS` | All corroborating evidence agrees; identity is durable. | env vars match manifest, manifest parses cleanly, workspace and harness signals align |
| `DEGRADED` | One or more pieces of evidence disagree or are missing; identity is best-effort. | stale env var, manifest id mismatch, workspace claims different harness than resolved |
| `NOT-YET` | The capability is named in the descriptor but the probe hasn't completed. | cold start, dependency missing, probe scheduled but not yet run |
| `UNKNOWN` | The probe failed or returned uninterpretable data. | parse failure, walk failure, transport error, unhandled exception |

## Mutation gating (`mutation_permitted`)

Separate dimension. A row can be `identity_status: PASS` with `mutation_permitted: false` for non-identity reasons (read-only context, dry-run flag, explicit denial). And `DEGRADED` identity necessarily blocks mutation, but the consuming code reads `mutation_block_reason`, not `identity_status`.

```yaml
mutation_permitted: true | false                # REQUIRED
mutation_block_reason:                          # REQUIRED when mutation_permitted=false
  - identity-degraded
  - identity-not-yet
  - identity-unknown
  - read-only-context
  - dry-run-flag
  - explicit-denial
  - missing-prerequisite
```

The doctrine layer rule: **identity is what we know; mutation is what we permit; consumers read the gate, not the enum.**

## Evidence fields

The receipt trail. Every identity classification carries the observations that led to it.

```yaml
observed_at:            # ISO 8601 timestamp (e.g. "2026-05-27T13:00:00Z")
harness:                # claude-code | codex | gemini | unknown
workspace_id:           # string from <cwd>/workspace.json, or null
cwd:                    # process.cwd() at probe time
env_signals:            # object: env var name → resolved value (or null if unset)
                        #   Include at minimum: CLAUDE_PLUGIN_ROOT, CODEX_PLUGIN_ROOT,
                        #   GEMINI_PLUGIN_ROOT, CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID
effective_script_root:  # realpath of the executing module's plugin-root anchor
manifest_path:          # absolute path to the resolved plugin manifest, or null
plugin_id:              # plugin name from manifest, or null
plugin_version:         # plugin version from manifest, or null
cache_path:             # installed-cache path, or null for source-repo runs
authority:              # canonical-source | installed-cache | harness-workspace | unknown
freshness:              # session-stable | operation-volatile | content-volatile
refresh_policy:         # never | per-session | per-operation | per-read
evidence:               # array of observation records (see below)
```

### `evidence[]` shape

Each item in the `evidence` array records one observation that fed the identity classification:

```yaml
- source: env-var-CODEX_PLUGIN_ROOT
  value: "<HOME>/.codex/plugins/cache/<marketplace>-core/<version>"
  agrees_with_others: true
  weight: corroborating               # corroborating | primary | conflicting

- source: realpath-walk
  value: "<HOME>/.codex/plugins/cache/<marketplace>-core/<version>/skills/core/scripts/resolve-plugin-root.mjs"
  agrees_with_others: true
  weight: primary

- source: manifest-read
  value: { plugin_id: "core", plugin_version: "2.6.0" }
  agrees_with_others: true
  weight: primary
```

When evidence pieces conflict (env var differs from realpath, etc.), the conflicting entries get `agrees_with_others: false` and `weight: conflicting`. Identity classification reads the array and decides PASS/DEGRADED/UNKNOWN based on agreement.

## Capability identification

```yaml
capability_id:          # stable id, kebab-case
                        #   e.g. "plugin-root-resolution", "session-id-source",
                        #        "harness-detection", "git-write-access"
capability_name:        # human-readable label
                        #   e.g. "Plugin root resolution"
capability_kind:        # identity | runtime | mutation | observation
```

| `capability_kind` | Meaning | Examples |
|---|---|---|
| `identity` | Reports what the system IS. | plugin-root-resolution, harness-detection, session-id-source |
| `runtime` | Reports what the system CAN do mechanically. | git-write-access, node-version-compatible, env-vars-loadable |
| `mutation` | Reports whether a specific mutation surface is gate-passable. | collab-event-write, project-md-write, _memories-write |
| `observation` | Reports whether a specific observation surface is reachable. | otel-span-emission, hygiene-log-readable |

## Stability + refresh policy

```yaml
freshness:              # session-stable | operation-volatile | content-volatile
refresh_policy:         # never | per-session | per-operation | per-read
```

| `freshness` | Meaning | `refresh_policy` typically is |
|---|---|---|
| `session-stable` | Value doesn't change within a session; safe to cache. | `per-session` |
| `operation-volatile` | Value can change between operations; refresh before each gate check. | `per-operation` |
| `content-volatile` | Value depends on filesystem/network content; refresh on every read. | `per-read` |

Most identity rows are `session-stable / per-session`. Mutation rows that read network/filesystem state (git-write-access) are `operation-volatile / per-operation`. Content rows are rare in v2.6.0.

## Schema version

The schema itself versions to allow non-breaking field additions:

```yaml
schema_version: "1.0.0"  # this version — semver
```

Major version bumps require coordinated update of every consumer cited in this file's "Known consumers" section below. Minor bumps add fields; patch bumps clarify semantics without changing the wire shape.

## Known consumers

Per DC-98 (schema-consumer coupling), this schema lives only as long as it has named consumers. When a consumer is retired, remove its entry. When the consumers list is empty, the schema graduates to a deprecated doc.

| Consumer | Where | What it reads |
|---|---|---|
| `capability-probe.mjs --startup` | v2.6.0 | full row, surfaces non-PASS rows to readiness summary |
| `capability-probe.mjs --pre-action collab-files-mutating` | v2.6.0 | `mutation_permitted` + `mutation_block_reason`; fails closed if not permitted |
| (v2.7) drift detector | v2.7.0 | reads `evidence[]` to compute content-hash-based drift |
| (v2.7) regression report | v2.7.0 | reads multi-session row history |

## Producer expectations

Every script that writes capability rows MUST:

1. Stamp `schema_version` on every row it emits.
2. Populate `observed_at`, `harness`, `cwd`, `env_signals` — these are unconditional.
3. Populate `identity_status` and the matching evidence — never leave `UNKNOWN` without an evidence entry naming the failure.
4. Populate `mutation_permitted` based on the identity outcome AND any operation-specific gating reason; populate `mutation_block_reason` when `false`.
5. Never write `PASS` without at least one `weight: primary` evidence entry.
6. Never write `DEGRADED` without at least one `weight: conflicting` evidence entry.

## Consumer expectations

Every script that reads capability rows MUST:

1. Check `schema_version` and refuse rows above its own known-major version.
2. Read `mutation_permitted` to decide whether to proceed with a gated action; do NOT re-derive from `identity_status`.
3. When surfacing a row to the user, narrate `identity_status` and `mutation_block_reason` separately — they answer different questions.
4. Honor `freshness` + `refresh_policy` when caching; never cache a `content-volatile` row across operations.

## Relationship to DC-98

This schema is itself an instance of the doctrine it serves. The doctrine says: "schema lives only as long as its consumer." The "Known consumers" section above is the load-bearing list. When the consumers list goes empty, this file gets archived; the schema doesn't outlive its purpose.
