#!/usr/bin/env node
/**
 * retrieve-context-hook.mjs — per-turn retrieval injection (DC-94a, Gate G2).
 *
 * A UserPromptSubmit hook entry. When enabled, it runs the deterministic retriever
 * (retrieve-context.mjs) over the incoming user prompt and prints the top-3 matching
 * unit summaries to stdout, which Claude Code injects into the turn's context — so the
 * most relevant stored facts are in front of the agent every turn, not just at bootstrap.
 *
 * SHIPPED DEFAULT-ON, OPT-OUT (Gate G2 resolved, 2026-06-28). Registered in the plugin
 * manifest (hooks/hooks.json) as a UserPromptSubmit hook, so it is live on install. It
 * runs every turn unless the user sets CORE_RETRIEVAL_HOOK=0 (mirrors the DC-107 metrics
 * opt-out). Rationale: a default-off, manually-wired hook is invisible machinery no real
 * user would enable — the north-star ("never fail to retrieve") is only served if it's
 * actually live, and only then can the metrics layer measure whether injection helps.
 * A zero-hit lexical result injects a bounded Tier 3 directive that tells the active model
 * to inspect every exhaustive reasoning shard. Known limit (DC-111): when lexical matching
 * returns topical-but-irrelevant context, only the active model can judge insufficiency and
 * follow the same Tier 3 protocol; the model-free hook cannot decide semantic relevance.
 * To opt out:
 *
 *   // ~/.claude/settings.json  (or set the env var)
 *   CORE_RETRIEVAL_HOOK=0
 *
 * I/O contract: reads the UserPromptSubmit payload as JSON on stdin (uses `.prompt`;
 * store path from CORE_RETRIEVAL_STORE, else payload `.cwd`, else process.cwd()).
 * Output is byte-capped. Any error is swallowed to a clean exit 0 — a retrieval hook
 * must never block the user's turn.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 */

import { readFileSync, existsSync, realpathSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildRetrievalTrace } from '../scripts/retrieve-context.mjs';
import { recordRetrievalEvent } from '../scripts/record-retrieval-event.mjs';
import { recordRetrievalOutcome } from '../scripts/record-retrieval-outcome.mjs';
import { metricsEnabled, logEvent } from '../scripts/log-event.mjs';
import { tokenize } from '../scripts/bm25.mjs';
import { selectCandidates } from '../scripts/select-relevant-units.mjs';
import { logHookEvent } from './hook-log.mjs';

const OUTPUT_BYTE_CAP = 2048;
const TOP_N = 3;

// Producer identity for outcome rows — read from the plugin manifest so the
// version can never fork from the shipped identity; 'unknown' is honest when
// the manifest is unreadable (packaged layouts vary).
const PRODUCER_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return String(manifest.version || 'unknown');
  } catch { return 'unknown'; }
})();

// Typed operational receipt (Hale minimal path, 2026-07-17): ONE terminal
// hook-log row per eligible invocation — early exits included — on the SHARED
// {hook, action, reason} contract (never a second dialect like `kind:`).
// Closed vocabularies; an unknown code is coerced to failed/pipeline-error
// rather than emitted (tests assert every path lands in-vocabulary).
export const RETRIEVAL_ACTIONS = ['skip', 'delivered', 'failed'];
export const RETRIEVAL_REASONS = ['ok', 'retrieval-opt-out', 'empty-prompt', 'store-absent', 'pipeline-error', 'store-unavailable', 'metrics-opt-out', 'no-hit', 'delivery-failed', 'event-write-failed', 'trace-write-failed', 'hook-log-write-failed'];

export function receipt(action, reason, extra = {}) {
  const a = RETRIEVAL_ACTIONS.includes(action) ? action : 'failed';
  const r = RETRIEVAL_REASONS.includes(reason) ? reason : 'pipeline-error';
  try {
    const out = logHookEvent({ hook: 'retrieve-context', action: a, reason: r, ...extra });
    if (!out?.written) {
      // stderr is the last-resort operational surface. Never print to stdout:
      // stdout is injected into the user's context by the hook protocol.
      process.stderr.write(`${JSON.stringify({
        ts: new Date().toISOString(),
        hook: 'retrieve-context',
        action: 'failed',
        reason: 'hook-log-write-failed',
        intended_action: a,
        intended_reason: r,
        error_code: out?.error_code || 'hook-log-write-failed',
      })}\n`);
    }
  } catch {
    // Preserve fail-open behavior even if the fallback surface itself fails.
  }
  return 0;
}

export async function main() {
  // Default-ON, opt-out gate (G2 shipped on, 2026-06-28). Runs unless explicitly
  // disabled with CORE_RETRIEVAL_HOOK=0 (mirrors the DC-107 metrics opt-out).
  if (process.env.CORE_RETRIEVAL_HOOK === '0') return receipt('skip', 'retrieval-opt-out');

  let payload = {};
  // Read stdin synchronously via fd 0 (works under execFileSync's input pipe).
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const prompt = String(payload.prompt || '');
  if (!prompt.trim()) return receipt('skip', 'empty-prompt');

  const store = process.env.CORE_RETRIEVAL_STORE || payload.cwd || process.cwd();
  if (!existsSync(join(store, '_memories'))) return receipt('skip', 'store-absent', { cwd: store });
  try {
    if (!statSync(join(store, '_memories')).isDirectory()) return receipt('skip', 'store-unavailable', { cwd: store });
  } catch { return receipt('skip', 'store-unavailable', { cwd: store }); }

  // ONE pipeline run serves both jobs (2026-07-17, closes Hale audit finding 1 +
  // finding 4 on e1490d4): buildRetrievalTrace runs the same staged pipeline as
  // retrieveContext and carries the delivered pack — the hook injects pack.text
  // and emits the canonical per-turn retrieval event from the same run, so the
  // telemetry corpus is product-emitted, not agent-behavior-dependent.
  let trace = null;
  const configuredCap = Number(process.env.CORE_RETRIEVAL_BYTE_CAP);
  const byteCap = Number.isFinite(configuredCap) && configuredCap >= 0
    ? Math.min(configuredCap, OUTPUT_BYTE_CAP) : OUTPUT_BYTE_CAP;
  try { trace = buildRetrievalTrace(prompt, store, { topN: TOP_N, byteCap }); } catch { return receipt('failed', 'pipeline-error', { cwd: store }); }
  if (!trace || trace.storeless || !trace.stages) return receipt('skip', 'store-unavailable', { cwd: store });

  const final = Array.isArray(trace.stages.final) ? trace.stages.final : [];
  // Telemetry outcome for the single terminal receipt (priority: pipeline
  // failure > event-write > trace-write > opt-out > ok).
  let telemetryReason = 'ok';
  let retrievalId = null;
  let outcomeNote = null; // bounded note when the post-answer outcome close failed

  // Canonical per-turn product event — always on when metrics capture is on
  // (DC-107 default-ON, opt-out). Fail-open: a telemetry failure must never
  // block the user's turn — but it must be OBSERVABLE, so failures land in the
  // hook log instead of vanishing (Hale live-hook audit, 2026-07-17).
  //
  // Every field is an OBSERVED value from this run's stages — never a constant,
  // never a reinterpreted field. In particular: the ladder tier of a hit is
  // derived from WHICH STAGE produced it (in stages.top => Tier 1 lexical; added
  // by edge expansion => Tier 2). `h.tier` on trace hits is the unit AUTHORITY
  // tier (canonical/observation) and must never be coerced into a ladder tier —
  // that exact coercion shipped in a2cab1b and fabricated tier telemetry.
  // This pipeline is the model-free substrate: it never runs Tier 3, so an empty
  // result is `no-hit` at the tier actually reached — never a fabricated
  // 1→2→3 `miss`.
  try {
    if (!metricsEnabled({ project: store })) {
      telemetryReason = 'metrics-opt-out'; // hook-log is the authoritative receipt; no retrieval row is faked
    } else {
      // Ladder semantics (Hale, round 2 of this correction): the shipped product
      // retriever — INCLUDING its built-in one-hop edge expansion — is Tier 1 by
      // the protocol's own definition; Tier 2 is the separate 2–3-hop graph-walk
      // path, which this pipeline never runs. So every event from this mechanism
      // is tier_reached 1, and hit provenance rides a separate closed
      // `source_stage` field instead of overloading the ladder tier (the first
      // corrected mapping made routine expansion hits read as Tier-2 escalation —
      // the same causal-evidence defect under a different mapping).
      const topIds = new Set((Array.isArray(trace.stages.top) ? trace.stages.top : []).map((h) => String(h.id)));
      retrievalId = randomUUID();

      // PRODUCTION POST-ANSWER OUTCOME CALLER (Hale's required path, freeze
      // rejection 2026-07-17: the good mechanism from 303df39 + the nine
      // corrections). This invocation runs strictly AFTER the previous turn's
      // answer, so it closes the PREVIOUS retrieval's outcome via the
      // strengthened writer. Corrections applied: harness detected from
      // runtime, pending state keyed by harness + resolved NON-NULL session
      // (no aliasing; no session → no pending, no outcome), overlap is a
      // provisional SIGNAL only — the outcome stays 'unknown' until calibrated
      // — and the pending record is persisted only after the retrieval row
      // write is proven below.
      const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : null;
      const harness = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE ? 'claude-code'
        : (process.env.CODEX_SESSION_ID || process.env.CODEX_PLUGIN_ROOT ? 'codex' : 'claude-code');
      const queryTermsEarly = tokenize(prompt).slice(0, 8);
      const pendingFile = sessionId
        ? join(store, '_memories', '_lib', `pending-retrieval-${harness}-${sessionId.slice(0, 24)}.json`)
        : null;
      if (pendingFile) {
        try {
          let prev = null;
          try { prev = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { prev = null; }
          if (prev && prev.retrieval_id && prev.session_id === sessionId && prev.harness === harness) {
            const prevTerms = new Set(prev.query_terms || []);
            const overlap = queryTermsEarly.length ? queryTermsEarly.filter((t) => prevTerms.has(t)).length / queryTermsEarly.length : 0;
            const retryShaped = overlap >= 0.6 && queryTermsEarly.length >= 3;
            recordRetrievalOutcome(store, {
              retrieval_id: prev.retrieval_id,
              usefulness_outcome: 'unknown', // provisional signals never become harmful outcomes before calibration
              evidence_authority: retryShaped ? 'corrective-retry' : 'unobservable',
              signal_overlap: overlap,
              harness,
              session_id: sessionId,
              answer_turn_id: prev.retrieval_id,
              producer_version: PRODUCER_VERSION,
            }, { sessionId });
            try { rmSync(pendingFile, { force: true }); } catch { /* consumed */ }
          }
        } catch (err) {
          // Never a second operational row (one terminal row per invocation);
          // the failure rides the terminal receipt as a bounded note.
          outcomeNote = String(err && err.message).slice(0, 80);
        }
      }
      const units = final.map((h) => ({ id: String(h.id), tier: 1, source_stage: topIds.has(String(h.id)) ? 'ranked' : 'one-hop-expansion' }));
      const queryTerms = tokenize(prompt).slice(0, 8);
      const out = recordRetrievalEvent(store, {
        trigger: 'per-turn-hook',
        mechanism: 'model-free-substrate', // names what actually ran: rank/policy/edge pipeline — Tier 1 only, never 2 or 3
        retrieval_id: retrievalId,
        intent_topics: queryTerms.length ? queryTerms : ['empty-after-tokenize'],
        tier_reached: 1,
        escalation_path: [1],
        units_retrieved: units,
        ...(units.length === 0 ? { result: 'no-hit' } : {}),
        candidate_count: Array.isArray(trace.stages.substrate) ? trace.stages.substrate.length : units.length,
        selected_count: trace.pack && Array.isArray(trace.pack.accepted) ? trace.pack.accepted.length : units.length,
        context_pack_token_estimate: trace.pack ? Math.round((trace.pack.bytes || 0) * 0.30) : 0,
      }, { sessionId: payload.session_id || undefined });
      if (!out.written) telemetryReason = 'event-write-failed';
      // Persist the pending marker ONLY after the retrieval row write is
      // PROVEN (correction 2: an unproven retrieval must never become the
      // base of a future outcome row). Atomic temp+rename; keyed per
      // harness+session, so concurrent sessions never alias (correction 1).
      if (out.written && pendingFile) {
        try {
          mkdirSync(dirname(pendingFile), { recursive: true });
          const tmp = `${pendingFile}.tmp`;
          writeFileSync(tmp, JSON.stringify({
            retrieval_id: retrievalId,
            session_id: sessionId,
            harness,
            query_terms: queryTermsEarly,
            had_hits: final.length > 0,
          }));
          renameSync(tmp, pendingFile);
        } catch { /* pending is best-effort; a missed close is an unknown, never a fabrication */ }
      }
      // The persisted trace carries the SAME retrieval_id so the event, the
      // trace, and any future answer-outcome row join on one key.
      trace.retrieval_id = retrievalId;

      // Full trace persistence is opt-in (CORE_RETRIEVAL_TRACE=1): the trace is
      // a deep diagnostic with per-stage payloads; the EVENT above is the
      // always-on canonical record. Local-only either way.
      if (process.env.CORE_RETRIEVAL_TRACE === '1') {
        try {
          const traceOut = logEvent(store, 'retrieval-trace.jsonl', trace);
          if (telemetryReason === 'ok' && (!traceOut || traceOut.legacy !== true)) telemetryReason = 'trace-write-failed';
        } catch { if (telemetryReason === 'ok') telemetryReason = 'trace-write-failed'; }
      }
    }
  } catch {
    telemetryReason = 'pipeline-error'; // fail-open by contract — surfaced in the terminal receipt below
  }

  let reasoningDirective = '';
  if (final.length === 0) {
    try {
      const shards = selectCandidates(prompt, store, { shardSize: 80 });
      if (shards.length) {
        const unitsTotal = shards[0].units_total;
        reasoningDirective = `CORE reasoning escalation required: Tier 1 found no lexical context. Follow the Tier 3 retrieval protocol and inspect all ${shards.length} shard(s) covering ${unitsTotal} active units with select-relevant-units.mjs; reason over each shard using the current prompt before concluding no relevant memory exists.\n`;
      }
    } catch { /* fail-open: the ordinary no-hit remains honest and observable */ }
  }

  const injected = Boolean((trace.pack && trace.pack.text) || reasoningDirective);
  if (trace.pack && trace.pack.text) process.stdout.write(trace.pack.text);
  else if (reasoningDirective) process.stdout.write(reasoningDirective.slice(0, OUTPUT_BYTE_CAP));

  // The single terminal operational row for this invocation: what happened to
  // the user-facing injection (action) and what happened to telemetry (reason).
  let action;
  let reason;
  if (reasoningDirective) {
    action = 'delivered';
    reason = 'no-hit';
  } else if (injected) {
    action = 'delivered';
    reason = telemetryReason;
  } else if (final.length === 0) {
    action = telemetryReason === 'ok' || telemetryReason === 'metrics-opt-out' ? 'skip' : 'failed';
    reason = telemetryReason === 'ok' ? 'no-hit' : telemetryReason;
  } else {
    // Selection succeeded but the byte-capped product delivered no context.
    // This is never skip/ok: it is a user-visible delivery failure.
    action = 'failed';
    reason = 'delivery-failed';
  }
  return receipt(action, reason, {
    cwd: store,
    ...(reason !== telemetryReason ? { telemetry_reason: telemetryReason } : {}),
    ...(retrievalId ? { retrieval_id: retrievalId } : {}),
    ...(outcomeNote ? { outcome_close_note: outcomeNote } : {}),
  });
}

const _canon = (path) => { try { return realpathSync(path); } catch { return path; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  main().then((code) => process.exit(code || 0)).catch(() => process.exit(0));
}
