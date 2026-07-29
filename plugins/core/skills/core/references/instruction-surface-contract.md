# Instruction-Surface Contract (v3.0)

What it is: one canonical `<project>/CONTRACT.md` is the authoritative source of a project's agent instructions; the per-harness files — `CLAUDE.md` (Claude Code), `AGENTS.md` (Codex) — are **generated** from it, not hand-maintained. This is the v3.0 maintenance-model change: you edit the contract, you regenerate; you don't edit the harness files in parallel and hope they stay in sync.

Read this when a project asks to adopt the contract system, when you're editing a contract, or when a release surfaces a contract-drift gate.

## The pieces (all ship as plugin scripts under `skills/core/scripts/`)

- `contract-format.mjs` — the shared core. `parseContract` (frontmatter + `##` sections + `### <harness>-only` subsections, with schema validation), `renderForHarness`, `parseOverrides`, deterministic provenance, and `generateForHarness` (the body every generator calls).
- `generate-claude-md.mjs` / `generate-agents-md.mjs` — thin per-harness wrappers. Modes: `--mode write|check|dry-run`.
- `migrate-to-contract.mjs` — bootstraps a **draft** contract from a project's existing harness files.

## CONTRACT.md shape

```markdown
---
schema_version: 1.0
contract_id: <project-slug>      # [A-Za-z0-9._-] only (frontmatter-injection guard)
canonical_for: ["claude-code", "codex"]
maintained_by: <author>
last_revised: 2026-05-30          # REQUIRED for determinism — see below
---

# Project Contract
## Identity & Voice            ← canonical: emitted to every harness
## Project-Specific Rules      ← canonical: emitted to every harness
## Harness-Specific Sections
### claude-code-only           ← emitted only to CLAUDE.md
### codex-only                 ← emitted only to AGENTS.md
```

Canonical sections (everything except the Harness-Specific block) go to every generated file; each `### <harness>-only` subsection is appended only to its harness's file.

## Determinism — the load-bearing property

Generated output is a pure function of the contract: `generated_at` is the contract's `last_revised` (never wall-clock), and `contract_hash` is the sha256 of the contract bytes. So the same contract regenerates **byte-identically**. That is what makes `--check` meaningful: any difference is a hand edit, never a clock tick. If `last_revised` is missing, `generated_at` falls back to `unknown` and the generator warns — set it.

## The adopt workflow

1. **Migrate (draft):** `node migrate-to-contract.mjs --id <slug> --claude CLAUDE.md --codex AGENTS.md --last-revised <date> --write CONTRACT.md`. Shared lines → canonical, unique → harness-only. The output is a **DRAFT** — the migrator refuses to overwrite an existing `CONTRACT.md` without `--force`, and it never auto-adopts.
2. **Review with the user.** The draft is a starting point; the user edits and accepts. Never silently replace a project's own instruction files — that's the user's authorship.
3. **Generate:** `node generate-<harness>-md.mjs --contract CONTRACT.md --mode write` for each harness in `canonical_for`. Record the contract location in `workspace.json` `contract_path` only if it's nonstandard (default `<project>/CONTRACT.md` resolves automatically).
4. **Enforce:** `/cut-release` pre-flight #13 runs `--mode check` for each harness when a `CONTRACT.md` exists; drift blocks the release. No contract = check skipped.

## Overrides

When a harness needs something the contract doesn't cover, put it in `<harness>.md.override` (e.g. `CLAUDE.md.override`). It's appended to the generated file inside a `BEGIN/END OVERRIDE` separator and tracked by `override_block_hash` (over raw bytes). Overrides **add**; they cannot delete contract content (to remove content for one harness, edit that harness's `-only` section).

## Cross-harness honesty

The only per-harness facts in the generators are the harness name and the output filename (`HARNESS_OUTPUT`). Everything else is shared. A harness absent from `canonical_for` triggers a warning if you generate for it. This keeps the system harness-agnostic — the contract describes the project, the generators map it to each surface.

## When there is no CONTRACT.md (the common case)

Behavior is asymmetric per harness — intentional, but it has to be known:

- **Claude Code:** the project usually already has a `CLAUDE.md` (hand-written or `/init`-generated). CORE leaves it alone — no contract means no generation and no drift checking.
- **Codex:** there is no instruction surface unless someone writes one. `configure-project --apply` is deliberately a no-op without `CONTRACT.md` (it reports `skipped-no-contract`); it never invents an `AGENTS.md`. A Codex project that wants agent instructions either adopts the contract system (workflow above — `migrate-to-contract.mjs` will draft from any existing harness file) or hand-writes `AGENTS.md`.

Net effect: a Codex user without a contract can end up with no instruction surface at all. When `configure-project` reports `skipped-no-contract` on a project that also has no `AGENTS.md`, say so and name the two options — don't leave the project silently bare.

## Remaining caveats

`audit-memory-boundary.mjs` ships as a memory-authority audit (sampled, read-only) and runs in `/process-memory`, but its conflict-detection scope is deliberately deferred — describe it as shipped-with-conflict-detection-deferred, not complete.

There is no separate instruction-surface adapter (inventorying arbitrary surfaces and planning CORE-block upserts across them): everything such an adapter would reach for is covered by the contract-generator path above (`generate-<harness>-md.mjs`), which actually writes. A wrapper author wanting a CORE-owned block injected into a harness surface uses that path.
