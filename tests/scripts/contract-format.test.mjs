import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseContract, sha256, KNOWN_HARNESSES, HARNESS_OUTPUT, SCHEMA_VERSION,
} from '../../plugins/core/skills/core/scripts/contract-format.mjs';

const CONTRACT = `---
schema_version: "${SCHEMA_VERSION}"
contract_id: test-contract
canonical_for: [claude-code, codex]
last_revised: 2026-06-09
---

## Project Overview

This is a test project.

## Harness-Specific Sections

### claude-code-only

Claude Code specifics here.

### codex-only

Codex specifics here.
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'contract-format-'));
  const path = join(dir, 'CONTRACT.md');
  writeFileSync(path, CONTRACT);
  return { dir, path };
}

test('parseContract round-trips a minimal valid contract', () => {
  const { dir, path } = fixture();
  try {
    const c = parseContract(path);
    assert.equal(c.frontmatter.contract_id, 'test-contract');
    assert.equal(String(c.frontmatter.schema_version), SCHEMA_VERSION);
    assert.deepEqual(c.canonicalFor, ['claude-code', 'codex']);
    assert.equal(c.sections['Project Overview'], 'This is a test project.');
    assert.equal(c.harnessOnly['claude-code-only'], 'Claude Code specifics here.');
    assert.equal(c.harnessOnly['codex-only'], 'Codex specifics here.');
    assert.deepEqual(c.warnings, [], 'a fully-known canonical_for produces no warnings');
    assert.equal(c.raw, CONTRACT, 'raw bytes preserved for hashing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sha256 is stable for identical input and differs for different input', () => {
  const a = sha256('same content');
  const b = sha256('same content');
  const c = sha256('other content');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('every known harness has an output filename in HARNESS_OUTPUT', () => {
  assert.ok(KNOWN_HARNESSES.length > 0);
  for (const h of KNOWN_HARNESSES) {
    assert.ok(HARNESS_OUTPUT[h], `harness '${h}' has an output filename`);
    assert.match(HARNESS_OUTPUT[h], /\.md$/);
  }
  assert.deepEqual(Object.keys(HARNESS_OUTPUT).sort(), [...KNOWN_HARNESSES].sort(),
    'no output mapping for an unknown harness');
});
