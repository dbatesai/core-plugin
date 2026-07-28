#!/usr/bin/env node
/**
 * retrieve-context-hook-codex.mjs — Codex entry point for the per-turn retrieval hook.
 *
 * Thin wrapper, not a copy: sets CORE_HOOK_HARNESS='codex' EXPLICITLY (never inferred from
 * ambient env vars — those are undocumented on Codex) then
 * delegates to the shared implementation in retrieve-context-hook.mjs. Pure JS, no shell env-var
 * prefix syntax, so this works identically on POSIX and Windows (.mjs only).
 *
 * Registered on Codex's UserPromptSubmit event via hooks-codex.json. See
 * harnesses/codex.md §hook-register for the registration. This file's correctness against the
 * DOCUMENTED Codex contract is checked by this repo's tests.
 *
 * The import itself is inside the fail-open boundary, not just main(): a resolution or
 * syntax failure in the shared implementation must still exit 0, the same guarantee
 * main()'s own entry guard gives once it's running (same defect class as the Stop-side
 * Codex wrapper).
 */
process.env.CORE_HOOK_HARNESS = 'codex';
try {
  const { main } = await import('./retrieve-context-hook.mjs');
  process.exit((await main()) || 0);
} catch {
  process.exit(0);
}
