/**
 * artifact-receipts.mjs — the shared audit-trail mechanism for every
 * artifact-page generator (extracted and generalized from
 * render-browse-artifact.mjs, 2026-07-22, when the metrics artifact generator
 * became its second consumer — extraction over duplication, matching the
 * state-cache.mjs precedent).
 *
 * Two receipts, two different claims (Hale condition 4):
 *
 *   - The GENERATION receipt (the preflight manifest, written by the
 *     generator before consent) records what was generated and offered —
 *     never what went up. This module owns where it lands
 *     (`~/.core/workspaces/<workspace_id>/artifact-receipts/`, or the flagged
 *     `~/.core/artifact-receipts/` fallback when no workspace.json exists).
 *   - The PUBLISH receipt (`--record-publish`) is written after the consent/
 *     publish step resolves and records the actual outcome — declined,
 *     failed, or published-private with privacy-verification evidence — as
 *     `<generation-receipt>.publish.json` beside it; `--record-revocation`
 *     later stamps `revoked_at` on it.
 *
 * Generalization: the generation receipt's `kind` names which generator
 * produced it, and ARTIFACT_RECEIPT_KINDS maps each known generation kind to
 * its publish-receipt kind — so both artifact families record outcomes
 * through the exact same code path, same directory, same schema, same
 * refusals (no evidence → no published-private; one outcome per generation;
 * no double revocation).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { atomicWriteFileSync } from './fs-atomic.mjs';

export const PUBLISH_RECEIPT_SCHEMA_VERSION = '1.0.0';
export const PUBLISH_STATUSES = ['declined', 'failed', 'published-private'];

// generation-receipt kind -> publish-receipt kind. Closed vocabulary: an
// unknown generation kind is refused, never guessed at.
export const ARTIFACT_RECEIPT_KINDS = {
  'core-memory-browse-preflight': 'core-memory-browse-publish',
  'core-metrics-artifact-preflight': 'core-metrics-artifact-publish',
};
const PUBLISH_KINDS = new Set(Object.values(ARTIFACT_RECEIPT_KINDS));

// ---------- generation-receipt location ----------

export function readWorkspaceId(projectDir) {
  try {
    const ws = JSON.parse(readFileSync(join(resolve(projectDir), 'workspace.json'), 'utf8'));
    return typeof ws.workspace_id === 'string' && ws.workspace_id.trim() ? ws.workspace_id : null;
  } catch { return null; }
}

export function sanitizeTimestamp(iso) {
  // Windows filenames cannot carry ':'; keep the ISO instant readable.
  return String(iso).replace(/[:.]/g, '-');
}

/**
 * Where a generation receipt for this project/instant lands. `workspaceId`
 * null means no workspace.json — the audit trail is kept anyway, in the
 * flagged fallback location the caller must surface (`receipt_fallback`).
 */
export function generationReceiptLocation({ home, projectDir, generatedAt }) {
  const workspaceId = readWorkspaceId(projectDir);
  const receiptDir = workspaceId
    ? join(home, '.core', 'workspaces', workspaceId, 'artifact-receipts')
    : join(home, '.core', 'artifact-receipts');
  return { workspaceId, receiptDir, receiptPath: join(receiptDir, `${sanitizeTimestamp(generatedAt)}.json`) };
}

// ---------- publish receipt ----------

export function publishReceiptPathFor(generationReceiptPath) {
  const p = resolve(generationReceiptPath);
  return p.endsWith('.json') ? p.slice(0, -'.json'.length) + '.publish.json' : p + '.publish.json';
}

export function recordPublishOutcome({
  generationReceiptPath, status, artifactUrl = null,
  privateVerifiedEvidence = null, consentBy = null, consentMechanism = null,
  note = null, now = () => new Date(),
} = {}) {
  if (!PUBLISH_STATUSES.includes(status)) {
    throw Object.assign(new Error(`--status must be one of: ${PUBLISH_STATUSES.join(', ')} (got '${status}')`), { code: 'BAD_STATUS' });
  }
  const genPath = resolve(generationReceiptPath);
  let gen;
  try { gen = JSON.parse(readFileSync(genPath, 'utf8')); }
  catch (e) {
    throw Object.assign(new Error(`cannot read generation receipt ${genPath}: ${e.message}`), { code: 'BAD_GENERATION_RECEIPT' });
  }
  const publishKind = ARTIFACT_RECEIPT_KINDS[gen.kind];
  if (!publishKind) {
    throw Object.assign(new Error(`${genPath} is not a generation receipt (kind '${gen.kind}', expected one of: ${Object.keys(ARTIFACT_RECEIPT_KINDS).join(', ')})`), { code: 'BAD_GENERATION_RECEIPT' });
  }
  if (status === 'published-private' && !privateVerifiedEvidence) {
    throw Object.assign(new Error(
      "--status published-private requires --private-verified-evidence — state how privacy was actually confirmed (condition 3); without evidence the publish is 'failed', not 'published-private'"), { code: 'EVIDENCE_REQUIRED' });
  }
  // Hale's e0a808f revise (2026-07-22): a published-private outcome without a
  // consent record was a gap between the skill prose ("record who consented on
  // which manifest") and this CLI contract — close it here, for every kind.
  if (status === 'published-private' && (!consentBy || !consentMechanism)) {
    throw Object.assign(new Error(
      "--status published-private requires --consent-by and --consent-mechanism — record who consented and what they were shown (condition 4); without a consent record the publish is 'failed', not 'published-private'"), { code: 'CONSENT_REQUIRED' });
  }
  const outPath = publishReceiptPathFor(genPath);
  if (existsSync(outPath)) {
    throw Object.assign(new Error(`publish receipt already exists at ${outPath} — one outcome per generation; use --record-revocation to revoke, or regenerate for a new publish`), { code: 'RECEIPT_EXISTS' });
  }
  const at = now().toISOString();
  const receipt = {
    kind: publishKind,
    schema_version: PUBLISH_RECEIPT_SCHEMA_VERSION,
    generation_receipt: basename(genPath),
    // Self-contained snapshot identity (Hale's e0a808f revise, 2026-07-22):
    // copied from the validated generation receipt at record time, so this
    // receipt still names WHAT was published even if the neighbor generation
    // receipt is later moved, deleted, or altered. Browse receipts carry the
    // store snapshot id; metrics receipts carry no store snapshot (aggregates
    // only) so their identity is the data-gathering instant.
    snapshot_id: gen.snapshot_id ?? null,
    data_generated_at: gen.data_generated_at ?? null,
    generation_generated_at: gen.generated_at ?? null,
    publish_status: status,
    recorded_at: at,
    published_at: status === 'published-private' ? at : null,
    artifact_url: artifactUrl,
    consent: (consentBy || consentMechanism)
      ? { granted_by: consentBy, granted_at: at, mechanism: consentMechanism }
      : null,
    private_verified: status === 'published-private'
      ? { at, evidence: privateVerifiedEvidence }
      : null,
    revoked_at: null,
    ...(note ? { note } : {}),
  };
  atomicWriteFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, path: outPath };
}

export function recordRevocation(publishReceiptPath, { now = () => new Date() } = {}) {
  const p = resolve(publishReceiptPath);
  let receipt;
  try { receipt = JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) {
    throw Object.assign(new Error(`cannot read publish receipt ${p}: ${e.message}`), { code: 'BAD_PUBLISH_RECEIPT' });
  }
  if (!PUBLISH_KINDS.has(receipt.kind)) {
    throw Object.assign(new Error(`${p} is not a publish receipt (kind '${receipt.kind}', expected one of: ${[...PUBLISH_KINDS].join(', ')})`), { code: 'BAD_PUBLISH_RECEIPT' });
  }
  if (receipt.revoked_at) {
    throw Object.assign(new Error(`publish receipt ${p} is already revoked (revoked_at ${receipt.revoked_at})`), { code: 'ALREADY_REVOKED' });
  }
  receipt.revoked_at = now().toISOString();
  atomicWriteFileSync(p, JSON.stringify(receipt, null, 2) + '\n');
  return { receipt, path: p };
}

// ---------- shared record-mode CLI ----------

export const RECORD_USAGE_CODES = new Set([
  'BAD_STATUS', 'BAD_GENERATION_RECEIPT', 'EVIDENCE_REQUIRED', 'CONSENT_REQUIRED',
  'RECEIPT_EXISTS', 'BAD_PUBLISH_RECEIPT', 'ALREADY_REVOKED', 'BAD_OPTION', 'MISSING_ARG',
]);

/**
 * The `--record-publish` / `--record-revocation` CLI shared by every artifact
 * generator. `label` is the invoking script's name for error prefixes.
 * Returns the process exit code (0 ok, 2 usage, 1 fatal).
 */
export function runRecordCli(argv, { label = 'artifact-receipts' } = {}) {
  const opts = {};
  let mode = null;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--record-publish') mode = 'publish';
      else if (a === '--record-revocation') { mode = 'revoke'; opts.publishReceiptPath = argv[++i]; }
      else if (a === '--generation-receipt') opts.generationReceiptPath = argv[++i];
      else if (a === '--status') opts.status = argv[++i];
      else if (a === '--artifact-url') opts.artifactUrl = argv[++i];
      else if (a === '--private-verified-evidence') opts.privateVerifiedEvidence = argv[++i];
      else if (a === '--consent-by') opts.consentBy = argv[++i];
      else if (a === '--consent-mechanism') opts.consentMechanism = argv[++i];
      else if (a === '--note') opts.note = argv[++i];
      else throw Object.assign(new Error(`unknown option ${a} in record mode`), { code: 'BAD_OPTION' });
    }
    let result;
    if (mode === 'publish') {
      if (!opts.generationReceiptPath) throw Object.assign(new Error('--record-publish requires --generation-receipt <path>'), { code: 'MISSING_ARG' });
      if (!opts.status) throw Object.assign(new Error('--record-publish requires --status declined|failed|published-private'), { code: 'MISSING_ARG' });
      result = recordPublishOutcome(opts);
    } else {
      if (!opts.publishReceiptPath) throw Object.assign(new Error('--record-revocation requires the publish receipt path'), { code: 'MISSING_ARG' });
      result = recordRevocation(opts.publishReceiptPath);
    }
    process.stdout.write(JSON.stringify({ publish_receipt_path: result.path, receipt: result.receipt }, null, 2) + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`${label}: ${e.message}\n`);
    return RECORD_USAGE_CODES.has(e.code) ? 2 : 1;
  }
}
