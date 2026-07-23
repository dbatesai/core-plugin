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
 * store path from payload `.cwd`, else process.cwd() — CORE_RETRIEVAL_STORE was
 * removed entirely, D1 fix 2026-07-18, second pass: no legitimate production use
 * ever set it, and its trust check was lexical-only, bypassable via a symlink
 * placed under ~/.core, so deleting the override closes the class rather than
 * further hardening a boundary that's proven leaky).
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
import { recordRetrievalOutcome, pendingOutcomePath } from '../scripts/record-retrieval-outcome.mjs';
import { metricsEnabled, logEvent } from '../scripts/log-event.mjs';
import { captureRichContext, richContextCaptureEnabled, shouldEnrichRichContext } from '../scripts/rich-context-capture.mjs';
import { tokenize } from '../scripts/bm25.mjs';
import { selectCandidates } from '../scripts/select-relevant-units.mjs';
import { logHookEvent } from './hook-log.mjs';

const OUTPUT_BYTE_CAP = 2048;
const TOP_N = 3;

/**
 * Truncate `str` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character (or a surrogate pair) mid-sequence. String.slice
 * counts UTF-16 code units, not bytes — wrong for a byte-budget contract on
 * any non-ASCII content (K-series UTF-8 byte-cap fix, Hale's re-audit 2026-07-19).
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

// Producer identity for outcome rows — read from the plugin manifest so the
// version can never fork from the shipped identity; 'unknown' is honest when
// the manifest is unreadable (packaged layouts vary).
const PRODUCER_MANIFEST = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  } catch { return {}; }
})();
const PRODUCER_VERSION = String(PRODUCER_MANIFEST.version || 'unknown');
// producer_sha (2026-07-18): producer_version alone can't distinguish which
// exact commit produced a row -- 'unknown' is honest for every build that
// isn't release-stamped (a --scope local dev install, or a manifest predating
// this field). Reads manifest.source_sha -- named 'source', not 'git', per
// Hale's review: it names the commit this release PACKAGES (the version-bump
// commit's own parent), not the tagged release commit's own SHA -- those are
// two different identities and the field name says which one this is. See
// docs/specs/2026-07-18-self-identifying-build-sha.md.
const PRODUCER_SHA = String(PRODUCER_MANIFEST.source_sha || 'unknown');

// Typed operational receipt (Hale minimal path, 2026-07-17): ONE terminal
// hook-log row per eligible invocation — early exits included — on the SHARED
// {hook, action, reason} contract (never a second dialect like `kind:`).
// Closed vocabularies; an unknown code is coerced to failed/pipeline-error
// rather than emitted (tests assert every path lands in-vocabulary).
export const RETRIEVAL_ACTIONS = ['skip', 'delivered', 'failed'];
export const RETRIEVAL_REASONS = ['ok', 'retrieval-opt-out', 'empty-prompt', 'store-absent', 'pipeline-error', 'store-unavailable', 'metrics-opt-out', 'no-hit', 'delivery-failed', 'event-write-failed', 'trace-write-failed', 'hook-log-write-failed'];

// CORE_REASONING_ARM (2026-07-19): a test-only control for the preregistered
// three-arm efficacy pilot (Hale + Antigravity + Keel convergence). 'automatic'
// is the unchanged shipped default -- the directive fires only on a true Tier 1
// zero-hit, exactly as before this existed. 'deterministic-only' and 'always-on'
// exist ONLY so the pilot can force a real, distinguishable behavioral
// difference per arm; no real user should ever set this. An explicit but
// unrecognized value throws rather than silently falling back to 'automatic' --
// a test harness that thinks it requested one arm and silently got another
// would invalidate the pilot, so wrong input must be loud, not swallowed.
export const REASONING_ARMS = ['automatic', 'deterministic-only', 'always-on'];
export function resolveReasoningArm(rawValue) {
  if (rawValue === undefined || rawValue === '') return 'automatic';
  if (!REASONING_ARMS.includes(rawValue)) {
    throw new Error(`CORE_REASONING_ARM must be one of ${REASONING_ARMS.join('/')}, got ${JSON.stringify(rawValue)}`);
  }
  return rawValue;
}

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

  const store = payload.cwd || process.cwd();
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
  let requestedArm = 'automatic';
  const configuredCap = Number(process.env.CORE_RETRIEVAL_BYTE_CAP);
  const byteCap = Number.isFinite(configuredCap) && configuredCap >= 0
    ? Math.min(configuredCap, OUTPUT_BYTE_CAP) : OUTPUT_BYTE_CAP;
  try {
    // Test-only fault seam (2026-07-18, Hale-authorized: prove a GENUINE
    // uncaught exception through the real subprocess path reaches this catch
    // and still exits 0 — the prior coverage only ever called receipt()
    // directly, which proves the logging contract but not that a real crash
    // gets caught at all). Same pattern as CORE_FILELOCK_NO_LINK: an explicit,
    // self-documenting test seam, never read in normal operation.
    if (process.env.CORE_TEST_FORCE_PIPELINE_ERROR) throw new Error('CORE_TEST_FORCE_PIPELINE_ERROR');
    // Resolved INSIDE this try (Hale catch, 2026-07-19): a throw here used to
    // land outside every try/catch in this function, so it escaped all the
    // way to the outer main().catch(() => process.exit(0)) with no receipt()
    // call at all -- exit 0 was correct (never block the turn) but the
    // promised typed pipeline-error row silently never got written. Resolving
    // it here reuses the exact same fault seam as buildRetrievalTrace instead
    // of inventing a second one.
    requestedArm = resolveReasoningArm(process.env.CORE_REASONING_ARM);
    trace = buildRetrievalTrace(prompt, store, { topN: TOP_N, byteCap });
  } catch { return receipt('failed', 'pipeline-error', { cwd: store }); }
  if (!trace || trace.storeless || !trace.stages) return receipt('skip', 'store-unavailable', { cwd: store });

  const final = Array.isArray(trace.stages.final) ? trace.stages.final : [];
  const zeroHit = final.length === 0;
  const shouldEmitDirective = requestedArm === 'always-on' ? true
    : requestedArm === 'deterministic-only' ? false
    : zeroHit; // 'automatic' — unchanged shipped default
  // Telemetry outcome for the single terminal receipt (priority: pipeline
  // failure > event-write > trace-write > opt-out > ok).
  let telemetryReason = 'ok';
  let retrievalId = null;
  let outcomeNote = null; // bounded note when the post-answer outcome close failed
  let reasoningDirective = '';
  // Built unconditionally, BEFORE the metrics-gated block below and BEFORE the
  // event record inside it (second Hale catch, 2026-07-19): the first fix
  // moved this construction inside the `metricsEnabled()` branch so the
  // recorded directive_fired field could reflect the real outcome -- but that
  // put actual DELIVERED CONTENT behind a telemetry-only gate. With
  // CORE_METRICS_ENABLED=0, automatic zero-hit escalation and always-on
  // delivery silently stopped firing at all -- opting out of telemetry must
  // never change what the user's turn actually receives. Building it here,
  // unconditionally, fixes that while still keeping it ahead of the event
  // record (which lives inside the metrics branch and reads this value) so
  // directive_fired still reflects the real constructed outcome, not intent.
  if (shouldEmitDirective) {
    try {
      const shards = selectCandidates(prompt, store, { shardSize: 80 });
      if (shards.length) {
        const unitsTotal = shards[0].units_total;
        // Pilot self-invocation finding (2026-07-21, real-invocation probe):
        // the internal test-control env var name leaking into model-facing
        // text ("CORE_REASONING_ARM=always-on forces...") reads as a
        // fabricated/self-referential instruction to a fresh model with no
        // established trust in this session -- three real Claude Code
        // invocations independently flagged content built this way as a
        // likely prompt injection. Describe the forced case in the same
        // plain, non-mechanism-revealing register as the honest zero-hit
        // case; the requestedArm value itself has no legitimate reason to
        // appear in what the model reads.
        const why = zeroHit
          ? 'Tier 1 found no lexical context.'
          : 'An explicit escalation request forces escalation regardless of Tier 1 result.';
        reasoningDirective = `CORE reasoning escalation required: ${why} Follow the Tier 3 retrieval protocol and inspect all ${shards.length} shard(s) covering ${unitsTotal} active units with select-relevant-units.mjs; reason over each shard using the current prompt before concluding no relevant memory exists.\n`;
      }
    } catch { /* fail-open: the ordinary no-hit remains honest and observable */ }
  }
  // Deferred-write inputs for the NEW pending marker (Hale audit, 2026-07-17,
  // hazard: "creates pending state before delivery"). The marker must only be
  // persisted once this turn's context is actually confirmed delivered to the
  // user — captured here, written after the stdout.write below.
  let pendingWrite = null;

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
      // Hoisted so the OPT-IN rich-context capture below can see the
      // corrective-retry signal computed inside the fallback-close block.
      let retryDetected = false;

      // FALLBACK inferred-closure path (Hale's 303df39 mechanism + the nine
      // freeze-rejection corrections). Superseded on BOTH harnesses now by a
      // real Stop hook (answer-close-hook.mjs / answer-close-hook-codex.mjs)
      // that fires on a genuine post-answer event with the harness's own turn
      // identity; this path only ever infers closure from the NEXT prompt
      // arriving, which is sequencing, not post-answer observation (Hale
      // audit, 2026-07-17) — so normally the real Stop hook clears the
      // pending marker first and this block finds nothing to close. Kept as
      // defense-in-depth for a session where the Stop hook didn't fire
      // (missed trust review, older harness build, hook crash upstream).
      // Corrections applied: harness detected from runtime, pending state
      // keyed by harness + resolved NON-NULL session (no aliasing; no session
      // -> no pending, no outcome), overlap is a provisional SIGNAL only — the
      // outcome stays 'unknown' until calibrated — and the pending record is
      // persisted only after the retrieval row write is proven below.
      const sessionId = typeof payload.session_id === 'string' && payload.session_id.trim() ? payload.session_id.trim() : null;
      // Harness resolution (Hale audit, 2026-07-17 fresh round): CORE_HOOK_HARNESS
      // is the EXPLICIT, authoritative signal — set by the harness-specific
      // wrapper entry file (retrieve-context-hook-codex.mjs sets it to 'codex'
      // before calling main()), never inferred. The ambient env-var fallback
      // below is undocumented Codex behavior (Hale's own words) — kept ONLY
      // for direct/manual invocation that bypasses the wrapper, never trusted
      // as the primary signal.
      const harness = process.env.CORE_HOOK_HARNESS === 'codex' ? 'codex'
        : process.env.CORE_HOOK_HARNESS === 'claude-code' ? 'claude-code'
        : process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDECODE ? 'claude-code'
        : (process.env.CODEX_SESSION_ID || process.env.CODEX_PLUGIN_ROOT ? 'codex' : null);
      const queryTermsEarly = tokenize(prompt).slice(0, 8);
      const pendingFile = pendingOutcomePath(store, harness, sessionId);
      if (pendingFile) {
        try {
          let prev = null;
          try { prev = JSON.parse(readFileSync(pendingFile, 'utf8')); } catch { prev = null; }
          if (prev && prev.retrieval_id && prev.session_id === sessionId && prev.harness === harness) {
            const prevTerms = new Set(prev.query_terms || []);
            const overlap = queryTermsEarly.length ? queryTermsEarly.filter((t) => prevTerms.has(t)).length / queryTermsEarly.length : 0;
            const retryShaped = overlap >= 0.6 && queryTermsEarly.length >= 3;
            retryDetected = retryShaped; // seen by the rich-context capture below
            // Hale audit, 2026-07-17: reusing retrieval_id AS the answer_turn_id
            // fabricates identity — the two are different concepts (which
            // retrieval ran vs. which answer turn closed it). This inferred
            // path still has no real per-turn id to offer, so it generates a
            // fresh one rather than aliasing — honest about being synthetic,
            // never a copy dressed up as an observation.
            const closeResult = recordRetrievalOutcome(store, {
              retrieval_id: prev.retrieval_id,
              usefulness_outcome: 'unknown', // provisional signals never become harmful outcomes before calibration
              evidence_authority: retryShaped ? 'corrective-retry' : 'unobservable',
              signal_overlap: overlap,
              harness,
              session_id: sessionId,
              answer_turn_id: randomUUID(),
              producer_version: PRODUCER_VERSION,
              producer_sha: PRODUCER_SHA,
            }, { sessionId });
            // Delete only once the outcome row is CONFIRMED written (Hale
            // audit, 2026-07-17, hazard: "deletes pending evidence without
            // confirmed outcome persistence") — a failed/fail-open write must
            // never destroy the only record that this retrieval is still
            // open, or the evidence is lost for good.
            if (closeResult.written) {
              try { rmSync(pendingFile, { force: true }); } catch { /* consumed */ }
            } else {
              outcomeNote = 'outcome-close-not-persisted';
            }
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
        // Gated on the env var being EXPLICITLY set (Hale catch, 2026-07-19),
        // not on the resolved arm differing from 'automatic'. An ordinary
        // user who never touches CORE_REASONING_ARM still gets zero new
        // fields -- byte-identical to before this existed. But the pilot's
        // "escalation-only" arm (the preregistration's name for today's
        // shipped default behavior) legitimately requests 'automatic'
        // explicitly, and the prior condition gave that arm no observable
        // receipt at all -- every escalation-only trial would have spoiled
        // under the runner's own fail-closed contract, since there was
        // nothing to check requested_arm against.
        ...(process.env.CORE_REASONING_ARM !== undefined ? { requested_arm: requestedArm, directive_fired: Boolean(reasoningDirective) } : {}),
      }, { sessionId: payload.session_id || undefined });
      if (!out.written) telemetryReason = 'event-write-failed';

      // OPT-IN rich-context capture (Hale metrics-evidence contract, item 4).
      // OFF by default; active only when this project's workspace.json carries
      // rich_context_capture:true. When a retrieval outcome is BAD in a way we
      // can see synchronously — a zero-hit result, or a corrective-retry shape
      // — the closed-schema row above records THAT but not WHY. This captures
      // the query text + delivered context locally so the developer can debug
      // the failure with full context. Structurally isolated from the package
      // exporter (it never reads _metrics/rich-context/). Fail-open: a capture
      // failure must never block or crash the turn, exactly like telemetry.
      // Gated INSIDE the metrics-on branch on purpose: the rich stream is
      // strictly more sensitive than the aggregate stream, so you cannot be
      // capturing it while having opted out of all local capture — while its
      // own flag still disables it independently (metrics stays on).
      try {
        const zeroHit = final.length === 0;
        if (richContextCaptureEnabled({ project: store }) && shouldEnrichRichContext({ zeroHit, retryShaped: retryDetected })) {
          const packText = trace.pack && trace.pack.text ? trace.pack.text : '';
          const turnId = harness === 'codex'
            ? (typeof payload.turn_id === 'string' && payload.turn_id.trim() ? payload.turn_id.trim() : null)
            : (typeof payload.prompt_id === 'string' && payload.prompt_id.trim() ? payload.prompt_id.trim() : null);
          captureRichContext(store, {
            retrieval_id: retrievalId,
            session_id: sessionId,
            turn_id: turnId,
            harness,
            verdict: zeroHit ? 'no-hit' : 'corrective-retry',
            tier_reached: 1,
            escalation_path: [1],
            producer_version: PRODUCER_VERSION,
            producer_sha: PRODUCER_SHA,
            query_text: prompt,
            context_pack_head: packText,
          });
        }
      } catch { /* fail-open: rich capture never blocks the turn */ }
      // Stage the pending-marker write for AFTER delivery is confirmed below
      // (Hale audit, 2026-07-17, hazard: "creates pending state before
      // delivery") — writing it here, before this turn's context has even
      // reached stdout, would let a crash between here and the stdout.write
      // leave a marker for a retrieval the user never actually saw. Still
      // gated on the retrieval row write being PROVEN (correction 2: an
      // unproven retrieval must never become the base of a future outcome
      // row) and keyed per harness+session so concurrent sessions never alias
      // (correction 1).
      if (out.written && pendingFile) {
        pendingWrite = {
          path: pendingFile,
          content: JSON.stringify({
            retrieval_id: retrievalId,
            session_id: sessionId,
            harness,
            prompt_id: typeof payload.prompt_id === 'string' && payload.prompt_id.trim() ? payload.prompt_id.trim() : null,
            query_terms: queryTermsEarly,
            had_hits: final.length > 0,
          }),
        };
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

  const injected = Boolean((trace.pack && trace.pack.text) || reasoningDirective);
  // Both can be true at once now (always-on can force the directive even when
  // Tier 1 also found hits) — before CORE_REASONING_ARM existed this was
  // structurally impossible (the directive only ever fired on zero-hit), so
  // the old if/else-if silently dropping one of them was never reachable.
  // Deliver both, directive appended after the pack, still under the same cap.
  //
  // Hale's re-audit, 2026-07-19: buildFinalContextPack already budgets
  // packText in real UTF-8 bytes (Buffer.byteLength), but this final combine
  // step used to re-truncate with String.slice(0, OUTPUT_BYTE_CAP) — .slice
  // counts UTF-16 code units, not bytes, so appending reasoningDirective and
  // re-slicing could both exceed the preregistered byte budget on non-ASCII
  // content AND split a multi-byte character (or a surrogate pair) mid-
  // sequence, corrupting the delivered payload. It also always used the
  // hardcoded 2048 constant rather than the effective `byteCap` (which can be
  // smaller via CORE_RETRIEVAL_BYTE_CAP), silently ignoring a tighter
  // configured budget. truncateUtf8 trims on a real byte offset and backs off
  // to the nearest complete UTF-8 sequence boundary instead of cutting blind.
  const packText = trace.pack && trace.pack.text ? trace.pack.text : '';
  if (packText && reasoningDirective) {
    process.stdout.write(truncateUtf8(packText + reasoningDirective, byteCap));
  } else if (packText) {
    process.stdout.write(packText);
  } else if (reasoningDirective) {
    process.stdout.write(truncateUtf8(reasoningDirective, byteCap));
  }

  // NOW persist the pending marker — after delivery, never before (Hale
  // audit, 2026-07-17). Only when something was actually injected: a marker
  // for a retrieval whose context never reached the user has no honest
  // "delivered" state to close later. Atomic temp+rename.
  if (injected && pendingWrite) {
    try {
      mkdirSync(dirname(pendingWrite.path), { recursive: true });
      const tmp = `${pendingWrite.path}.tmp`;
      writeFileSync(tmp, pendingWrite.content);
      renameSync(tmp, pendingWrite.path);
    } catch { /* pending is best-effort; a missed close is an unknown, never a fabrication */ }
  }

  // The single terminal operational row for this invocation: what happened to
  // the user-facing injection (action) and what happened to telemetry (reason).
  let action;
  let reason;
  if (reasoningDirective) {
    action = 'delivered';
    // 'no-hit' is only honest for the true zero-hit case (unchanged from
    // before this control existed). always-on can now force the directive
    // even when Tier 1 found real hits -- reporting 'no-hit' there would be
    // a fabrication, so fall back to the actual telemetry outcome instead.
    reason = zeroHit ? 'no-hit' : telemetryReason;
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
