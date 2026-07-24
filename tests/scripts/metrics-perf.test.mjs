// Performance battery (v3.14.0 Task 7) — the FIRST timing tests in this
// suite. Two budgets from the approved spec:
//   1. captureTurnEvidence adds <25ms p95 over a no-op baseline (the hook
//      rides every user turn — Agy's bar: zero perceptible degradation).
//   2. a judge batch of 50 turns over a 200-unit store completes <10s
//      (the maintenance cadence budget).
// Budgets carry generous CI-variance margin by design — these catch order-of-
// magnitude regressions (an accidental sync fsync loop, an O(n²) scan), not
// microsecond drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { captureTurnEvidence } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';
import { judgeUnjudgedTurns } from '../../plugins/core/skills/core/scripts/hindsight-judge.mjs';
import { computeStoreSignature } from '../../plugins/core/skills/core/scripts/turn-capture.mjs';

function makeStore(root, units) {
  const project = join(root, 'proj');
  const store = join(project, '_memories');
  mkdirSync(store, { recursive: true });
  writeFileSync(join(project, 'workspace.json'), JSON.stringify({ workspace_id: 'perf-fixture' }));
  for (let i = 0; i < units; i++) {
    writeFileSync(join(store, `dc-perf-${i}.md`),
      `---\nid: dc-perf-${i}\ntype: decision\nstatus: active\ncreated: 2026-06-01\ntitle: Decision ${i} about subsystem ${i % 7}\n---\n\nThe team decided approach ${i} for subsystem ${i % 7} covering topic-${i % 13} and area-${i % 5}.\n`);
  }
  return project;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.CORE_METRICS_ENABLED;
  delete env.CORE_TURN_CAPTURE;
  return env;
}

const row = (i) => ({
  retrieval_id: `r-perf-${i}`,
  session_id: 's-perf',
  harness: 'claude-code',
  prompt_text: `how was the decision about subsystem ${i % 7} made regarding topic-${i % 13}`,
  pack_text: 'delivered pack text for the perf run, a realistic couple of hundred bytes of memory context injected into the turn as the product actually does it.',
  delivered: [{ id: `dc-perf-${i % 50}`, score: 8.1, source_stage: 'ranked' }],
  rejected_top: Array.from({ length: 20 }, (_, k) => ({ id: `dc-perf-${(i + k) % 200}`, score: 5 - k * 0.2, source_stage: 'ranked' })),
  truncation: { byte_cap_applied: false, prompt_tokens_used: 8 },
  store_signature: 'sig-perf',
  producer_version: 'v', producer_sha: 'sha',
});

test('perf: captureTurnEvidence adds <25ms p95 over 30 iterations', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-cap-'));
  try {
    const project = makeStore(root, 5);
    const env = cleanEnv();
    // warm-up (dir creation, first lock)
    captureTurnEvidence(project, row(0), { env });
    const samples = [];
    for (let i = 1; i <= 30; i++) {
      const t0 = performance.now();
      const res = captureTurnEvidence(project, row(i), { env });
      const t1 = performance.now();
      assert.equal(res.written, true, res.reason);
      samples.push(t1 - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1];
    assert.ok(p95 < 25, `capture p95 ${p95.toFixed(2)}ms exceeds the 25ms budget (samples: ${samples.map((s) => s.toFixed(1)).join(',')})`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('perf: judging a 50-turn batch over a 200-unit store completes inside the 10s maintenance budget', () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-judge-'));
  try {
    const project = makeStore(root, 200);
    const env = cleanEnv();
    const sig = computeStoreSignature(project);
    for (let i = 0; i < 50; i++) {
      const r = row(i);
      r.store_signature = sig;
      assert.equal(captureTurnEvidence(project, r, { env }).written, true);
    }
    const t0 = performance.now();
    const res = judgeUnjudgedTurns(project, { limit: 50 });
    const elapsed = performance.now() - t0;
    assert.equal(res.judged, 50);
    assert.ok(elapsed < 10000, `judge batch took ${(elapsed / 1000).toFixed(1)}s, budget 10s`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
