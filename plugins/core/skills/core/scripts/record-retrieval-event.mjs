#!/usr/bin/env node
/**
 * record-retrieval-event.mjs — producer helper for v3 retrieval evidence.
 *
 * This is the narrow write path for retrieval-shaped evidence. It reuses the
 * shared `logEvent()` substrate so one producer call writes both the legacy
 * `_sessions/<date>/retrieval-log.jsonl` row and the OTel trace span.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent, sanitizeAttributeValue } from './log-event.mjs';

export const VALID_TRIGGERS = new Set([
  'session-start',
  'mid-conversation',
  'subagent',
  'refresh-context',
  'per-turn-hook', // the canonical product-emitted event: retrieve-context-hook writes one per turn (2026-07-17)
]);

const NON_NEGATIVE_INTEGER_FIELDS = [
  'dip_back_count',
  'candidate_count',
  'selected_count',
  'edge_count',
  'retired_suppressed_count',
  'stale_suppressed_count',
  'native_memory_suppressed_count',
  'context_pack_token_estimate',
];

function fail(field, message) {
  throw new Error(`invalid retrieval event: ${field} ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail(field, 'must be a non-empty string');
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) fail(field, 'must be a non-negative integer');
}

function normalizeUnit(unit, idx) {
  if (!isPlainObject(unit)) fail('units_retrieved', `entry ${idx} must be an object`);
  requireString(unit.id, `units_retrieved[${idx}].id`);
  if (!Number.isInteger(unit.tier) || unit.tier < 1 || unit.tier > 3) {
    fail(`units_retrieved[${idx}].tier`, 'must be 1, 2, or 3');
  }
  if (unit.score !== undefined && (typeof unit.score !== 'number' || Number.isNaN(unit.score))) {
    fail(`units_retrieved[${idx}].score`, 'must be a number when present');
  }
  return { ...unit, id: sanitizeAttributeValue(unit.id.trim(), { maxLen: 200 }) };
}

export function normalizeRetrievalEvent(event) {
  if (!isPlainObject(event)) fail('event', 'must be an object');

  if (!VALID_TRIGGERS.has(event.trigger)) {
    fail('trigger', `must be one of ${Array.from(VALID_TRIGGERS).join(', ')}`);
  }

  if (!Array.isArray(event.intent_topics) || event.intent_topics.length === 0) {
    fail('intent_topics', 'must be a non-empty string array');
  }
  const intentTopics = event.intent_topics.map((topic, idx) => {
    requireString(topic, `intent_topics[${idx}]`);
    return sanitizeAttributeValue(topic.trim(), { maxLen: 200 });
  });

  if (!Number.isInteger(event.tier_reached) || event.tier_reached < 1 || event.tier_reached > 3) {
    fail('tier_reached', 'must be 1, 2, or 3');
  }

  if (!Array.isArray(event.escalation_path) || event.escalation_path.length === 0) {
    fail('escalation_path', 'must be a non-empty array');
  }
  const escalationPath = event.escalation_path.map((tier, idx) => {
    if (!Number.isInteger(tier) || tier < 1 || tier > 3) {
      fail(`escalation_path[${idx}]`, 'must be 1, 2, or 3');
    }
    return tier;
  });
  if (escalationPath[escalationPath.length - 1] !== event.tier_reached) {
    fail('escalation_path', 'must end at tier_reached');
  }

  if (!Array.isArray(event.units_retrieved)) {
    fail('units_retrieved', 'must be an array');
  }
  const unitsRetrieved = event.units_retrieved.map(normalizeUnit);
  if (unitsRetrieved.length === 0 && !(event.tier_reached === 3 && event.result === 'miss')) {
    fail('result', 'must be "miss" when Tier 3 retrieval returns no units');
  }

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    if (event[field] !== undefined) requireNonNegativeInteger(event[field], field);
  }

  return { ...event, kind: 'retrieval', intent_topics: intentTopics, escalation_path: escalationPath, units_retrieved: unitsRetrieved };
}

export function recordRetrievalEvent(projectDir, event, opts = {}) {
  const record = normalizeRetrievalEvent(event);
  logEvent(projectDir, 'retrieval-log.jsonl', record, opts);
  return record;
}

function parseArgs(argv) {
  const out = { flags: new Map(), positionals: [] };
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out.flags.set(key, true);
        i++;
      } else {
        out.flags.set(key, next);
        i += 2;
      }
    } else {
      out.positionals.push(tok);
      i++;
    }
  }
  return out;
}

function loadEvent(flags) {
  if (flags.has('event-json')) return JSON.parse(String(flags.get('event-json')));
  if (flags.has('event-file')) return JSON.parse(readFileSync(String(flags.get('event-file')), 'utf8'));
  const raw = readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

export function main(argv) {
  const args = parseArgs(argv);
  const projectDir = resolve(args.positionals[0] || '.');
  let event;
  try {
    event = loadEvent(args.flags);
  } catch (err) {
    process.stderr.write(`error: retrieval event JSON is required: ${err.message}\n`);
    return 2;
  }
  recordRetrievalEvent(projectDir, event, {
    today: args.flags.get('today'),
    now: args.flags.get('now'),
    sessionId: args.flags.get('session-id'),
    workspaceId: args.flags.get('workspace-id'),
  });
  return 0;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
