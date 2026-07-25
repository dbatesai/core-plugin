---
name: metrics-package
description: DEPRECATED shim (v3.14.0) — the anonymized memory-efficacy export moved behind the single metrics door as "/metrics export". This shim exists so existing habits and scripts keep working for one release; it delegates to the same exporter and prints a pointer. Removal scheduled for v3.15.0. Use /metrics export directly.
user-invocable: true
allowed-tools:
  - Read
  - Bash
  - Glob
---

# `/metrics-package` → moved to `/metrics export`

This command was folded into the single `/metrics` door (v3.14.0). Tell the user in one non-fatal line — *"/metrics-package is now `/metrics export`; running it there"* — then follow `skills/metrics/SKILL.md` §"`export` mode" exactly. Same exporter, same anonymization boundary, same exit-code honesty. This shim is removed in v3.15.0.
