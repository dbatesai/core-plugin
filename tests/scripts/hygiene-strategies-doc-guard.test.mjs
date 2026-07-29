import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// hygiene-strategies.md is the deeper-hygiene reference an agent executes. It drifted
// out of line with the canonical protocols/hygiene.md model (archive/retire/cold-store +
// file-cap), describing retired auto-MIGRATE machinery and a destructive `delete` verb.
// These guards keep the reconciliation from creeping back.
const SRC = readFileSync(
  fileURLToPath(new URL('../../plugins/core/skills/core/references/hygiene-strategies.md', import.meta.url)),
  'utf8',
);

test('the Phase-2 verb list uses retire (body-preserving), not a destructive unit delete', () => {
  // graduate/archive/retire are the canonical verbs; "delete" is scoped to index entries only.
  assert.match(SRC, /\*\*retire\*\*/, 'retire is offered as the verb for wrong/superseded units');
  assert.match(SRC, /body preserved/i, 'retire preserves the body (anti-resurrection)');
  assert.doesNotMatch(SRC, /\*\*delete\*\* \(wrong, or now in code\/docs\)/,
    'the old destructive "delete a unit" verb must be gone');
});

test('§3c describes v2 file-cap reconciliation, not retired auto-MIGRATE machinery', () => {
  assert.doesNotMatch(SRC, /Auto-MIGRATE runs autonomously/,
    'the retired auto-MIGRATE framing must be gone');
  assert.doesNotMatch(SRC, /Count MIGRATE entries/, 'no MIGRATE-count re-decision prompt');
  assert.match(SRC, /file-cap monitoring and proactive compaction/i,
    'points at the canonical hygiene.md file-cap mechanism');
});
