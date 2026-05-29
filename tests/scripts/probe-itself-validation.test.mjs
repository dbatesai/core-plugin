import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runStartup } from '../../skills/core/scripts/capability-probe.mjs';

// In-memory descriptor with one claude-code capability that uses a capability/ delegate.
// The _importer seam (passed via opts) decides what that delegate resolves to.
function descriptorWith(delegate) {
  return {
    schema_version: '1.0.0',
    harnesses: {
      'claude-code': {
        probe_script: 'x',
        capabilities: [
          { capability_id: 'fixture-cap', capability_kind: 'runtime', delegate, required_for_actions: [] },
        ],
      },
      codex: { probe_script: null, capabilities: [] },
      gemini: { probe_script: null, capabilities: [] },
    },
    consumer_actions: {},
  };
}

test('§7: a probe that throws mid-execution yields UNKNOWN with probe_failed evidence', async () => {
  const throwingImporter = async () => ({ probe: async () => { throw new Error('boom in probe'); } });
  const res = await runStartup({ harness: 'claude-code', descriptor: descriptorWith('capability/fixture.mjs'), _importer: throwingImporter });
  const row = res.rows.find(r => r.capability_id === 'fixture-cap');
  assert.ok(row, 'row should exist');
  assert.equal(row.identity_status, 'UNKNOWN');
  const pe = row.evidence.find(e => e.source === 'probe-execution');
  assert.ok(pe, 'must carry a probe-execution evidence entry');
  assert.equal(pe.probe_failed, true);
  assert.match(JSON.stringify(pe.value), /boom in probe/);
  assert.equal(row.mutation_block_reason, 'identity-unknown');
  assert.ok(['primary', 'corroborating', 'conflicting'].includes(pe.weight), 'weight must be schema-valid');
  assert.equal(res.summary.unknown, 1, 'summary should count the UNKNOWN row');
});

test('§7: a delegate that fails to import yields NOT-YET (not implemented ≠ crashed)', async () => {
  const failingImporter = async () => { throw new Error('Cannot find module'); };
  const res = await runStartup({ harness: 'claude-code', descriptor: descriptorWith('capability/missing.mjs'), _importer: failingImporter });
  const row = res.rows.find(r => r.capability_id === 'fixture-cap');
  assert.equal(row.identity_status, 'NOT-YET');
  assert.equal(row.mutation_block_reason, 'identity-not-yet');
  // The distinction is the point: import-failure is descriptor-walk, not probe-execution.
  assert.ok(!row.evidence.some(e => e.source === 'probe-execution'), 'import-fail must not masquerade as a probe crash');
});

test('§7: a healthy probe passes through unchanged with descriptor-stamped id', async () => {
  const okImporter = async () => ({
    probe: async () => ({
      schema_version: '1.0.0', identity_status: 'PASS',
      evidence: [{ source: 'x', value: 'ok', agrees_with_others: true, weight: 'primary' }],
      mutation_permitted: false, mutation_block_reason: null,
    }),
  });
  const res = await runStartup({ harness: 'claude-code', descriptor: descriptorWith('capability/ok.mjs'), _importer: okImporter });
  const row = res.rows.find(r => r.capability_id === 'fixture-cap');
  assert.equal(row.identity_status, 'PASS');
  assert.equal(row.capability_kind, 'runtime', 'runner stamps kind from descriptor');
});
