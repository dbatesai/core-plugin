#!/usr/bin/env node
/**
 * land-observation.mjs — land one quoted observation in <project>/inbox.md, exactly once.
 *
 * The single intake entry point for an installation that delivers source bytes (collab's
 * outcome, a BBLens refresh item). The bytes are quoted verbatim in a fenced block; the agent's
 * own reading of them, if any, is a separate observation. Graduation stays /process-memory's job.
 *
 * Acceptance is a parsed record, never a text match: a block or unit whose frontmatter carries
 * the same `handoff-collab-id` (a handoff receipt) or, without a receipt, the same `id` with a
 * byte-identical block. A differing record under the same key is refused, not replaced.
 *
 * Outcomes: landed · already-landed · refused:<reason> · pending:<reason>. A refusal writes
 * nothing. The write is a temp file renamed over inbox.md under the project intake lock, so a
 * crash leaves the old file or the new one, never a partial block.
 *
 * CLI: node land-observation.mjs <project> --id <obs-…> --source <name> --sha <sha256>
 *        [--confidence sourced|inferred|reconstructed] [--title <text>]
 *        [--receipt '{"collab_id":…,"origin_anchor":…,"outcome_sha256":…,"mapping":…}']  < bytes
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync as fsReadFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInbox, parseInboxBlocks } from './check-inbox.mjs';
import { parseFlatFrontmatter } from './frontmatter-flat.mjs';
import { isCliEntry } from './cli-entry.mjs';
import { withFileLock } from './file-lock.mjs';
import { INBOX_DRAFT_STATUS, VALID_CONFIDENCE_LEVELS } from './unit-vocab.mjs';

export const MAX_BYTES = 256 * 1024;
const ID_RE = /^obs-[a-z0-9-]{1,120}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RECEIPT_FIELDS = ['collab_id', 'origin_anchor', 'outcome_sha256', 'mapping'];
const fmKey = (f) => `handoff-${f.replace(/_/g, '-')}`;

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Every intake record the project holds: inbox blocks, then units anywhere under _memories/.
 * A directory that is genuinely absent holds nothing; any other listing failure is thrown, so an
 * unreadable subtree is never read as "no prior receipt".
 */
export function intakeRecords(project, readFileSync = fsReadFileSync, listDir = readdirSync) {
  const out = [];
  const inbox = join(project, 'inbox.md');
  if (existsSync(inbox)) for (const b of parseInboxBlocks(readFileSync(inbox, 'utf8'))) out.push({ where: 'inbox', fm: b.fm, body: b.body });
  const stack = [join(project, '_memories')];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = listDir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '_validation') stack.push(p); }
      else if (e.name.endsWith('.md')) {
        // the shared flat parser tolerates CRLF and lone-CR units (Windows / OneDrive-authored)
        const [fm] = parseFlatFrontmatter(readFileSync(p, 'utf8'));
        if (fm && Object.keys(fm).length) out.push({ where: p, fm });
      }
    }
  }
  return out;
}

function composeBlock({ id, source, confidence, receipt, title, bytes, now }) {
  const lines = ['---', `id: ${id}`, 'type: observation', `status: ${INBOX_DRAFT_STATUS}`, `source: ${source}`,
    `extracted-at: ${now}`, `confidence-level: ${confidence}`, 'mode: B', `quoted-sha256: ${sha256(bytes)}`];
  if (receipt) for (const f of RECEIPT_FIELDS) lines.push(`${fmKey(f)}: ${receipt[f]}`);
  lines.push('---');
  const head = title || `Quoted from ${source}`;
  const note = receipt
    ? `${head}. These are the exact bytes collab recorded (sha256 ${receipt.outcome_sha256}). Authors named inside are self-asserted, not authenticated: this block quotes a record, it does not establish a decision.`
    : `${head}. The exact bytes the source delivered (sha256 ${sha256(bytes)}), quoted verbatim.`;
  return `${lines.join('\n')}\n${note}\n\n\`\`\`\n${bytes.toString('utf8').replace(/\n$/, '')}\n\`\`\`\n`;
}

export function landObservation(project, { id, source, bytes, sha, confidence = 'sourced', receipt = null, title = null, now = new Date().toISOString(), lockOpts = {}, fsOps = {} }) {
  const ops = { writeFileSync, renameSync, rmSync, readFileSync: fsReadFileSync, readdirSync, ...fsOps };
  if (!ID_RE.test(String(id))) return { status: 'refused:bad-id', id };
  if (!SOURCE_RE.test(String(source)) || !existsSync(join(project, '_sources', `${source}.yaml`))) return { status: 'refused:unregistered-source', id };
  if (!VALID_CONFIDENCE_LEVELS.has(confidence)) return { status: 'refused:bad-confidence', id };
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) return { status: 'refused:size', id };
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes) || bytes.includes(0)) return { status: 'refused:encoding', id };
  // The inbox parser ends a block at any line whose trimmed text is `---`, and a markdown fence
  // closes on a line of 3+ backticks or tildes; a quoted line of either shape would let the rest
  // of the quote parse as frontmatter. Refuse rather than escape.
  if (bytes.toString('utf8').split(/\r?\n|\r/).some(l => l.trim() === '---' || /^\s*(`{3,}|~{3,})/.test(l))) return { status: 'refused:fence-in-quote', id };
  if (title !== null && (typeof title !== 'string' || title.length > 200 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(title))) return { status: 'refused:bad-title', id };
  if (sha256(bytes) !== sha) return { status: 'refused:sha-mismatch', id };
  if (receipt) {
    if (!RECEIPT_FIELDS.every(f => typeof receipt[f] === 'string' && receipt[f] && !/[\n\r]/.test(receipt[f]))) return { status: 'refused:receipt-malformed', id };
    if (!HEX64.test(receipt.collab_id) || receipt.outcome_sha256 !== sha) return { status: 'refused:receipt-malformed', id };
  }

  const block = composeBlock({ id, source, confidence, receipt, title, bytes, now });
  const probe = mkdtempSync(join(tmpdir(), 'land-obs-'));
  try {
    writeFileSync(join(probe, 'inbox.md'), block);
    const fails = checkInbox(probe).filter(r => r.level === 'FAIL');
    if (fails.length) return { status: 'refused:malformed', id, detail: fails.map(f => f.check).join(',') };
  } finally { rmSync(probe, { recursive: true, force: true }); }

  const lockPath = join(project, '_memories', '_lib', 'intake.lock');
  mkdirSync(join(project, '_memories', '_lib'), { recursive: true });
  try {
    return withFileLock(lockPath, () => {
      // A file another process holds open (an editor, a sync client, a scanner: EBUSY/EPERM/EACCES
      // on Windows) is a named pending state, never an exception out of intake.
      let records, old;
      const inbox = join(project, 'inbox.md');
      try {
        records = intakeRecords(project, ops.readFileSync, ops.readdirSync);
        old = existsSync(inbox) ? ops.readFileSync(inbox, 'utf8') : '';
      } catch (e) {
        if (!e.code) throw e;
        return { status: 'pending:read-failed', id, detail: e.code };
      }
      if (receipt) {
        const mine = records.filter(r => r.fm[fmKey('collab_id')] === receipt.collab_id);
        for (const r of mine) {
          if (!RECEIPT_FIELDS.every(f => r.fm[fmKey(f)])) return { status: 'refused:receipt-malformed', id, where: r.where };
          if (!RECEIPT_FIELDS.every(f => r.fm[fmKey(f)] === receipt[f])) return { status: 'refused:receipt-conflict', id, where: r.where };
        }
        if (mine.length) return { status: 'already-landed', id, where: mine.map(r => r.where) };
      }
      const sameId = records.filter(r => r.fm.id === id);
      for (const r of sameId) {
        if (r.fm[fmKey('collab_id')] && (!receipt || r.fm[fmKey('collab_id')] !== receipt.collab_id)) return { status: 'refused:display-id-collision', id, where: r.where };
        // A receipt-bearing call is only satisfied by a complete matching receipt (handled above);
        // a same-id record without one is never accepted or upgraded in its place.
        if (receipt) return { status: 'refused:receipt-missing', id, where: r.where };
        // the immutable identity is id + source + quoted bytes; graduation rewrites status, mode, dates and topics
        if (r.fm.source !== source || r.fm['quoted-sha256'] !== sha256(bytes)) return { status: 'refused:id-conflict', id, where: r.where };
      }
      if (sameId.length) return { status: 'already-landed', id, where: sameId.map(r => r.where) };

      const sep = !old ? '' : old.endsWith('\n\n') ? '' : old.endsWith('\n') ? '\n' : '\n\n';
      // The old inbox stays in place until the rename; a failed write or rename removes the temp
      // file and reports the failure, so the next run sees the old inbox and lands once.
      const tmp = join(project, `.inbox.md.tmp-${process.pid}-${Date.now()}`);
      try {
        ops.writeFileSync(tmp, old + sep + block);
        ops.renameSync(tmp, inbox);
      } catch (e) {
        try { ops.rmSync(tmp, { force: true }); } catch { /* the failure below is what matters */ }
        return { status: 'pending:write-failed', id, detail: e.code || e.message };
      }
      return { status: 'landed', id };
    }, { retries: 20, retryDelayMs: 100, ...lockOpts });
  } catch (e) {
    if (e.code === 'LOCK_HELD') return { status: 'pending:lock-busy', id };
    if (e.code) return { status: 'pending:intake-error', id, detail: e.code };   // a filesystem fault at the lock
    throw e;
  }
}

export function main(argv) {
  const [project, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i];
  if (!project || !opt.id || !opt.source || !opt.sha) {
    process.stderr.write('usage: land-observation.mjs <project> --id <obs-…> --source <name> --sha <sha256> [--confidence …] [--title …] [--receipt <json>] < bytes\n');
    return 2;
  }
  let receipt = null;
  if (opt.receipt) { try { receipt = JSON.parse(opt.receipt); } catch { process.stdout.write(JSON.stringify({ status: 'refused:receipt-malformed', id: opt.id }) + '\n'); return 1; } }
  const r = landObservation(project, { id: opt.id, source: opt.source, sha: opt.sha, confidence: opt.confidence, title: opt.title, receipt, bytes: fsReadFileSync(0) });
  process.stdout.write(JSON.stringify(r) + '\n');
  return r.status.startsWith('refused') ? 1 : 0;
}

if (isCliEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));
