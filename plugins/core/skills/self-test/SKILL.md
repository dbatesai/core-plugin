---
name: self-test
description: DEPRECATED shim (v3.14.0) — the blind memory self-test moved behind the single metrics door as "/metrics self-test". This shim exists so existing habits and scripts keep working for one release; it delegates to the same round machinery and prints a pointer. Removal scheduled for v3.15.0. Use /metrics self-test directly.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Task
---

# `/self-test` → moved to `/metrics self-test`

This command was folded into the single `/metrics` door (v3.14.0). Tell the user in one non-fatal line — *"/self-test is now `/metrics self-test`; running it there"* — then follow `skills/metrics/SKILL.md` §"`self-test` mode" exactly. Same machinery, same blindness discipline, nothing lost. This shim is removed in v3.15.0.
