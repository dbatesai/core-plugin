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
 * Known limit (DC-111): lexical matching can inject a topical-but-irrelevant unit on an
 * abstract query (O1 noise) — bounded (byte-capped, advisory, fail-open) and the reasoning
 * tier is the sequenced de-noiser. To opt out:
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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRetrievalTrace } from '../scripts/retrieve-context.mjs';
import { recordRetrievalEvent } from '../scripts/record-retrieval-event.mjs';
import { metricsEnabled, logEvent } from '../scripts/log-event.mjs';
import { tokenize } from '../scripts/bm25.mjs';
import { logHookEvent } from './hook-log.mjs';

const OUTPUT_BYTE_CAP = 2048;
const TOP_N = 3;

// Typed operational receipt (Hale minimal path, 2026-07-17): ONE terminal
// hook-log row per eligible invocation — early exits included — on the SHARED
// {hook, action, reason} contract (never a second dialect like `kind:`).
// Closed vocabularies; an unknown code is coerced to failed/pipeline-error
// rather than emitted (tests assert every path lands in-vocabulary).
export const RETRIEVAL_ACTIONS = ['skip', 'delivered', 'failed'];
export const RETRIEVAL_REASONS = ['ok', 'retrieval-opt-out', 'empty-prompt', 'store-absent', 'pipeline-error', 'store-unavailable', 'metrics-opt-out', 'no-hit', 'event-write-failed', 'trace-write-failed'];

function receipt(action, reason, extra = {}) {
  const a = RETRIEVAL_ACTIONS.includes(action) ? action : 'failed';
  const r = RETRIEVAL_REASONS.includes(reason) ? reason : 'pipeline-error';
  try { logHookEvent({ hook: 'retrieve-context', action: a, reason: r, ...extra }); } catch { /* fail-open: observability never blocks the turn */ }
  return 0;
}

async function main() {
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

  // ONE pipeline run serves both jobs (2026-07-17, closes Hale audit finding 1 +
  // finding 4 on e1490d4): buildRetrievalTrace runs the same staged pipeline as
  // retrieveContext and carries the delivered pack — the hook injects pack.text
  // and emits the canonical per-turn retrieval event from the same run, so the
  // telemetry corpus is product-emitted, not agent-behavior-dependent.
  let trace = null;
  try { trace = buildRetrievalTrace(prompt, store, { topN: TOP_N, byteCap: OUTPUT_BYTE_CAP }); } catch { return receipt('failed', 'pipeline-error', { cwd: store }); }
  if (!trace || trace.storeless || !trace.stages) return receipt('skip', 'store-unavailable', { cwd: store });

  const final = Array.isArray(trace.stages.final) ? trace.stages.final : [];
  // Telemetry outcome for the single terminal receipt (priority: pipeline
  // failure > event-write > trace-write > opt-out > ok).
  let telemetryReason = 'ok';
  let retrievalId = null;

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

  const injected = Boolean(trace.pack && trace.pack.text);
  if (injected) process.stdout.write(trace.pack.text);

  // The single terminal operational row for this invocation: what happened to
  // the user-facing injection (action) and what happened to telemetry (reason).
  const action = injected ? 'delivered' : (telemetryReason === 'ok' || telemetryReason === 'metrics-opt-out' ? 'skip' : 'failed');
  const reason = !injected && final.length === 0 && (telemetryReason === 'ok') ? 'no-hit' : telemetryReason;
  return receipt(action, reason, { cwd: store, ...(retrievalId ? { retrieval_id: retrievalId } : {}) });
}

main().then((code) => process.exit(code || 0)).catch(() => process.exit(0));
