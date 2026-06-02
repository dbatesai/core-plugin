import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../plugins/core/skills/core/scripts/generate-memory-index.mjs'),
  'utf8',
);

// H1: the CLI entry guard must use fileURLToPath, not new URL().pathname.
// On Windows `new URL(import.meta.url).pathname` yields `/C:/...` (leading slash,
// %-encoded), which never equals `process.argv[1]` (`C:\...`), so the guard
// fails and the contamination-guarded MEMORY.md refresh silently no-ops.
test('generate-memory-index CLI guard uses fileURLToPath (H1 — Windows-safe)', () => {
  assert.ok(SRC.includes('fileURLToPath'), 'must import/use fileURLToPath for the CLI entry self-path');
});

test('generate-memory-index CLI guard does NOT use new URL().pathname (H1 regression)', () => {
  assert.ok(
    !/new URL\(\s*import\.meta\.url\s*\)\.pathname/.test(SRC),
    'new URL(import.meta.url).pathname breaks the entry guard on Windows — use fileURLToPath',
  );
});
