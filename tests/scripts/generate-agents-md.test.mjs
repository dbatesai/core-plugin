import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESS } from '../../plugins/core/skills/core/scripts/generate-agents-md.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-agents-md.mjs', import.meta.url));

const CONTRACT = `---
schema_version: "1.0"
contract_id: test-contract
canonical_for: [claude-code, codex]
last_revised: 2026-06-09
---

## Project Overview

A test project for the codex generator.

## Harness-Specific Sections

### codex-only

Codex specifics here.
`;

test('writes AGENTS.md from a contract via the CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-agents-'));
  try {
    writeFileSync(join(dir, 'CONTRACT.md'), CONTRACT);
    const r = spawnSync(process.execPath, [SCRIPT, '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = join(dir, 'AGENTS.md');
    assert.ok(existsSync(out), 'AGENTS.md written next to the contract');
    const md = readFileSync(out, 'utf8');
    assert.match(md, /GENERATED FROM CONTRACT — DO NOT EDIT BY HAND/);
    assert.match(md, /A test project for the codex generator\./);
    assert.match(md, /Codex specifics here\./, 'codex-only subsection rendered');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HARNESS export is codex', () => {
  assert.equal(HARNESS, 'codex');
});

test('no contract present → clean SKIP, exit 0, no file written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-agents-skip-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'absent contract is the common Codex case — skip, not crash');
    assert.match(r.stdout, /SKIP: no CONTRACT\.md/);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'nothing written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
