import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreAction } from '../../plugins/core/skills/core/scripts/capability-probe.mjs';
import {
  classifyAdversarialRun, evaluateAdversarialRun, ADVERSARIAL_ACTION, ADVISORY_WATERMARK, ADVERSARIAL_DECISIONS,
} from '../../plugins/core/skills/core/scripts/adversarial-run-gate.mjs';

// --- Integration: real descriptor, anti-anchoring is deterministically DEGRADED ---

test('authority-for-mutation BLOCKED while anti-anchoring is DEGRADED (gate reads the real row)', async () => {
  const res = await runPreAction(ADVERSARIAL_ACTION, { harness: 'claude-code' });
  assert.equal(res.permitted, false, 'fail-closed: a DEGRADED anti-anchoring mechanism must block mutation authority');
  assert.equal(res.block_reason, 'identity-degraded');
  const row = res.rows.find(r => r.capability_id === 'anti-anchoring-mechanism');
  assert.ok(row, 'the actual anti-anchoring-mechanism row must be in the gate output — not a policy string');
  assert.equal(row.identity_status, 'DEGRADED');
});

test('advisory/review generation allowed with a loud DEGRADED watermark and no mutation authority', async () => {
  const decision = await evaluateAdversarialRun({ harness: 'claude-code' });
  assert.equal(decision.authority_for_mutation, false);
  assert.equal(decision.advisory_allowed, true);
  assert.ok(decision.watermark && decision.watermark.length > 0, 'advisory must be watermarked');
  assert.match(decision.watermark, /DEGRADED/);
  assert.equal(decision.anti_anchoring_status, 'DEGRADED');
  assert.equal(decision.gate.permitted, false, 'the underlying authority gate is still fail-closed');
});

// --- Unit: classifyAdversarialRun reads identity_status off the real row shape ---

test('PASS anti-anchoring authorizes mutation', () => {
  const d = classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'PASS' }] });
  assert.equal(d.authority_for_mutation, true);
  assert.equal(d.advisory_allowed, true);
  assert.equal(d.watermark, null);
});

test('NEGATIVE: UNKNOWN anti-anchoring does NOT silently grant mutation authority', () => {
  const d = classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'UNKNOWN' }] });
  assert.equal(d.authority_for_mutation, false, 'UNKNOWN must not authorize a mutation');
  assert.equal(d.advisory_allowed, true);
  assert.equal(d.blocked_reason, 'identity-unknown');
});

test('NEGATIVE: an absent anti-anchoring row authorizes nothing (no silent allow)', () => {
  const d = classifyAdversarialRun({ rows: [] });
  assert.equal(d.authority_for_mutation, false);
  assert.equal(d.advisory_allowed, false, 'a missing capability row must not read as advisory-ok either');
  assert.equal(d.blocked_reason, 'anti-anchoring-row-absent');
});

test('NOT-YET anti-anchoring blocks authority but allows watermarked advisory', () => {
  const d = classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'NOT-YET' }] });
  assert.equal(d.authority_for_mutation, false);
  assert.equal(d.advisory_allowed, true);
  assert.equal(d.watermark, ADVISORY_WATERMARK);
});

test('decision enum is machine-readable: AUTHORIZED / ADVISORY / BLOCKED (HC_555 hardening)', () => {
  assert.equal(classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'PASS' }] }).decision, 'AUTHORIZED');
  assert.equal(classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'DEGRADED' }] }).decision, 'ADVISORY');
  assert.equal(classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'UNKNOWN' }] }).decision, 'ADVISORY');
  assert.equal(classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: 'NOT-YET' }] }).decision, 'ADVISORY');
  assert.equal(classifyAdversarialRun({ rows: [] }).decision, 'BLOCKED');
  // every decision is in the published enum — ADVISORY can never be confused for AUTHORIZED
  for (const s of ['PASS', 'DEGRADED', 'UNKNOWN', 'NOT-YET']) {
    const d = classifyAdversarialRun({ rows: [{ capability_id: 'anti-anchoring-mechanism', identity_status: s }] });
    assert.ok(ADVERSARIAL_DECISIONS.includes(d.decision));
  }
});
