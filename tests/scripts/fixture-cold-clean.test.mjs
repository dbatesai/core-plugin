// GUARD — the committed fixture stores stay cold.
//
// Even "read" retrieval paths write the cached index
// (_memories/_lib/unit-summaries.json) into whatever store they are pointed
// at. Every stock test therefore runs against a mkdtemp CLONE of its fixture
// (the retrieval-premise.test.mjs pattern), never the checked-in tree. This
// test is the tripwire: it fails if any checked-in fixture carries derived
// `_lib` state — i.e. if a test (present or future) pointed a cache-writing
// read at the committed fixture again.
//
// Debris is persistent, which is what makes this deterministic: a recreation
// that lands after this file runs in one suite invocation is still on disk at
// the START of the next cold run, so it cannot survive two runs unseen. The
// falsifier for this guard: point any retrieval read at a checked-in fixture,
// run the suite twice — this test goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function findDerivedState(root) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '_lib') hits.push(relative(FIXTURES, p));
        else walk(p);
      } else if (entry.name === 'unit-summaries.json') {
        hits.push(relative(FIXTURES, p));
      }
    }
  };
  walk(root);
  return hits;
}

test('checked-in fixture trees carry no derived _lib state (cold-clean invariant)', () => {
  const hits = findDerivedState(FIXTURES);
  assert.deepEqual(hits, [],
    'derived cache state found inside checked-in fixtures — a test pointed a '
    + 'cache-writing read at the committed tree instead of a mkdtemp clone '
    + `(see retrieval-premise.test.mjs for the pattern): ${hits.join(', ')}`);
});
