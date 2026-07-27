#!/usr/bin/env node
/**
 * close-pass-hook.mjs — SessionEnd hook entry for self-managed session close.
 *
 * Fires once at session end (NOT per-turn — that's why it's SessionEnd, not Stop: Stop fires
 * after every agent response). When the session did real work or owes maintenance, it spawns a
 * detached `claude -p "/finalize"` close agent that discharges the owed work in the background,
 * so the user exits instantly and the close happens itself. If SessionEnd never fires (hard
 * terminal kill), the startup catch-up (startup.md, close-pass.mjs detectCloseState) is the
 * backstop — the marker shows incomplete and next startup discharges the remainder.
 *
 * Four guards:
 *   1. Recursion guard — the spawned `claude -p` fires its OWN SessionEnd when it finishes.
 *      We export CORE_CLOSE_PASS_ACTIVE=1 into its env; this hook sees that and no-ops, so the
 *      close agent never spawns a close agent.
 *   2. Kill switch — CORE_AUTO_CLOSE=0 halts the auto-discharge entirely. Covers the
 *      one writer that touches PROJECT.md every close.
 *   3. Spawn pre-check — shouldSpawn() gates the agent: a trivial read-only session
 *      that owes nothing never pays for a close agent.
 *   4. Fail-open — a session-close hook must never block or error the user's exit. Any failure
 *      swallows to exit 0; the startup catch-up covers a missed close.
 *
 * Detachment, not the hook's async flag, is what keeps the child alive: spawn detached +
 * unref() so `claude -p` survives this session's exit (the nohup equivalent). We don't run the
 * close synchronously — that would make the user wait to exit.
 *
 * Ships with the plugin as prescriptive code; .mjs only. Claude Code only — Codex has no exit
 * hook (harnesses/codex.md §close-pass drop); there, discharge is startup-catch-up-only.
 *
 * I/O: reads the SessionEnd payload as JSON on stdin (.reason, .cwd, .session_id). Always exits 0.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isRegisteredWorkspace, shouldEnqueueClose } from '../scripts/close-pass.mjs';
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
  // Security: a generic `_memories/` dir is not proof; the ~/.core
  // registry is the trust anchor an attacker can't plant from inside a project dir.
  let store = resolve(payload.cwd || process.cwd());
  try { store = realpathSync(store); } catch { /* keep resolved */ }
  if (!isRegisteredWorkspace(store)) {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: 'not-registered-workspace', cwd: store });
    return 0;
  }

  // Guard 3 — the exact-session decision (pure; see decideCloseAction below).
  const decision = decideCloseAction(payload, { store });
  if (decision.action === 'skip') {
    logHookEvent({ hook: 'session-end', action: 'skip', reason: decision.reason, cwd: store });
    return 0;
  }

  // Spawn the DETERMINISTIC close for THIS EXACT SESSION. Detached + unref() so it
  // survives our exit; auth-strip and output logging live inside the runner.
  try {
    const child = spawn('node', decision.args, { cwd: store, env: process.env, detached: true, stdio: 'ignore' });
    child.unref();
    logHookEvent({
      hook: 'session-end', action: 'spawn',
      reason: 'session-reason=' + (reason || 'unknown'),
      cwd: store, session: decision.sessionId,
    });
  } catch {
    // node/runner unavailable, or spawn failed — startup catch-up covers it. Never block exit.
    logHookEvent({ hook: 'session-end', action: 'spawn-failed', cwd: store });
  }
  return 0;
}

/**
 * Decide what SessionEnd should do, given the payload. Pure: no spawn, no
 * registry read, no logging — so the decision is testable without a real
 * workspace or a child process.
 *
 * Two things changed from the behavior this replaces:
 *
 * 1. The session id is USED. It arrives on every SessionEnd payload and was
 *    previously discarded, which is why a manual finalize could be followed by
 *    a second reasoning close for the same session moments later.
 * 2. "A transcript file exists" is no longer evidence that work is owed. Every
 *    real session produces a transcript, so that gate was always true; the
 *    exact-session receipt is the authoritative answer instead.
 *
 * A payload with no usable identity SKIPS rather than synthesizing one. A close
 * that cannot be deduplicated is the failure being removed, so running it
 * anyway would preserve the defect. Startup catch-up recovers those sessions.
 */
export function decideCloseAction(payload = {}, { store } = {}, opts = {}) {
  const reason = String(payload.reason || '');
  if (SKIP_REASONS.has(reason)) {
    return { action: 'skip', reason: 'session-reason=' + reason };
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  if (!sessionId) {
    return { action: 'skip', reason: 'no-session-identity' };
  }

  if (!shouldEnqueueClose(store, { sessionId }, opts)) {
    return { action: 'skip', reason: 'already-closed', sessionId };
  }

  const runner = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'close-pass.mjs');
  return {
    action: 'enqueue',
    reason: 'owed',
    sessionId,
    args: [runner, 'process-request', store, '--session', sessionId],
  };
}

// Only run as the hook entry — importing this module (e.g. for buildChildEnv in tests) must
// NOT execute main() / process.exit().
const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
