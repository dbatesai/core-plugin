#!/usr/bin/env node
/**
 * close-pass-hook.mjs — SessionEnd hook entry for self-managed session close.
 *
 * Fires once at session end (NOT per-turn — that's why it's SessionEnd, not Stop: Stop fires
 * after every agent response). When the exact session still owes a close, it spawns the
 * deterministic runner — `node scripts/close-pass.mjs process-request <store> --session <id>`
 * — detached, so the user exits instantly and the close discharges in the background. No
 * model runs: the child is a Node process with a fixed argument list, not an agent, so its
 * cost and its effects are both bounded by that runner. If SessionEnd never fires (hard
 * terminal kill), the startup catch-up (startup.md, close-pass.mjs detectCloseState) is the
 * backstop — the marker shows incomplete and next startup discharges the remainder.
 *
 * Five guards, in the order they run:
 *   1. Environment suppression — CORE_CLOSE_PASS_ACTIVE=1 no-ops the hook, so a close running
 *      inside a session cannot trigger another one.
 *   2. Kill switch — CORE_AUTO_CLOSE=0 halts the auto-discharge entirely. Covers the
 *      one writer that touches PROJECT.md every close.
 *   3. Workspace trust — the cwd is canonicalized and must resolve to a workspace registered
 *      in ~/.core; a bare `_memories/` directory authorizes nothing.
 *   4. Exact-session receipt — decideCloseAction() skips a session that has no usable identity
 *      or already holds a close receipt, so one session is closed at most once.
 *   5. Fail-open — a session-close hook must never block or error the user's exit. Any failure
 *      swallows to exit 0; the startup catch-up covers a missed close.
 *
 * Detachment, not the hook's async flag, is what keeps the child alive: spawn detached +
 * unref() so the runner survives this session's exit (the nohup equivalent). The close does
 * not run synchronously — that would make the user wait to exit.
 *
 * Ships with the plugin as prescriptive code; .mjs only. Claude Code only — Codex has no exit
 * hook (harnesses/codex.md §close-pass drop); there, discharge is startup-catch-up-only.
 *
 * I/O: reads the SessionEnd payload as JSON on stdin (.reason, .cwd, .session_id). Always exits 0.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { isRegisteredWorkspace, shouldEnqueueClose } from '../scripts/close-pass.mjs';
import { logHookEvent } from './hook-log.mjs';
import { isCliEntry } from '../scripts/cli-entry.mjs';

// SessionEnd reasons that are NOT real ends — skip them. `resume` suspends for later
// resumption; closing then is premature (startup catch-up re-detects on resume).
const SKIP_REASONS = new Set(['resume']);


function main() {
  // Guard 1 — environment suppression: a close already owns this environment. No-op.
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

  // Guard 4 — the exact-session decision (pure; see decideCloseAction below).
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
 * The decision is keyed on the session id from the payload, and the authority
 * is the exact-session close receipt: a session that already holds one is
 * skipped, so a manual finalize is never followed by a second close moments
 * later. The presence of a transcript file is not evidence that work is owed —
 * every real session produces one.
 *
 * A payload with no usable identity SKIPS rather than synthesizing one: a close
 * that cannot be deduplicated is the failure this gate exists to prevent.
 * Startup catch-up recovers those sessions.
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
  const args = [runner, 'process-request', store, '--session', sessionId];
  // The exact transcript for THIS session, when the harness provides one — without it
  // process-request can only record a coverage:'partial' receipt (stays owed, never
  // silently certified 'closed' off events it never read).
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path.trim() : '';
  if (transcriptPath) args.push('--transcript', transcriptPath);
  return { action: 'enqueue', reason: 'owed', sessionId, args };
}

// Only run as the hook entry — importing this module (tests import decideCloseAction) must
// NOT execute main() / process.exit().
if (isCliEntry(import.meta.url)) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
