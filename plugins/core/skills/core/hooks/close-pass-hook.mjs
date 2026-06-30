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

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { shouldSpawn } from '../scripts/close-pass.mjs';

// The op set the close agent is responsible for. Kept in sync with the close-pass marker
// (close-pass.mjs STORE_DERIVED) and what /finalize discharges headlessly.
const CLOSE_OPS = [
  'maintenance-run', 'render-project-md', 'hot-section', 'demote-moves',
  'compact-project', 'demote-state', 'check-units', 'reflection-a', 'reflection-b',
  'metrics', 'summary-stub', 'memory-refresh',
];

// SessionEnd reasons that are NOT real ends — skip them. `resume` suspends for later
// resumption; closing then is premature (startup catch-up re-detects on resume).
const SKIP_REASONS = new Set(['resume']);

function isCoreWorkspace(store) {
  return existsSync(join(store, 'workspace.json')) || existsSync(join(store, '_memories'));
}

function main() {
  // Guard 1 — recursion: we're inside the spawned close agent's own SessionEnd. No-op.
  if (process.env.CORE_CLOSE_PASS_ACTIVE === '1') return 0;
  // Guard 2 — kill switch: auto-close disabled.
  if (process.env.CORE_AUTO_CLOSE === '0') return 0;

  let payload = {};
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  if (SKIP_REASONS.has(String(payload.reason || ''))) return 0;

  const store = resolve(process.env.CORE_CLOSE_STORE || payload.cwd || process.cwd());
  if (!isCoreWorkspace(store)) return 0;

  // Guard 3 — spawn pre-check. didWork is approximated by "a transcript exists" (any real
  // session produced one); the authoritative gate is owed-work, which shouldSpawn checks.
  const didWork = !!payload.transcript_path && existsSync(String(payload.transcript_path));
  if (!shouldSpawn(store, { didWork, allOps: CLOSE_OPS })) return 0;

  // Spawn the detached close agent. unref() + detached + ignored stdio = survives our exit.
  // CORE_CLOSE_PASS_ACTIVE=1 trips Guard 1 in the child's own SessionEnd (no recursive spawn).
  try {
    const child = spawn('claude', ['-p', '/finalize'], {
      cwd: store,
      env: { ...process.env, CORE_CLOSE_PASS_ACTIVE: '1', CORE_CLOSE_HEADLESS: '1' },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // claude not on PATH, or spawn failed — startup catch-up covers it. Never block exit.
  }
  return 0;
}

try { process.exit(main() || 0); } catch { process.exit(0); }
