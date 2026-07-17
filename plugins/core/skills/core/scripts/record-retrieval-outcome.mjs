#!/usr/bin/env node
/** Record an evidence-qualified answer outcome for one existing retrieval. */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { logEvent, sanitizeAttributeValue } from './log-event.mjs';
import { acquireFileLock, releaseFileLock } from './file-lock.mjs';

export const USEFULNESS_OUTCOMES = new Set(['useful', 'partial', 'noisy', 'miss']);
export const EVIDENCE_KINDS = new Set(['user-confirmed', 'answer-citation', 'agent-judgment']);

export function outcomeLockPath(projectDir) {
  return join(projectDir, '_sessions', '.retrieval-outcome.lock');
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

export function normalizeRetrievalOutcome(input) {
  const retrievalId = typeof input?.retrieval_id === 'string' ? input.retrieval_id.trim() : '';
  if (!retrievalId) throw new Error('invalid retrieval outcome: retrieval_id must be a non-empty string');
  if (!USEFULNESS_OUTCOMES.has(input.usefulness_outcome)) {
    throw new Error(`invalid retrieval outcome: usefulness_outcome must be one of ${[...USEFULNESS_OUTCOMES].join(', ')}`);
  }
  if (!EVIDENCE_KINDS.has(input.evidence_kind)) {
    throw new Error(`invalid retrieval outcome: evidence_kind must be one of ${[...EVIDENCE_KINDS].join(', ')}`);
  }
  return {
    kind: 'retrieval-outcome',
    retrieval_id: sanitizeAttributeValue(retrievalId, { maxLen: 200 }),
    usefulness_outcome: input.usefulness_outcome,
    evidence_kind: input.evidence_kind,
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
    if (rows.some(row => row.kind === 'retrieval-outcome' && row.retrieval_id === record.retrieval_id)) {
      throw new Error(`retrieval ${record.retrieval_id} already has an outcome`);
    }
    const writeOutcome = logEvent(projectDir, 'retrieval-log.jsonl', record, opts) || { legacy: false, otel: false, reason: 'no-outcome' };
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
      evidence_kind: flags.get('evidence-kind'),
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
