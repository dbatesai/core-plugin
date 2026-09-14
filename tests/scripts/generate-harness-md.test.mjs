import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HARNESSES, generate } from '../../plugins/core/skills/core/scripts/generate-harness-md.mjs';

const SCRIPT = fileURLToPath(new URL('../../plugins/core/skills/core/scripts/generate-harness-md.mjs', import.meta.url));

const contract = (harness, text) => `---
schema_version: "1.0"
contract_id: test-contract
canonical_for: [claude-code, codex]
last_revised: 2026-06-09
---

## Project Overview

A test project for the ${harness} generator.

## Harness-Specific Sections

### ${harness}-only

${text}
`;

test('the harness table names both harnesses with their output file and missing-contract policy', () => {
  assert.deepEqual(Object.keys(HARNESSES).sort(), ['claude-code', 'codex']);
  assert.equal(HARNESSES['claude-code'].output, 'CLAUDE.md');
  assert.equal(HARNESSES.codex.output, 'AGENTS.md');
  assert.equal(HARNESSES['claude-code'].missingContract, 'error');
  assert.equal(HARNESSES.codex.missingContract, 'skip');
});

for (const [harness, text] of [['claude-code', 'Claude Code specifics here.'], ['codex', 'Codex specifics here.']]) {
  test(`--harness ${harness} writes ${HARNESSES[harness].output} from a contract via the CLI`, () => {
    const dir = mkdtempSync(join(tmpdir(), `gen-${harness}-`));
    try {
      writeFileSync(join(dir, 'CONTRACT.md'), contract(harness, text));
      const r = spawnSync(process.execPath, [SCRIPT, '--harness', harness, '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const out = join(dir, HARNESSES[harness].output);
      assert.ok(existsSync(out), `${HARNESSES[harness].output} written next to the contract`);
      const md = readFileSync(out, 'utf8');
      assert.match(md, /GENERATED FROM CONTRACT — DO NOT EDIT BY HAND/);
      assert.match(md, new RegExp(`A test project for the ${harness} generator\\.`));
      assert.ok(md.includes(text), `${harness}-only subsection rendered`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

// Missing-contract policy per harness. Claude Code: the CLI validates the path at
// its trust boundary — one named diagnostic on stderr, exit 2, nothing written, no
// stack. Codex: an absent contract is the normal case (a folder can have CLAUDE.md
// or neither and no adopted contract yet) — SKIP cleanly, exit 0, nothing written.
test('claude-code with no contract → exit 2, one bounded diagnostic, no file written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-claude-missing-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--harness', 'claude-code', '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.equal(r.status, 2, 'missing contract fails loudly');
    assert.match(r.stderr, /contract file not found/);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace at the CLI boundary');
    assert.ok(!existsSync(join(dir, 'CLAUDE.md')), 'nothing written');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('codex with no contract → clean SKIP, exit 0, no file written; the library call returns { skipped }', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gen-codex-skip-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--harness', 'codex', '--contract', join(dir, 'CONTRACT.md'), '--mode', 'write'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'absent contract is the common Codex case — skip, not crash');
    assert.match(r.stdout, /SKIP: no CONTRACT\.md/);
    assert.ok(!existsSync(join(dir, 'AGENTS.md')), 'nothing written');
    const lib = await generate({ harness: 'codex', contractPath: join(dir, 'CONTRACT.md'), mode: 'write' });
    assert.equal(lib.skipped, true); assert.equal(lib.reason, 'no-contract');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unknown or missing --harness is refused with exit 2 and names the choices', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--contract', 'CONTRACT.md'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--harness claude-code\|codex/);
  assert.rejects(() => generate({ harness: 'gemini', contractPath: 'x' }), /unknown harness "gemini"/);
});
