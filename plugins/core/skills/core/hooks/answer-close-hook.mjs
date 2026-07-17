#!/usr/bin/env node
/**
 * answer-close-hook.mjs — REAL post-answer outcome closer (Stop hook).
 *
 * Hale's HOLD audit of e4383c1 (2026-07-17) named the core defect in the old design: the
 * per-turn retrieval hook (retrieve-context-hook.mjs) closed the PREVIOUS retrieval's outcome
 * by inferring "the answer must be done" from the NEXT prompt arriving — sequencing, not
 * post-answer observation — and it fabricated identity by reusing retrieval_id AS the
 * answer_turn_id. Both are now fixed by wiring a REAL adapter: Stop fires once, right after
 * Claude's response completes (never per-tool-call, never per-turn like UserPromptSubmit would
 * be) — a genuine post-answer event — and Claude Code's Stop payload carries `prompt_id`, the
 * harness's own identifier for the turn that just finished. That's the real per-harness answer-
 * turn identity Hale asked for; nothing here infers or aliases it.
 *
 * Codex has no validated Stop-equivalent (harnesses/codex.md §hook-register is DROPPED pending
 * empirical validation), so this hook is Claude-Code-only. On Codex the fallback inferred-
 * closure path inside retrieve-context-hook.mjs remains the only mechanism — an explicitly
 * named drop, not a silent gap. Re-open when a live Codex install validates a Stop-equivalent.
 *
 * Fail-open by contract: a Stop hook must never block or alter the assistant's turn. Every
 * failure swallows to exit 0; the pending marker (and thus the missed close) is picked up by
 * the fallback path on the next UserPromptSubmit if this hook can't close it.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * I/O: reads the Stop payload as JSON on stdin (session_id, prompt_id, cwd). Emits nothing to
 * stdout (Stop hook output is not injected into context the way UserPromptSubmit's is — this
 * hook's only product is the outcome-log row + the hook-log receipt). Always exits 0.
 */

import { readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { recordRetrievalOutcome, pendingOutcomePath } from '../scripts/record-retrieval-outcome.mjs';
import { logHookEvent } from './hook-log.mjs';

export const CLOSE_ACTIONS = ['skip', 'closed', 'failed'];
export const CLOSE_REASONS = ['ok', 'no-pending', 'no-session', 'session-mismatch', 'not-persisted', 'pipeline-error', 'hook-log-write-failed'];

export function receipt(action, reason, extra = {}) {
  const a = CLOSE_ACTIONS.includes(action) ? action : 'failed';
  const r = CLOSE_REASONS.includes(reason) ? reason : 'pipeline-error';
  try {
    const out = logHookEvent({ hook: 'answer-close', action: a, reason: r, ...extra });
    if (!out?.written) {
      process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(), hook: 'answer-close', action: 'failed', reason: 'hook-log-write-failed',
        intended_action: a, intended_reason: r, error_code: out?.error_code || 'hook-log-write-failed',
      })}\n`);
    }
  } catch { /* preserve fail-open even if the fallback surface fails */ }
  return 0;
}

function readManifestVersion() {
  try {
    const path = fileURLToPath(new URL('../../../.claude-plugin/plugin.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return String(manifest.version || 'unknown');
  } catch { return 'unknown'; }
}

export function main() {
  let payload = {};
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : null;
  if (!sessionId) return receipt('skip', 'no-session');

  const store = process.env.CORE_RETRIEVAL_STORE || payload.cwd || process.cwd();
  if (!existsSync(store)) return receipt('skip', 'no-pending', { cwd: store });

  // This hook only ever runs where Claude Code wired it (hooks.json Stop), so
  // harness is definitionally 'claude-code' — no inference needed, unlike the
  // fallback path which has to guess from env vars.
  const harness = 'claude-code';
  const pendingFile = pendingOutcomePath(store, harness, sessionId);
  if (!pendingFile || !existsSync(pendingFile)) return receipt('skip', 'no-pending', { cwd: store });

  let prev = null;
  try { prev = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { prev = null; }
  if (!prev || !prev.retrieval_id || prev.session_id !== sessionId || prev.harness !== harness) {
    return receipt('skip', 'session-mismatch', { cwd: store });
  }

  // The real per-harness answer-turn identity: Claude Code's own prompt_id for
  // the turn that just finished (Stop fires once the answer is complete, so
  // this is a genuine post-answer observation, not an inference from the next
  // prompt arriving). Fall back to a freshly-generated id — never an alias of
  // retrieval_id — when prompt_id isn't available (older Claude Code builds).
  const promptId = typeof payload.prompt_id === 'string' && payload.prompt_id.trim() ? payload.prompt_id.trim() : null;
  const answerTurnId = promptId || randomUUID();

  try {
    const closeResult = recordRetrievalOutcome(store, {
      retrieval_id: prev.retrieval_id,
      // Stop tells us the answer happened; it still can't tell us whether the
      // retrieved context was USEFUL — that stays 'unknown' until a stronger
      // signal (user confirmation, objective task success) arrives and is
      // recorded separately. The improvement here is honesty about WHEN and
      // WHOSE identity closed the retrieval, not a claim of usefulness.
      usefulness_outcome: 'unknown',
      evidence_authority: 'unobservable',
      harness,
      session_id: sessionId,
      answer_turn_id: answerTurnId,
      producer_version: readManifestVersion(),
    }, { sessionId });
    if (closeResult.written) {
      try { rmSync(pendingFile, { force: true }); } catch { /* consumed */ }
      return receipt('closed', 'ok', { cwd: store, retrieval_id: prev.retrieval_id });
    }
    return receipt('failed', 'not-persisted', { cwd: store, retrieval_id: prev.retrieval_id });
  } catch {
    return receipt('failed', 'pipeline-error', { cwd: store });
  }
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  try { process.exit(main() || 0); } catch { process.exit(0); }
}
