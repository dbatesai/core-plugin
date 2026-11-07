import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const startupMd = readFileSync(join(ROOT, 'plugins', 'core', 'skills', 'core', 'protocols', 'startup.md'), 'utf8');

test('startup writes no retrieval-analytics row; the per-turn hook records retrieval events when analytics are on', () => {
  assert.doesNotMatch(startupMd, /record-retrieval-event\.mjs/, 'startup no longer tells the agent to write a retrieval row');
  assert.match(startupMd, /Startup writes no retrieval-analytics row/, 'startup says so plainly');
});

test('retrieval.md documents the Tier 3 degraded fallback for harnesses without a subagent tool', () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/references/retrieval.md'),
    'utf8');
  assert.match(doc, /Degraded mode/, 'the fallback has a named home in the Tier 3 section');
  assert.match(doc, /result: "degraded"/, 'and specifies the logging contract');
});
