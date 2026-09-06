#!/usr/bin/env node
/**
 * retrieve-context-hook.mjs — per-turn retrieval injection.
 *
 * A UserPromptSubmit hook entry. When enabled, it runs the deterministic retriever
 * (retrieve-context.mjs) over the incoming user prompt and prints the top-3 matching
 * unit summaries to stdout, which Claude Code injects into the turn's context — so the
 * most relevant stored facts are in front of the agent every turn, not just at bootstrap.
 *
 * DEFAULT-ON, OPT-OUT. Registered in the plugin
 * manifest (hooks/hooks.json) as a UserPromptSubmit hook, so it is live on install. It
 * runs every turn unless the user sets CORE_RETRIEVAL_HOOK=0 (mirrors the default-on
 * metrics opt-out). Rationale: a default-off, manually-wired hook is invisible machinery no real
 * user would enable — the north-star ("never fail to retrieve") is only served if it's
 * actually live, and only then can the metrics layer measure whether injection helps.
 * When the keyword result is thin (a question whose ranking has no clear winner) or
 * empty, the hook also injects the first two candidate shards — up to 160 units as
 * `id — summary`, ordered by the enrichment arm then the substrate — so the active model
 * reasons over them in the same turn. CORE_ESCALATION=0 restores the text-only directive
 * on a zero-hit; the shard pack is capped separately (CORE_ESCALATION_BYTE_CAP, lower only).
 * To opt out:
 *
 *   // ~/.claude/settings.json  (or set the env var)
 *   CORE_RETRIEVAL_HOOK=0
 *
 * I/O contract: reads the UserPromptSubmit payload as JSON on stdin (uses `.prompt`;
 * store path from payload `.cwd`, else process.cwd() — deliberately no env-var
 * store override: a path override is a trust boundary this hook cannot safely
 * enforce, so none exists).
 * Output is byte-capped. Any error is swallowed to a clean exit 0 — a retrieval hook
 * must never block the user's turn.
 *
 * Ships with the plugin by design; the plugin ships .mjs only.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCliEntry } from '../scripts/cli-entry.mjs';
import { buildRetrievalTrace } from '../scripts/retrieve-context.mjs';
import { recordRetrievalEvent } from '../scripts/record-retrieval-event.mjs';
import { metricsEnabled } from '../scripts/log-event.mjs';
import { captureTurnEvidence, turnCaptureEnabled, computeStoreSignature } from '../scripts/turn-capture.mjs';
import { tokenize } from '../scripts/bm25.mjs';
import { selectCandidates } from '../scripts/select-relevant-units.mjs';
import { thinSignal, shouldEscalate, buildReasoningShards, renderEscalationPack, escalationByteCap } from '../scripts/reasoning-shortlist.mjs';
import { logHookEvent, PRODUCER_VERSION, PRODUCER_SHA } from './hook-log.mjs';

const OUTPUT_BYTE_CAP = 2048;
const TOP_N = 3;

/**
 * Truncate `str` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character (or a surrogate pair) mid-sequence. String.slice
 * counts UTF-16 code units, not bytes — wrong for a byte-budget contract on
 * any non-ASCII content.
 */
export function truncateUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  // Back off while sitting on a UTF-8 continuation byte (10xxxxxx = 0x80-0xBF)
  // — that means `end` is mid-sequence; the first non-continuation byte at or
  // before `end` is where a complete character boundary actually is.
  while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// Producer identity (PRODUCER_VERSION / PRODUCER_SHA) is imported from
// hook-log.mjs — ONE manifest read shared by every hook, so evidence rows and
// hook-log receipts can never disagree about which build produced them.

// Typed operational receipt: ONE terminal
// hook-log row per eligible invocation — early exits included — on the SHARED
// {hook, action, reason} contract (never a second dialect like `kind:`).
// Closed vocabularies; an unknown code is coerced to failed/pipeline-error
// rather than emitted (tests assert every path lands in-vocabulary).
export const RETRIEVAL_ACTIONS = ['skip', 'delivered', 'failed'];
export const RETRIEVAL_REASONS = ['ok', 'retrieval-opt-out', 'empty-prompt', 'store-absent', 'pipeline-error', 'store-unavailable', 'metrics-opt-out', 'no-hit', 'delivery-failed', 'event-write-failed', 'hook-log-write-failed'];

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
  // Default-ON, opt-out gate. Runs unless explicitly
  // disabled with CORE_RETRIEVAL_HOOK=0 (mirrors the default-on metrics opt-out).
  if (process.env.CORE_RETRIEVAL_HOOK === '0') return receipt('skip', 'retrieval-opt-out');

  let payload = {};
  // Read stdin synchronously via fd 0 (works under execFileSync's input pipe).
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }
  if (raw.trim()) { try { payload = JSON.parse(raw); } catch { payload = {}; } }

  const prompt = String(payload.prompt || '');
  if (!prompt.trim()) return receipt('skip', 'empty-prompt');

  const store = payload.cwd || process.cwd();
  if (!existsSync(join(store, '_memories'))) return receipt('skip', 'store-absent', { cwd: store });
  try {
    if (!statSync(join(store, '_memories')).isDirectory()) return receipt('skip', 'store-unavailable', { cwd: store });
  } catch { return receipt('skip', 'store-unavailable', { cwd: store }); }

  // ONE pipeline run serves both jobs: buildRetrievalTrace runs the same staged pipeline as
  // retrieveContext and carries the delivered pack — the hook injects pack.text
  // and emits the canonical per-turn retrieval event from the same run, so the
  // telemetry corpus is product-emitted, not agent-behavior-dependent.
  let trace = null;
  const configuredCap = Number(process.env.CORE_RETRIEVAL_BYTE_CAP);
  const byteCap = Number.isFinite(configuredCap) && configuredCap >= 0
    ? Math.min(configuredCap, OUTPUT_BYTE_CAP) : OUTPUT_BYTE_CAP;
  try {
    // Test-only fault seam: lets tests prove a GENUINE uncaught exception
    // through the real subprocess path reaches this catch and still exits 0.
    // Same pattern as CORE_FILELOCK_NO_LINK: an explicit,
    // self-documenting test seam, never read in normal operation.
    if (process.env.CORE_TEST_FORCE_PIPELINE_ERROR) throw new Error('CORE_TEST_FORCE_PIPELINE_ERROR');
    trace = buildRetrievalTrace(prompt, store, { topN: TOP_N, byteCap });
  } catch { return receipt('failed', 'pipeline-error', { cwd: store }); }
  if (!trace || trace.storeless || !trace.stages) return receipt('skip', 'store-unavailable', { cwd: store });

  const final = Array.isArray(trace.stages.final) ? trace.stages.final : [];
  const zeroHit = final.length === 0;
  // Telemetry outcome for the single terminal receipt (priority: pipeline
  // failure > event-write > trace-write > opt-out > ok).
  let telemetryReason = 'ok';
  let retrievalId = null;
  let turnCaptureStatus = null; // closed status code for the terminal receipt (captured/disabled/capture-failed)
  let reasoningDirective = '';
  // Reasoning escalation: on a thin or empty keyword result, inject the first two
  // candidate shards so the active model reasons over them this turn. Built here,
  // unconditionally and before the telemetry block, for the same reason as the
  // directive below: it is delivered content, and the event must record what was
  // actually constructed. Fail-open: any failure falls back to the directive path.
  let escalation = 'none';
  let escalationPack = '';
  let shardRows = 0;
  const escalationEnabled = process.env.CORE_ESCALATION !== '0';
  if (escalationEnabled) {
    let thin = zeroHit;
    if (!thin) {
      try { thin = shouldEscalate(thinSignal(prompt, store, { snapshot: trace.stages?.snapshot || null })); } catch { thin = false; }
    }
    if (thin) {
      try {
        const shards = buildReasoningShards(prompt, store, { shards: 2, shardSize: 80, snapshot: trace.stages?.snapshot || null });
        const pack = renderEscalationPack(shards, { byteCap: escalationByteCap() });
        if (pack.rows > 0) { escalationPack = pack.text; shardRows = pack.rows; escalation = 'shards'; }
      } catch { /* fall through: the zero-hit directive below still fires */ }
    }
  }
  // Built unconditionally, BEFORE the metrics-gated block below and BEFORE the
  // event record inside it: this is delivered content, not telemetry --
  // opting out of telemetry (CORE_METRICS_ENABLED=0) must never change what
  // the user's turn actually receives. Building it here, unconditionally,
  // keeps it ahead of the event record (which lives inside the metrics branch
  // and reads this value) so directive_fired reflects the real constructed
  // outcome, not intent.
  if (zeroHit && !escalationPack) {
    try {
      const shards = selectCandidates(prompt, store, { shardSize: 80 });
      if (shards.length) {
        const unitsTotal = shards[0].units_total;
        reasoningDirective = `CORE reasoning escalation required: Tier 1 found no lexical context. Follow the Tier 3 retrieval protocol and inspect all ${shards.length} shard(s) covering ${unitsTotal} active units with select-relevant-units.mjs; reason over each shard using the current prompt before concluding no relevant memory exists.\n`;
        escalation = 'directive';
      }
    } catch { /* fail-open: the ordinary no-hit remains honest and observable */ }
  }

  // Canonical per-turn product event — always on when metrics capture is on
  // (metrics capture is default-ON, opt-out). Fail-open: a telemetry failure must never
  // block the user's turn — but it must be OBSERVABLE, so failures land in the
  // hook log instead of vanishing.
  //
  // Every field is an OBSERVED value from this run's stages — never a constant,
  // never a reinterpreted field. In particular: the ladder tier of a hit is
  // derived from WHICH STAGE produced it (in stages.top => Tier 1 lexical; added
  // by edge expansion => Tier 2). `h.tier` on trace hits is the unit AUTHORITY
  // tier (canonical/observation) and must never be coerced into a ladder tier —
  // that coercion fabricates tier telemetry.
  // This pipeline is the model-free substrate: it never runs Tier 3, so an empty
  // result is `no-hit` at the tier actually reached — never a fabricated
  // 1→2→3 `miss`.
  try {
    if (!metricsEnabled({ project: store })) {
      telemetryReason = 'metrics-opt-out'; // hook-log is the authoritative receipt; no retrieval row is faked
    } else {
      // Ladder semantics: the shipped product
      // retriever — INCLUDING its built-in one-hop edge expansion — is Tier 1 by
      // the protocol's own definition; Tier 2 is the separate 2–3-hop graph-walk
      // path, which this pipeline never runs. So every event from this mechanism
      // is tier_reached 1, and hit provenance rides a separate closed
      // `source_stage` field instead of overloading the ladder tier
      // (overloading it would make routine expansion hits read as Tier-2
      // escalation — a causal-evidence defect).
      const topIds = new Set((Array.isArray(trace.stages.top) ? trace.stages.top : []).map((h) => String(h.id)));
      retrievalId = randomUUID();

      // Session + harness identity ride the evidence capture below — resolved
      // here, never fabricated: no session id in the payload means null, not
      // an alias.
      const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : null;
      // Harness resolution: CORE_HOOK_HARNESS
      // is the EXPLICIT, authoritative signal — set by the harness-specific
      // wrapper entry file (retrieve-context-hook-codex.mjs sets it to 'codex'
      // before calling main()), never inferred. The ambient env-var fallback
      // below is undocumented Codex behavior — kept ONLY
      // for direct/manual invocation that bypasses the wrapper, never trusted
      // as the primary signal.
      const harness = process.env.CORE_HOOK_HARNESS === 'codex' ? 'codex'
        : process.env.CORE_HOOK_HARNESS === 'claude-code' ? 'claude-code'
        : process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE ? 'claude-code'
        : (process.env.CODEX_SESSION_ID || process.env.CODEX_PLUGIN_ROOT ? 'codex' : null);
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
        escalation,
        ...(shardRows ? { shard_rows: shardRows } : {}),
      }, { sessionId: payload.session_id || undefined });
      if (!out.written) telemetryReason = 'event-write-failed';

      // EVERY-TURN evidence capture (Link 1 of the evidence chain), default-ON
      // with opt-outs. Written in the same moment as the numbers row above, joined
      // by the same retrieval_id: the full prompt, the combined delivered pack
      // text, per-unit ids+scores, the top rejected candidates, a store
      // signature for drift detection, and producer identity. This is what the
      // hindsight judge later grades — the numbers row records THAT retrieval
      // happened; this records enough to judge whether it was RIGHT.
      //
      // LOCAL ONLY: lands under the metrics storage base (0700/0600, 30-day
      // retention, purge command); metrics-package.mjs has no read path into
      // it (canary tripwire test). Fail-open: a capture failure never blocks
      // the turn — it lands in the stream's health counter (Link 5 watches
      // that) and its closed status rides the terminal receipt. Gated INSIDE
      // the metrics-on branch: opting out of all local capture also stops
      // this; its own CORE_TURN_CAPTURE / workspace turn_capture flag disables
      // it independently.
      try {
        if (turnCaptureEnabled({ project: store })) {
          const deliveredIds = new Set(units.map((u) => u.id));
          const scoreById = new Map(
            (Array.isArray(trace.stages.substrate) ? trace.stages.substrate : []).map((h) => [String(h.id), h.score]),
          );
          const tcResult = captureTurnEvidence(store, {
            retrieval_id: retrievalId,
            session_id: sessionId,
            harness,
            prompt_text: prompt,
            pack_text: trace.pack && trace.pack.text ? trace.pack.text : '',
            delivered: units.map((u) => ({ id: u.id, score: scoreById.get(u.id) ?? null, source_stage: u.source_stage })),
            rejected_top: (Array.isArray(trace.stages.substrate) ? trace.stages.substrate : [])
              .filter((h) => !deliveredIds.has(String(h.id)))
              .map((h) => ({ id: String(h.id), score: h.score, source_stage: 'ranked' })),
            truncation: {
              byte_cap_applied: Boolean(trace.pack && Array.isArray(trace.pack.excluded)
                && trace.pack.excluded.some((e) => e && e.reason === 'byte-cap')),
              prompt_tokens_used: queryTerms.length,
            },
            store_signature: computeStoreSignature(store),
            producer_version: PRODUCER_VERSION,
            producer_sha: PRODUCER_SHA,
          });
          turnCaptureStatus = tcResult.written ? 'captured'
            : String(tcResult.reason || 'error').split(/[:\s]/)[0]; // closed head token, never raw content
        } else {
          turnCaptureStatus = 'disabled';
        }
      } catch { turnCaptureStatus = 'error'; /* fail-open, but observable on the receipt */ }
    }
  } catch {
    telemetryReason = 'pipeline-error'; // fail-open by contract — surfaced in the terminal receipt below
  }

  const injected = Boolean((trace.pack && trace.pack.text) || reasoningDirective || escalationPack);
  // Pack and directive are mutually exclusive: the directive only exists on a
  // true Tier 1 zero-hit, and a zero-hit pack has no text. buildFinalContextPack
  // already budgets packText in real UTF-8 bytes (Buffer.byteLength);
  // truncateUtf8 holds the same contract for the directive — a real byte
  // offset, backed off to the nearest complete UTF-8 sequence boundary,
  // honoring the effective `byteCap` (which can be smaller than the 2048
  // constant via CORE_RETRIEVAL_BYTE_CAP).
  const packText = trace.pack && trace.pack.text ? trace.pack.text : '';
  if (packText) {
    process.stdout.write(packText);
  }
  if (escalationPack) {
    // The shard pack has its own budget (already enforced at a whole-row boundary);
    // it never competes with the ordinary pack's cap.
    process.stdout.write(escalationPack);
  } else if (!packText && reasoningDirective) {
    process.stdout.write(truncateUtf8(reasoningDirective, byteCap));
  }

  // The single terminal operational row for this invocation: what happened to
  // the user-facing injection (action) and what happened to telemetry (reason).
  let action;
  let reason;
  if (escalationPack && !packText) {
    action = 'delivered';
    reason = 'no-hit'; // the substrate found nothing; the shard pack is the escalation, not a hit
  } else if (reasoningDirective) {
    action = 'delivered';
    // The directive only fires on a true Tier 1 zero-hit, so 'no-hit' is the
    // honest reason; a telemetry failure still rides the receipt as the
    // telemetry_reason field below.
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
    // Evidence-capture outcome: a closed status code — never raw prompt/pack
    // content — so a capture (or a silent capture failure) is observable on
    // the receipt in addition to the stream's own health counter.
    ...(turnCaptureStatus ? { turn_capture: turnCaptureStatus } : {}),
    escalation,
  });
}

if (isCliEntry(import.meta.url)) {
  main().then((code) => process.exit(code || 0)).catch(() => process.exit(0));
}
