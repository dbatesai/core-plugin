/**
 * aggregate-receipt.mjs — the privacy-safe aggregate exporter (Train A A2;
 * Crest closure program 2026-07-12 §A2/§A5, keel-to-crest next-steps §7).
 *
 * Two evidence surfaces, never one:
 *   - LOCAL evidence bundle — the runHarness report and tier-sweep output as-is
 *     (gold rows, rawRanks, per-query bands, store paths). Project data. Stays in
 *     the approved environment; NEVER crosses the files-repo boundary.
 *   - SHAREABLE receipt — what this module builds: aggregate-only measurements
 *     (rates, counts, latencies, hashes, schema identities). Nothing that could
 *     reconstruct a managed project's contents, including in combination
 *     (small-cell disclosure counts as reconstruction).
 *
 * Two belts, both mechanical:
 *   1. Whitelist construction — the receipt is built field-by-field from known-safe
 *      values. No spread of input objects, ever; a new report field never leaks by
 *      default.
 *   2. Refusal scan — the finished receipt is serialized and scanned against the
 *      forbidden vocabulary derived from the LOCAL input (every unit id, query text,
 *      and filesystem path the report saw). Any hit → throw, export refused, the
 *      offending fragment named. The scan also refuses generic absolute paths.
 *
 * Per DC-77 ships with the plugin; per DC-80 .mjs only.
 *
 * CLI: node aggregate-receipt.mjs <report.json> [--sweep <sweep.json>] [--out <receipt.json>]
 *      (report.json = runHarness --json output; sweep.json = runTierPolicySweep output)
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync } from './fs-atomic.mjs';

/**
 * collectForbiddenStrings — the reconstruction vocabulary of a local report:
 * unit ids (gold expected/forbidden, every id in rawRanks), query texts, and
 * filesystem paths. Case-insensitive matching; short strings (<4 chars) are
 * skipped to avoid false positives on numbers/units like "p50".
 */
export function collectForbiddenStrings(report, sweep = null) {
  const out = new Set();
  const add = (s) => { if (typeof s === 'string' && s.trim().length >= 4) out.add(s.toLowerCase()); };
  for (const q of report?.gold || []) {
    add(q.query);
    for (const id of q.expected || []) add(id);
    for (const id of q.forbidden || []) add(id);
  }
  for (const perQuery of Object.values(report?.rawRanks || {})) {
    for (const ranked of Object.values(perQuery || {})) {
      for (const id of ranked || []) add(id);
    }
  }
  add(report?.store);
  add(report?.manifest?.gold_path);
  for (const b of sweep?.bands || []) { add(b.query); add(b.gold); }
  return out;
}

/** refusalScan — throws if any forbidden fragment (or an absolute path) appears in the receipt. */
export function refusalScan(receipt, forbidden) {
  const json = JSON.stringify(receipt);
  const lower = json.toLowerCase();
  for (const frag of forbidden) {
    if (lower.includes(frag)) {
      throw new Error(`aggregate-receipt REFUSED: receipt contains a local fragment (${frag.slice(0, 40)}…) — rows stay local, aggregates travel`);
    }
  }
  // Generic path refusal: no absolute POSIX/Windows path or home shorthand leaves.
  if (/"[^"]*(?:\/Users\/|\/home\/|[A-Za-z]:\\|~\/)/.test(json)) {
    throw new Error('aggregate-receipt REFUSED: receipt contains a filesystem path');
  }
  return true;
}

/**
 * buildAggregateReceipt — whitelist-constructed shareable receipt from a local
 * runHarness report (and optionally a tier-sweep output). Refusal-scanned before
 * return; the return value is safe to post across the files-repo boundary.
 */
export function buildAggregateReceipt(report, sweep = null) {
  const m = report.manifest || {};
  const receipt = {
    receipt_schema: 'train-a-aggregate-receipt/1',
    source: {
      plugin_version: m.plugin_version ?? null,
      source_commit: m.source_commit ?? null,
      harness_sha256: m.harness_sha256 ?? null,
      product_function_sha256: {
        'retrieve-context.mjs': m.product_function_sha256?.['retrieve-context.mjs'] ?? null,
        'bm25.mjs': m.product_function_sha256?.['bm25.mjs'] ?? null,
        'generate-summary-index.mjs': m.product_function_sha256?.['generate-summary-index.mjs'] ?? null,
      },
      built_artifact_sha256: m.built_artifact_sha256 ?? null,
      snapshot_id: m.snapshot_id ?? null,
      gold_sha256: m.gold_sha256 ?? null,           // content-addressed, not content
      corpus_content_sha256: m.corpus_content_sha256 ?? null,
      receipt_schema_of_source: m.receipt_schema ?? null,
    },
    corpus: {
      total_units: report.total ?? null,
      // unit-type mix is generic CORE vocabulary (decision/observation/…) — counts only.
      unit_type_counts: Object.fromEntries(Object.entries(report.mix || {}).map(([t, n]) => [String(t), Number(n)])),
    },
    evaluation: {
      queries: m.counts?.queries ?? report.nQueries ?? null,
      no_answer: m.counts?.no_answer ?? null,
      declared_supports: m.counts?.declared_supports ?? null,
      latency_ms: Object.fromEntries(Object.entries(report.latency || {})
        .map(([arm, l]) => [arm, { p50: l.p50_ms, p95: l.p95_ms }])),
      // results are rates/means only — recall@K, MRR, forbidden rate, per-rung means.
      arms: Object.fromEntries(Object.entries(report.results || {}).map(([arm, r]) => [arm, r.unavailable
        ? { unavailable: true }
        : {
          recall: Object.fromEntries(Object.entries(r.recall || {}).map(([k, v]) => [k, v === null ? null : +v.toFixed(3)])),
          mrr: r.mrr === null ? null : +r.mrr.toFixed(3),
          forbidden_rate: r.forbiddenRate === null ? null : +r.forbiddenRate.toFixed(3),
          per_rung_recall: Object.fromEntries(Object.entries(r.perRung || {}).map(([rung, byK]) => [rung,
            Object.fromEntries(Object.entries(byK).map(([k, v]) => [k, v === null ? null : +v.toFixed(3)]))])),
        }])),
    },
    tier_sweep: sweep ? {
      snapshot_id: sweep.snapshot_id ?? null,
      top_n: sweep.topN ?? null,
      per_policy: (sweep.perPolicy || []).map(p => ({ policy: p.policy, r3: p.r3, n: p.n, forbidden3: p.forbidden3 })),
      // Band HISTOGRAM only — the per-(query,gold) rows carry local labels and stay local.
      band_histogram: (sweep.bands || []).reduce((h, b) => { h[b.band] = (h[b.band] || 0) + 1; return h; }, {}),
      counts: {
        queries: sweep.counts?.queries ?? null,
        scored: sweep.counts?.scored ?? null,
        no_answer: sweep.counts?.no_answer ?? null,
        declared_supports: sweep.counts?.declared_supports ?? null,
      },
    } : null,
  };
  refusalScan(receipt, collectForbiddenStrings(report, sweep));
  return receipt;
}

function main(argv) {
  const reportPath = argv[0];
  if (!reportPath) {
    process.stderr.write('usage: aggregate-receipt.mjs <report.json> [--sweep <sweep.json>] [--out <receipt.json>]\n');
    return 2;
  }
  const sweepIdx = argv.indexOf('--sweep');
  const outIdx = argv.indexOf('--out');
  let report, sweep = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
  catch (e) { process.stderr.write(`cannot read report: ${e.message}\n`); return 2; }
  if (sweepIdx >= 0) {
    try { sweep = JSON.parse(readFileSync(argv[sweepIdx + 1], 'utf8')); }
    catch (e) { process.stderr.write(`cannot read sweep: ${e.message}\n`); return 2; }
  }
  let receipt;
  try { receipt = buildAggregateReceipt(report, sweep); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; } // refusal is exit 2, loudly
  const json = JSON.stringify(receipt, null, 2) + '\n';
  if (outIdx >= 0) { atomicWriteFileSync(argv[outIdx + 1], json); process.stdout.write(`receipt written (${Buffer.byteLength(json)} bytes)\n`); }
  else process.stdout.write(json);
  return 0;
}

const _canon = (p) => { try { return realpathSync(p); } catch { return p; } };
if (_canon(process.argv[1] || '') === _canon(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
