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
import { VALID_TYPES } from './unit-vocab.mjs';

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

// Any string that IS or CONTAINS a filesystem path, across the supported path
// forms (blocker 1, Hale verdict §1 battery): absolute POSIX (/tmp, /etc, /var,
// /private/tmp, /Users, /Volumes, …), home shorthand, Windows drive letters,
// and UNC (\\server\share). Leading-anchored OR embedded after a delimiter.
//
// K09 (audit, 2026-07-16): two real bypasses in the embedded-path branch.
// (1) The boundary-character class before an embedded path didn't include ':',
// so "path:/Users/<user>/x" (a very common separator — "note:", "file:",
// "location:") slipped through undetected. (2) The embedded alternatives only
// covered POSIX well-known roots and UNC (\\server) — an embedded (non-leading)
// Windows drive-letter path like "see C:\Users\<user>\x" was never checked at
// all; the drive-letter form was only tested at the string's very start. Both
// fixed: ':' added to the boundary class, and the embedded drive-letter form
// added as its own alternative alongside the POSIX-root and UNC ones.
const PATH_SHAPED = new RegExp(
  '^(?:/|~[/\\\\]|[A-Za-z]:[/\\\\]|\\\\\\\\)' +                 // starts like a path
  '|(?:^|[\\s"\'(=,:])(?:/(?:private|tmp|etc|var|Users|home|Volumes|opt|usr|srv|mnt|media)\\b|\\\\\\\\[A-Za-z0-9]|[A-Za-z]:[/\\\\])' // or embeds one (POSIX root, UNC, or a drive letter)
);

/** True when a receipt KEY or string VALUE is path-shaped in any supported form. */
export function isPathShaped(s) {
  return typeof s === 'string' && PATH_SHAPED.test(s);
}

/** Walk every key and string value of the receipt; throw on the first path-shaped one. */
function refusePathShapes(node, at = 'receipt') {
  if (typeof node === 'string') {
    if (isPathShaped(node)) throw new Error(`aggregate-receipt REFUSED: receipt contains a filesystem path (value at ${at}: "${node.slice(0, 60)}")`);
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => refusePathShapes(v, `${at}[${i}]`)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (isPathShaped(k)) throw new Error(`aggregate-receipt REFUSED: receipt contains a filesystem path (KEY at ${at}: "${k.slice(0, 60)}")`);
      refusePathShapes(v, `${at}.${k}`);
    }
  }
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
  // Path refusal across supported path forms, on every key and string value —
  // not a JSON-blob regex (blocker 1: dynamic keys were where paths leaked).
  refusePathShapes(receipt);
  // Belt: the original blob regex stays as a second, independent net.
  if (/"[^"]*(?:\/Users\/|\/home\/|[A-Za-z]:\\|~\/)/.test(json)) {
    throw new Error('aggregate-receipt REFUSED: receipt contains a filesystem path');
  }
  return true;
}

// ---------- blocker 1: closed enums + scalar shapes ----------

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const SCHEMA_RE = /^[a-z0-9-]+\/\d+$/;           // e.g. train-a-aggregate-receipt/1
const ARM_RE = /^[a-z][a-z0-9_]{0,24}$/;          // lexical | ranking | context3 | bm25 | future arms
const POLICY_RE = /^P\d(?:_w[0-9.]{1,6})?$/;      // P0..P2, P3_w0.8 …
// K09: this used to be a pure
// SHAPE check (lowercase, <=24 chars), so any arbitrary lowercase word passed —
// including a project-specific id-naming prefix, which is exactly what leaked
// before the root-cause fix in retrieval-harness.mjs's unitTypeMix (it now
// emits the real `type` field, not an id-prefix guess). The first version of
// this closed-set gate fixed that leak but introduced a NEW defect Hale's
// re-audit caught: it was a second, hand-written copy of the type vocabulary
// that silently omitted real canonical types (`open-question`, `premise`) —
// the positive test passed only because it validated the implementation
// against itself, not against CORE's actual vocabulary. Fixed by importing
// the one real source of truth (`unit-vocab.mjs`'s `VALID_TYPES`) and adding
// only the receipt-specific `other` fallback — no second canonical list.
const KNOWN_UNIT_TYPES = new Set([...VALID_TYPES, 'other']);
const MIX_KEY_RE = /^[a-z][a-z-]{0,23}$/;         // shape check; KNOWN_UNIT_TYPES is the real closed-set gate below
const RUNGS = new Set(['literal', 'category', 'value', 'cross-domain']);
// Bands are short prose labels — closed by SHAPE (bounded charset; real labels
// carry '/', ',', '_', '.' as in "enrichment/reasoning" and "P3_w0.8") — plus the
// isPathShaped guard below, which is what actually excludes filesystem paths.
const BAND_RE = /^[a-zA-Z0-9@ ().;,_/-]{1,90}$/;

const fail = (field, got) => { throw new Error(`aggregate-receipt REFUSED: ${field} fails its closed shape (got ${JSON.stringify(String(got)).slice(0, 60)})`); };
const shape = (field, v, re) => { if (v !== null && !(typeof v === 'string' && re.test(v))) fail(field, v); };
const num01 = (field, v) => { if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) fail(field, v); };
const count = (field, v) => { if (v !== null && !(Number.isInteger(v) && v >= 0)) fail(field, v); };
const nonneg = (field, v) => { if (v !== null && v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) fail(field, v); };

/**
 * validateReceiptShape — every field of the finished receipt against closed enums
 * and scalar shapes. The whitelist constructor bounds WHICH fields exist; this
 * bounds their CONTENT, so poisoned report values (a path in a rung key, a
 * sentence in a sha field) refuse instead of riding a legitimate field out.
 */
export function validateReceiptShape(receipt) {
  const s = receipt.source;
  shape('source.plugin_version', s.plugin_version, VERSION_RE);
  shape('source.source_commit', s.source_commit, COMMIT_RE);
  shape('source.harness_sha256', s.harness_sha256, SHA256_RE);
  for (const [k, v] of Object.entries(s.product_function_sha256)) shape(`source.product_function_sha256[${k}]`, v, SHA256_RE);
  shape('source.built_artifact_sha256', s.built_artifact_sha256, SHA256_RE);
  shape('source.snapshot_id', s.snapshot_id, SHA256_RE);
  shape('source.gold_sha256', s.gold_sha256, SHA256_RE);
  shape('source.corpus_content_sha256', s.corpus_content_sha256, SHA256_RE);
  shape('source.receipt_schema_of_source', s.receipt_schema_of_source, SCHEMA_RE);

  count('corpus.total_units', receipt.corpus.total_units);
  for (const [k, v] of Object.entries(receipt.corpus.unit_type_counts)) {
    if (!MIX_KEY_RE.test(k) || !KNOWN_UNIT_TYPES.has(k)) fail('corpus.unit_type_counts key', k);
    count(`corpus.unit_type_counts[${k}]`, v);
  }

  const e = receipt.evaluation;
  count('evaluation.queries', e.queries); count('evaluation.no_answer', e.no_answer); count('evaluation.declared_supports', e.declared_supports);
  for (const [arm, l] of Object.entries(e.latency_ms)) {
    if (!ARM_RE.test(arm)) fail('evaluation.latency_ms arm', arm);
    nonneg(`latency_ms[${arm}].p50`, l.p50); nonneg(`latency_ms[${arm}].p95`, l.p95);
  }
  for (const [arm, r] of Object.entries(e.arms)) {
    if (!ARM_RE.test(arm)) fail('evaluation.arms arm', arm);
    if (r.unavailable) continue;
    for (const [k, v] of Object.entries(r.recall)) { if (!/^\d{1,3}$/.test(k)) fail('recall K', k); num01(`arms[${arm}].recall[${k}]`, v); }
    num01(`arms[${arm}].mrr`, r.mrr); num01(`arms[${arm}].forbidden_rate`, r.forbidden_rate);
    for (const [rung, byK] of Object.entries(r.per_rung_recall)) {
      if (!RUNGS.has(rung)) fail('per_rung_recall rung', rung); // Hale's exact repro: a path accepted as a rung key
      for (const [k, v] of Object.entries(byK)) { if (!/^\d{1,3}$/.test(k)) fail('per-rung K', k); num01(`per_rung_recall[${rung}][${k}]`, v); }
    }
  }

  const t = receipt.tier_sweep;
  if (t) {
    shape('tier_sweep.snapshot_id', t.snapshot_id, SHA256_RE);
    count('tier_sweep.top_n', t.top_n);
    for (const p of t.per_policy) {
      if (!POLICY_RE.test(p.policy)) fail('tier_sweep policy', p.policy);
      num01(`per_policy[${p.policy}].r3`, p.r3); count(`per_policy[${p.policy}].n`, p.n); num01(`per_policy[${p.policy}].forbidden3`, p.forbidden3);
    }
    for (const [band, n] of Object.entries(t.band_histogram)) {
      if (!BAND_RE.test(band) || isPathShaped(band)) fail('band_histogram band', band);
      count(`band_histogram[${band}]`, n);
    }
    count('tier_sweep.counts.queries', t.counts.queries); count('tier_sweep.counts.scored', t.counts.scored);
    count('tier_sweep.counts.no_answer', t.counts.no_answer); count('tier_sweep.counts.declared_supports', t.counts.declared_supports);
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
  validateReceiptShape(receipt);                              // blocker 1: closed enums + scalar shapes first
  refusalScan(receipt, collectForbiddenStrings(report, sweep)); // then the reconstruction-vocabulary + path scan
  return receipt;
}

function main(argv) {
  const reportPath = argv[0];
  if (!reportPath) {
    process.stderr.write('usage: aggregate-receipt.mjs <report.json> [--sweep <sweep.json>] [--artifact-sha <content-manifest-sha256>] [--out <receipt.json>]\n');
    return 2;
  }
  const sweepIdx = argv.indexOf('--sweep');
  const outIdx = argv.indexOf('--out');
  const artIdx = argv.indexOf('--artifact-sha');
  let report, sweep = null;
  try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
  catch (e) { process.stderr.write(`cannot read report: ${e.message}\n`); return 2; }
  if (sweepIdx >= 0) {
    try { sweep = JSON.parse(readFileSync(argv[sweepIdx + 1], 'utf8')); }
    catch (e) { process.stderr.write(`cannot read sweep: ${e.message}\n`); return 2; }
  }
  // The freeze step injects the artifact identity here — the CONTENT-MANIFEST
  // sha256 from artifact-identity.mjs, one meaning end to end.
  // Shape validation still applies: a non-sha256 value refuses the export.
  if (artIdx >= 0) {
    report.manifest = report.manifest || {};
    report.manifest.built_artifact_sha256 = argv[artIdx + 1];
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
