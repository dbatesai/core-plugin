import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const startupMd = readFileSync(join(ROOT, 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md'), 'utf8');

test('startup protocol gives agents the exact retrieval producer schema', () => {
  assert.match(startupMd, /record-retrieval-event\.mjs/, 'startup names the producer helper');
  assert.match(startupMd, /--event-json '\{/, 'startup shows an inline JSON producer example');
  assert.match(startupMd, /"trigger":"session-start"/, 'startup emits the session-start trigger (the resumption bootstrap path — formerly orient)');

  for (const field of [
    'trigger',
    'intent_topics',
    'tier_reached',
    'escalation_path',
    'units_retrieved',
    'dip_back_count',
    'candidate_count',
    'selected_count',
    'context_pack_token_estimate',
  ]) {
    assert.match(startupMd, new RegExp(`"${field}"`), `startup example includes ${field}`);
  }

  assert.match(
    startupMd,
    /Do not invent aliases such as `session_intent_topics`, `highest_tier_reached`, or `selected_units`/,
    'startup explicitly warns against producer-rejected aliases',
  );
  assert.doesNotMatch(
    startupMd,
    /highest tier reached|selected unit IDs/,
    'startup must not use ambiguous prose that led fresh agents to invent alias fields',
  );
});

test('MEM-001: retrieval.md documents the Tier 3 degraded fallback for harnesses without a subagent tool', () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/references/retrieval.md'),
    'utf8');
  assert.match(doc, /Degraded mode/, 'the fallback has a named home in the Tier 3 section');
  assert.match(doc, /result: "degraded"/, 'and specifies the logging contract');
});
