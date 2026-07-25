#!/usr/bin/env node
/**
 * answer-close-hook-codex.mjs — Codex entry point for the real post-answer outcome closer.
 *
 * Thin wrapper, not a copy: sets CORE_HOOK_HARNESS='codex' EXPLICITLY then delegates to the
 * shared implementation in answer-close-hook.mjs, which reads Codex's `turn_id` (instead of
 * Claude Code's `prompt_id`) once that env var is set. Pure JS, no shell env-var prefix syntax —
 * works identically on POSIX and Windows (.mjs only).
 *
 * Registered on Codex's Stop event via hooks-codex.json — the per-harness post-answer
 * adapter. See harnesses/codex.md §hook-register for the registration and the
 * install/trust/two-turn proof scope (proven at exact SHA 8e941de6; re-proof owed at
 * each subsequent candidate).
 */
process.env.CORE_HOOK_HARNESS = 'codex';
const { main } = await import('./answer-close-hook.mjs');
process.exit((main()) || 0);
