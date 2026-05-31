import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateToContract } from '../../skills/core/scripts/migrate-to-contract.mjs';
import { parseContract } from '../../skills/core/scripts/contract-format.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('migrate: shared lines → canonical; unique lines → harness-only', () => {
  const r = migrateToContract({
    contractId: 'p', lastRevised: '2026-04-01',
    files: {
      'claude-code': 'Plain voice always.\nQuality over speed.\nUse the Agent tool.',
      codex: 'Plain voice always.\nQuality over speed.\nUse AGENTS.md conventions.',
    },
  });
  // "Plain voice always." and "Quality over speed." are in both → canonical
  assert.ok(/Plain voice always\./.test(r.draft));
  assert.ok(/Quality over speed\./.test(r.draft));
  // harness-only lines land in their sections
  assert.ok(/claude-code-only[\s\S]*Use the Agent tool/.test(r.draft));
  assert.ok(/codex-only[\s\S]*AGENTS\.md conventions/.test(r.draft));
});

test('migrate: draft is a parseable contract with correct canonical_for', () => {
  const r = migrateToContract({
    contractId: 'demo', lastRevised: '2026-04-01',
    files: { 'claude-code': 'Shared line.\nClaude thing.', codex: 'Shared line.\nCodex thing.' },
  });
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  try {
    const p = join(dir, 'CONTRACT.md');
    writeFileSync(p, r.draft);
    const c = parseContract(p);
    assert.equal(c.frontmatter.contract_id, 'demo');
    assert.deepEqual(c.canonicalFor.sort(), ['claude-code', 'codex']);
    assert.ok(c.warnings.length === 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migrate: a single harness file → all its content is harness-only (no false shared)', () => {
  const r = migrateToContract({ contractId: 'solo', lastRevised: '2026-04-01', files: { 'claude-code': 'A.\nB.\nC.' } });
  assert.equal(r.stats.shared, 0, 'nothing shared with only one file');
  assert.ok(r.stats.perHarness['claude-code'] >= 3);
});

test('migrate: strips an existing generated provenance header from inputs', () => {
  const generated = '<!--\nGENERATED FROM CONTRACT — DO NOT EDIT BY HAND\ncontract_hash: abc\n-->\n\nReal content line.';
  const r = migrateToContract({ contractId: 'p', lastRevised: '2026-04-01', files: { 'claude-code': generated, codex: 'Real content line.' } });
  assert.ok(!/GENERATED FROM CONTRACT/.test(r.draft), 'provenance header not migrated into the contract');
  assert.ok(/Real content line\./.test(r.draft));
});

test('migrate: output is marked DRAFT for user review (dry-run default)', () => {
  const r = migrateToContract({ contractId: 'p', lastRevised: '2026-04-01', files: { 'claude-code': 'x', codex: 'x' } });
  assert.ok(/DRAFT/i.test(r.draft), 'draft contract flagged for review, not auto-adopted');
});

// --- Hale review fixes (security + input validation) ---

test('migrate: YAML-injection contract_id throws (frontmatter-injection guard)', () => {
  assert.throws(
    () => migrateToContract({ contractId: 'demo\nmalicious: true', lastRevised: '2026-04-01', files: { 'claude-code': 'x', codex: 'x' } }),
    /contract_id/,
  );
});

test('migrate: malformed last_revised throws', () => {
  assert.throws(
    () => migrateToContract({ contractId: 'demo', lastRevised: 'whenever\nx: y', files: { 'claude-code': 'x' } }),
    /last_revised/,
  );
});

test('migrate: no known harness throws (not a silent empty canonical_for)', () => {
  assert.throws(
    () => migrateToContract({ contractId: 'demo', lastRevised: '2026-04-01', files: { borg: 'x' } }),
    /no known harness/,
  );
});

test('migrate: unknown harness key warns (ignored, not silently dropped)', () => {
  const r = migrateToContract({ contractId: 'demo', lastRevised: '2026-04-01', files: { 'claude-code': 'x', borg: 'y' } });
  assert.ok(r.warnings.some((w) => /borg/.test(w)));
});

test('migrate: last_revised "unknown" warns weak-provenance / non-releaseable (Hale)', () => {
  const r = migrateToContract({ contractId: 'demo', lastRevised: 'unknown', files: { 'claude-code': 'x', codex: 'x' } });
  assert.ok(r.warnings.some((w) => /weak provenance|non-releaseable/i.test(w)));
});
