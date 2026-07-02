import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { retrieveContext } from '../../plugins/core/skills/core/scripts/retrieve-context.mjs';

// The per-turn retrieval hook runs in EVERY directory the user opens. If the dir
// has no CORE store, retrieveContext must not create one — before this fix it
// called generateSummaryIndex, which mkdir -p's _memories/_lib and littered
// unit-summaries.json into unrelated repos (T20).
test('T20: retrieveContext writes nothing into a store-less directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stray-write-'));
  try {
    const before = readdirSync(dir);
    const hits = retrieveContext('any query at all', dir, { topN: 3 });
    const after = readdirSync(dir);
    assert.deepEqual(after, before, `retrieveContext created files: ${JSON.stringify(after)}`);
    assert.deepEqual(hits, [], 'no store means no hits');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
