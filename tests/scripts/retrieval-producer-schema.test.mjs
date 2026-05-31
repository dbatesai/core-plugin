import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const startupMd = readFileSync(join(ROOT, 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md'), 'utf8');
const orientMd = readFileSync(join(ROOT, 'plugins', 'core', 'skills', 'orient', 'SKILL.md'), 'utf8');

test('startup protocol gives agents the exact retrieval producer schema', () => {
  assert.match(startupMd, /record-retrieval-event\.mjs/, 'startup names the producer helper');
  assert.match(startupMd, /--event-json '\{/, 'startup shows an inline JSON producer example');

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

test('orient skill wires the retrieval producer (the most common retrieval path)', () => {
  // /orient is a resumption bootstrap that runs the full ladder but historically
  // never emitted a retrieval row — leaving analyze-retrieval-quality blind to the
  // most common path. Guard the wiring so it can't silently regress.
  assert.match(orientMd, /record-retrieval-event\.mjs/, 'orient names the producer helper');
  assert.match(orientMd, /--event-json '\{/, 'orient shows an inline JSON producer example');
  assert.match(orientMd, /"trigger":"session-start"/, 'orient emits the session-start trigger (it is a resumption bootstrap)');
  assert.match(
    orientMd,
    /do not invent aliases/i,
    'orient carries the same schema-fidelity warning as startup',
  );
});
