#!/usr/bin/env node
/**
 * close-pass-hook.mjs — SessionEnd hook entry for self-managed session close (spec 2026-06-29).
 *
 * Fires once at session end (NOT per-turn — that's why it's SessionEnd, not Stop: Stop fires
 * after every agent response). When the session did real work or owes maintenance, it spawns a
 * detached `claude -p "/finalize"` close agent that discharges the owed work in the background,
 * so the user exits instantly and the close happens itself. If SessionEnd never fires (hard
 * terminal kill), the startup catch-up (startup.md, close-pass.mjs detectCloseState) is the
 * backstop — the marker shows incomplete and next startup discharges the remainder.
 *
 * Four guards, all from the 2026-06-29 adversarial pass (spec §8, §10):
 *   1. Recursion guard — the spawned `claude -p` fires its OWN SessionEnd when it finishes.
 *      We export CORE_CLOSE_PASS_ACTIVE=1 into its env; this hook sees that and no-ops, so the
 *      close agent never spawns a close agent.
 *   2. Kill switch (spec §7) — CORE_AUTO_CLOSE=0 halts the auto-discharge entirely. Covers the
 *      one writer that touches PROJECT.md every close, not just the M3 judgment tier.
 *   3. Spawn pre-check (spec §8) — shouldSpawn() gates the agent: a trivial read-only session
 *      that owes nothing never pays for a close agent.
 *   4. Fail-open — a session-close hook must never block or error the user's exit. Any failure
 *      swallows to exit 0; the startup catch-up covers a missed close.
 *
 * Detachment, not the hook's async flag, is what keeps the child alive: spawn detached +
 * unref() so `claude -p` survives this session's exit (the nohup equivalent). We don't run the
 * close synchronously — that would make the user wait to exit.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only. Claude Code only — Codex has no exit
 * hook (harnesses/codex.md §close-pass drop); there, discharge is startup-catch-up-only.
 *
 * I/O: reads the SessionEnd payload as JSON on stdin (.reason, .cwd, .session_id). Always exits 0.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { shouldSpawn, isRegisteredWorkspace, CLOSE_OPS } from '../scripts/close-pass.mjs';
import { logHookEvent } from './hook-log.mjs';

// SessionEnd reasons that are NOT real ends — skip them. `resume` suspends for later
// resumption; closing then is premature (startup catch-up re-detects on resume).
const SKIP_REASONS = new Set(['resume']);


function main() {
  // Guard 1 — recursion: we're inside the spawned close agent's own SessionEnd. No-op.
  // (Logging this is useful — it proves the child's SessionEnd fired AND was suppressed.)
  if (process.env.CORE_CLOSE_PASS_ACTIVE === '1') {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'recursion-guard' });
    return 0;
  }
  // Guard 2 — kill switch: auto-close disabled.
  if (process.env.CORE_AUTO_CLOSE === '0') {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'kill-switch' });
    return 0;
  }

  let payload = {};
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const reason = String(payload.reason || '');
  if (SKIP_REASONS.has(reason)) {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'session-reason=' + reason });
    return 0;
  }

  // Canonicalize (realpath) then require a REGISTERED CORE workspace before spawning anything.
  // Security (review 2026-06-30, HIGH): a generic `_memories/` dir is not proof; the ~/.core
  // registry is the trust anchor an attacker can't plant from inside a project dir.
  let store = resolve(payload.cwd || process.cwd());
  try { store = realpathSync(store); } catch { /* keep resolved */ }
  if (!isRegisteredWorkspace(store)) {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'not-registered-workspace', cwd: store });
    return 0;
  }

  // Guard 3 — spawn pre-check. didWork is approximated by "a transcript exists" (any real
  // session produced one); the authoritative gate is owed-work, which shouldSpawn checks.
  const didWork = !!payload.transcript_path && existsSync(String(payload.transcript_path));
  if (!shouldSpawn(store, { didWork, allOps: CLOSE_OPS })) {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'nothing-owed', cwd: store });
    return 0;
  }

  // Spawn the DETERMINISTIC close envelope, not raw `claude -p`. `close-pass.mjs run`
  // guarantees the marker lifecycle (begin/finish lock + marker) and mechanical maintenance
  // around the LLM close — the reliability spine can't be skipped by agent discretion
  // (validation 2026-06-30 showed a headless agent narrating a close it never marked). Detached
  // + unref() so it survives our exit; auth-strip + output log live inside `run`.
  const runner = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'close-pass.mjs');
  try {
    const child = spawn('node', [runner, 'run', store], { cwd: store, env: process.env, detached: true, stdio: 'ignore' });
    child.unref();
    logHookEvent({ hook: 'session-end', action: 'spawn', reason: 'session-reason=' + (reason || 'unknown'), cwd: store });
  } catch {
    // node/runner unavailable, or spawn failed — startup catch-up covers it. Never block exit.
    logHookEvent({ hook: 'session-end', action: 'spawn-failed', cwd: store });
  }
  return 0;
}

// Only run as the hook entry — importing this module (e.g. for buildChildEnv in tests) must
// NOT execute main() / process.exit().
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
