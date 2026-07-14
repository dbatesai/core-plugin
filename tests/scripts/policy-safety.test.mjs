/**
 * Policy-stage safety battery — Train A A6 (Crest correction #4, 2026-07-12).
 *
 * The earlier tier-safety fixture proved LOADER anti-resurrection (a retired unit
 * never reaches ranking). This battery puts distractor classes AT the policy stage —
 * active-wrong, conflicting, vocabulary-stuffed, plus terminal (t_invalid) and
 * retired — and asserts what each tier policy provably does with them:
 *   - terminal/retired: excluded under every policy (two exclusion mechanisms);
 *   - P3: only ever DOWNWEIGHTS observations — a forbidden observation can never
 *     improve its position under P3;
 *   - P2: CHARACTERIZED, not defended — slot reservation promotes the best-scoring
 *     active canonical on authority alone, wrong answers included. That is the
 *     canonical-authority assumption the ceremony's evidence weighs; the sweep must
 *     MEASURE it (forbidden@3 > 0 on this fixture), never mask it.
 *   - vocabulary stuffing: ranks high under flat scoring — a recall/enrichment
 *     reality, not a tier-policy defect; pinned so the number is visible.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..',
  'plugins', 'core', 'skills', 'core', 'scripts');
const FIXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'policy-safety-store');

const { retrieveContext } = await import(pathToFileURL(join(SCRIPTS, 'retrieve-context.mjs')).href);
const { runTierPolicySweep } = await import(pathToFileURL(join(SCRIPTS, 'retrieval-harness.mjs')).href);

const POLICIES = ['P0', 'P1', 'P2', 'P3'];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'policy-safety-'));
  cpSync(FIXT, dir, { recursive: true });
  return dir;
}

test('terminal units are excluded under EVERY policy — retired and t_invalid both', () => {
  const dir = freshStore();
  try {
    for (const policy of POLICIES) {
      const ids = retrieveContext('beacon rollout freeze', dir, { topN: 3, tierPolicy: policy }).map(h => h.id);
      assert.ok(!ids.includes('dc-retired-strong-beacon'), `${policy}: retired unit leaked into final context`);
      assert.ok(!ids.includes('dc-terminal-invalid-beacon'), `${policy}: t_invalid unit leaked into final context`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('P3 only downweights observations — a forbidden observation never improves its rank', () => {
  const dir = freshStore();
  try {
    const rankOf = (ids, id) => { const i = ids.indexOf(id); return i === -1 ? Infinity : i; };
    const p0 = retrieveContext('beacon rollout freeze', dir, { topN: 3, tierPolicy: 'P0' }).map(h => h.id);
    const p3 = retrieveContext('beacon rollout freeze', dir, { topN: 3, tierPolicy: 'P3' }).map(h => h.id);
    assert.ok(rankOf(p3, 'obs-conflict-beacon') >= rankOf(p0, 'obs-conflict-beacon'),
      'P3 improved a conflicting observation — downweight-only property violated');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CHARACTERIZED: P2 slot reservation promotes an active-wrong canonical on authority alone', () => {
  // All top-3 lantern hits are observations under P0; the only canonical with score>0
  // is the WRONG answer. P2's design promotes it anyway — this test pins the risk so
  // the ceremony weighs a measured number, not a hoped-for property. If this test
  // ever fails, P2's semantics changed and the contract evidence must be re-run.
  const dir = freshStore();
  try {
    const p0 = retrieveContext('lantern audit trail', dir, { topN: 3, tierPolicy: 'P0' }).map(h => h.id);
    assert.ok(!p0.includes('dc-lantern-wrong'), 'precondition: P0 keeps the wrong canonical out of top-3');
    const p2 = retrieveContext('lantern audit trail', dir, { topN: 3, tierPolicy: 'P2' }).map(h => h.id);
    assert.ok(p2.includes('dc-lantern-wrong'),
      'expected P2 to promote the active-wrong canonical (the documented canonical-authority risk)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the sweep MEASURES the P2 risk on this fixture (forbidden@3 > 0 for P2, 0 for P0) — non-tautological', () => {
  const dir = freshStore();
  try {
    const gold = [{
      id: 'lantern', query: 'lantern audit trail',
      expected: ['obs-lantern-gold'],
      forbidden: ['dc-lantern-wrong', 'dc-retired-strong-beacon', 'dc-terminal-invalid-beacon'],
    }];
    const sweep = runTierPolicySweep(dir, gold);
    const byPolicy = Object.fromEntries(sweep.perPolicy.map(p => [p.policy, p]));
    assert.equal(byPolicy.P0.forbidden3, 0, 'P0 control clean on this fixture');
    assert.ok(byPolicy.P2.forbidden3 > 0,
      'sweep failed to measure the P2 canonical-promotion risk — the safety evidence would be tautological');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('PINNED recall reality: vocabulary stuffing ranks high under flat scoring (not a tier-policy defect)', () => {
  const dir = freshStore();
  try {
    const p0 = retrieveContext('beacon rollout freeze', dir, { topN: 3, tierPolicy: 'P0' }).map(h => h.id);
    assert.ok(p0.includes('dc-vocab-stuffed-beacon'),
      'expected the stuffed unit in flat top-3 — if this stopped holding, the scoring changed and the pinned reality must be re-measured');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
