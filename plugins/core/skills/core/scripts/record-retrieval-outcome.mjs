#!/usr/bin/env node
/** Record an evidence-qualified answer outcome for one existing retrieval. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logEvent, sanitizeAttributeValue } from './log-event.mjs';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';

// Contract: 'unknown' is a first-class honest state; evidence AUTHORITY is
// carried separately from the outcome so weak attribution can never look
// confirmed; identity (harness, session/turn, producer version) is REQUIRED.
export const USEFULNESS_OUTCOMES = new Set(['useful', 'partial', 'noisy', 'miss', 'unknown']);
export const EVIDENCE_AUTHORITY = new Set(['user-confirmed', 'objective-task-success', 'corrective-retry', 'agent-attribution', 'unobservable']);

export function outcomeLockPath(projectDir) {
  return join(projectDir, '_sessions', '.retrieval-outcome.lock');
}

// Filename-safe: a session id is harness-controlled input, not guaranteed
// path-safe. Anything outside this allowlist collapses to '_' before it ever
// reaches the filesystem — no path separators, no traversal, no platform-
// illegal characters can escape the intended directory.
export function sanitizeForFilename(value, maxLen = 24) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, maxLen);
}

export function pendingOutcomePath(projectDir, harness, sessionId) {
  if (!harness || !sessionId) return null;
  return join(projectDir, '_memories', '_lib', `pending-retrieval-${sanitizeForFilename(harness, 20)}-${sanitizeForFilename(sessionId)}.json`);
}

// Shared authority resolver — ONE resolver across consumers.
// Every consumer that folds multiple outcome
// rows for one retrieval_id down to a single resolved outcome must go
// through this — analyze-retrieval-quality.mjs and metrics-package.mjs both
// do. Highest evidence_authority wins; a tie among top-ranked rows that
// disagree resolves to 'unknown' rather than picking arbitrarily.
export const AUTHORITY_RANK = { 'user-confirmed': 4, 'objective-task-success': 3, 'corrective-retry': 2, 'agent-attribution': 1, 'unobservable': 0 };

export function resolveOutcomeAuthority(rows) {
  if (!rows || !rows.length) return null;
  const ranked = rows
    .filter((r) => r && USEFULNESS_OUTCOMES.has(r.usefulness_outcome))
    .map((r) => ({ outcome: r.usefulness_outcome, rank: AUTHORITY_RANK[String(r.evidence_authority)] ?? 0 }));
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.rank - a.rank);
  const top = ranked.filter((r) => r.rank === ranked[0].rank);
  const distinct = new Set(top.map((r) => r.outcome));
  return distinct.size === 1 ? top[0].outcome : 'unknown';
}

function retrievalRows(projectDir) {
  const sessions = join(projectDir, '_sessions');
  if (!existsSync(sessions)) return [];
  const rows = [];
  for (const date of readdirSync(sessions).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const file = join(sessions, date, 'retrieval-log.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* malformed evidence is not a match */ }
    }
  }
  return rows;
}

function requireStr(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid retrieval outcome: ${field} must be a non-empty string`);
  return value.trim();
}

export function normalizeRetrievalOutcome(input) {
  const retrievalId = requireStr(input?.retrieval_id, 'retrieval_id');
  if (!USEFULNESS_OUTCOMES.has(input.usefulness_outcome)) {
    throw new Error(`invalid retrieval outcome: usefulness_outcome must be one of ${[...USEFULNESS_OUTCOMES].join(', ')}`);
  }
  if (!EVIDENCE_AUTHORITY.has(input.evidence_authority)) {
    throw new Error(`invalid retrieval outcome: evidence_authority must be one of ${[...EVIDENCE_AUTHORITY].join(', ')}`);
  }
  // Honesty coupling: an outcome stronger than 'unknown' cannot rest on
  // unobservable evidence, and 'unknown' is the required default whenever the
  // product cannot see an answer result — missing is never neutral or success.
  if (input.usefulness_outcome !== 'unknown' && input.evidence_authority === 'unobservable') {
    throw new Error('invalid retrieval outcome: a non-unknown outcome cannot be unobservable');
  }
  // Required identity (strengthened audit item 3): harness, resolved non-null
  // session + answer-turn identity, producer/schema version.
  const harness = requireStr(input.harness, 'harness');
  const sessionId = requireStr(input.session_id, 'session_id');
  const answerTurnId = requireStr(input.answer_turn_id, 'answer_turn_id');
  const producerVersion = requireStr(input.producer_version, 'producer_version');
  // producer_sha: producer_version alone can't distinguish which
  // exact commit produced a row -- many SHAs can ship the same
  // semver string. 'unknown' is the honest default when the manifest carries
  // no source_sha (unstamped builds, --scope local dev installs) rather than a
  // guessed or omitted value -- same 'unknown is first-class' philosophy as
  // usefulness_outcome above. Required, not optional, so no call site can
  // silently skip stating it.
  const producerSha = requireStr(input.producer_sha, 'producer_sha');
  return {
    kind: 'retrieval-outcome',
    schema_version: '1.2.0',
    retrieval_id: sanitizeAttributeValue(retrievalId, { maxLen: 200 }),
    usefulness_outcome: input.usefulness_outcome,
    evidence_authority: input.evidence_authority,
    harness: sanitizeAttributeValue(harness, { maxLen: 40 }),
    session_id: sanitizeAttributeValue(sessionId, { maxLen: 80 }),
    answer_turn_id: sanitizeAttributeValue(answerTurnId, { maxLen: 80 }),
    producer_version: sanitizeAttributeValue(producerVersion, { maxLen: 24 }),
    producer_sha: sanitizeAttributeValue(producerSha, { maxLen: 44 }),
    ...(typeof input.signal_overlap === 'number' && Number.isFinite(input.signal_overlap)
      ? { signal_overlap: Math.round(input.signal_overlap * 1000) / 1000 } // observed provisional signal, never an outcome by itself
      : {}),
    ...(typeof input.note === 'string' && input.note.trim()
      ? { note: sanitizeAttributeValue(input.note.trim(), { maxLen: 500 }) }
      : {}),
  };
}

export function recordRetrievalOutcome(projectDir, input, opts = {}) {
  const record = normalizeRetrievalOutcome(input);
  const lock = acquireFileLock(outcomeLockPath(projectDir));
  if (!lock.ok) throw new Error(`retrieval outcome writer is locked (${lock.reason})`);
  try {
    const rows = retrievalRows(projectDir);
    const bases = rows.filter(row => row.kind === 'retrieval' && row.retrieval_id === record.retrieval_id);
    if (bases.length !== 1) throw new Error(`retrieval_id must identify exactly one retrieval; found ${bases.length}`);
    // A second (or Nth) outcome row for the same retrieval_id is EXPECTED, not
    // an error — an automatic unknown must never block
    // stronger later evidence. The auto-close path writes 'unknown' the
    // moment closure is inferred; real evidence — a user confirmation, a
    // corrective retry — can arrive after that and must still be recordable.
    // Consumers resolve multiple rows via resolveOutcomeAuthority() above, so
    // rejecting the append here would make that resolver permanently dead
    // code on the live write path. SEPARATE later outcome log:
    // outcome rows never enter the append-only
    // retrieval log they judge.
    const writeOutcome = logEvent(projectDir, 'outcome-log.jsonl', record, opts) || { legacy: false, otel: false, reason: 'no-outcome' };
    return { record, written: writeOutcome.legacy === true, write_outcome: writeOutcome };
  } finally {
    releaseFileLock(outcomeLockPath(projectDir), lock.nonce);
  }
}

export function main(argv) {
  const projectDir = resolve(argv[0] || '.');
  const flags = new Map();
  for (let i = 1; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    flags.set(argv[i].slice(2), argv[i + 1]);
    i += 1;
  }
  try {
    const result = recordRetrievalOutcome(projectDir, {
      retrieval_id: flags.get('retrieval-id'),
      usefulness_outcome: flags.get('outcome'),
      evidence_authority: flags.get('evidence-authority'),
      harness: flags.get('harness'),
      session_id: flags.get('session-id'),
      answer_turn_id: flags.get('answer-turn-id'),
      producer_version: flags.get('producer-version'),
      producer_sha: flags.get('producer-sha'),
      note: flags.get('note'),
    });
    process.stdout.write(`${JSON.stringify({ written: result.written, write_outcome: result.write_outcome })}\n`);
    return result.written ? 0 : 1;
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 2;
  }
}

if (basename(process.argv[1] || '') === basename(import.meta.filename)) {
  process.exit(main(process.argv.slice(2)));
}
