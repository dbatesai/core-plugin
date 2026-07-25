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
import { producerIdentity } from './producer-identity.mjs';

// Stamped on every row this producer writes from 2026-07-22 onward (the
// metrics-evidence-lifecycle slice-2 review: a reader validating retrieval
// rows needs to tell "written under the current, fully-enforced producer
// contract" apart from "predates this contract entirely" — bump this only
// when normalizeRetrievalEvent()'s REQUIRED-field contract changes in a way
// that would reject rows a prior version accepted).
// 1.1.0 (v3.14.0 Link 4a): rows carry producer_version/producer_sha — additive.
export const RETRIEVAL_EVENT_SCHEMA_VERSION = '1.1.0';

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
  // Closed intra-tier provenance (2026-07-17): which stage of the Tier-1 product
  // pipeline produced the hit. NEVER encoded in the ladder tier.
  if (unit.source_stage !== undefined && !['ranked', 'one-hop-expansion'].includes(unit.source_stage)) {
    fail(`units_retrieved[${idx}].source_stage`, 'must be ranked or one-hop-expansion');
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
  if (unitsRetrieved.length === 0) {
    // Two honest empty-result shapes (live-hook audit 2026-07-17 — a
    // no-hit must never fabricate a Tier-3 escalation that didn't run):
    //  - a full-ladder Tier 3 search that found nothing  -> result 'miss'
    //  - the per-turn hook's model-free pipeline (tiers 1-2 only) finding
    //    nothing, with NO escalation attempted             -> result 'no-hit'
    const tier3Miss = event.tier_reached === 3 && event.result === 'miss';
    const hookNoHit = event.trigger === 'per-turn-hook' && event.result === 'no-hit' && event.tier_reached <= 2;
    if (!tier3Miss && !hookNoHit) {
      fail('result', 'empty units require Tier-3 "miss" or per-turn-hook "no-hit" at tier <= 2');
    }
  }

  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    if (event[field] !== undefined) requireNonNegativeInteger(event[field], field);
  }

  // Optional producer-honesty fields (2026-07-17): `mechanism` names what
  // actually ran (closed enum — never free text), `retrieval_id` correlates
  // the row with traces and downstream outcome sampling.
  if (event.mechanism !== undefined && !['model-free-substrate', 'reasoning-shortlist', 'explore-subagent', 'inline-degraded'].includes(event.mechanism)) {
    fail('mechanism', 'must be one of the closed mechanism vocabulary');
  }
  if (event.retrieval_id !== undefined) requireString(event.retrieval_id, 'retrieval_id');

  return {
    // Producer identity (Link 4a): every row says which build wrote it. The
    // shared manifest read is the default; an explicit caller value wins (a
    // row relayed from another producer keeps its original identity).
    ...producerIdentity(),
    ...event,
    kind: 'retrieval',
    schema_version: RETRIEVAL_EVENT_SCHEMA_VERSION, // always OUR stamp, never a caller-supplied value
    intent_topics: intentTopics,
    escalation_path: escalationPath,
    units_retrieved: unitsRetrieved,
  };
}

// Returns { record, written, write_outcome } — `written` is the authoritative
// legacy-row delivery; callers that need delivery evidence must check it
// rather than trusting the normalized record's existence.
export function recordRetrievalEvent(projectDir, event, opts = {}) {
  const record = normalizeRetrievalEvent(event);
  const outcome = logEvent(projectDir, 'retrieval-log.jsonl', record, opts) || { legacy: false, otel: false, reason: 'no-outcome' };
  return { record, written: outcome.legacy === true, write_outcome: outcome };
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
  const out = recordRetrievalEvent(projectDir, event, {
    today: args.flags.get('today'),
    now: args.flags.get('now'),
    sessionId: args.flags.get('session-id'),
    workspaceId: args.flags.get('workspace-id'),
  });
  // Machine-readable delivery receipt: normalization succeeding is NOT delivery
  //. Automation gets exit 1 + the outcome on a write failure.
  process.stdout.write(JSON.stringify({ written: out.written, write_outcome: out.write_outcome }) + '\n');
  return out.written ? 0 : 1;
}

const _cliEntryCanonical = (p) => { try { return realpathSync(p); } catch { return p; } };
const _cliEntryArgv1 = _cliEntryCanonical(process.argv[1]);
const _cliEntrySelf = _cliEntryCanonical(fileURLToPath(import.meta.url));
if (_cliEntryArgv1 === _cliEntrySelf) {
  process.exit(main(process.argv.slice(2)));
}
