#!/usr/bin/env node
/**
 * answer-close-hook-codex.mjs — Codex entry point for the real post-answer outcome closer.
 *
 * Thin wrapper, not a copy: sets CORE_HOOK_HARNESS='codex' EXPLICITLY then delegates to the
 * shared implementation in answer-close-hook.mjs, which reads Codex's `turn_id` (instead of
 * Claude Code's `prompt_id`) once that env var is set. Pure JS, no shell env-var prefix syntax —
 * works identically on POSIX and Windows (per DC-80, .mjs only).
 *
 * Registered on Codex's Stop event via hooks-codex.json — the real per-harness post-answer
 * adapter Hale's HOLD audit required, closing the gap the earlier "Codex has no Stop-equivalent"
 * framing left open. See harnesses/codex.md §hook-register for the registration. Install + trust
 * + a real two-turn proof landed 2026-07-18 at exact SHA 8e941de6 (two independent proof
 * bundles) -- re-proof owed at each subsequent candidate, not a standing gap.
 */
process.env.CORE_HOOK_HARNESS = 'codex';
const { main } = await import('./answer-close-hook.mjs');
process.exit((main()) || 0);
