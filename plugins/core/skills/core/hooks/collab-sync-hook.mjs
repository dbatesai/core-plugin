#!/usr/bin/env node
/**
 * collab-sync-hook.mjs — UserPromptSubmit trigger that keeps collab outcomes landing mid-session.
 *
 * A collab that closes after this session's bootstrap must land without a new collab event, a
 * manual command, or a repeated /core (whose bootstrap dedup would skip the startup step). Every
 * prompt — the user's, or a loop tick's — reaches this hook, so it is the model-free trigger:
 * it runs `core-collab-sync` for the registered project at most once per THROTTLE_MS, as an
 * async hook so the turn never waits. Sync itself is idempotent, so a second run is harmless.
 *
 * Guards, in order: kill switch CORE_COLLAB_SYNC=0; the cwd must resolve to a project registered
 * in ~/.core (a bare folder authorizes nothing); collab must be installed; the throttle stamp in
 * the project's hot state must be older than THROTTLE_MS. Fail-open: any error exits 0 and the
 * startup step or the next prompt retries. Claude Code only — Codex lands collab outcomes at its
 * /core startup step (harnesses/codex.md).
 *
 * I/O: reads the UserPromptSubmit payload (.cwd) on stdin. Prints nothing. Always exits 0.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRegisteredRoot } from '../scripts/close-pass.mjs';
import { syncCollab, findCollabScripts } from '../scripts/core-collab-sync.mjs';
import { stateDir, detectStateHarness } from '../scripts/project-state.mjs';
import { logHookEvent } from './hook-log.mjs';
import { isCliEntry } from '../scripts/cli-entry.mjs';

export const THROTTLE_MS = 10 * 60 * 1000;

export function runCollabSyncHook(payload, { env = process.env, now = Date.now(), sync = syncCollab, resolveRoot = resolveRegisteredRoot, findCollab = findCollabScripts, hotDir = (root) => stateDir({ root, harness: detectStateHarness(env), kind: 'hot', forWrite: true }).dir } = {}) {
  if (env.CORE_COLLAB_SYNC === '0') return { action: 'skip', reason: 'kill-switch' };
  const root = payload?.cwd ? resolveRoot(payload.cwd) : null;
  if (!root) return { action: 'skip', reason: 'unregistered' };
  const collabCli = findCollab(env);
  if (!collabCli) return { action: 'skip', reason: 'collab-absent' };
  const stamp = join(hotDir(root), 'collab-sync-stamp.json');
  let last = 0;
  if (existsSync(stamp)) { try { last = JSON.parse(readFileSync(stamp, 'utf8')).at || 0; } catch { /* treated as never */ } }
  if (now - last < THROTTLE_MS) return { action: 'skip', reason: 'throttled' };
  writeFileSync(stamp, JSON.stringify({ at: now }) + '\n');   // claim first, so concurrent prompts don't both run
  const r = sync(root, { collabCli });
  return { action: 'ran', status: r.status, items: r.items?.length ?? 0 };
}

function main() {
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
    const r = runCollabSyncHook(payload);
    logHookEvent({ hook: 'collab-sync', ...r });
  } catch (e) {
    try { logHookEvent({ hook: 'collab-sync', action: 'error', reason: e.code || String(e.message).slice(0, 120) }); } catch { /* fail open */ }
  }
  return 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main();
