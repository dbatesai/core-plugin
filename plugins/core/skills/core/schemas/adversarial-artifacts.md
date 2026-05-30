# Adversarial artifact schema (v2.9/v3.0)

The durable, in-repo contract for the three artifacts CORE's anti-anchoring discipline produces. `validate-adversarial-artifacts.mjs` enforces this. (The proposal + Hale's review that shaped it lived in the dev workshop; this file is the shipped source of truth.)

These artifacts are how we know the adversarial process actually ran. They prove the discipline *executed and recorded itself* — they do NOT prove physical isolation. R-17 closure (physical anti-anchoring) needs a staging manifest + the empirical Workflow spike; these schemas are necessary, not sufficient, for that.

## `initial-frame.json` — one per agent, written in Phase 1 before peer exposure
| Field | Required | Check |
|---|---|---|
| `schema_version` | yes | equals `"1.0"` |
| `agent` | yes | non-empty string |
| `role` | yes | non-empty string |
| `ts` | yes | ISO 8601, parseable |
| `peer_exposure` | yes | must be `false` — a **declared invariant** (self-asserted), not isolation proof. The mechanical proof is the staging manifest, cross-checked separately. |
| `frame.key_claims` | yes | non-empty array |
| `frame.confidence` | optional | one of `low \| medium \| high \| foundational` (DC-94 categorical) |

## `persuasion-log.jsonl` — one event per line (inter-agent persuasion)
| Field | Required | Check |
|---|---|---|
| `schema_version` | yes | equals `"1.0"` |
| `ts` | yes | ISO 8601, parseable |
| `from_agent`, `to_agent` | yes | must appear in the initial-frame agent set (cross-check) |
| `claim` | yes | non-empty |
| `shifted` | yes | boolean; if `true`, `from_position` + `to_position` required |

## `mind-changes.jsonl` — one event per line (intra-agent position change)
| Field | Required | Check |
|---|---|---|
| `schema_version` | yes | equals `"1.0"` |
| `ts` | yes | ISO 8601, parseable |
| `agent` | yes | must appear in the initial-frame agent set |
| `field`, `from`, `to` | yes | non-empty |
| `persuaded_by` | yes | `self`, or an agent in the initial-frame set |

## Cross-artifact integrity (errors, not warnings)
Logs cannot name participants who never produced an initial frame. When initial frames are present, every `from_agent`/`to_agent`/`agent`/`persuaded_by` (except `self`) referenced in the logs must resolve to a framed agent. This is the difference between validating isolated JSON shapes and validating that an adversarial process plausibly ran.

## Empty-persuasion-log policy — mode-dependent
- **advisory** (default): an empty persuasion log after adversarial phases is a WARNING (`process-suspect`) — legitimate consensus is rare but possible; advisory review shouldn't hard-fail it.
- **authority**: if a run claims Phase-3 adversarial pressure and feeds an authority/release gate, an empty persuasion log is a hard FAIL (`valid:false`).
