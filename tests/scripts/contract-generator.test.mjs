import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseContract, parseOverrides, renderForHarness, withProvenance, computeProvenance, HARNESS_OUTPUT,
} from '../../skills/core/scripts/contract-format.mjs';
import { generate } from '../../skills/core/scripts/generate-claude-md.mjs';

const FIXTURE = `---
schema_version: 1.0
contract_id: demo-project
canonical_for: ["claude-code", "codex", "gemini"]
maintained_by: David
last_revised: 2026-04-01
---

# Project Contract

## Identity & Voice
Plain person voice. Always.

## Project-Specific Rules
Quality over speed.

## Harness-Specific Sections
### claude-code-only
Use the Agent tool for subagents.

### codex-only
Use AGENTS.md conventions.

### gemini-only
Use activate_skill.
`;

function tmpContract(body = FIXTURE) {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  const p = join(dir, 'CONTRACT.md');
  writeFileSync(p, body);
  return { dir, p };
}

// --- parser + schema validation (§2) ---

test('parseContract: reads frontmatter + sections', () => {
  const { dir, p } = tmpContract();
  try {
    const c = parseContract(p);
    assert.equal(c.frontmatter.schema_version, '1.0');
    assert.equal(c.frontmatter.contract_id, 'demo-project');
    assert.deepEqual(c.frontmatter.canonical_for, ['claude-code', 'codex', 'gemini']);
    assert.ok(c.sections['Identity & Voice'].includes('Plain person voice'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseContract: wrong schema_version → throws clear error', () => {
  const { dir, p } = tmpContract(FIXTURE.replace('schema_version: 1.0', 'schema_version: 9.9'));
  try {
    assert.throws(() => parseContract(p), /schema_version/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseContract: missing required field → throws', () => {
  const { dir, p } = tmpContract(FIXTURE.replace('contract_id: demo-project\n', ''));
  try {
    assert.throws(() => parseContract(p), /contract_id/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseContract: unknown harness in canonical_for → warning, not throw', () => {
  const { dir, p } = tmpContract(FIXTURE.replace('"gemini"]', '"gemini", "borg"]'));
  try {
    const c = parseContract(p);
    assert.ok(c.warnings.some((w) => /borg/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- render: harness-specific inclusion/exclusion ---

test('renderForHarness: claude-code gets canonical + claude-only, NOT codex/gemini-only', () => {
  const { dir, p } = tmpContract();
  try {
    const c = parseContract(p);
    const out = renderForHarness(c, 'claude-code', {});
    assert.ok(out.includes('Plain person voice'), 'canonical Identity & Voice');
    assert.ok(out.includes('Quality over speed'), 'canonical Project-Specific Rules');
    assert.ok(out.includes('Use the Agent tool'), 'claude-code-only section included');
    assert.ok(!out.includes('Use AGENTS.md conventions'), 'codex-only excluded');
    assert.ok(!out.includes('Use activate_skill'), 'gemini-only excluded');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- determinism (the load-bearing v3.0 property) ---

test('generate: deterministic — same contract → byte-identical output (generated_at = last_revised, not wall-clock)', async () => {
  const { dir, p } = tmpContract();
  try {
    const outPath = join(dir, 'CLAUDE.md');
    const r1 = await generate({ contractPath: p, outputPath: outPath, mode: 'dry-run' });
    const r2 = await generate({ contractPath: p, outputPath: outPath, mode: 'dry-run' });
    assert.equal(r1.wouldWrite, r2.wouldWrite, 'two dry-runs byte-identical');
    assert.ok(r1.wouldWrite.includes('generated_at: 2026-04-01'), 'generated_at is contract.last_revised, not today');
    assert.ok(/contract_hash: [0-9a-f]{64}/.test(r1.wouldWrite), 'sha256 contract hash in provenance');
    assert.ok(r1.wouldWrite.includes('DO NOT EDIT BY HAND'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate check mode: matches after write (no drift), drifts after hand-edit', async () => {
  const { dir, p } = tmpContract();
  try {
    const outPath = join(dir, 'CLAUDE.md');
    await generate({ contractPath: p, outputPath: outPath, mode: 'write' });
    const clean = await generate({ contractPath: p, outputPath: outPath, mode: 'check' });
    assert.equal(clean.drift, false, 'freshly written file has no drift');
    writeFileSync(outPath, readFileSync(outPath, 'utf8') + '\nhand edit\n');
    const dirty = await generate({ contractPath: p, outputPath: outPath, mode: 'check' });
    assert.equal(dirty.drift, true, 'hand-edited file detected as drift');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: override file appended with separator + reflected in override_block_hash', async () => {
  const { dir, p } = tmpContract();
  try {
    const outPath = join(dir, 'CLAUDE.md');
    const ovPath = join(dir, 'CLAUDE.md.override');
    writeFileSync(ovPath, 'Extra Claude-only note.');
    const r = await generate({ contractPath: p, outputPath: outPath, overridePath: ovPath, mode: 'dry-run' });
    assert.ok(r.wouldWrite.includes('BEGIN OVERRIDE'), 'override separator present');
    assert.ok(r.wouldWrite.includes('Extra Claude-only note'), 'override content appended');
    assert.ok(!/override_block_hash: none/.test(r.wouldWrite), 'override hash set when override present');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HARNESS_OUTPUT maps harnesses to canonical filenames', () => {
  assert.equal(HARNESS_OUTPUT['claude-code'], 'CLAUDE.md');
  assert.equal(HARNESS_OUTPUT['codex'], 'AGENTS.md');
  assert.equal(HARNESS_OUTPUT['gemini'], 'GEMINI.md');
});

test('all three generators: each emits its own harness-only section, excludes the others', async () => {
  const { generate: genClaude } = await import('../../skills/core/scripts/generate-claude-md.mjs');
  const { generate: genAgents } = await import('../../skills/core/scripts/generate-agents-md.mjs');
  const { generate: genGemini } = await import('../../skills/core/scripts/generate-gemini-md.mjs');
  const { dir, p } = tmpContract();
  try {
    const c = await genClaude({ contractPath: p, mode: 'dry-run' });
    const a = await genAgents({ contractPath: p, mode: 'dry-run' });
    const g = await genGemini({ contractPath: p, mode: 'dry-run' });
    assert.ok(c.wouldWrite.includes('Use the Agent tool') && !c.wouldWrite.includes('AGENTS.md conventions') && !c.wouldWrite.includes('activate_skill'));
    assert.ok(a.wouldWrite.includes('AGENTS.md conventions') && !a.wouldWrite.includes('Use the Agent tool') && !a.wouldWrite.includes('activate_skill'));
    assert.ok(g.wouldWrite.includes('activate_skill') && !g.wouldWrite.includes('Use the Agent tool') && !g.wouldWrite.includes('AGENTS.md conventions'));
    // all three share the canonical sections
    for (const r of [c, a, g]) assert.ok(r.wouldWrite.includes('Plain person voice') && r.wouldWrite.includes('Quality over speed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
