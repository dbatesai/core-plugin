import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probe, SCHEMA_VERSION, CAPABILITY_ID, RISK_UNIT, CLOSURE_TARGET, CLOSURE_REQUIREMENT,
} from '../../plugins/core/skills/core/scripts/capability/anti-anchoring-mechanism-probe.mjs';

const VALID_WEIGHTS = new Set(['primary', 'corroborating', 'conflicting']);
const VALID_KINDS = new Set(['identity', 'runtime', 'mutation', 'observation']);

test('probe: honestly demotes to DEGRADED with mechanism trust-based (R-17)', async () => {
  const row = await probe({ cwd: '/work/Any' });
  assert.equal(row.identity_status, 'DEGRADED');
  assert.equal(row.mechanism, 'trust-based');
  assert.equal(row.capability_id, CAPABILITY_ID);
  assert.equal(row.schema_version, SCHEMA_VERSION);
});

test('probe: capability_kind is a schema kind (runtime)', async () => {
  const row = await probe();
  assert.ok(VALID_KINDS.has(row.capability_kind));
  assert.equal(row.capability_kind, 'runtime');
});

test('probe: DEGRADED carries a conflicting evidence entry; all weights schema-valid', async () => {
  const row = await probe();
  assert.ok(row.evidence.some(e => e.weight === 'conflicting'), 'DEGRADED needs a conflicting entry');
  for (const e of row.evidence) assert.ok(VALID_WEIGHTS.has(e.weight), `bad weight: ${e.weight}`);
});

test('probe: evidence points at the R-17 risk unit', async () => {
  const row = await probe();
  const ptr = row.evidence.find(e => e.source === 'risk-unit-pointer');
  assert.ok(ptr, 'must carry a risk-unit-pointer');
  assert.equal(ptr.value, RISK_UNIT);
  assert.match(RISK_UNIT, /^risk-17-/);
});

test('probe: declares an honest closure target (not a false exact promise) + requirement + mechanism', async () => {
  const row = await probe();
  assert.equal(row.closure_target, CLOSURE_TARGET);
  // MET-007: 'v2.9+' became a stale promise the moment v2.9–v3.7 shipped without
  // closure. 'unscheduled' is the honest state; CLOSURE_REQUIREMENT carries the bar.
  assert.equal(CLOSURE_TARGET, 'unscheduled');
  assert.match(CLOSURE_REQUIREMENT, /requires physical anti-anchoring isolation/);
  assert.equal(row.closure_requirement, CLOSURE_REQUIREMENT);
  assert.ok(typeof row.closure_mechanism_planned === 'string' && row.closure_mechanism_planned.length > 0);
});

test('probe: DEGRADED blocks mutation with identity-degraded reason', async () => {
  const row = await probe();
  assert.equal(row.mutation_permitted, false);
  assert.equal(row.mutation_block_reason, 'identity-degraded');
});

test('probe: carries required schema fields', async () => {
  const row = await probe();
  for (const k of ['schema_version', 'capability_id', 'capability_kind', 'observed_at', 'identity_status', 'mutation_permitted', 'evidence']) {
    assert.ok(k in row, `missing field: ${k}`);
  }
});

// --- e2e through the runner ---

test('e2e: anti-anchoring-mechanism row flows through capability-probe runStartup as DEGRADED', async () => {
  const { runStartup } = await import('../../plugins/core/skills/core/scripts/capability-probe.mjs');
  const res = await runStartup({ harness: 'claude-code', cwd: '/work/Any' });
  const row = res.rows.find(r => r.capability_id === 'anti-anchoring-mechanism');
  assert.ok(row, 'runner should emit the anti-anchoring-mechanism row for claude-code');
  assert.equal(row.identity_status, 'DEGRADED');
  assert.equal(row.mechanism, 'trust-based');
  assert.ok(res.summary.degraded >= 1, 'summary should count the DEGRADED row');
});
