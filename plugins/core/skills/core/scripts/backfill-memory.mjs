/**
 * backfill-memory.mjs — discovery + bookkeeping for memory back-fill.
 *
 * The automatic session close is deterministic and makes zero model calls, so
 * an auto-closed session gets a lifecycle receipt but no observation capture,
 * graduation, or synthesis. This script is the deterministic half of the
 * back-fill that `/process-memory` runs: `list` names the sessions whose
 * receipts show preserved-but-never-memory-processed work (status `recorded`
 * or `partial`, no `memory_processed_at` stamp), and `mark` stamps a session's
 * receipt once the agent has actually read its transcript and captured what
 * it warranted. The judgment work between those two calls belongs to the
 * agent, not this script.
 *
 * Corrupt receipts are counted and reported, never silently skipped — an
 * elided receipt would read as "nothing pending" when the truth is UNKNOWN.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  receiptPath, readCloseReceipt, writeCloseReceipt,
} from './close-pass.mjs';

/** Receipt statuses whose sessions never received semantic memory processing. */
const BACKFILL_STATUSES = new Set(['recorded', 'partial']);

/** Resolve the receipt directory the same way close-pass.mjs does. */
function receiptDirOf(store, opts = {}) {
  // receiptPath appends `<hash>.json` under the receipts dir; derive the dir
  // from a throwaway key so the resolution logic stays single-sourced.
  return dirname(receiptPath(store, 'x', opts));
}

/**
 * List sessions pending memory back-fill, newest ended_at first.
 * Returns { pending: [...receipts], corrupt: <count> }.
 */
export function listPendingBackfill(store, opts = {}) {
  const dir = receiptDirOf(store, opts);
  const pending = [];
  let corrupt = 0;
  let names = [];
  if (existsSync(dir)) {
    try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { names = []; }
  }
  for (const name of names) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      corrupt++;
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.session_id !== 'string') {
      corrupt++;
      continue;
    }
    if (!BACKFILL_STATUSES.has(parsed.status)) continue;
    if (typeof parsed.memory_processed_at === 'string' && parsed.memory_processed_at) continue;
    pending.push(parsed);
  }
  // A real receipt carries the session's end inside record.ended_at (the
  // transcript range) with closed_at as the receipt-write time — sort on the
  // session end, fall back to the receipt time.
  const endOf = (r) => String((r.record && r.record.ended_at) || r.closed_at || '');
  pending.sort((a, b) => endOf(b).localeCompare(endOf(a)));
  return { pending, corrupt };
}

/**
 * Stamp a session's receipt as memory-processed. Atomic (rides the receipt
 * writer), preserves every existing field. Refuses to invent a receipt for a
 * session that has none.
 */
export function markBackfilled(store, sessionId, opts = {}) {
  const receipt = readCloseReceipt(store, sessionId, opts);
  if (!receipt) return { ok: false, reason: 'missing' };
  receipt.memory_processed_at = (opts.now || new Date().toISOString());
  writeCloseReceipt(store, receipt, opts);
  return { ok: true };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function main(argv) {
  const sub = argv[0];
  const f = parseFlags(argv.slice(1));
  const store = f._[0];
  if (!sub || !store) {
    process.stderr.write('usage: backfill-memory.mjs <list|mark> <store> [--session <id>] [--limit N] [--json] [--storage-root <dir>]\n');
    return 2;
  }
  const opts = {};
  if (typeof f['storage-root'] === 'string') opts.storageRoot = f['storage-root'];

  switch (sub) {
    case 'list': {
      let limit = Infinity;
      if (f.limit !== undefined) {
        const n = Number(f.limit);
        if (!Number.isInteger(n) || n <= 0) {
          process.stderr.write('backfill-memory: --limit must be a positive integer\n');
          return 2;
        }
        limit = n;
      }
      const { pending, corrupt } = listPendingBackfill(store, opts);
      const limited = pending.slice(0, limit);
      if (f.json) {
        process.stdout.write(JSON.stringify({
          pending: limited, total_pending: pending.length, corrupt,
        }) + '\n');
      } else {
        process.stdout.write(`${pending.length} session(s) pending memory back-fill`
          + (corrupt ? `; ${corrupt} corrupt receipt(s) need a look` : '') + '\n');
        for (const p of limited) {
          const ended = (p.record && p.record.ended_at) || p.closed_at || 'unknown';
          process.stdout.write(`- ${p.session_id} (${p.status}, ended ${ended})\n`);
        }
      }
      return 0;
    }
    case 'mark': {
      const sessionId = typeof f.session === 'string' ? f.session : null;
      if (!sessionId) { process.stderr.write('mark needs --session\n'); return 2; }
      const r = markBackfilled(store, sessionId, opts);
      if (!r.ok) { process.stderr.write(`backfill-memory: ${r.reason}\n`); return 1; }
      process.stdout.write('marked\n');
      return 0;
    }
    default:
      process.stderr.write(`backfill-memory: unknown subcommand '${sub}'\n`);
      return 2;
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) process.exit(main(process.argv.slice(2)));
