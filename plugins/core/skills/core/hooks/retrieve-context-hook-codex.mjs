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
 *
 * When the shared module does not load, the turn still passes (exit 0) but a receipt says so: a
 * total outage must not look like a quiet turn. The receipt goes to the project's hook log when
 * the folder is a registered project, and to stderr otherwise. Never to stdout, which the hook
 * protocol injects into the user's context.
 */
import { readFileSync } from 'node:fs';

async function importFailedReceipt(error) {
  const event = {
    hook: 'retrieve-context', action: 'failed', reason: 'import-failed', harness: 'codex',
    error_code: String(error?.code || error?.name || 'import-failed').slice(0, 64),
  };
  let written = false;
  try {
    let cwd = process.cwd();
    try { const p = JSON.parse(readFileSync(0, 'utf8')); if (typeof p.cwd === 'string' && p.cwd) cwd = p.cwd; } catch { /* no payload */ }
    const { resolveRegisteredRoot } = await import('../scripts/close-pass.mjs');
    const { logHookEvent } = await import('./hook-log.mjs');
    const projectRoot = resolveRegisteredRoot(cwd);
    if (projectRoot) written = logHookEvent({ ...event, projectRoot }).written === true;
  } catch { /* fall through to stderr */ }
  if (!written) process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

process.env.CORE_HOOK_HARNESS = 'codex';
try {
  const { main } = await import('./retrieve-context-hook.mjs');
  process.exit((await main()) || 0);
} catch (error) {
  await importFailedReceipt(error);
  process.exit(0);
}
