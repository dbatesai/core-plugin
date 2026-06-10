import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESS } from '../../plugins/core/skills/core/scripts/generate-claude-md.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-claude-md.mjs', import.meta.url));

const CONTRACT = `---
schema_version: "1.0"
contract_id: test-contract
canonical_for: [claude-code, codex]
last_revised: 2026-06-09
---

## Project Overview

A test project for the claude-code generator.

## Harness-Specific Sections

### claude-code-only

Claude Code specifics here.
`;

test('writes CLAUDE.md from a contract via the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-claude-'));
  try {
    writeFileSync(join(dir, 'CONTRACT.md'), CONTRACT);
    const r = spawnSync(process.execPath, [SCRIPT, '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = join(dir, 'CLAUDE.md');
    assert.ok(existsSync(out), 'CLAUDE.md written next to the contract');
    const md = readFileSync(out, 'utf8');
    assert.match(md, /GENERATED FROM CONTRACT — DO NOT EDIT BY HAND/);
    assert.match(md, /A test project for the claude-code generator\./);
    assert.match(md, /Claude Code specifics here\./, 'claude-code-only subsection rendered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HARNESS export is claude-code', () => {
  assert.equal(HARNESS, 'claude-code');
});

// Characterization: unlike generate-agents-md (which guards the absent-contract case
// with a clean SKIP), this generator lets parseContract's ENOENT throw — the process
// exits non-zero with the error on stderr and writes nothing.
test('no contract present → non-zero exit, no file written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-claude-missing-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'missing contract fails loudly');
    assert.match(r.stderr, /ENOENT/);
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'nothing written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
