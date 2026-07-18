#!/usr/bin/env node
/**
 * answer-close-hook.mjs — REAL post-answer outcome closer (Stop hook).
 *
 * Hale's HOLD audit of e4383c1 (2026-07-17) named the core defect in the old design: the
 * per-turn retrieval hook (retrieve-context-hook.mjs) closed the PREVIOUS retrieval's outcome
 * by inferring "the answer must be done" from the NEXT prompt arriving — sequencing, not
 * post-answer observation — and it fabricated identity by reusing retrieval_id AS the
 * answer_turn_id. Both are now fixed by wiring a REAL adapter: Stop fires once, right after
 * the assistant's response completes (never per-tool-call, never per-turn like
 * UserPromptSubmit would be) — a genuine post-answer event — and the harness's own Stop
 * payload carries the real per-turn identity: Claude Code's `prompt_id`, Codex's `turn_id`
 * (developers.openai.com/codex/hooks#stop — confirmed 2026-07-17, Hale's fresh-audit correction:
 * the earlier "Codex has no Stop-equivalent" framing was stale, not true). Nothing here infers
 * or aliases identity on either harness.
 *
 * Codex support: this same file handles both harnesses. Which one is active for a given
 * invocation is set EXPLICITLY by the entry wrapper — answer-close-hook.mjs itself for Claude
 * Code (hooks.json Stop), answer-close-hook-codex.mjs for Codex (hooks-codex.json Stop) — via
 * CORE_HOOK_HARNESS, never inferred from ambient env vars. See harnesses/codex.md §hook-register
 * for the Codex-side registration. Install + trust + a real two-turn proof landed 2026-07-18
 * at exact SHA 8e941de6 (two independent proof bundles) -- re-proof owed at each subsequent
 * candidate, not a standing gap.
 *
 * Fail-open by contract: a Stop hook must never block or alter the assistant's turn. Every
 * failure swallows to exit 0; the pending marker (and thus the missed close) is picked up by
 * the fallback path on the next UserPromptSubmit if this hook can't close it.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * I/O: reads the Stop payload as JSON on stdin (session_id, prompt_id or turn_id, cwd). Always
 * writes `{}` to stdout on exit 0 — Codex's Stop contract requires valid JSON there ("Plain text
 * output is invalid for this event"; empty stdout shipped here originally, a real contract
 * violation Hale's fresh audit caught). An empty object carries no `decision` field, which both
 * harnesses treat as "let the turn proceed, no intervention" — Claude Code's own contract
 * explicitly permits this shape too, not just tolerates it. Stop hook output is not injected
 * into context the way UserPromptSubmit's is; this hook's real product is the outcome-log row +
 * the hook-log receipt, and the stdout JSON is a contract formality, never read for content by
 * anything in this codebase. Always exits 0.
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
  // Codex's Stop contract requires valid JSON on stdout for every exit-0 —
  // "Plain text output is invalid for this event" (developers.openai.com/codex/hooks,
  // confirmed 2026-07-17, Hale's fresh-audit catch: empty stdout shipped here
  // originally, silently violating that contract). An empty object carries no
  // `decision` field, which both harnesses treat as "allow the turn to
  // proceed, no intervention" — Claude Code's own Stop contract explicitly
  // permits "exit 0 without any JSON at all" OR omitting `decision`, so this
  // is compatible there too, not just tolerated.
  try { process.stdout.write('{}\n'); } catch { /* stdout write failure must never crash a fail-open hook */ }
  return 0;
}

function readProducerManifest() {
  try {
    const path = fileURLToPath(new URL('../../../.claude-plugin/plugin.json', import.meta.url));
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch { return {}; }
}

export function main() {
  let payload = {};
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : null;
  if (!sessionId) return receipt('skip', 'no-session');

  const store = payload.cwd || process.cwd();
  if (!existsSync(store)) return receipt('skip', 'no-pending', { cwd: store });

  // Explicit, never inferred (Hale audit, 2026-07-17 fresh round): the entry
  // wrapper sets CORE_HOOK_HARNESS before calling main(). Default to
  // 'claude-code' when unset — this file's OWN direct hooks.json registration
  // never sets it, so existing Claude Code installs keep working unchanged.
  const harness = process.env.CORE_HOOK_HARNESS === 'codex' ? 'codex' : 'claude-code';
  const pendingFile = pendingOutcomePath(store, harness, sessionId);
  if (!pendingFile || !existsSync(pendingFile)) return receipt('skip', 'no-pending', { cwd: store });

  let prev = null;
  try { prev = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { prev = null; }
  if (!prev || !prev.retrieval_id || prev.session_id !== sessionId || prev.harness !== harness) {
    return receipt('skip', 'session-mismatch', { cwd: store });
  }

  // The real per-harness answer-turn identity: Claude Code's prompt_id, or
  // Codex's turn_id (developers.openai.com/codex/hooks#stop — "Codex-specific
  // extension. Active Codex turn id", confirmed 2026-07-17) — whichever field
  // THIS harness's Stop payload actually carries. Stop fires once the answer
  // is complete, so this is a genuine post-answer observation, not an
  // inference from the next prompt arriving. Fall back to a freshly-generated
  // id — never an alias of retrieval_id — only when the harness-native field
  // is absent (older builds, or an undocumented payload shape).
  const nativeTurnField = harness === 'codex' ? payload.turn_id : payload.prompt_id;
  const nativeTurnId = typeof nativeTurnField === 'string' && nativeTurnField.trim() ? nativeTurnField.trim() : null;
  const answerTurnId = nativeTurnId || randomUUID();

  try {
    const manifest = readProducerManifest();
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
      producer_version: String(manifest.version || 'unknown'),
      producer_sha: String(manifest.git_sha || 'unknown'),
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
