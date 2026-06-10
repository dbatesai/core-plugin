import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseContract, parseOverrides, renderForHarness, HARNESS_OUTPUT,
} from '../../plugins/core/skills/core/scripts/contract-format.mjs';
import { generate } from '../../plugins/core/skills/core/scripts/generate-claude-md.mjs';

const FIXTURE = `---
schema_version: 1.0
contract_id: demo-project
canonical_for: ["claude-code", "codex"]
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
    assert.deepEqual(c.frontmatter.canonical_for, ['claude-code', 'codex']);
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
  const { dir, p } = tmpContract(FIXTURE.replace('"codex"]', '"codex", "borg"]'));
  try {
    const c = parseContract(p);
    assert.ok(c.warnings.some((w) => /borg/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- render: harness-specific inclusion/exclusion ---

test('renderForHarness: claude-code gets canonical + claude-only, NOT codex-only', () => {
  const { dir, p } = tmpContract();
  try {
    const c = parseContract(p);
    const out = renderForHarness(c, 'claude-code', {});
    assert.ok(out.includes('Plain person voice'), 'canonical Identity & Voice');
    assert.ok(out.includes('Quality over speed'), 'canonical Project-Specific Rules');
    assert.ok(out.includes('Use the Agent tool'), 'claude-code-only section included');
    assert.ok(!out.includes('Use AGENTS.md conventions'), 'codex-only excluded');
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
});

// --- Hale review fixes (generator warnings + override hash fidelity) ---

test('generate: warns when target harness is not in canonical_for', async () => {
  const { dir, p } = tmpContract(FIXTURE.replace('canonical_for: ["claude-code", "codex"]', 'canonical_for: ["codex"]'));
  try {
    const r = await generate({ contractPath: p, mode: 'dry-run' }); // generate-claude-md, but contract is codex-only
    assert.ok(r.warnings.some((w) => /not in canonical_for/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: warns when last_revised is missing (determinism dependency)', async () => {
  const { dir, p } = tmpContract(FIXTURE.replace('last_revised: 2026-04-01\n', ''));
  try {
    const r = await generate({ contractPath: p, mode: 'dry-run' });
    assert.ok(r.warnings.some((w) => /last_revised/.test(w)));
    assert.ok(r.wouldWrite.includes('generated_at: unknown'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- Hale item 2: check mode FAILS CLOSED on fatal provenance issues ---

test('generate check: missing last_revised is FATAL (gate fails closed, not just warns)', async () => {
  const { dir, p } = tmpContract(FIXTURE.replace('last_revised: 2026-04-01\n', ''));
  try {
    const outPath = join(dir, 'CLAUDE.md');
    await generate({ contractPath: p, outputPath: outPath, mode: 'write' });
    const r = await generate({ contractPath: p, outputPath: outPath, mode: 'check' });
    assert.equal(r.fatal, true, 'missing last_revised makes the check fatal');
    assert.ok(r.fatalErrors.some((e) => /last_revised/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate check: last_revised:"unknown" is FATAL (separate from missing — Hale)', async () => {
  const { dir, p } = tmpContract(FIXTURE.replace('last_revised: 2026-04-01', 'last_revised: unknown'));
  try {
    const outPath = join(dir, 'CLAUDE.md');
    await generate({ contractPath: p, outputPath: outPath, mode: 'write' });
    const r = await generate({ contractPath: p, outputPath: outPath, mode: 'check' });
    assert.equal(r.fatal, true, "'unknown' last_revised fails closed like missing");
    assert.ok(r.fatalErrors.some((e) => /unknown/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate check: target harness not in canonical_for is FATAL', async () => {
  const { dir, p } = tmpContract(FIXTURE.replace('canonical_for: ["claude-code", "codex"]', 'canonical_for: ["codex"]'));
  try {
    const r = await generate({ contractPath: p, outputPath: join(dir, 'CLAUDE.md'), mode: 'check' });
    assert.equal(r.fatal, true);
    assert.ok(r.fatalErrors.some((e) => /canonical_for/.test(e)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate check: a clean contract is not fatal', async () => {
  const { dir, p } = tmpContract();
  try {
    const outPath = join(dir, 'CLAUDE.md');
    await generate({ contractPath: p, outputPath: outPath, mode: 'write' });
    const r = await generate({ contractPath: p, outputPath: outPath, mode: 'check' });
    assert.equal(r.fatal, false);
    assert.equal(r.drift, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parseOverrides: hash is over RAW bytes — a whitespace-only edit changes the hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ov-'));
  try {
    const a = join(dir, 'a.override'); const b = join(dir, 'b.override');
    writeFileSync(a, 'note');
    writeFileSync(b, 'note\n\n  '); // same trimmed content, different raw bytes
    assert.notEqual(parseOverrides(a).hash, parseOverrides(b).hash, 'raw-byte hash distinguishes whitespace edits');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both generators: each emits its own harness-only section, excludes the other', async () => {
  const { generate: genClaude } = await import('../../plugins/core/skills/core/scripts/generate-claude-md.mjs');
  const { generate: genAgents } = await import('../../plugins/core/skills/core/scripts/generate-agents-md.mjs');
  const { dir, p } = tmpContract();
  try {
    const c = await genClaude({ contractPath: p, mode: 'dry-run' });
    const a = await genAgents({ contractPath: p, mode: 'dry-run' });
    assert.ok(c.wouldWrite.includes('Use the Agent tool') && !c.wouldWrite.includes('AGENTS.md conventions'));
    assert.ok(a.wouldWrite.includes('AGENTS.md conventions') && !a.wouldWrite.includes('Use the Agent tool'));
    // both share the canonical sections
    for (const r of [c, a]) assert.ok(r.wouldWrite.includes('Plain person voice') && r.wouldWrite.includes('Quality over speed'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
